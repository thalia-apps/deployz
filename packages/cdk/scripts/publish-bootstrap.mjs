/**
 * Publishes the customer bootstrap template to EVERY supported region.
 *
 * Synthesizes the bootstrap stack ONCE, then repacks a separate template per
 * region so every Lambda `Code.S3Bucket` points at that region's own public
 * bucket (`deployz-templates-<region>`), ZIPs the Lambda assets once, and
 * uploads the identical asset bytes + regional template into each regional
 * bucket. Every region is verified after publishing (bucket region, template
 * + asset presence, `Code.S3Bucket` match, URL reachability, and
 * CloudFormation `ValidateTemplate`); publishing FAILS if any region fails
 * verification — a partially published set would silently leave some regions
 * broken with an S3 `PermanentRedirect` on stack creation.
 *
 * Why per region: a Lambda must read its code from a bucket in its OWN
 * region. A single us-east-1 bucket referenced from a us-east-2 stack fails
 * Lambda creation with `PermanentRedirect` (verified in production).
 *
 * Bucket prerequisite: each `deployz-templates-<region>` bucket must already
 * exist with public read access before this script runs — the publisher
 * verifies, it does not create. Verification fails (and publishing aborts)
 * for any region whose bucket is missing, in the wrong region, or missing
 * objects, so a broken region can never be half-published.
 *
 * Environment (region targeting):
 *   BOOTSTRAP_PUBLISH_REGIONS
 *                         comma-separated region list to publish. Defaults to
 *                         every supported region (current behaviour).
 *                         Publishing to a region other than us-east-1
 *                         requires that region's `deployz-templates-<region>`
 *                         bucket to already exist.
 *   BOOTSTRAP_LEGACY_BUCKET_REGION
 *                         when set to `us-east-1`, that region publishes into
 *                         the resolved `TEMPLATE_BUCKET` (the legacy
 *                         control-plane bucket) instead of
 *                         `deployz-templates-us-east-1`. Unset by default.
 *
 * Production recipe (publish the one region the control plane actually
 * deploys to today, into the legacy bucket its API Lambda already points
 * at):
 *   BOOTSTRAP_PUBLISH_REGIONS=us-east-1 BOOTSTRAP_LEGACY_BUCKET_REGION=us-east-1 pnpm --filter @deployz/cdk run publish:bootstrap
 *
 * Until this has run, no install link can be handed to a customer in any
 * non-default region: the control plane's `DEPLOYABLE_AWS_REGIONS` is unset,
 * so deployment creation rejects those regions and the install link resolver
 * never hands out a template for them. That is deliberate — a link to a
 * template CloudFormation cannot fetch fails inside the customer's own
 * console with nothing they can act on.
 *
 * Requires `pnpm build` first (imports the compiled @deployz/cdk dist).
 * Usage:
 *   pnpm --filter @deployz/cdk run publish:bootstrap
 *
 * Environment:
 *   TEMPLATE_BUCKET       legacy us-east-1 bucket the bootstrap template
 *                         publishes into. Defaults to the
 *                         `<stack>-TemplateBucket` output of the deployed
 *                         control plane stack (read via CloudFormation).
 *   API_URL               control-plane URL baked into every link.
 *   BOOTSTRAP_BUILD_ID    build identity the relay reports and the immutable
 *                         template copy is keyed by. Defaults to the content
 *                         hash of the template (`bootstrap:build-id`).
 *   AWS_REGION            region of the legacy bucket.
 *   TEMPLATE_BUCKET_PREFIX
 *                         prefix of the regional buckets to publish into
 *                         (`<prefix>-<region>`). Set it for a non-production
 *                         control plane, whose buckets carry its own prefix
 *                         (see packages/cdk/src/stage.ts). Unset keeps the
 *                         production `deployz-templates-<region>` names.
 */
