/**
 * The container environment of an observation run, built from production code:
 *
 *   1. `compileDeploymentIntent` (the call production makes at deployment
 *      creation) compiles the manifest; the `Environment` and `Secrets` of the
 *      role's task definition are read from the template and their
 *      intrinsics are resolved locally (`resolve.ts`).
 *   2. The configuration values the relay adds at install are added with the
 *      exported production functions: vendor inputs, derived S3 and URL
 *      values (`derivedS3EnvValue`, `derivedUrlEnvValue`) and minted secrets
 *      (`mintedEnvKeys`, `generateSecretValue`). No exported function
 *      composes them: `buildRelayConfigEntries` (apps/api) needs a database.
 *      The composition is repeated here with the same precedence: vendor
 *      input, then derived value, then minted secret.
 *   3. Harness-only values: the MinIO endpoint and keys (production uses the
 *      task IAM role). They are listed in `harnessOnly`.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { derivedS3EnvValue, derivedUrlEnvValue, mintedEnvKeys } from '@deployz/analysis';
import { compileDeploymentIntent } from '@deployz/api/compiler-artifact';
import { deployzTaskFamily, resolveInfrastructureSizeProfile, type DeploymentManifest } from '@deployz/contracts';
import { generateSecretValue } from '@deployz/relay/config-update';

import type { Recipe } from '../contract.js';
import type { ProductionEnvironmentFn, ServiceSet } from '../ports.js';
import { UnresolvedReferenceError, resolveSecretValueFrom, resolveValue, type ResolveContext } from './resolve.js';

const REGION = 'us-east-1';

type Resource = { Type: string; Properties?: Record<string, unknown> };
type Template = { Parameters?: Record<string, { Default?: unknown }>; Resources: Record<string, Resource> };
type TaskEntry = { Name: string; Value?: unknown; ValueFrom?: unknown };
type SecretContext = ResolveContext & { secretValue(secretId: string, field: string | null): string };

export interface ProductionEnvironment {
  env: Record<string, string>;
  harnessOnly: string[];
  secretNames: string[];
  /** Variables the template defines but the harness cannot supply (queue names); they are left out. */
  unresolved: string[];
}

/** Generated values are the same for every role of one service set, as one deployment shares them. */
const generatedValues = new WeakMap<ServiceSet, Map<string, string>>();

function generated(services: ServiceSet, key: string, make: () => string): string {
  let values = generatedValues.get(services);
  if (values === undefined) {
    values = new Map();
    generatedValues.set(services, values);
  }
  let value = values.get(key);
  if (value === undefined) {
    value = make();
    values.set(key, value);
  }
  return value;
}

