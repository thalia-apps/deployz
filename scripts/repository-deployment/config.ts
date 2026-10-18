/**
 * Stage B per-repository vendor configuration and wave membership —
 * `docs/testing/repository-deployment/deploy-config.yaml`.
 *
 * Everything here is what a real vendor could set through the product
 * (application overrides, configuration values) plus what the audit needs
 * to verify a deployment (health path to probe, expected response,
 * dependency checks). It references run-and-check recipes by id and never
 * repeats them. Secret VALUES are never stored: `secrets` names the
 * keys the harness generates at run time.
 */
import { readFileSync } from 'node:fs';

import { parse } from 'yaml';
import { z } from 'zod';

const ENTRY_ID_REGEX = /^repo-\d{3}$/;
const WAVE_ID_REGEX = /^[a-z0-9-]+$/;

/**
 * The three deployment classes for Stage B (compatibility.md "Stage B").
 *
 * B1 runtime-reuse: withdrawn (DEPLOY-017) — a deployment owns its
 *   installation, so a shared standing installation can never serve a
 *   second one. There is no `--runtime-reuse` execution path any more.
 *   `'runtime-reuse'` stays in `DEPLOYMENT_CLASSES` only so the schema can
 *   still parse the committed `runs/*.json` history that recorded it before
 *   the removal — `deploymentClassFor` never returns it for a new result.
 * B2 capability-cohort:         fresh infrastructure for repos covering each
 *   capability cohort (PostgreSQL, Redis, PostgreSQL+Redis, storage, custom
 *   Dockerfile, custom port, custom health check, special topology). Also
 *   the default for a repository not explicitly placed in `b2Repos` or
 *   `b3Repos` — it runs the same fresh-AWS `--real-aws` funnel either way.
 * B3 fresh-full:                full funnel through fresh AWS (build → ECR →
 *   bootstrap → install → healthy → destroy → cleanup audit).
 */
export const DEPLOYMENT_CLASSES = ['runtime-reuse', 'capability-cohort', 'fresh-full'] as const;
export type DeploymentClass = (typeof DEPLOYMENT_CLASSES)[number];

/** Mirrors PATCH /api/applications/:id — the vendor-correctable manifest inputs. */
export const vendorOverridesSchema = z
  .object({
    containerPort: z.number().int().positive().optional(),
    healthPath: z.string().min(1).optional(),
    migrationCommand: z.string().min(1).nullable().optional(),
    databaseRequired: z.boolean().optional(),
    storageRequired: z.boolean().optional(),
    redisRequired: z.boolean().optional(),
    appRoot: z.string().min(1).optional(),
    dockerfilePath: z.string().min(1).optional(),
    buildContext: z.string().min(1).optional(),
    buildCommand: z.string().min(1).optional(),
    startCommand: z.string().min(1).optional(),
  })
  .strict();
export type VendorOverrides = z.infer<typeof vendorOverridesSchema>;

/**
 * A non-secret configuration value the vendor would type into the
 * Configuration screen. `${DEPLOYZ_APP_URL}` in a value stands for the
 * deployment's permanent default-HTTPS address: the harness writes a
 * placeholder at the vendor scope (so the gate sees the key) and the real
 * address at the customer scope as soon as the deployment id exists.
 */
export const configValueSchema = z
  .object({
    key: z.string().min(1),
    value: z.string(),
  })
  .strict();

export const APP_URL_TOKEN = '${DEPLOYZ_APP_URL}';

export const SECRET_FORMATS = ['base64url', 'hex32', 'hex64', 'password'] as const;
export type SecretFormat = (typeof SECRET_FORMATS)[number];

/**
 * A secret key the harness generates at run time — a bare key, or a key with the format the app validates —
 * or a vendor-supplied credential it cannot generate, read from the named environment variable at run time
 * (`fromEnv`). Values are never stored either way.
 */
export const secretSpecSchema = z.union([
  z.string().min(1),
  z.object({ key: z.string().min(1), format: z.enum(SECRET_FORMATS) }).strict(),
  z.object({ key: z.string().min(1), fromEnv: z.string().min(1) }).strict(),
]);
export type SecretSpec = z.infer<typeof secretSpecSchema>;

export function secretKey(spec: SecretSpec): string {
  return typeof spec === 'string' ? spec : spec.key;
}

export function secretFormat(spec: SecretSpec): SecretFormat {
  return typeof spec === 'string' || !('format' in spec) ? 'base64url' : spec.format;
}

