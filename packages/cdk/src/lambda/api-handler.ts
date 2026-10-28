/**
 * Lambda handler for the Deployz Fastify API.
 *
 * This is the entry point bundled by esbuild (NodejsFunction). It imports
 * the Fastify app from @deployz/api and uses app.inject() to handle API
 * Gateway v2 events — no HTTP server needed inside Lambda.
 *
 * The Fastify instance is cached across warm invocations (module-level
 * singleton). Cold starts pay the full bootstrap cost once.
 *
 * DB credentials, the bundled drizzle migrations and the pooled drizzle
 * instance all come from db-connection.ts, shared with the worker Lambda so
 * the two can never disagree about the schema.
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { FastifyInstance } from 'fastify';

import { toInjectOptions, toLambdaResult } from './api-gateway-adapter.js';
import { connectDb } from './db-connection.js';

let appPromise: Promise<FastifyInstance> | null = null;

function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    appPromise = (async () => {
      await loadGithubAppPrivateKey();
      // Imported only now: the API reads its configuration when it loads.
      const [{ buildServer }, { createAuth }] = await Promise.all([
        import('@deployz/api/server'),
        import('@deployz/api/auth'),
      ]);
      const db = await connectDb();
      const auth = createAuth(db);
      const app = await buildServer({ auth, db });
      await app.ready();
      return app;
    })();
  }
  return appPromise;
}

// The key is kept out of the Lambda environment (api-lambda.ts), so it comes
// from its secret.
async function loadGithubAppPrivateKey(): Promise<void> {
  const secretArn = process.env.GITHUB_APP_PRIVATE_KEY_SECRET_ARN;
  if (!secretArn) return;
  const secret = await new SecretsManagerClient({}).send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  if (secret.SecretString) process.env.GITHUB_APP_PRIVATE_KEY = secret.SecretString;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const app = await getApp();
  const response = await app.inject(toInjectOptions(event));
  return toLambdaResult(response);
}