/** The name of the web container on the internal network; the app's own URL is `http://<name>:<port>`. */
export function webHostName(services: ServiceSet): string {
  return `${services.id}-web`;
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** `hexN` and `alnum-N` have N characters; `base64-N` and `base64url-N` encode N random bytes. */
export function vendorValue(format: 'hex32' | 'hex64' | 'base64-32' | 'base64url-32' | 'uuid' | 'alnum-32'): string {
  switch (format) {
    case 'hex32':
      return randomBytes(16).toString('hex');
    case 'hex64':
      return randomBytes(32).toString('hex');
    case 'base64-32':
      return randomBytes(32).toString('base64');
    case 'base64url-32':
      return randomBytes(32).toString('base64url');
    case 'uuid':
      return randomUUID();
    case 'alnum-32':
      return Array.from(randomBytes(32), (byte) => ALNUM[byte % ALNUM.length]).join('');
  }
}

function taskDefinition(template: Template, componentId: string): Resource {
  const family = deployzTaskFamily(componentId, '');
  for (const resource of Object.values(template.Resources)) {
    if (resource.Type !== 'AWS::ECS::TaskDefinition') continue;
    const name = (resource.Properties?.['Family'] as { 'Fn::Join'?: [string, unknown[]] } | undefined)?.['Fn::Join']?.[1]?.[0];
    if (name === family) return resource;
  }
  throw new Error(`no task definition for ${componentId} (family ${family})`);
}

function databaseEngine(template: Template): 'postgres' | 'mysql' | null {
  const instance = Object.values(template.Resources).find((resource) => resource.Type === 'AWS::RDS::DBInstance');
  if (instance === undefined) return null;
  return String(instance.Properties?.['Engine']).startsWith('mysql') ? 'mysql' : 'postgres';
}

function resolveContext(template: Template, manifest: DeploymentManifest, services: ServiceSet): SecretContext {
  const parameterOverrides: Record<string, () => string> = {
    paramAppApiKey: () => generated(services, 'param:apiKey', generateSecretValue),
    paramAppSigningSecret: () => generated(services, 'param:signingSecret', generateSecretValue),
  };
  const context: SecretContext = {
    ref(name) {
      if (name === 'AWS::Region') return REGION;
      const parameter = template.Parameters?.[name];
      if (parameter !== undefined) {
        if (name === 'paramContainerPort' && manifest.web.port !== null) return String(manifest.web.port);
        const override = parameterOverrides[name];
        if (override !== undefined) return override();
        if (parameter.Default === undefined) throw new Error(`parameter ${name} has no default`);
        return String(parameter.Default);
      }
      const resource = template.Resources[name];
      if (resource === undefined) throw new Error(`unknown reference ${name}`);
      switch (resource.Type) {
        case 'AWS::SecretsManager::Secret':
          return name;
        case 'AWS::S3::Bucket':
          return services.minio.bucket;
        case 'AWS::SQS::Queue':
          throw new UnresolvedReferenceError(name);
        default:
          throw new Error(`unsupported Ref to ${resource.Type} ${name}`);
      }
    },
    getAtt(name, attribute) {
      const resource = template.Resources[name];
      if (resource === undefined) throw new Error(`unknown reference ${name}`);
      if (resource.Type === 'AWS::RDS::DBInstance' && attribute === 'Endpoint.Address') {
        return databaseEngine(template) === 'mysql' ? services.mysql.host : services.postgres.host;
      }
      if (resource.Type === 'AWS::ElastiCache::ReplicationGroup' && attribute === 'PrimaryEndPoint.Address') {
        return services.valkey.host;
      }
      if (resource.Type === 'AWS::SQS::Queue') throw new UnresolvedReferenceError(name);
      throw new Error(`unsupported GetAtt ${name}.${attribute} (${resource.Type})`);
    },
    secretField(secretId, field) {
      return context.secretValue(secretId, field);
    },
    secretValue(secretId, field) {
      const secret = template.Resources[secretId];
      if (secret?.Type !== 'AWS::SecretsManager::Secret') throw new Error(`unknown secret ${secretId}`);
      if (secret.Properties?.['GenerateSecretString'] !== undefined) {
        if (field !== 'password') throw new Error(`unsupported field ${String(field)} of generated secret ${secretId}`);
        return databaseEngine(template) === 'mysql' ? services.mysql.password : services.postgres.password;
      }
      const text = resolveValue(secret.Properties?.['SecretString'], context);
      if (field === null) return text;
      const value = (JSON.parse(text) as Record<string, unknown>)[field];
      if (typeof value !== 'string') throw new Error(`secret ${secretId} has no field ${field}`);
      return value;
    },
  };
  return context;
}

export function productionEnvironmentDetailed(input: Parameters<ProductionEnvironmentFn>[0]): ProductionEnvironment {
  const { manifest, role, services, recipe } = input;
  const profile = resolveInfrastructureSizeProfile('small', 2);
  if (profile === undefined) throw new Error('size profile small-v2 is not published');
  const template = compileDeploymentIntent({ manifest, region: REGION, sizeProfile: profile }).template as unknown as Template;

  const componentId = role === 'worker' ? (input.workerId ?? 'worker') : role;
  const container = (
    taskDefinition(template, componentId).Properties?.['ContainerDefinitions'] as
      | { Name: string; Environment?: TaskEntry[]; Secrets?: TaskEntry[] }[]
      | undefined
  )?.find((definition) => definition.Name === 'App');
  if (container === undefined) throw new Error(`task definition of ${componentId} has no App container`);

  const context = resolveContext(template, manifest, services);
  const env: Record<string, string> = {};
  const secretNames = new Set<string>();
  const unresolved: string[] = [];
  const add = (name: string, resolve: () => string, secret: boolean): void => {
    try {
      env[name] = resolve();
      if (secret) secretNames.add(name);
    } catch (error) {
      if (!(error instanceof UnresolvedReferenceError)) throw error;
      unresolved.push(name);
    }
  };
  for (const entry of container.Environment ?? []) add(entry.Name, () => resolveValue(entry.Value, context), false);
  for (const entry of container.Secrets ?? []) {
    add(entry.Name, () => resolveSecretValueFrom(entry.ValueFrom, context, context.secretValue), true);
  }

  const harnessOnly = addConfiguration({ env, secretNames, manifest, recipe, services, port: context.ref('paramContainerPort') });

  const harness: Record<string, string> = {
    AWS_ACCESS_KEY_ID: services.minio.accessKey,
    AWS_SECRET_ACCESS_KEY: services.minio.secretKey,
    AWS_ENDPOINT_URL: services.minio.endpoint,
    AWS_ENDPOINT_URL_S3: services.minio.endpoint,
    AWS_S3_FORCE_PATH_STYLE: 'true',
  };
  for (const [name, value] of Object.entries(harness)) {
    if (name in env) continue;
    env[name] = value;
    harnessOnly.push(name);
  }
  if (harnessOnly.includes('AWS_ACCESS_KEY_ID')) secretNames.add('AWS_ACCESS_KEY_ID');
  if (harnessOnly.includes('AWS_SECRET_ACCESS_KEY')) secretNames.add('AWS_SECRET_ACCESS_KEY');

  return { env, harnessOnly, secretNames: [...secretNames], unresolved };
}

/**
 * Vendor inputs, derived values and minted secrets, in the relay's precedence
 * order. Returns the names whose derived value the harness redirects: a
 * derived S3 endpoint points to MinIO, because runs have no internet.
 */
function addConfiguration(input: {
  env: Record<string, string>;
  secretNames: Set<string>;
  manifest: DeploymentManifest;
  recipe: Recipe;
  services: ServiceSet;
  port: string;
}): string[] {
  const { env, secretNames, manifest, recipe, services } = input;
  const configured = new Set<string>();
  const redirected: string[] = [];
  const deploymentUrl = `http://${webHostName(services)}:${input.port}`;
  for (const vendorInput of recipe.vendorInputs) {
    if (vendorInput.source.kind === 'fixed') {
      env[vendorInput.name] = vendorInput.source.value;
    } else if (vendorInput.source.kind === 'deploymentUrl') {
      env[vendorInput.name] = deploymentUrl;
    } else {
      const format = vendorInput.source.format;
      env[vendorInput.name] = generated(services, `vendor:${vendorInput.name}`, () => vendorValue(format));
      secretNames.add(vendorInput.name);
    }
    configured.add(vendorInput.name);
  }
  for (const variable of manifest.environment.variables) {
    if (configured.has(variable.key)) continue;
    const value =
      (manifest.storage.required ? derivedS3EnvValue(variable, REGION) : null) ?? derivedUrlEnvValue(variable, deploymentUrl);
    if (value === null) continue;
    const s3Endpoint = manifest.storage.required && value === derivedS3EnvValue(variable, REGION) && value.startsWith('https://');
    env[variable.key] = s3Endpoint ? services.minio.endpoint : value;
    if (s3Endpoint) redirected.push(variable.key);
    configured.add(variable.key);
  }
  for (const key of mintedEnvKeys(manifest, null)) {
    if (configured.has(key)) continue;
    env[key] = generated(services, `minted:${key}`, generateSecretValue);
    secretNames.add(key);
  }
  return redirected;
}

/** The ports.ts function; `productionEnvironmentDetailed` also returns the `unresolved` names. */
export const productionEnvironment: ProductionEnvironmentFn = productionEnvironmentDetailed;