/** The run-time value of a secret: the named environment variable for `fromEnv`, else a generated one. */
export function secretValue(spec: SecretSpec, generate: (format: SecretFormat) => string, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof spec !== 'string' && 'fromEnv' in spec) {
    const value = env[spec.fromEnv];
    if (!value) throw new Error(`${spec.key} reads ${spec.fromEnv}, which is not set`);
    return value;
  }
  return generate(secretFormat(spec));
}

export const DEPENDENCY_CHECKS = ['verify', 'skip'] as const;

export const verifySchema = z
  .object({
    /** The path Stage B probes for health (precedence 1). Defaults to the manifest's health path. */
    healthPath: z.string().min(1).optional(),
    /** The path that must return an application-generated response. Default `/`. */
    appPath: z.string().min(1).optional(),
    /** Acceptable status codes on `appPath`. Default: any non-5xx. */
    appStatus: z.array(z.number().int().min(100).max(599)).min(1).optional(),
    /** How long the healthy state must hold before PASS. Default 180. */
    observationSeconds: z.number().int().min(30).max(900).optional(),
  })
  .strict();

export const dependenciesSchema = z
  .object({
    postgres: z.enum(DEPENDENCY_CHECKS).optional(),
    redis: z.enum(DEPENDENCY_CHECKS).optional(),
    storage: z.enum(DEPENDENCY_CHECKS).optional(),
  })
  .strict();

export const SMOKE_EXERCISES = ['postgres', 'redis'] as const;
export type SmokeExercise = (typeof SMOKE_EXERCISES)[number];

/**
 * A repository-specific smoke check the harness runs against the live
 * application after HTTPS is ACTIVE — a generic 200 is not enough. At least
 * one of `bodyIncludes`/`jsonPath` is required: a status-only contract is
 * rejected here rather than silently passing on any non-error status.
 */
