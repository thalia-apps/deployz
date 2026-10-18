/**
 * Hard safety invariants for the customer-reset admin tool.
 *
 * This module is the last line of defense before anything destructive runs:
 * the hardcoded control-plane inventory nothing may ever match
 * (`buildProtectedInventory` / `assertNoOverlap`), the explicit confirmation
 * gate for `execute` (`requireConfirmToken` — no bypass flag), and the single
 * ownership rule every deletion in this tool must satisfy
 * (`isOwnedByInstallation`): a `deployz:installation` tag, membership in a
 * stack whose name AND tag/InstallationId match a manifest deployment, or a
 * DB-mapped `physical_resource_id`. A resource's name or prefix alone is
 * NEVER sufficient proof of ownership.
 */

// ── Protected control-plane inventory ───────────────────────────────────────
// This script cannot import @deployz/cdk, so the stage names below repeat the
// literals in packages/cdk/src/stage.ts.

export interface ProtectedInventory {
  readonly stackNames: ReadonlySet<string>;
  readonly bucketNamePatterns: readonly RegExp[];
  readonly ecrRepositoryNames: ReadonlySet<string>;
}

const PROTECTED_STACK_NAMES = ['Deployz', 'DeployzStaging', 'CDKToolkit'] as const;

/** Bucket-name prefixes the production and staging control-plane stacks
 * provision — see deployz-stack.ts and stage.ts. */
const PROTECTED_BUCKET_PATTERNS = [
  /^deployz-buildsourcebucket/i,
  /^deployz-templatebucket/i,
  /^deployz-templates-/i,
  /^deployzstaging-buildsourcebucket/i,
  /^deployzstaging-templatebucket/i,
  /^deployz-staging-templates-/i,
  /^cdk-/i,
] as const;

const PROTECTED_ECR_REPOSITORIES = ['deployz-images', 'deployz-staging-images'] as const;

export function buildProtectedInventory(): ProtectedInventory {
  return {
    stackNames: new Set(PROTECTED_STACK_NAMES),
    bucketNamePatterns: PROTECTED_BUCKET_PATTERNS,
    ecrRepositoryNames: new Set(PROTECTED_ECR_REPOSITORIES),
  };
}

export interface DeletionCandidate {
  readonly kind: 'stack' | 'bucket' | 'ecr-repository' | 'other';
  readonly name: string;
  /** The `aws:cloudformation:stack-name` tag value, when the resource carries one. */
  readonly cloudformationStackName?: string;
}

/**
 * Throws the moment any deletion candidate matches the hardcoded
 * control-plane invariants — the 'Deployz', 'DeployzStaging' and 'CDKToolkit'
 * stacks, anything tagged as belonging to one of them, the build-source and
 * template buckets of both stages, the `cdk-*` bootstrap buckets, or the
 * `deployz-images` and `deployz-staging-images` ECR repositories.
 */
export function assertNoOverlap(
  candidates: readonly DeletionCandidate[],
  protectedInventory: ProtectedInventory,
): void {
  for (const candidate of candidates) {
    if (candidate.kind === 'stack' && protectedInventory.stackNames.has(candidate.name)) {
      throw new Error(
        `Refusing to proceed: "${candidate.name}" is a protected control-plane stack`,
      );
    }
    if (
      candidate.cloudformationStackName !== undefined &&
      protectedInventory.stackNames.has(candidate.cloudformationStackName)
    ) {
      throw new Error(
        `Refusing to proceed: "${candidate.name}" belongs to protected stack "${candidate.cloudformationStackName}"`,
      );
    }
    if (
      candidate.kind === 'bucket' &&
      protectedInventory.bucketNamePatterns.some((pattern) => pattern.test(candidate.name))
    ) {
      throw new Error(
        `Refusing to proceed: "${candidate.name}" matches a protected bucket name pattern`,
      );
    }
    if (
      candidate.kind === 'ecr-repository' &&
      protectedInventory.ecrRepositoryNames.has(candidate.name)
    ) {
      throw new Error(`Refusing to proceed: "${candidate.name}" is a protected ECR repository`);
    }
  }
}

// ── Account guard ────────────────────────────────────────────────────────────

/** The test AWS account this tool refuses to run outside of — the same
 * default the version canary uses (`DEPLOYZ_CANARY_EXPECTED_ACCOUNT`,
 * `scripts/version-canary/config.ts`). */
export const DEFAULT_EXPECTED_ACCOUNT = '151955775369';

export function expectedAccountId(env: NodeJS.ProcessEnv = process.env): string {
  return env['DEPLOYZ_CANARY_EXPECTED_ACCOUNT'] ?? DEFAULT_EXPECTED_ACCOUNT;
}

