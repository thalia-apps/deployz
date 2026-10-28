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
import type { FastifyInstance } from 'fastify';

import { buildServer } from '@deployz/api/server';
import { createAuth } from '@deployz/api/auth';

import { toInjectOptions, toLambdaResult } from './api-gateway-adapter.js';
import { connectDb } from './db-connection.js';
import { loadGithubAppPrivateKey } from './github-app-key.js';

let appPromise: Promise<FastifyInstance> | null = null;

function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    appPromise = (async () => {
      const db = await connectDb();
      const auth = createAuth(db);
      // env.ts is read at import, before the key is loaded, so it is passed
      // in. A failed read leaves only the GitHub features unconfigured.
      const githubAppPrivateKey = await loadGithubAppPrivateKey().catch((error: unknown) => {
        console.error(JSON.stringify({ event: 'github:app-key-unavailable', error: String(error) }));
        return undefined;
      });
      const app = await buildServer({ auth, db, githubAppPrivateKey });
      await app.ready();
      return app;
    })();
  }
  return appPromise;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const app = await getApp();
  const response = await app.inject(toInjectOptions(event));
  return toLambdaResult(response);
}
