/**
 * Environment-variable classification (AI MVP Phase 4) — who supplies each
 * variable's value. Deterministic: names, detected requirements and the
 * external-service catalog decide; nothing here reads a value, and the LLM
 * never takes part.
 *
 *   - deployz_managed   — Deployz injects it at install (database, cache,
 *                         storage bindings, the port) or derives it from
 *                         the deployment region (S3 region/endpoint) or the
 *                         default HTTPS URL (the app's own public URL).
 *   - deployz_generated — an application-internal secret (session/JWT/
 *                         encryption keys) Deployz generates with
 *                         cryptographic randomness inside the customer's
 *                         account. Never a third-party credential.
 *   - customer_required — the vendor must supply a value before deployment.
 *   - optional          — the app reads it with a default, or the repository
 *                         supplies one.
 *   - unknown           — declared only in a sample file, never read: the
 *                         analysis cannot say whether it matters.
 */

import type { EnvVariableClassification, ManifestEnvVariable } from '@deployz/contracts';

import { isDerivedS3EnvVariable, postgresSemantic } from './bindings.js';
import { isDerivedUrlEnvVariable } from './derived-url.js';
import { EXTERNAL_SERVICE_CATALOG, S3_PRESENCE_EVIDENCE } from './detectors.js';

export interface EnvClassificationContext {
  postgresRequired: boolean;
  /** Env names the schema itself reads for the database URL (Prisma `datasource`), whatever they are called. */
  databaseBindingNames?: string[];
  redisRequired: boolean;
  /** The Redis env names Deployz injects when Redis is required. */
  redisBindingNames: string[];
  storageRequired: boolean;
  /** External services the repository evidences (ids from the catalog). */
  externalServices: string[];
  /** Env names Deployz injects for a provisioned SQS queue (or its DLQ) — Phase 5. */
  queueBindingNames: string[];
}

/** Env names the application stack injects for a managed PostgreSQL database. */
export const MANAGED_DATABASE_ENV_VARS = [
  'DATABASE_URL',
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_NAME',
  'DATABASE_USER',
  'DATABASE_PASSWORD',
] as const;

/** Env names the application stack injects for managed object storage. */
export const MANAGED_STORAGE_ENV_VARS = ['STORAGE_BUCKET', 'S3_BUCKET', 'AWS_S3_BUCKET', 'AWS_REGION'] as const;

/**
 * The AWS SDK credential names. The ECS task role gives the SDK its credentials
 * through the default provider chain, so the vendor never supplies static keys.
 */
const TASK_ROLE_CREDENTIAL_ENV_VARS = new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']);

/** True for a credential name that the task role replaces. */
export function isTaskRoleCredentialName(key: string): boolean {
  return TASK_ROLE_CREDENTIAL_ENV_VARS.has(key);
}

/** Env names the container platform always provides. */
const MANAGED_PLATFORM_ENV_VARS = ['PORT', 'HOSTNAME'] as const;

/** Application-internal secrets Deployz can mint: the name ends in one of these. */
const GENERATED_SECRET_SUFFIX_REGEX =
  /(?:^|_)(?:SECRET|SECRET_KEY|SECRET_KEY_BASE|ENCRYPTION_KEY|ENCRYPTION_SECRET|SIGNING_KEY|SIGNING_SECRET|APP_KEY|SESSION_KEY|JWT_KEY|COOKIE_KEY|HASH_SALT|SALT|PEPPER)$/;

/** A third-party product's prefix — its secret belongs to the vendor, never generated. */
const THIRD_PARTY_PREFIX_REGEX =
  /^(?:STRIPE|SMTP|MAIL|MAILGUN|POSTMARK|SES|SENDGRID|RESEND|AWS|S3|GITHUB|GITLAB|GOOGLE|GCP|AZURE|SLACK|DISCORD|TWILIO|OPENAI|ANTHROPIC|CLERK|AUTH0|OKTA|SUPABASE|FIREBASE|SHOPIFY|PAYPAL|SENTRY|DATADOG|CLOUDFLARE|VERCEL|OAUTH|OIDC|SAML|LDAP|TURNSTILE|RECAPTCHA|HCAPTCHA|FACEBOOK|APPLE|MICROSOFT|LINKEDIN|X|TWITTER)_/;

