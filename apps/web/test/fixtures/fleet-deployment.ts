import type { FleetDeployment } from '../../src/lib/deployments';

/** A fleet row for list-view tests: healthy by default, override what matters. */
export function fleetDeployment(
  overrides: Partial<Omit<FleetDeployment, 'deploymentStatus'>> & {
    deploymentStatus?: Partial<FleetDeployment['deploymentStatus']>;
  } = {},
): FleetDeployment {
  const { deploymentStatus, ...rest } = overrides;
  return {
    id: 'dep-1',
    customerId: 'cus-1',
    applicationId: 'app-1',
    organizationId: 'org-1',
    region: 'us-east-1',
    state: 'HEALTHY',
    awsAccountId: '1234••••••',
    currentReleaseId: null,
    previousReleaseId: null,
    relayStatus: 'CONNECTED',
    healthStatus: 'HEALTHY',
    components: null,
    desiredState: {},
    observedState: null,
    infraVersion: 'runtime-v1',
    installationId: 'inst-1',
    deploymentType: 'PRODUCTION',
    billingState: 'NOT_STARTED',
    billingStartedAt: null,
    billingStoppedAt: null,
    lastHealthAt: null,
    deletedAt: null,
    cleanupState: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    createdBy: null,
    updatedBy: null,
    customerName: 'Acme Corp',
    applicationName: 'MyApp',
    version: '1.4.2',
    relayVersion: null,
    bootstrapVersion: null,
    relayCapabilities: null,
    runningImageDigest: null,
    attemptNumber: 1,
    bootstrapStackName: null,
    installStartedAt: null,
    installLinkId: 'link-1',
    installLinkExpiresAt: null,
    deploymentStatus: {
      stage: 'READY',
      updatedAt: '2026-08-01T00:00:00.000Z',
      step: 'READY',
      currentActivity: 'Live and healthy.',
      ...deploymentStatus,
    } as FleetDeployment['deploymentStatus'],
    ...rest,
  };
}
