import { config } from 'dotenv';

import { SUPPORTED_AWS_REGIONS } from '@deployz/contracts';
import type { AiGatewayConfig } from '@deployz/analysis';

import {
  FIX_INSTRUCTIONS_AI_PROBLEMS,
  describeAiGatewayConfig,
  describeFixInstructionsAiConfig,
  resolveJevConfig,
  type JevConfig,
} from './ai-config.js';
import { parseTeamAdminEmails } from './admin/auth.js';

import { findEnvFile } from './find-env-file.js';

// Lambda injects the environment directly and ships no .env, so skip the
// filesystem probe there entirely. dotenv also no-ops silently when the file
// is absent, so CI and any other real-env deployment are unaffected.
//
// findEnvFile walks up from the working directory to the filesystem root —
// deliberately not a fixed number of hops, and deliberately not
// `fileURLToPath(import.meta.url)`: the API is bundled to CJS for Lambda
// because pg uses dynamic require(), and esbuild compiles `import.meta` to
// `{}` in CJS output, so import.meta.url is undefined and fileURLToPath
// throws at module load, killing the function during INIT before any handler
// runs. packages/db/src/client.ts avoids the same trap by evaluating
// import.meta.url lazily inside a function.
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const envFile = findEnvFile(process.cwd());
  if (envFile) config({ path: envFile });
}

// Single place that reads process.env for the API. Anything undefined falls
// back to localhost dev defaults; degraded capabilities warn, never crash.

const apiPort = Number(process.env.API_PORT ?? 3001);
const webPort = Number(process.env.WEB_PORT ?? 3000);

/** Origins are compared as strings (CORS, trustedOrigins), so a stray trailing
 *  slash silently stops matching. Normalise once, here. */
function origin(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : undefined;
}

/**
 * Parses a comma-separated region list (e.g. `DEPLOYABLE_AWS_REGIONS`),
 * keeping only regions in the canonical supported set. An empty result for
 * an explicitly-set var means "nothing deployable" — fail closed. The
 * default is applied only when the var is unset.
 */
function parseRegionList(value: string | undefined, fallback: readonly string[]): readonly string[] {
  if (value === undefined || value.trim() === '') return fallback;
  const allowed = new Set<string>(SUPPORTED_AWS_REGIONS);
  const regions = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && allowed.has(entry));
  return regions;
}

// The auth server's own origin. In production this is the API's public
// hostname (api.deployz.dev) — Better Auth builds OAuth callback URLs from it,
// so it must be the externally reachable origin, never the Lambda's internal
// one. BETTER_AUTH_URL is the historical name for exactly this value.
const apiUrl = origin(process.env.API_URL) ?? origin(process.env.BETTER_AUTH_URL) ?? `http://localhost:${apiPort}`;

// The dashboard origin (app.deployz.dev) and the marketing origin
// (deployz.dev). They are the same host in local dev, and both are browser
// origins that must pass CORS and Better Auth's origin check.
const webUrl = origin(process.env.WEB_URL) ?? `http://localhost:${webPort}`;
const marketingUrl = origin(process.env.MARKETING_URL) ?? webUrl;

// Set in production only (e.g. '.deployz.dev'). When present, session cookies
// are widened from host-scoped to domain-scoped so a cookie set by the API on
// api.deployz.dev is readable by app.deployz.dev. Left undefined in dev, where
// both sides are localhost and host-scoped cookies already work.
const cookieDomain = process.env.COOKIE_DOMAIN?.trim() || undefined;

// Changes the session-cookie name, so a second control plane in the same
// cookie domain (staging under '.deployz.dev') cannot read this one's cookie.
// Build the web image with the same value as NEXT_PUBLIC_COOKIE_PREFIX, or the
// middleware looks for a cookie name the API never sets. Unset keeps Better
// Auth's default name.
const cookiePrefix = process.env.COOKIE_PREFIX?.trim() || undefined;

if (!process.env.BETTER_AUTH_SECRET) {
  console.warn(
    '[auth] BETTER_AUTH_SECRET not set — Better Auth will use an ephemeral dev secret. Set it in .env.',
  );
}
if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
  console.warn(
    '[auth] GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET not set — GitHub OAuth is configured with empty credentials and will fail until set.',
  );
}
if (!process.env.EMAIL_FROM) {
  console.warn(
    '[email] EMAIL_FROM not set — transactional email (team invitations, membership changes) is logged instead of sent. Set it in .env.',
  );
}
if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY) {
  console.warn(
    '[github] GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY not set — the GitHub App is not configured (installation-token vending + repo listing no-op). Set them in .env.',
  );
}
if (cookieDomain && !apiUrl.startsWith('https://')) {
  console.warn(
    `[auth] COOKIE_DOMAIN is set but API_URL is ${apiUrl} — domain-scoped cookies are marked Secure and browsers drop them over http.`,
  );
}

