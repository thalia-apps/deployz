/**
 * The GitHub App private key, read once per container.
 *
 * Lambda caps a function's environment variables at 4 KB, and the PEM alone
 * is most of that, so the stack stores the key in Secrets Manager and passes
 * GITHUB_APP_PRIVATE_KEY_SECRET_ARN instead. Without that variable (local
 * runs) the key comes from GITHUB_APP_PRIVATE_KEY as before.
 *
 * GITHUB_APP_PRIVATE_KEY is set as a side effect, the same as connectDb sets
 * DATABASE_URL: the worker reads it from process.env.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

let keyPromise: Promise<string | undefined> | null = null;

export function loadGithubAppPrivateKey(): Promise<string | undefined> {
  keyPromise ??= (async () => {
    const secretArn = process.env.GITHUB_APP_PRIVATE_KEY_SECRET_ARN;
    if (!secretArn) return process.env.GITHUB_APP_PRIVATE_KEY;
    const response = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    if (response.SecretString) process.env.GITHUB_APP_PRIVATE_KEY = response.SecretString;
    return response.SecretString;
  })().catch((error: unknown) => {
    // A failed read is retried by the next invocation, not cached.
    keyPromise = null;
    throw error;
  });
  return keyPromise;
}
