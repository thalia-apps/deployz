import type { DeploymentPlan, InfrastructureSizeTier } from '@deployz/contracts';

export type { DeploymentPlan, InfrastructureSizeTier };

/** One input the confirm body may (optional) or must (required) supply. */
export interface PublicInstallInput {
  readonly key: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly classification?: string;
  readonly purpose?: string;
  /** Customer-facing label, written by the vendor, shown instead of the raw key. */
  readonly label?: string;
  /** Customer-facing help text, written by the vendor, shown under the label. */
  readonly help?: string;
}

/** One deployable region offered by the publisher. */
export interface PublicInstallRegion {
  readonly value: string;
  readonly label: string;
}

/** One size the vendor allows, with the resources it provisions. */
export interface PublicInstallSizeOption {
  readonly id: InfrastructureSizeTier;
  readonly label: string;
  readonly description: string;
  readonly recommended: boolean;
  readonly workload: { readonly cpuUnits: number; readonly memoryMiB: number; readonly desiredCount: number };
  readonly database: { readonly instanceClass: string; readonly storageGb: number };
  readonly cache: { readonly nodeType: string; readonly nodeCount: number };
}

/** The INSTALL plan for one Region and size; the fingerprint is what the customer approves. */
export type PublicInstallPlan = DeploymentPlan & {
  sizeProfile: InfrastructureSizeTier;
  /** Null when the Region cannot deploy: there is nothing to approve. */
  planFingerprint: string | null;
};

/** GET /api/public-install/:linkId response body. */
export interface PublicInstallResolve {
  application: { name: string };
  publisher: { name: string };
  release: { version: string; createdAt: string };
  /** The publisher's suggestion, if any. The customer always makes the final choice. */
  recommendedRegion: string | null;
  /** Who owns the final Region choice — always 'customer' for new links. */
  regionSelection: 'customer' | 'legacy_publisher_fixed';
  regions: PublicInstallRegion[];
  requiredInputs: PublicInstallInput[];
  sizing: {
    recommended: InfrastructureSizeTier;
    minimum: InfrastructureSizeTier;
    options: PublicInstallSizeOption[];
  };
  plan: DeploymentPlan;
}

/** Customer-facing message for a public-install error code. */
export function publicInstallErrorMessage(code: string): string {
  switch (code) {
    case 'PUBLIC_INSTALL_LINK_REVOKED':
      return 'This installation link has been revoked. Contact your software provider for a new link.';
    case 'PUBLIC_INSTALL_LINK_EXPIRED':
      return 'This installation link has expired. Contact your software provider for a new link.';
    case 'PUBLIC_INSTALL_LINK_USED':
      return 'This installation link has already been used. Contact your software provider if you need another installation.';
    case 'PUBLIC_INSTALL_LINK_DISABLED':
      return 'This application is not currently available for installation. Contact your software provider.';
    case 'RELEASE_NOT_PUBLISHED':
      return 'This application has no published release yet. Contact your software provider.';
    case 'REGION_NOT_SUPPORTED':
      return 'That region is not available for this application. Select a different region.';
    case 'MANIFEST_NEEDS_CONFIGURATION':
    case 'MANIFEST_NOT_COMPATIBLE':
      return 'This application cannot be installed in its current state. Contact your software provider.';
    case 'PUBLIC_INSTALL_CONFIG_INVALID':
      return 'Some configuration values are missing or not valid. Check the fields and try again.';
    case 'PLAN_CHANGED':
      return 'The installation plan changed after you reviewed it. Review the updated plan and confirm again.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'This confirmation was already used for a different Region or size. Reload the page and confirm again.';
    case 'SIZE_PROFILE_NOT_ALLOWED':
    case 'UNKNOWN_PROFILE':
      return 'That size is not available for this application. Select a different size.';
    case 'SUBSCRIPTION_REQUIRED':
      return 'Your software provider must fix their Deployz subscription before this application can be installed. Contact your software provider.';
    case 'VALIDATION_ERROR':
      return 'The submitted information is not valid. Check the fields and try again.';
    default:
      return 'Installation could not start. Try again or contact your software provider.';
  }
}