// The BILLING_ENFORCEMENT=off kill switch is loud at boot: a paused
// production gate must never be a silent state somebody forgets to undo.
if (process.env.BILLING_ENFORCEMENT === 'off') {
  console.warn(
    '[billing] BILLING_ENFORCEMENT=off — the production-deployment subscription gate is paused; every organization can deploy to production. Unset it to enforce again.',
  );
}

// Phase 5 Paddle billing. Optional at boot: an absent PADDLE_API_KEY only
// warns — every billing surface then reports BILLING_DISABLED (503) rather
// than crashing local dev or a fixture-mode test run. Once PADDLE_API_KEY IS
// set, the remaining four keys (plus PADDLE_ENVIRONMENT and the price id
// format) are validated strictly: missing configuration fails clearly at
// startup instead of silently no-oping against the wrong Paddle account.
const paddleApiKey = process.env.PADDLE_API_KEY;
const paddleWebhookSecret = process.env.PADDLE_WEBHOOK_SECRET;
const paddleClientToken = process.env.PADDLE_CLIENT_TOKEN;
const paddlePricePlatform = process.env.PADDLE_PRICE_PLATFORM;
const paddlePriceDeployment = process.env.PADDLE_PRICE_DEPLOYMENT;
const paddleEnvironment = process.env.PADDLE_ENVIRONMENT ?? 'sandbox';

if (!paddleApiKey) {
  console.warn(
    '[billing] PADDLE_API_KEY not set — billing is disabled; every billing surface reports BILLING_DISABLED. Set it in .env.',
  );
} else {
  if (!paddleWebhookSecret) {
    throw new Error(
      'PADDLE_API_KEY is set but PADDLE_WEBHOOK_SECRET is missing — set it in .env (Paddle billing requires both).',
    );
  }
  if (!paddleClientToken) {
    throw new Error(
      'PADDLE_API_KEY is set but PADDLE_CLIENT_TOKEN is missing — set it in .env (Paddle billing requires both).',
    );
  }
  if (!paddlePricePlatform) {
    throw new Error(
      'PADDLE_API_KEY is set but PADDLE_PRICE_PLATFORM is missing — set it in .env (Paddle billing requires both).',
    );
  }
  if (!paddlePriceDeployment) {
    throw new Error(
      'PADDLE_API_KEY is set but PADDLE_PRICE_DEPLOYMENT is missing — set it in .env (Paddle billing requires both).',
    );
  }
  if (!paddlePricePlatform.startsWith('pri_')) {
    throw new Error(`PADDLE_PRICE_PLATFORM must be a Paddle price id starting with "pri_"; got "${paddlePricePlatform}".`);
  }
  if (!paddlePriceDeployment.startsWith('pri_')) {
    throw new Error(`PADDLE_PRICE_DEPLOYMENT must be a Paddle price id starting with "pri_"; got "${paddlePriceDeployment}".`);
  }
  if (paddleEnvironment !== 'sandbox' && paddleEnvironment !== 'production') {
    throw new Error(`PADDLE_ENVIRONMENT must be "sandbox" or "production"; got "${paddleEnvironment}".`);
  }
}

// §16/§29 AI explanations. The resolution rules (all credentials required, the
// two secrets must differ) live in ai-config.ts so they are testable without
// mutating process.env.
function readAiGatewayConfig(): AiGatewayConfig | undefined {
  const { config, problem } = describeAiGatewayConfig(process.env);
  if (problem === 'missing') {
    console.warn(
      '[ai] AI_GATEWAY_BASE_URL/AI_PROVIDER_API_KEY not both set — AI explanations ' +
        'are disabled and diagnostics fall back to deterministic remediation ' +
        'guidance. Set them in .env. (AI_GATEWAY_TOKEN is only needed for a ' +
        'gateway with authentication switched on.)',
    );
  }
  if (problem === 'reused-secret') {
    console.warn(
      '[ai] AI_PROVIDER_API_KEY and AI_GATEWAY_TOKEN are identical — they authenticate ' +
        'different hops (the upstream provider and the gateway itself). AI explanations ' +
        'are disabled until they are set to their two distinct values.',
    );
  }
  return config;
}

// The fix-instructions model (ai-config.ts). A provider without its
// credentials leaves fix instructions unavailable; it never switches model.
const fixInstructionsAiResolution = describeFixInstructionsAiConfig(process.env);
if (fixInstructionsAiResolution.problem) {
  console.warn(
    `[ai] ${FIX_INSTRUCTIONS_AI_PROBLEMS[fixInstructionsAiResolution.problem]} — fix instructions are unavailable until it is configured.`,
  );
}

