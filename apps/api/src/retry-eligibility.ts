import { failureRecoverability, type FailureRecoverability } from '@deployz/copy-map';

// Phase 2 safe-retry eligibility: a read-only signal that tells the
// diagnostics card which MANUAL recovery path can succeed for the latest
// failure. Derived from facts the control plane already holds — no parallel
// state. It never retries anything by itself; there is deliberately no
// auto-retry loop (docs/deployment-resilience.md).

export interface RetryEligibility {
  action: 'RETRY_INSTALL' | 'DEPLOY_AGAIN' | 'CONTACT_DEPLOYZ' | 'WAIT' | 'NONE';
  retryable: boolean;
  whoMustAct: 'VENDOR' | 'DEPLOYZ' | null;
}

export interface RetryEligibilityInput {
  /** §46 deployment state. */
  state: string;
  /** Relay connection status on the deployment row. */
  relayStatus: string;
  /** Whether any INSTALL job ever succeeded — the fact performRetryInstall guards on. */
  installSucceeded: boolean;
  /** Whether a release has deployed (`currentReleaseId` set) — what the heartbeat self-heal needs. */
  hasRelease: boolean;
  /** §61 failure code of the latest failed job; null when there is none. */
  failureCode: string | null;
}

/** States where a failed day-2 operation leaves a running release to redeploy onto. */
const DAY_2_STATES = new Set(['HEALTHY', 'UPDATE_AVAILABLE', 'FAILED']);

const NOT_ELIGIBLE: RetryEligibility = { action: 'NONE', retryable: false, whoMustAct: null };

function whoMustActFor(recoverability: FailureRecoverability): RetryEligibility['whoMustAct'] {
  switch (recoverability) {
    case 'USER_ACTION':
    case 'TERMINAL':
      return 'VENDOR';
    case 'DEPLOYZ_ACTION':
      return 'DEPLOYZ';
    default:
      return null;
  }
}

/**
 * Derive manual-retry eligibility. Total: every state/code combination
 * yields a value, defaulting to NONE/false. A failed first install stays
 * retryable regardless of the failure's recoverability class — the
 * relay's ROLLBACK_COMPLETE recovery arc handles terminal stacks, so
 * TERMINAL shapes the copy (whoMustAct VENDOR), never the eligibility.
 *
 * WAIT is returned only where something recovers without the vendor: the
 * application is running (a live state), or a FAILED deployment has a
 * release for the heartbeat self-heal to restore. Anywhere else a
 * RECONCILE_FIRST code gets the retry, because nothing would reconcile it.
 */
export function retryEligibilityFor(input: RetryEligibilityInput): RetryEligibility {
  if (input.failureCode === null) return NOT_ELIGIBLE;
  const recoverability = failureRecoverability(input.failureCode);

  let eligibility: RetryEligibility;
  if (input.state === 'FAILED' && !input.installSucceeded) {
    eligibility = { action: 'RETRY_INSTALL', retryable: true, whoMustAct: whoMustActFor(recoverability) };
  } else if (input.installSucceeded && DAY_2_STATES.has(input.state)) {
    eligibility = { action: 'DEPLOY_AGAIN', retryable: true, whoMustAct: whoMustActFor(recoverability) };
  } else {
    return NOT_ELIGIBLE;
  }

  if (recoverability === 'DEPLOYZ_ACTION') {
    return { action: 'CONTACT_DEPLOYZ', retryable: false, whoMustAct: 'DEPLOYZ' };
  }
  const selfHeals = input.state !== 'FAILED' || input.hasRelease;
  if (recoverability === 'RECONCILE_FIRST' && selfHeals) {
    return { action: 'WAIT', retryable: false, whoMustAct: null };
  }
  if (input.relayStatus === 'DISCONNECTED') {
    return { ...eligibility, retryable: false };
  }
  return eligibility;
}
