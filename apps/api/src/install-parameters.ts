import { randomBytes } from 'node:crypto';

import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';

import {
  APP_API_KEY_PARAMETER,
  APP_SIGNING_SECRET_PARAMETER,
  DESIRED_COUNT_PARAMETER,
  IMAGE_REFERENCE_PARAMETER,
} from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';

export { DESIRED_COUNT_PARAMETER };

export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The newest release an install can run: READY, image digest recorded, and
 * not known-unavailable. Same selection as autoDeploySelectedRelease.
 */
export async function newestDeployableRelease(
  db: RuntimeDb,
  applicationId: string,
): Promise<{ id: string; imageDigest: string } | null> {
  const rows = await db
    .select({ id: schema.releases.id, imageDigest: schema.releases.imageDigest })
    .from(schema.releases)
    .where(
      and(
        eq(schema.releases.applicationId, applicationId),
        eq(schema.releases.releaseStatus, 'READY'),
        isNull(schema.releases.imageUnavailableAt),
        isNotNull(schema.releases.imageDigest),
      ),
    )
    .orderBy(desc(schema.releases.createdAt))
    .limit(1);
  const row = rows[0];
  return row?.imageDigest ? { id: row.id, imageDigest: row.imageDigest } : null;
}

export function releaseRequiredError(): ApiError {
  return new ApiError(
    409,
    'RELEASE_NOT_PUBLISHED',
    'This application has no built release yet. Build a release on the Releases page, then try again.',
  );
}

/**
 * Builds the CloudFormation parameter values for an INSTALL job (§31) against
 * the compiler-v2 template. The template's port/health parameters are derived
 * by the relay from the payload's manifest — the API only carries what the
 * customer account cannot derive:
 * - imageReference (DEPLOY-001) is the deployment's application's newest
 *   READY release with a known image (`imageUnavailableAt` null); when no
 *   such release exists the install is refused with RELEASE_NOT_PUBLISHED.
 *   `releaseId` names the selected release (for the deployment identity
 *   tags).
 * - paramAppApiKey / paramAppSigningSecret are generated per install and
 *   travel only through the job payload into NoEcho parameters (redacted
 *   from the stored payload once claimed).
 * - desiredCount is '0' when configuration must precede the first start
 *   (DEPLOY-009); the key is omitted otherwise.
 */
export async function buildInstallParameters(
  db: RuntimeDb,
  deploymentId: string,
  options: {
    /**
     * DEPLOY-009: configuration must reach the task before it first starts.
     * With a release to run, the service is created with zero tasks and the
     * first deploy after the post-install configuration pass starts it;
     * without one, nothing could start anyway and the key is omitted.
     */
    startAfterConfig?: boolean;
  } = {},
): Promise<{ parameters: Record<string, string>; releaseId: string | null }> {
  const rows = await db
    .select({ applicationId: schema.deployments.applicationId })
    .from(schema.deployments)
    .where(eq(schema.deployments.id, deploymentId))
    .limit(1);
  const parameters: Record<string, string> = {
    [APP_API_KEY_PARAMETER]: generateSecret(),
    [APP_SIGNING_SECRET_PARAMETER]: generateSecret(),
  };
  let releaseId: string | null = null;
  if (rows[0]?.applicationId) {
    // DEPLOY-001 — a fresh install must run the application's own release,
    // never the image the template happened to be published with: that
    // default is another application's image, so installing it fails at
    // container start. No usable release refuses the install.
    const release = await newestDeployableRelease(db, rows[0].applicationId);
    if (!release) throw releaseRequiredError();
    parameters[IMAGE_REFERENCE_PARAMETER] = release.imageDigest;
    releaseId = release.id;
    if (options.startAfterConfig === true) {
      parameters[DESIRED_COUNT_PARAMETER] = '0';
    }
  }
  return { parameters, releaseId };
}
