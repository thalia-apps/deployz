/**
 * ECR pull-grant lifecycle, control-plane side.
 *
 * The vendor's private ECR repository lives in the control-plane account;
 * the customer's deployment stack runs in the customer's account. The relay
 * cannot touch the repository policy (no cross-account IAM in that direction),
 * and the customer account id is only known to the control plane — so the
 * grant/revoke calls happen here, next to the job lifecycle that owns them:
 *
 *   relay registration / retry-install → grantPullToCustomer
 *   DESTROY / PURGE / re-enrollment    → revokePullFromCustomer
 *
 * The policy grants pull access to every account that still has a live
 * (not DELETED) deployment, in one statement (see ecr-grants.ts). Both calls
 * rebuild it from the deployments table under one Postgres advisory lock, so
 * two concurrent writes cannot lose an account.
 *
 * A grant that cannot be applied throws a 503: the image pull would otherwise
 * fail later as the customer task's IMAGE_PULL_FAILED. A revoke is best-effort
 * and never throws: a revoke that cannot land leaves an over-broad grant the
 * owner knows about, never a broken caller.
 */

import { and, isNotNull, ne, sql } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { env } from './env.js';
import { createRealEcrClient, syncPullPolicy, type EcrClient } from './ecr-grants.js';
import { ApiError } from './errors.js';

export interface EcrPullGrantDeps {
  readonly db: RuntimeDb;
  readonly ecr: EcrClient;
  readonly repositoryName: string;
}

/** Local dev and simulated E2E: no policy exists and no write reaches AWS. */
const NO_OP_ECR_CLIENT: EcrClient = {
  async getRepositoryPolicy() {
    return null;
  },
  async setRepositoryPolicy() {},
  async deleteRepositoryPolicy() {},
};

/**
 * Production wiring: the real client only in the deployed Lambda (as for the
 * release-image registry in env.ts). Tests inject their own `ecr` client.
 */
export function createEcrPullGrantDeps(db: RuntimeDb, ecr?: EcrClient): EcrPullGrantDeps {
  return {
    db,
    ecr: ecr ?? (env.releaseImageRegistryEnabled ? createRealEcrClient() : NO_OP_ECR_CLIENT),
    repositoryName: env.ecrRepositoryName,
  };
}

/**
 * Rebuilds the policy from the accounts of all live deployments, plus
 * `grantAccountId`. The advisory transaction lock serializes every writer.
 */
async function syncPullGrants(deps: EcrPullGrantDeps, grantAccountId?: string) {
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'ecr-pull-grants'}))`);
    const rows = await tx
      .selectDistinct({ awsAccountId: schema.deployments.awsAccountId })
      .from(schema.deployments)
      .where(and(isNotNull(schema.deployments.awsAccountId), ne(schema.deployments.state, 'DELETED')));
    const accountIds = new Set(rows.map((row) => row.awsAccountId!));
    if (grantAccountId) accountIds.add(grantAccountId);
    return syncPullPolicy(deps.ecr, deps.repositoryName, [...accountIds]);
  });
}

/**
 * Grants the customer account pull access. Idempotent. Throws a 503
 * `ECR_GRANT_FAILED` when the policy cannot be written.
 */
export async function grantPullToCustomer(
  deps: EcrPullGrantDeps,
  customerAccountId: string,
): Promise<void> {
  try {
    const result = await syncPullGrants(deps, customerAccountId);
    console.log(JSON.stringify({ event: 'ecr:pull-granted', customerAccountId, ...result }));
  } catch (error) {
    console.error(
      JSON.stringify({ event: 'ecr:pull-grant-failed', customerAccountId, error: String(error) }),
    );
    throw new ApiError(
      503,
      'ECR_GRANT_FAILED',
      'Image access for the customer account could not be granted. Try again.',
    );
  }
}

/**
 * Drops the pull access of every account that has no live deployment left.
 * Idempotent and never throws.
 */
export async function revokePullFromCustomer(deps: EcrPullGrantDeps): Promise<void> {
  try {
    const result = await syncPullGrants(deps);
    console.log(JSON.stringify({ event: 'ecr:pull-revoked', ...result }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'ecr:pull-revoke-failed', error: String(error) }));
  }
}
