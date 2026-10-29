/**
 * ECR cross-account pull grant lifecycle.
 *
 * The control plane owns a private ECR repository. Customer accounts need
 * cross-account pull access to deploy images. This module provides pure
 * functions for building the ECR repository policy, plus an injectable client
 * interface for applying it at runtime.
 *
 * The policy holds ONE pull statement (`deployz-pull`). Its principals are the
 * de-duplicated account root ARNs of the customer accounts (self-reported at
 * registration; no STS verification) that still have a live deployment. One
 * statement per installation would reach the 10,240-character policy limit at
 * about 44 installations. `syncPullPolicy` rewrites the whole statement from
 * the wanted account list, so a grant, a revoke and the absorption of the older
 * per-installation statements (`deployz-pull-<installation id>`) are one write.
 *
 * AWS-BLOCKED replaced — the real `EcrClient` implementation delegates to the
 * SDK v3. The `EcrClient` interface follows the same injectable-seam pattern as
 * `S3Client` (quick-create) and `AwsClients` (integration).
 */

import {
  ECRClient as SdkEcrClient,
  GetRepositoryPolicyCommand,
  SetRepositoryPolicyCommand,
  DeleteRepositoryPolicyCommand,
} from '@aws-sdk/client-ecr';

// ---------------------------------------------------------------------------
// ECR pull actions
// ---------------------------------------------------------------------------

/** Actions required for a customer account to pull an image from ECR. */
export const ECR_PULL_ACTIONS = [
  'ecr:BatchGetImage',
  'ecr:GetDownloadUrlForLayer',
  'ecr:BatchCheckLayerAvailability',
] as const;

// ---------------------------------------------------------------------------
// ECR client interface (injectable seam — real impl PENDING-AWS)
// ---------------------------------------------------------------------------

export interface EcrPolicy {
  /** The JSON policy document as a parsed object. */
  readonly policyText: Record<string, unknown>;
  /** S3-style ETag for optimistic locking (used by setRepositoryPolicy). */
  readonly policyRevision?: string | undefined;
}

export interface EcrClient {
  /** Gets the current repository policy (returns null if no policy exists). */
  getRepositoryPolicy(repositoryName: string): Promise<EcrPolicy | null>;
  /** Sets the repository policy (overwrites existing). */
  setRepositoryPolicy(
    repositoryName: string,
    policyText: Record<string, unknown>,
  ): Promise<void>;
  /** Deletes the repository policy entirely. */
  deleteRepositoryPolicy(repositoryName: string): Promise<void>;
}

const sdkEcr = new SdkEcrClient({});

