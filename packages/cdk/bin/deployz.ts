/**
 * CDK app entrypoint for the Deployz control-plane stack.
 *
 * Loads the repo-root .env explicitly because pnpm --filter runs cdk with
 * cwd=packages/cdk, so dotenv's default ./.env lookup would miss the root.
 * The lookup walks up rather than counting '..' hops, so it also resolves
 * from a git worktree (which never gets a copy of the gitignored .env).
 */
import { config } from 'dotenv';

import { findEnvFile, moduleDirectory } from '@deployz/api/find-env-file';

import { App } from 'aws-cdk-lib';
import { checkDeployGate } from '../src/deploy-gate.js';
import { DeployzStack } from '../src/deployz-stack.js';
import { resolveStage, stageNames } from '../src/stage.js';

const envFile = findEnvFile(moduleDirectory(import.meta.url));
if (envFile) {
  config({ path: envFile });
  // .env.production sits next to .env and wins over it. .env holds the
  // localhost defaults local development needs, while DeployzStack builds the
  // deployed Lambda's environment from these files alone — so without this a
  // deploy pushes localhost origins into production and, with API_DOMAIN_NAME
  // unset, deletes the api.deployz.dev mapping. The file is absent on a
  // machine that only develops locally, which makes this a no-op there.
  config({ path: `${envFile}.production`, override: true });
}

const app = new App();

// Refuse to run at all outside CI. The CDK CLI tells the app nothing about
// which command invoked it — no CDK_* variable names `synth` vs `deploy` — so
// this necessarily gates all three, and `-c local=true` is how synth and diff
// stay usable. That flag would also let a deliberate deploy through; the
// failure mode being closed here is habit, not intent.
const gate = checkDeployGate({
  env: process.env,
  allowLocal: app.node.tryGetContext('local') !== undefined,
});
if (!gate.allowed) {
  throw new Error(gate.reason);
}

// `-c stage=staging` or DEPLOYZ_STAGE lets a caller deploy the staging
// control plane, whose stack id and account-unique resource names differ from
// production's (see src/stage.ts). Defaults to the unchanged production names
// when unset, and throws on an unknown stage rather than deploying those names
// by accident.
const stage = resolveStage(
  (app.node.tryGetContext('stage') as string | undefined) ?? process.env.DEPLOYZ_STAGE,
);

new DeployzStack(app, stageNames(stage).stackId, { stage });
