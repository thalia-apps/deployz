// Shared between scripts/e2e.mjs (the runner) and playwright.config.ts (the
// API webServer's own env build) so simulated-mode E2E cannot inherit real
// AWS credentials, the control-plane job queue, or SES/email config from the
// developer's shell — even when playwright.config.ts is invoked directly,
// bypassing the runner (docs/testing/simulated-e2e.md D3).
export const SCRUB_ENV_VARS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'JOB_QUEUE_URL',
  // Email/SES config read by apps/api/src/env.ts.
  'EMAIL_FROM',
  'AWS_SES_ACCESS_KEY_ID',
  'AWS_SES_SECRET_ACCESS_KEY',
];

/**
 * Returns a copy of `sourceEnv` with every var in SCRUB_ENV_VARS set to an
 * empty string, plus the list of vars that held a value. The empty string is
 * deliberate: the API's dotenv load fills only unset names, so an unset name
 * would be filled from a parent checkout's .env. Every reader treats "" as
 * not configured.
 */
export function scrubEnv(sourceEnv) {
  const env = { ...sourceEnv };
  const scrubbed = [];
  for (const key of SCRUB_ENV_VARS) {
    if (env[key]) scrubbed.push(key);
    env[key] = '';
  }
  return { env, scrubbed };
}
