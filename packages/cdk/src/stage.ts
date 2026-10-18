/**
 * Stage-derived names for the control-plane stack.
 *
 * A second ("staging") control plane runs in the SAME AWS account and Region
 * as production, so every account-unique name must differ per stage: the
 * stack id, the config-secret KMS alias, the ECR repository and the prefix of
 * the regional template buckets.
 *
 * Each stage's names are written out in full, one literal record per stage.
 * An interpolated or suffixed name would compute PRODUCTION's names at run
 * time, so a mistake in the suffix logic renames a resource that is
 * `RemovalPolicy.RETAIN`: a renamed KMS key leaves every stored ciphertext
 * unreadable, and a renamed ECR repository leaves every stored image
 * unreachable. Written out, production's names cannot change by accident.
 */

/** The control-plane environments that can share one account and Region. */
export type DeployzStage = 'production' | 'staging';

/** The account-unique names one stage owns. */
export interface StageNames {
  /** CloudFormation stack id. */
  readonly stackId: string;
  /** Alias of the config-secret KMS key. */
  readonly kmsAlias: string;
  /** ECR repository the release build pushes images to. */
  readonly ecrRepositoryName: string;
  /**
   * Prefix of the regional template buckets (`<prefix>-<region>`).
   *
   * Staging uses `deployz-staging-templates`, NOT `deployz-templates-staging`:
   * the API Lambda's S3 statement in `deployz-stack.ts` is a wildcard on
   * `deployz-templates-*`, so a staging bucket under the `deployz-templates-`
   * prefix would stay inside production's grant. Neither of the two chosen
   * prefixes is a prefix of the other, in either direction.
   */
  readonly templateBucketPrefix: string;
}

const PRODUCTION_NAMES: StageNames = {
  stackId: 'Deployz',
  kmsAlias: 'alias/deployz-config-secrets',
  ecrRepositoryName: 'deployz-images',
  templateBucketPrefix: 'deployz-templates',
};

const STAGING_NAMES: StageNames = {
  stackId: 'DeployzStaging',
  kmsAlias: 'alias/deployz-staging-config-secrets',
  ecrRepositoryName: 'deployz-staging-images',
  templateBucketPrefix: 'deployz-staging-templates',
};

/**
 * Reads the stage from a context flag or an environment variable.
 *
 * An absent or blank value is `production` — the only stage that existed
 * before staging. Anything else that is not a known stage THROWS: a typo
 * must never silently deploy production's names.
 */
export function resolveStage(value: string | undefined): DeployzStage {
  const stage = value?.trim();
  if (stage === undefined || stage.length === 0) return 'production';
  if (stage === 'production' || stage === 'staging') return stage;
  throw new Error(`Unknown stage '${value}'. Use 'production' or 'staging'.`);
}

/** The names the given stage owns. */
export function stageNames(stage: DeployzStage): StageNames {
  return stage === 'staging' ? STAGING_NAMES : PRODUCTION_NAMES;
}
