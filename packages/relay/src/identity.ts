/**
 * Relay identity — what the relay reports about itself at enrollment and on
 * every heartbeat, so the control plane can gate UI actions on what the
 * installed relay can actually execute.
 */

import type { RelayCapabilities, RelayIdentity } from '@deployz/contracts';

import type { CloudFormationReader } from './verify.js';

/**
 * Bumped with each relay release. Drives capability gating and rollout
 * verification ("confirm relayVersion after updating deployz-bootstrap");
 * the relay bundle carries no package metadata at runtime, so this constant
 * is the version.
 */
export const RELAY_VERSION = '0.2.0';

/**
 * What this relay build can execute. Flips to true per capability as the
 * real executors land; until then the dashboard must not offer the action.
 */
export const RELAY_CAPABILITIES: RelayCapabilities = {
  deployRelease: true,
  rollback: true,
  restart: true,
  configUpdate: true,
  destroy: true,
  domainManagement: true,
};

/** Extracts the account id from a Lambda ARN (arn:aws:lambda:REGION:ACCOUNT:...). */
export function accountIdFromArn(arn: string): string | null {
  const parts = arn.split(':');
  return /^\d{12}$/.test(parts[4] ?? '') ? parts[4]! : null;
}

/**
 * The identity to report this invocation. Outside Lambda (local runs, unit
 * tests) the account id and region are absent — reporting nothing is more
 * honest than reporting a guess.
 */
export function readRelayIdentity(context?: {
  invokedFunctionArn?: string;
}): Partial<RelayIdentity> {
  const identity: Partial<RelayIdentity> = {
    relayVersion: RELAY_VERSION,
    bootstrapVersion: process.env['DEPLOYZ_BOOTSTRAP_VERSION'] || null,
    capabilities: RELAY_CAPABILITIES,
  };
  const accountId = context?.invokedFunctionArn
    ? accountIdFromArn(context.invokedFunctionArn)
    : null;
  if (accountId) identity.awsAccountId = accountId;
  if (process.env['AWS_REGION']) identity.region = process.env['AWS_REGION'];
  return identity;
}

/**
 * The CloudFormation status of the relay's own bootstrap stack, reported on
 * every heartbeat so the control plane can verify a connector update. Null
 * when the read fails (an older stack without the read grant, a throttle):
 * the heartbeat then omits the status and is sent as usual.
 */
export async function readBootstrapStackStatus(
  cfn: Pick<CloudFormationReader, 'describeStack'>,
  stackName: string,
): Promise<string | null> {
  try {
    const lookup = await cfn.describeStack(stackName);
    return lookup.found ? lookup.stack.status : null;
  } catch {
    return null;
  }
}

/**
 * True while the customer updates the bootstrap stack (including its
 * rollback). The relay then claims no new commands: the update can replace
 * the relay code and role mid-command. A stack still being created or being
 * deleted does not pause claims.
 */
export function isBootstrapStackUpdating(status: string | null): boolean {
  return status !== null && status.startsWith('UPDATE_') && status.endsWith('_IN_PROGRESS');
}