export function createRealEcrClient(): EcrClient {
  return {
    async getRepositoryPolicy(repositoryName) {
      try {
        const result = await sdkEcr.send(
          new GetRepositoryPolicyCommand({ repositoryName }),
        );
        return {
          policyText: JSON.parse(result.policyText ?? '{}') as Record<string, unknown>,
        };
      } catch (error: unknown) {
        if (
          error !== null &&
          typeof error === 'object' &&
          'name' in error &&
          error.name === 'RepositoryPolicyNotFoundException'
        ) {
          return null;
        }
        throw error;
      }
    },
    async setRepositoryPolicy(repositoryName, policyText) {
      await sdkEcr.send(
        new SetRepositoryPolicyCommand({
          repositoryName,
          policyText: JSON.stringify(policyText),
        }),
      );
    },
    async deleteRepositoryPolicy(repositoryName) {
      try {
        await sdkEcr.send(
          new DeleteRepositoryPolicyCommand({ repositoryName }),
        );
      } catch (error: unknown) {
        if (
          error !== null &&
          typeof error === 'object' &&
          'name' in error &&
          error.name === 'RepositoryPolicyNotFoundException'
        ) {
          return;
        }
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pure functions — policy construction
// ---------------------------------------------------------------------------

export interface EcrGrantStatement {
  readonly Sid: string;
  readonly Effect: 'Allow';
  readonly Principal: { readonly AWS: string | readonly string[] };
  readonly Action: readonly string[];
  readonly Condition?: Record<string, Record<string, string>> | undefined;
}

type AwsPolicyDocument = {
  readonly Version: string;
  readonly Statement: readonly EcrGrantStatement[];
};

/** Sid of the one pull statement. */
export const PULL_GRANT_SID = 'deployz-pull';

/** Sid prefix of the older per-installation statements (`deployz-pull-<id>`). */
const LEGACY_PULL_SID_PREFIX = 'deployz-pull-';

/** ECR rejects a repository policy larger than this many characters. */
export const ECR_POLICY_MAX_CHARS = 10_240;

function isPullGrantStatement(statement: EcrGrantStatement): boolean {
  return (
    statement.Sid === PULL_GRANT_SID ||
    (typeof statement.Sid === 'string' && statement.Sid.startsWith(LEGACY_PULL_SID_PREFIX))
  );
}

/**
 * Builds the one pull statement for a list of customer account ids. The
 * principals are de-duplicated and sorted, so equal inputs give equal output.
 */
export function buildPullStatement(accountIds: readonly string[]): EcrGrantStatement {
  const arns = [...new Set(accountIds.map((id) => `arn:aws:iam::${id}:root`))].sort();
  return {
    Sid: PULL_GRANT_SID,
    Effect: 'Allow',
    Principal: { AWS: arns },
    Action: [...ECR_PULL_ACTIONS],
  };
}

/**
 * Builds a full ECR repository policy document from a list of statements.
 * Returns null if the statement list is empty (no policy needed).
 */
export function buildRepoPolicyDocument(
  statements: readonly EcrGrantStatement[],
): AwsPolicyDocument | null {
  if (statements.length === 0) {
    return null;
  }
  return {
    Version: '2012-10-17',
    Statement: statements,
  };
}

/**
 * Returns the statements with every pull statement (the one statement and the
 * older per-installation ones) replaced by one statement for `accountIds`.
 * Other statements stay as they are. No accounts means no pull statement.
 */
export function replacePullStatements(
  statements: readonly EcrGrantStatement[],
  accountIds: readonly string[],
): EcrGrantStatement[] {
  const others = statements.filter((statement) => !isPullGrantStatement(statement));
  return accountIds.length === 0 ? others : [...others, buildPullStatement(accountIds)];
}

// ---------------------------------------------------------------------------
// Policy write — read-modify-write with the client
// ---------------------------------------------------------------------------

export interface SyncPullPolicyResult {
  readonly changed: boolean;
  readonly accountCount: number;
  readonly policyDeleted: boolean;
}

/**
 * Makes the repository policy grant pull access to exactly `accountIds`.
 *
 * Reads the current policy, replaces its pull statements (see
 * `replacePullStatements`) and writes the result only when it differs. An
 * empty result deletes the policy. A policy over the ECR size limit is
 * refused before the write.
 *
 * The caller must serialize calls: this is a read-modify-write.
 */
export async function syncPullPolicy(
  client: EcrClient,
  repositoryName: string,
  accountIds: readonly string[],
): Promise<SyncPullPolicyResult> {
  const current = await client.getRepositoryPolicy(repositoryName);
  const currentStatements: readonly EcrGrantStatement[] = current
    ? ((current.policyText as AwsPolicyDocument).Statement ?? [])
    : [];
  const accountCount = new Set(accountIds).size;

  const next = replacePullStatements(currentStatements, accountIds);
  if (JSON.stringify(next) === JSON.stringify(currentStatements)) {
    return { changed: false, accountCount, policyDeleted: false };
  }

  const doc = buildRepoPolicyDocument(next);
  if (!doc) {
    await client.deleteRepositoryPolicy(repositoryName);
    return { changed: true, accountCount, policyDeleted: true };
  }

  if (JSON.stringify(doc).length > ECR_POLICY_MAX_CHARS) {
    throw new Error(
      `ECR repository policy would exceed ${ECR_POLICY_MAX_CHARS} characters with ${accountCount} accounts`,
    );
  }
  await client.setRepositoryPolicy(repositoryName, doc);
  return { changed: true, accountCount, policyDeleted: false };
}