import { CloudFormationClient, ListExportsCommand } from '@aws-sdk/client-cloudformation';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrapTemplateBucketName, SUPPORTED_AWS_REGIONS } from '@deployz/contracts';
import {
  createRealRegionVerifier,
  createRealS3Client,
  parsePublishRegions,
  publishBootstrapToAllRegions,
  resolveBootstrapBuildId,
  synthesizeBootstrapStack,
} from '../dist/quick-create/publish.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const controlPlaneUrl = process.env.API_URL ?? 'https://api.deployz.dev';
const stackName = process.env.CONTROL_PLANE_STACK ?? 'Deployz';
const keyPrefix = process.env.TEMPLATE_KEY_PREFIX ?? 'bootstrap/v1';
const legacyBucketRegion = process.env.BOOTSTRAP_LEGACY_BUCKET_REGION;
const bucketPrefix = process.env.TEMPLATE_BUCKET_PREFIX;
const publishRegions = parsePublishRegions(
  process.env.BOOTSTRAP_PUBLISH_REGIONS,
  SUPPORTED_AWS_REGIONS,
);

/** Reads the template bucket name from the control plane stack's exports. */
async function resolveBucket() {
  if (process.env.TEMPLATE_BUCKET) return process.env.TEMPLATE_BUCKET;

  const client = new CloudFormationClient({ region });
  const exportName = `${stackName}-TemplateBucket`;
  let nextToken;
  do {
    const page = await client.send(new ListExportsCommand({ NextToken: nextToken }));
    const match = page.Exports?.find((entry) => entry.Name === exportName);
    if (match?.Value) return match.Value;
    nextToken = page.NextToken;
  } while (nextToken);

  throw new Error(
    `Could not find the ${exportName} stack export. Deploy the control plane first, ` +
      'or set TEMPLATE_BUCKET explicitly.',
  );
}

const bucket = await resolveBucket();
const outdir = mkdtempSync(join(tmpdir(), 'deployz-bootstrap-'));

const buildId = await resolveBootstrapBuildId({ outdir, controlPlaneUrl });
const synth = await synthesizeBootstrapStack({ outdir, controlPlaneUrl, buildId });

// One real S3 client + verifier per region (each bound to that region's
// endpoint), assets built once and reused everywhere. When
// BOOTSTRAP_LEGACY_BUCKET_REGION is set, that region publishes into the
// resolved TEMPLATE_BUCKET instead of its deployz-templates-<region> bucket
// (see the file header); every other requested region keeps the default, or
// this stage's own prefix when TEMPLATE_BUCKET_PREFIX is set.
const results = await publishBootstrapToAllRegions(
  (r) => createRealS3Client(r),
  (r) => createRealRegionVerifier(r),
  synth,
  {
    keyPrefix,
    controlPlaneUrl,
    regions: publishRegions,
    bucketFor: (r) =>
      r === legacyBucketRegion
        ? bucket
        : bucketPrefix
          ? bootstrapTemplateBucketName(r, bucketPrefix)
          : undefined,
  },
);

console.log(`Build id ${synth.buildId}`);
console.log(`Published ${synth.assets.length} Lambda asset(s) + a template to ${results.length} region(s):`);
for (const result of results) {
  console.log(`  ${result.region}`);
  console.log(`    bucket      ${result.bucket}`);
  console.log(`    template    ${result.templateUrl}`);
  console.log(`    quickCreate ${result.quickCreateUrl}`);
  console.log(`    versioned   ${result.versionedTemplateUrl}`);
  console.log(`    size        ${result.templateBytes} bytes, ${result.parameterCount} parameter(s)`);
}
console.log();
console.log('Record the verified regions on the control plane so install links are handed out:');
console.log(`  DEPLOYABLE_AWS_REGIONS=${results.map((r) => r.region).join(',')}`);

const defaultRegionResult = results.find((r) => r.region === region);
if (defaultRegionResult) {
  console.log();
  console.log('Compare against the deployed API Lambda\'s BOOTSTRAP_TEMPLATE_URL:');
  console.log(`  BOOTSTRAP_TEMPLATE_URL=${defaultRegionResult.templateUrl}`);
}