/** A key that names a connection to something outside the app is never minted. */
const CONNECTION_KEY_REGEX = /(?:_URL|_URI|_DSN|_HOST|_ENDPOINT|_USER|_USERNAME|_PASSWORD|_TOKEN|_API_KEY|_ACCESS_KEY|_CLIENT_SECRET)$/;

/** A secret shared with another party (a webhook signer, a partner HMAC, a licence server) must match theirs — never minted. */
const SHARED_SECRET_REGEX = /(?:^|_)(?:WEBHOOK|HMAC|LICENSE|LICENCE|SHARED|PARTNER|SIGNATURE|VERIFICATION|CALLBACK)_(?:SECRET|KEY|SECRET_KEY|SIGNING_KEY|SIGNING_SECRET)$/;

function externalServiceKeys(services: string[]): Set<string> {
  const keys = new Set<string>();
  for (const def of EXTERNAL_SERVICE_CATALOG) {
    if (services.includes(def.id)) for (const key of def.keys) keys.add(key);
  }
  return keys;
}

/** True when Deployz can safely mint this variable's value. */
export function isGeneratableSecretName(key: string): boolean {
  return (
    GENERATED_SECRET_SUFFIX_REGEX.test(key) &&
    !THIRD_PARTY_PREFIX_REGEX.test(key) &&
    !CONNECTION_KEY_REGEX.test(key) &&
    !SHARED_SECRET_REGEX.test(key)
  );
}

function classifyOne(
  variable: ManifestEnvVariable,
  managed: Set<string>,
  serviceKeys: Set<string>,
): EnvVariableClassification {
  if (managed.has(variable.key)) return 'deployz_managed';
  const generatable =
    variable.secret &&
    !serviceKeys.has(variable.key) &&
    !variable.source.includes(S3_PRESENCE_EVIDENCE) &&
    isGeneratableSecretName(variable.key);
  // An optional internal secret usually falls back to a development default;
  // a generated value replaces it (kutt's envalid `devDefault`, DEPLOY-013).
  if (generatable && (variable.required || variable.purpose === 'internal_secret')) return 'deployz_generated';
  if (variable.required) return 'customer_required';
  const isRead = variable.source.some((entry) => entry.startsWith('read in '));
  return isRead ? 'optional' : 'unknown';
}

/**
 * Classify every variable in the model. Pure; the input entries are copied,
 * never mutated. Only the names Deployz actually injects for THIS app count
 * as managed — a `REDIS_URL` in an app without a required cache is the
 * vendor's to provide.
 */
export function classifyEnvVariables(
  model: ManifestEnvVariable[],
  context: EnvClassificationContext,
): ManifestEnvVariable[] {
  const managed = new Set<string>(MANAGED_PLATFORM_ENV_VARS);
  if (context.postgresRequired) {
    for (const name of [...MANAGED_DATABASE_ENV_VARS, ...(context.databaseBindingNames ?? [])]) managed.add(name);
    // Alias names the binding phase injects (MEMOS_DSN, SPRING_DATASOURCE_URL, …).
    for (const variable of model) if (postgresSemantic(variable.key) !== null) managed.add(variable.key);
  }
  if (context.redisRequired) for (const name of context.redisBindingNames) managed.add(name);
  if (context.storageRequired) {
    for (const name of MANAGED_STORAGE_ENV_VARS) managed.add(name);
    // S3 region/endpoint names the app reads get a value derived from the
    // deployment region.
    for (const variable of model) if (isDerivedS3EnvVariable(variable)) managed.add(variable.key);
  }
  for (const name of context.queueBindingNames) managed.add(name);
  // The app's own public URL is the deployment's default HTTPS URL.
  for (const variable of model) if (isDerivedUrlEnvVariable(variable)) managed.add(variable.key);
  const serviceKeys = externalServiceKeys(context.externalServices);

  return model.map((variable) =>
    isTaskRoleCredentialName(variable.key)
      ? { ...variable, required: false, classification: 'optional' }
      : { ...variable, classification: classifyOne(variable, managed, serviceKeys) },
  );
}
