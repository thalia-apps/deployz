// §28 relay liveness, persisted.
//
// The relay polls every minute (the bootstrap stack's RelaySchedule) and
// reports health as it goes. The heartbeat writes CONNECTED; the worker's
// scheduled sweep (15 min, same cadence as the stuck-job watchdog) persists
// DISCONNECTED once
// RELAY_STALE_AFTER_MS passes without a check-in, and a returning relay's
// heartbeat flips the column straight back to CONNECTED. Every read — fleet
// badge, deployment detail, action gating, diagnostics — trusts the persisted
// column instead of re-deriving it, so all screens agree without a scheduler
// of their own.

import { RELAY_STALE_AFTER_MS } from '@deployz/contracts';

export { RELAY_STALE_AFTER_MS };

export type RelayStatus = 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
export type HealthStatus = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';

/**
 * Health as of `now`. A stale relay means the reported health is stale too —
 * whatever it last said, we no longer know, and UNKNOWN is the honest answer.
 */
export function deriveHealthStatus(
  stored: HealthStatus,
  relayStatus: RelayStatus,
): HealthStatus {
  return relayStatus === 'DISCONNECTED' ? 'UNKNOWN' : stored;
}