export interface CallerIdentityReader {
  getCallerIdentity(): Promise<{ account: string }>;
}

/** The pure comparison `requireExpectedAccount` runs — split out so the
 * inline self-check below can exercise it without a fake async client. */
export function assertAccountMatches(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(
      `AWS account ${actual || 'unknown'} is not the expected test account ${expected} — refusing to run customer-reset`,
    );
  }
}

/**
 * Hard-fails unless the caller identity's account matches the expected test
 * account — this tool wipes every customer deployment it finds, so running
 * it against the wrong AWS account would be catastrophic. There is no
 * `--reuse-stack`-style override: the account is read fresh, every run.
 */
export async function requireExpectedAccount(
  sts: CallerIdentityReader,
  expected: string = expectedAccountId(),
): Promise<string> {
  const identity = await sts.getCallerIdentity();
  assertAccountMatches(identity.account, expected);
  return identity.account;
}

// ── Confirmation gate ────────────────────────────────────────────────────────

export const CONFIRM_TOKEN = 'FULL-CUSTOMER-RESET';

/**
 * Hard-fails unless `--confirm FULL-CUSTOMER-RESET` is present in argv.
 * There is deliberately no bypass/force flag — the token must be typed.
 */
export function requireConfirmToken(argv: readonly string[]): void {
  const flagIndex = argv.indexOf('--confirm');
  const token = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  if (token !== CONFIRM_TOKEN) {
    throw new Error(
      `Refusing to execute: pass --confirm ${CONFIRM_TOKEN} to run the destructive customer reset`,
    );
  }
}

// ── Ownership gate ───────────────────────────────────────────────────────────

export interface OwnershipEvidence {
  /** The resource/stack's own `deployz:installation` tag value, if readable. */
  readonly taggedInstallationId?: string | undefined;
  /** True when the resource's stack name AND tag/InstallationId both match a manifest deployment. */
  readonly stackMatchesManifest?: boolean | undefined;
  /** True when a `deployment_resources` row maps this exact `physical_resource_id`. */
  readonly dbMappedPhysicalId?: boolean | undefined;
}

/**
 * The single ownership gate every deletion in this tool passes through
 * before it touches AWS. A resource's name or prefix (e.g. "it starts with
 * deployz-app-") is NEVER, on its own, sufficient — one of the three
 * positive proofs below must hold.
 */
export function isOwnedByInstallation(evidence: OwnershipEvidence, installationId: string): boolean {
  if (evidence.taggedInstallationId !== undefined) {
    return evidence.taggedInstallationId === installationId;
  }
  if (evidence.dbMappedPhysicalId === true) return true;
  if (evidence.stackMatchesManifest === true) return true;
  return false;
}

// ── Tag-based protection (belt-and-suspenders) ───────────────────────────────

/**
 * Pure predicate: returns true when a resource's tags include
 * `DeployzPersistent=true` or `DeployzProtected=true`. This is an
 * independent protection layer — even if the manifest-based check
 * somehow misses a resource, the tag-based guard will block its deletion.
 */
export function isProtectedByTags(tags: Record<string, string>): boolean {
  return tags['DeployzPersistent'] === 'true' || tags['DeployzProtected'] === 'true';
}

export interface BlockedEntry {
  readonly name: string;
  readonly reason: string;
}

// ── Inline self-check ────────────────────────────────────────────────────────
// The vitest workspace does not cover scripts/customer-reset, so this
// inline validation confirms the predicate logic at module load time.

function _validatePredicate(): void {
  const protectedTags = { DeployzPersistent: 'true', DeployzTestMode: 'canary' };
  const protectedTags2 = { DeployzProtected: 'true', Environment: 'e2e' };
  const safeTags = { Environment: 'prod', deployz: 'installation' };
  const emptyTags: Record<string, string> = {};

  if (!isProtectedByTags(protectedTags)) throw new Error('safety: DeployzPersistent=true not detected');
  if (!isProtectedByTags(protectedTags2)) throw new Error('safety: DeployzProtected=true not detected');
  if (isProtectedByTags(safeTags)) throw new Error('safety: safe tags falsely flagged as protected');
  if (isProtectedByTags(emptyTags)) throw new Error('safety: empty tags falsely flagged as protected');

  console.debug('[safety] tag-predicate self-check passed');
}

function _validateAccountGuard(): void {
  assertAccountMatches('151955775369', '151955775369'); // must not throw

  let refused = false;
  try {
    assertAccountMatches('000000000000', '151955775369');
  } catch {
    refused = true;
  }
  if (!refused) throw new Error('safety: account guard accepted a mismatched account');

  console.debug('[safety] account-guard self-check passed');
}

_validatePredicate();
_validateAccountGuard();
