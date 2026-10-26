import { BOOTSTRAP_TEMPLATE_KEY, resolveBootstrapTemplate, type ConnectorStackState } from '@deployz/contracts';

/**
 * What the customer needs to update the connector (bootstrap) stack that
 * already exists in their AWS account. An update keeps the stack's
 * installation id, relay credential, markers and application stack; only the
 * template changes. Distinct from a relay reset, which issues a new credential.
 */
export interface ConnectorUpdateOffer {
  /** Build id of the connector Deployz currently publishes; null when the control plane does not know it. */
  publishedBuildId: string | null;
  /** Console page of the existing connector stack, where the customer chooses Update. */
  updateUrl: string | null;
  /** Template URL to paste at "Replace existing template" — the immutable versioned copy when the build id is known. */
  templateUrl: string | null;
}

export interface ConnectorUpdateConfig {
  buildId: string | undefined;
  legacyUrl: string | undefined;
  deployableRegions: readonly string[];
}

/** Console page of an existing connector stack and the template to choose when updating it. */
export function connectorUpdateLinks(
  region: string,
  stackName: string | null,
  config: ConnectorUpdateConfig,
): { updateUrl: string; templateUrl: string | null } {
  const latest = resolveBootstrapTemplate(region, {
    ...(config.legacyUrl ? { legacyUrl: config.legacyUrl } : {}),
    deployableRegions: config.deployableRegions,
  });
  const templateUrl =
    latest && config.buildId
      ? latest.replace(
          new RegExp(`/${BOOTSTRAP_TEMPLATE_KEY}$`),
          `/versions/${config.buildId}/${BOOTSTRAP_TEMPLATE_KEY}`,
        )
      : (latest ?? null);
  const filter = stackName ? `&filteringText=${encodeURIComponent(stackName)}` : '';
  return {
    updateUrl: `https://${region}.console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(region)}#/stacks?filteringStatus=active${filter}`,
    templateUrl,
  };
}

export function connectorUpdateOffer(
  deployment: { region: string; state: string; relayBoundAt: Date | null; bootstrapStackName: string | null },
  config: ConnectorUpdateConfig,
): ConnectorUpdateOffer | null {
  if (deployment.relayBoundAt === null || deployment.state === 'DELETING' || deployment.state === 'DELETED') {
    return null;
  }
  return {
    publishedBuildId: config.buildId ?? null,
    ...connectorUpdateLinks(deployment.region, deployment.bootstrapStackName, config),
  };
}

/**
 * The connector stack status the relay last reported, stored by the heartbeat
 * as observedState.bootstrapStack. A heartbeat without a status keeps the
 * stored one, so `observedAt` tells how old it is.
 */
export interface ObservedBootstrapStack {
  status: string;
  observedAt: string;
}

/** A reported status older than this is UNKNOWN (the relay-liveness window). */
export const BOOTSTRAP_STACK_STALE_MS = 15 * 60_000;

export function readObservedBootstrapStack(observedState: unknown): ObservedBootstrapStack | null {
  const value = (observedState as { bootstrapStack?: unknown } | null)?.bootstrapStack as
    | Partial<ObservedBootstrapStack>
    | null
    | undefined;
  return typeof value?.status === 'string' && typeof value.observedAt === 'string'
    ? { status: value.status, observedAt: value.observedAt }
    : null;
}

/** Maps a CloudFormation StackStatus to the connector stack state the UI may show. */
export function connectorStackState(status: string | null): ConnectorStackState {
  if (status === null) return 'UNKNOWN';
  if (status.endsWith('_IN_PROGRESS')) return 'UPDATING';
  if (status === 'UPDATE_ROLLBACK_COMPLETE') return 'ROLLED_BACK';
  if (status.endsWith('_FAILED')) return 'FAILED';
  if (status === 'CREATE_COMPLETE' || status === 'UPDATE_COMPLETE') return 'STABLE';
  return 'UNKNOWN';
}

export type ConnectorUpdateEventType =
  | 'connector.update_verified'
  | 'connector.update_rolled_back'
  | 'connector.update_failed';

/**
 * The connector update outcome a heartbeat newly shows, or null. Edge
 * triggered: the stored previous status and build id make each outcome
 * record once.
 * - verified: the stack is STABLE on the published build after an update
 *   (the build id changed, or the stack was in an update state).
 * - rolled back: UPDATE_ROLLBACK_COMPLETE for the first time.
 * - failed: an update status that ends in _FAILED for the first time. A
 *   failed create or delete is not an update failure.
 */
export function connectorUpdateEvent(
  previous: { installedBuildId: string | null; status: string | null },
  next: { installedBuildId: string | null; status: string },
  publishedBuildId: string | null,
): ConnectorUpdateEventType | null {
  if (next.status === previous.status && next.installedBuildId === previous.installedBuildId) return null;
  const nextState = connectorStackState(next.status);
  if (nextState === 'STABLE') {
    const buildChanged = previous.installedBuildId !== null && previous.installedBuildId !== next.installedBuildId;
    const wasUpdating =
      previous.status !== null && previous.status.startsWith('UPDATE_') && connectorStackState(previous.status) !== 'STABLE';
    return publishedBuildId !== null && next.installedBuildId === publishedBuildId && (buildChanged || wasUpdating)
      ? 'connector.update_verified'
      : null;
  }
  if (next.status === previous.status) return null;
  if (nextState === 'ROLLED_BACK') return 'connector.update_rolled_back';
  if (nextState === 'FAILED' && next.status.startsWith('UPDATE_')) return 'connector.update_failed';
  return null;
}