export const smokeCheckSchema = z
  .object({
    path: z.string().regex(/^\//),
    method: z.literal('GET').default('GET'),
    status: z.union([z.number().int().min(100).max(599), z.array(z.number().int().min(100).max(599)).min(1)]),
    bodyIncludes: z.string().min(1).optional(),
    /** A dot path into the JSON body, e.g. `status` or `data.ok`. */
    jsonPath: z.string().min(1).optional(),
    /** Compared with strict equality; when `jsonPath` is set without this, the value must exist and be non-null. */
    jsonEquals: z.union([z.string(), z.number(), z.boolean()]).optional(),
    /** Which managed dependency this check exercises, when it fails, that dependency is recorded FAIL. */
    exercises: z.array(z.enum(SMOKE_EXERCISES)).optional(),
    graceSeconds: z.number().int().min(0).max(600).default(0),
    retries: z.number().int().min(0).max(10).default(3),
    retryDelaySeconds: z.number().int().min(1).max(120).default(20),
  })
  .strict()
  .refine((check) => check.bodyIncludes !== undefined || check.jsonPath !== undefined, {
    message: 'a smoke check needs bodyIncludes or jsonPath — a status-only contract does not prove the application answered',
  });
export type SmokeCheck = z.infer<typeof smokeCheckSchema>;

export const repositoryConfigSchema = z
  .object({
    id: z.string().regex(ENTRY_ID_REGEX),
    /** The fork the vendor GitHub App installation can read. Default `instashop-dev/<repo>`. */
    fork: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .optional(),
    overrides: vendorOverridesSchema.optional(),
    config: z.array(configValueSchema).optional(),
    /** Secret keys the harness generates at run time (never values). */
    secrets: z.array(secretSpecSchema).optional(),
    verify: verifySchema.optional(),
    dependencies: dependenciesSchema.optional(),
    smoke: z.array(smokeCheckSchema).optional(),
    /** Registry findings (findings.md) that explain this entry's known outcome. */
    findings: z.array(z.string().regex(/^DEPLOY-\d{3}$/)).default([]),
    notes: z.array(z.string()).default([]),
    /**
     * Override the deployment class for this repository.
     * Defaults are derived from deploy-config.yaml b2_repos/b3_repos lists.
     */
    deploymentClass: z.enum(DEPLOYMENT_CLASSES).optional(),
  })
  .strict();
export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;

export const deployConfigSchema = z
  .object({
    version: z.literal(1),
    /** Wave name → recipe ids, in execution order. */
    waves: z.record(z.string().regex(WAVE_ID_REGEX), z.array(z.string().regex(ENTRY_ID_REGEX)).min(1)).default({}),
    repositories: z.array(repositoryConfigSchema).default([]),
    /**
     * Explicit list of repos that run as B2 capability-cohort (fresh
     * infrastructure per attempt). Chosen for widest capability coverage.
     * Overrides the default runtime-reuse class for these ids.
     */
    b2Repos: z.array(z.string().regex(ENTRY_ID_REGEX)).default([]),
    /**
     * Explicit list of repos that run as B3 fresh-full (full funnel through
     * fresh AWS). Chosen as the ~10-15 most representative repos across the
     * corpus. Overrides the default runtime-reuse class for these ids.
     */
    b3Repos: z.array(z.string().regex(ENTRY_ID_REGEX)).default([]),
  })
  .strict();
export type DeployConfig = z.infer<typeof deployConfigSchema>;

/**
 * Resolve the deployment class for a repository id.
 *
 *   - Explicit override in the repository config wins.
 *   - B3 list membership → fresh-full.
 *   - B2 list membership, or no membership at all → capability-cohort.
 *
 * `runtime-reuse` (B1) is never returned here — it is withdrawn (DEPLOY-017)
 * and kept in `DEPLOYMENT_CLASSES` only so the schema can still parse the 40
 * committed `runs/*.json` result files that recorded it before the removal.
 * A repository this function does not explicitly place in `b2Repos`/
 * `b3Repos` still runs the same fresh-AWS `--real-aws` funnel as an
 * explicit B2 entry, so `capability-cohort` is the honest default now.
 */
export function deploymentClassFor(config: DeployConfig, id: string): DeploymentClass {
  const repoConfig = config.repositories.find((entry) => entry.id === id);
  if (repoConfig?.deploymentClass) return repoConfig.deploymentClass;
  if (config.b3Repos.includes(id)) return 'fresh-full';
  return 'capability-cohort';
}

/**
 * Parse and cross-validate: unique repository ids, unique keys within an
 * entry's config, no key both configured and generated, unique ids within a
 * wave. Whether every wave id has a recipe is checked by the caller, which
 * holds the recipes.
 */
export function parseDeployConfig(text: string): DeployConfig {
  const config = deployConfigSchema.parse(parse(text) ?? {});
  const ids = new Set<string>();
  for (const entry of config.repositories) {
    if (ids.has(entry.id)) throw new Error(`duplicate repository config ${entry.id}`);
    ids.add(entry.id);
    const keys = new Set<string>();
    for (const value of entry.config ?? []) {
      if (keys.has(value.key)) throw new Error(`${entry.id} configures ${value.key} twice`);
      keys.add(value.key);
    }
    for (const secret of entry.secrets ?? []) {
      const key = secretKey(secret);
      if (keys.has(key)) throw new Error(`${entry.id} both configures and generates ${key}`);
      keys.add(key);
    }
  }
  for (const [wave, members] of Object.entries(config.waves)) {
    if (new Set(members).size !== members.length) throw new Error(`wave ${wave} lists a repository twice`);
  }

  const overlap = config.b2Repos.filter((id) => config.b3Repos.includes(id));
  if (overlap.length > 0) {
    throw new Error(`b2Repos and b3Repos overlap: ${overlap.join(', ')} — each repo must belong to at most one class list`);
  }

  return config;
}

export function loadDeployConfig(path: string): DeployConfig {
  return parseDeployConfig(readFileSync(path, 'utf8'));
}

/** The configuration for one recipe id — an empty one when nothing is configured. */
export function configFor(config: DeployConfig, id: string): RepositoryConfig {
  return config.repositories.find((entry) => entry.id === id) ?? { id, findings: [], notes: [] };
}

/** Every configuration key the harness will provide for an entry (values and generated secrets). */
export function providedKeys(entry: RepositoryConfig): string[] {
  return [...(entry.config ?? []).map((value) => value.key), ...(entry.secrets ?? []).map(secretKey)].sort();
}

/** The configuration keys whose value must carry the deployment's own address. */
export function appUrlKeys(entry: RepositoryConfig): string[] {
  return (entry.config ?? []).filter((value) => value.value.includes(APP_URL_TOKEN)).map((value) => value.key);
}

/**
 * `--require-smoke`: a repository with no smoke contract must stop before
 * anything is created, not fail 40 minutes later on a generic 200. Throws
 * the refusal; does nothing when the flag is off or a contract is configured.
 */
export function requireSmokeContract(entry: RepositoryConfig, requireSmoke: boolean): void {
  if (requireSmoke && (entry.smoke?.length ?? 0) === 0) {
    throw new Error(`${entry.id} has no smoke contract — refusing under --require-smoke (add a "smoke" entry to its deploy-config.yaml entry)`);
  }
}
