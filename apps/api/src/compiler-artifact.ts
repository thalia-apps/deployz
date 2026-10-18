import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import {
  manifestToApplicationGraph,
  planApplicationGraph,
  buildDeploymentSpecV2,
} from '@deployz/analysis';
import {
  bootstrapTemplateBucketName,
  defaultCapabilityRegistry,
  defaultInfrastructureSizeProfile,
  type DeploymentManifest,
  type InfrastructureSizeProfile,
  type DeploymentSpecV2,
  type Region,
} from '@deployz/contracts';
import { compileDeployzInfrastructure } from '@deployz/infrastructure-compiler';

// Compiler-v2 provisioning intent (Phase 2): the manifest becomes an
// ApplicationGraph, the graph a DeployzIR, and the IR the frozen compiled
// artifact. The spec freezes the compiler's outputs (verification contract,
// ownership records, footprint) plus the artifact location; the template is
// published to the region's template bucket BEFORE the deployment row is
// written, content-addressed by template hash and never overwritten.

/** Object key prefix of the published compiled template artifact. */
export const COMPILER_ARTIFACT_KEY_PREFIX = 'compiler-v2';

/** Object key of a compiled template artifact, content-addressed by template hash. */
export function compilerArtifactKey(templateHash: string): string {
  return `${COMPILER_ARTIFACT_KEY_PREFIX}/${templateHash}.json`;
}

/** The deterministic public https URL of a published compiled artifact.
 *  `templateBucketPrefix` is optional — omitted it names production's own
 *  regional bucket, which is what every caller but the stage-aware creation
 *  path needs. */
export function compilerArtifactUrl(
  region: string,
  templateHash: string,
  templateBucketPrefix?: string,
): string {
  return `https://${bootstrapTemplateBucketName(region, templateBucketPrefix)}.s3.${region}.amazonaws.com/${compilerArtifactKey(templateHash)}`;
}

/** Everything the publisher needs to freeze one compiled template. */
export interface PublishTemplateInput {
  readonly region: Region;
  readonly bucket: string;
  readonly key: string;
  /** The exact template JSON string that was hashed. */
  readonly body: string;
}

/** Injectable publish seam — the no-op default keeps unit tests off AWS. */
export interface TemplatePublisher {
  publishTemplate(input: PublishTemplateInput): Promise<void>;
}

export const NO_OP_TEMPLATE_PUBLISHER: TemplatePublisher = {
  async publishTemplate() {},
};

/** The real publisher: conditional PutObject (IfNoneMatch '*') — no overwrite.
 *  A content-addressed artifact that already exists (same IR → same hash →
 *  same key) is the dedup path, not a failure: S3 answers 412
 *  PreconditionFailed and the stored object is byte-identical by
 *  construction, so the caller proceeds on the frozen artifact. */
export function createS3TemplatePublisher(): TemplatePublisher {
  return {
    async publishTemplate(input) {
      const client = new S3Client({ region: input.region });
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: input.bucket,
            Key: input.key,
            Body: input.body,
            ContentType: 'application/json',
            IfNoneMatch: '*',
          }),
        );
      } catch (error) {
        if ((error as { name?: string }).name !== 'PreconditionFailed') throw error;
      } finally {
        client.destroy();
      }
    },
  };
}

/** The publish input for one deployment creation (bucket/key/body + region). */
export function compilerArtifactPublishInput(
  region: Region,
  templateHash: string,
  body: string,
  templateBucketPrefix?: string,
): PublishTemplateInput {
  return {
    region,
    bucket: bootstrapTemplateBucketName(region, templateBucketPrefix),
    key: compilerArtifactKey(templateHash),
    body,
  };
}

/** The compiler output that completes one spec, plus the template to publish. */
export interface CompiledDeploymentIntent {
  readonly spec: DeploymentSpecV2;
  readonly template: Record<string, unknown>;
  readonly templateHash: string;
}

/**
 * The one-shot creation path: manifest → graph → IR → compiled artifact →
 * completed spec. Pure — publishing is a separate step so callers can order
 * it before their DB write.
 */
export function compileDeploymentIntent(input: {
  manifest: DeploymentManifest;
  region: Region;
  sizeProfile?: InfrastructureSizeProfile;
  /** Omitted names production's own regional bucket. */
  templateBucketPrefix?: string;
}): CompiledDeploymentIntent {
  const sizeProfile = input.sizeProfile ?? defaultInfrastructureSizeProfile();
  const graph = manifestToApplicationGraph(input.manifest);
  const ir = planApplicationGraph({ graph, region: input.region, sizeProfile });
  const compilation = compileDeployzInfrastructure({ ir, region: input.region, sizeProfile });
  const spec = buildDeploymentSpecV2({
    graph,
    ir,
    sizeProfileId: sizeProfile.id,
    capabilityRegistryVersion: defaultCapabilityRegistry().version,
    compilation: {
      compilerVersion: compilation.artifact.compilerVersion,
      templateHash: compilation.artifact.templateHash,
      artifactLocation: compilerArtifactUrl(
        input.region,
        compilation.artifact.templateHash,
        input.templateBucketPrefix,
      ),
      verificationContract: compilation.verificationContract,
      ownershipRecords: compilation.ownershipRecords,
      footprint: compilation.footprint,
    },
  });
  return { spec, template: compilation.template, templateHash: compilation.artifact.templateHash };
}
