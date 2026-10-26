/**
 * The application's own public URL. An app that needs `APP_URL`, `BASE_URL`
 * or `NEXTAUTH_URL` needs the address it is served from. Deployz owns that
 * address (`https://d-<deploymentId>.deployz.dev`), so it supplies the value
 * and nobody has to type it. The classifier and the relay config read both
 * use these two functions, so they always agree.
 */

import type { ManifestEnvVariable } from '@deployz/contracts';

import {
  CLIENT_BUILD_PREFIX_REGEX,
  CLIENT_DIRECTORY_REGEX,
  OWN_URL_NAME_REGEX,
  SAMPLE_PATH_EVIDENCE,
} from './detectors.js';

/** `<APP>_PUBLIC_URL`, `<APP>_BASE_URL`, `<APP>_APP_URL`, `<APP>_SITE_URL`, `<APP>_ROOT_URL`, `<APP>_EXTERNAL_URL`, also as one word (`<APP>_SERVICE_PUBLICURL`). */
const APP_PREFIXED_URL_NAME_REGEX = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:PUBLIC|BASE|APP|SITE|ROOT|EXTERNAL)_?URL$/;

/** A third-party service or backing resource: its URL is never this app's own address. */
const PROVIDER_PREFIX_REGEX =
  /^(?:OPENAI|ANTHROPIC|AZURE|AWS|S3|GCP|GOOGLE|STRIPE|SLACK|GITHUB|GITLAB|SENTRY|POSTHOG|SMTP|MAIL|SES|REDIS|DATABASE|DB|POSTGRES|MYSQL|MONGO|KAFKA|OLLAMA|LLM|API|OAUTH|OIDC|SAML|LDAP|SUPABASE|FIREBASE|CLOUDFLARE|TWILIO|SENDGRID|MEILI|MEILISEARCH|ELASTIC|ELASTICSEARCH|MINIO|SPACES|CDN|UPSTASH|CLERK|AUTH0|OKTA|VERCEL|DISCORD|GRAVATAR|SEARCH)_/;

/** The variable is the app's own public URL, and the app needs a value for it. */
export function isDerivedUrlEnvVariable(variable: ManifestEnvVariable): boolean {
  const { key } = variable;
  const named =
    OWN_URL_NAME_REGEX.test(key) ||
    (APP_PREFIXED_URL_NAME_REGEX.test(key) && !PROVIDER_PREFIX_REGEX.test(key) && !CLIENT_BUILD_PREFIX_REGEX.test(key));
  if (!variable.required || !named || variable.source.includes(SAMPLE_PATH_EVIDENCE)) return false;
  const readFiles = variable.source.filter((entry) => entry.startsWith('read in ')).map((entry) => entry.slice(8));
  return readFiles.some((file) => !CLIENT_DIRECTORY_REGEX.test(file));
}

/** The value Deployz supplies: the deployment's default HTTPS URL, or null when it supplies none. */
export function derivedUrlEnvValue(variable: ManifestEnvVariable, deploymentUrl: string): string | null {
  return isDerivedUrlEnvVariable(variable) ? deploymentUrl : null;
}