// Jev shadow-mode client (PR 1 foundation — nothing consumes it yet). Default
// OFF: JEV_ENABLED=true is required, and a partial URL/key configuration
// stays disabled with a warning (resolveJevConfig) rather than failing per
// request later.
function readJevConfig(): JevConfig {
  return resolveJevConfig(process.env);
}

export const env = {
  aiGateway: readAiGatewayConfig(),
  fixInstructionsAi: fixInstructionsAiResolution.config,
  fixInstructionsAiProblem: fixInstructionsAiResolution.problem,
  jev: readJevConfig(),
  apiPort,
  apiUrl,
  webUrl,
  marketingUrl,
  // Every browser origin allowed to call the API with credentials. Deduped
  // because dev (and any single-host deployment) has marketing === web.
  webOrigins: [...new Set([webUrl, marketingUrl])],
  cookieDomain,
  cookiePrefix,
  databaseUrl: process.env.DATABASE_URL,
  betterAuthSecret: process.env.BETTER_AUTH_SECRET,
  githubClientId: process.env.GITHUB_CLIENT_ID ?? '',
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
  githubAppId: process.env.GITHUB_APP_ID,
  githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY,
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  githubAppInstallUrl: process.env.GITHUB_APP_INSTALL_URL,
  emailFrom: process.env.EMAIL_FROM,
  sesAccessKeyId: process.env.AWS_SES_ACCESS_KEY_ID,
  sesSecretAccessKey: process.env.AWS_SES_SECRET_ACCESS_KEY,
  // Public HTTPS URL of the published bootstrap template. Written by the
  // publisher (`pnpm --filter @deployz/cdk run publish:bootstrap`) into the
  // control-plane stack's environment. Unset means no install link can be
  // handed out yet — GET /api/install/:id then returns quickCreateUrl null
  // and the install page says so, instead of pointing the customer at a
  // template that does not exist.
  bootstrapTemplateUrl: process.env.BOOTSTRAP_TEMPLATE_URL,
  // Build id of the published connector (the publisher's BOOTSTRAP_BUILD_ID).
  // Optional: when set, a deployment whose connector reports another build is
  // offered a customer-approved update to this version's immutable template.
  bootstrapBuildId: process.env.BOOTSTRAP_BUILD_ID || undefined,
  // Regions whose regional bootstrap artifacts are CONFIRMED published (the
  // publisher fans identical assets into `deployz-templates-<region>` per
  // region and verifies each before reporting success). Comma-separated.
  //
  // Fail-closed default: only `us-east-1` — the single region the legacy
  // single-bucket flow ever actually published. Until an operator runs the
  // per-region publisher and records the verified list here, every other
  // supported region is treated as unavailable: deployment creation rejects
  // it and the install link resolver never hands out a template for it.
  // See SUPPORTED_AWS_REGIONS + resolveBootstrapTemplate in @deployz/contracts.
  deployableAwsRegions: parseRegionList(process.env.DEPLOYABLE_AWS_REGIONS, ['us-east-1']),
  awsRegion: process.env.AWS_REGION ?? 'us-east-1',
  // The control-plane ECR repository customer task roles pull images from.
  // Created by the BuildPipeline (default `deployz-images`); the stack wires
  // the real name into the Lambda environment so a rename cannot drift.
  ecrRepositoryName: process.env.DEPLOYZ_ECR_REPOSITORY_NAME ?? 'deployz-images',
  // Prefix of the regional buckets each deployment's compiled template is
  // published into (`<prefix>-<region>`). Default `deployz-templates` is
  // production's own prefix; the stack wires the real name into the Lambda
  // environment so a rename cannot drift.
  templateBucketPrefix: process.env.DEPLOYZ_TEMPLATE_BUCKET_PREFIX?.trim() || 'deployz-templates',
  // The release build project's log group, read for failed-build evidence.
  // Unset (local, E2E) → build logs read as unavailable; nothing else changes.
  buildLogGroupName: process.env.BUILD_LOG_GROUP_NAME,
  // Phase 1 Cloudflare runtime config — the deployz.dev zone lives on
  // Cloudflare and is where the default-HTTPS flow writes each deployment's
  // DNS-validation and routing CNAMEs. Zone id/name are public; the API token
  // is a secret scoped to Zone.DNS edit on exactly this zone. All unset → the
  // Cloudflare flow stays OFF (a deployment then needs a custom domain for
  // HTTPS, exactly like before Phase 11).
  cloudflareZoneId: process.env.CLOUDFLARE_ZONE_ID,
  cloudflareZoneName: process.env.CLOUDFLARE_ZONE_NAME,
  // Prefix for the permanent d-<deployment-id>.deployz.dev URL scheme. The
  // plan's default is `d-`; override only to migrate the scheme away from it.
  defaultHostnamePrefix: process.env.DEPLOYZ_DEFAULT_HOSTNAME_PREFIX ?? 'd-',
  cloudflareZoneApiToken: process.env.CLOUDFLARE_ZONE_EDIT_API_TOKEN,
  githubFixtureMode:
    process.env.GITHUB_FIXTURE_MODE === 'true' || process.env.GITHUB_FIXTURE_MODE === '1',
  // Custom-domains MVP E2E fixture mode — see domain-check.ts's
  // createFixtureDomainCheckDeps. Mirrors githubFixtureMode.
  domainFixtureMode: process.env.DOMAIN_FIXTURE_MODE === 'true',
  // Phase 11 default HTTPS under DNS fixture mode. The automatic
  // default-HTTPS flow needs Cloudflare config in production; under the E2E
  // fixture environment there is no real zone, so it stays OFF unless this
  // explicit opt-in is set — the existing fixture suite (custom-domain,
  // app-url, deployment-progress…) is written against HTTP-only installs and
  // must not silently change behaviour.
  defaultHttpsFixtureMode: process.env.DEPLOYZ_DEFAULT_HTTPS_FIXTURE === 'true',
  // AI fixture mode — canned gateway responses so the E2E suite can drive
  // the fix-instructions flow without a live model. Mirrors githubFixtureMode.
  aiFixtureMode: process.env.AI_FIXTURE_MODE === 'true',
  // Build fixture mode — locally a release can never reach READY (BUILD_RELEASE
  // enqueues without JOB_QUEUE_URL configured and no-ops), so deploy/rollback
  // always 409. Marks a new release built immediately with a deterministic
  // fixture digest instead of enqueuing. Mirrors githubFixtureMode.
  buildFixtureMode: process.env.BUILD_FIXTURE_MODE === 'true',
  // Paddle migration Phase 7 fixture mode — every newly created organization
  // (signup's default tenant in auth.ts, and createOrganization in
  // organizations.ts) also gets a normal ACTIVE billing_subscriptions row, so
  // the simulated E2E suite's PRODUCTION-deployment scenarios exercise the
  // real entitlement gate (billing-entitlements.ts) instead of always
  // hitting 402 SUBSCRIPTION_REQUIRED. Also unlocks the fixture-only
  // POST /internal/fixture/billing/subscription route (server.ts), which
  // later phases use to drive past-due/canceled/evaluation UI scenarios.
  // Mirrors githubFixtureMode.
  billingFixtureMode: process.env.BILLING_FIXTURE_MODE === 'true',
  // Kill switch for the PRODUCTION-deployment subscription gate
  // (billing-entitlements.ts). BILLING_ENFORCEMENT=off lets every
  // organization deploy to production whatever its subscription status —
  // for an incident where Paddle state is wrong or unreachable and
  // customers must not be blocked. Any other value (including unset)
  // enforces. Nothing else in billing changes: webhooks, checkout,
  // reconciliation and the allowance counters all keep running.
  billingEnforcementPaused: process.env.BILLING_ENFORCEMENT === 'off',
  // The release-image registry (the control plane's own ECR repository) is
  // consulted only from the deployed Lambda: locally a release is either
  // fixture-built (BUILD_FIXTURE_MODE) or never READY, so the scriptable
  // fixture client stands in and no test or E2E run ever calls ECR.
  releaseImageRegistryEnabled: Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME),
  // Team Admin env-grant allowlist (comma-separated exact emails or
  // `*@domain` wildcards) — see apps/api/src/admin/auth.ts. Local dev/E2E
  // only; teamAdminEnvGrantsEnabled below shuts this off in production.
  teamAdminEmails: parseTeamAdminEmails(process.env.TEAM_ADMIN_EMAILS),
  // False whenever the process is the deployed Lambda, so env-based admin
  // grants can never take effect in production — only user.platform_role
  // can. Resolved once here (not read at call time) so it stays
  // test-injectable.
  teamAdminEnvGrantsEnabled: !process.env.AWS_LAMBDA_FUNCTION_NAME,
  // Phase 5 Paddle billing (see the validation block above). All undefined
  // when PADDLE_API_KEY is unset; otherwise the four companion keys are
  // guaranteed present and price ids are guaranteed to start with "pri_".
  paddleApiKey,
  paddleWebhookSecret,
  paddleClientToken,
  paddlePricePlatform,
  paddlePriceDeployment,
  paddleEnvironment: paddleEnvironment as 'sandbox' | 'production',
  // DEPLOY-027 (Phase 4): KMS key ARN used to encrypt at-rest secret values.
  // Unset in local dev and tests → the API falls back to the in-memory cipher
  // stub. In AWS Lambda it is required: createSecretCipherFromEnv throws
  // without it (docs/pending-secret-delivery.md).
  kmsKeyArn: process.env.DEPLOYZ_KMS_KEY_ARN,
} as const;
