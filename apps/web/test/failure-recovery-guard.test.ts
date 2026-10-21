import { FAILURE_CODES } from '@deployz/copy-map';
import { describe, expect, it } from 'vitest';

import { retryEligibilityFor } from '../../api/src/retry-eligibility';
import {
  canRetryFirstInstall,
  deploymentEverRan,
  retryNeedsNewInstallLink,
} from '../src/lib/deployment-hero';
import { DEPLOYMENT_STATES, type DeploymentState } from '../src/lib/deployment-vocabulary';
import { retryCta } from '../src/lib/diagnostics';

// Guard against failure dead ends: for every state × failure code the
// deployment page can show, the vendor has a control that can succeed, or
// something recovers the deployment without them. The control choice below
// is the same logic DeploymentActions uses, fed by the API's real
// retry-eligibility rule. Deployz has no public API, so a route with no
// control does not count.

/** Idle states where the page shows the latest failure with the action row. */
const SETTLED_STATES = ['FAILED', 'HEALTHY', 'UPDATE_AVAILABLE'] as const;

/** Every other state, and what moves it on. A new state must be placed here or above. */
const OTHER_STATES: Record<Exclude<DeploymentState, (typeof SETTLED_STATES)[number]>, string> = {
  NOT_INSTALLED: 'install link card: Copy install link and Issue new install link',
  WAITING_FOR_RELAY: 'install link card: Copy install link and Issue new install link',
  INSTALLING: 'operation running: the watchdog settles it',
  UPDATING: 'operation running: the watchdog settles it',
  DELETING: 'disconnect panel: the watchdog re-offers DESTROY; force-complete after the threshold',
  DELETED: 'removed: Delete retained data when resources remain',
  DISCONNECTED: 'never written as a deployment state',
};

const HISTORIES = [
  { name: 'never installed', installSucceeded: false, hasRelease: false },
  { name: 'installed, no release', installSucceeded: true, hasRelease: false },
  { name: 'installed with release', installSucceeded: true, hasRelease: true },
] as const;

const RELAY_STATUSES = ['CONNECTED', 'DISCONNECTED', 'UNKNOWN'] as const;

type Recovery =
  | 'retry-deployment'
  | 'issue-new-install-link'
  | 'contact-support'
  | 'deploy-update'
  | 'relay-heartbeat';

function recoveries(input: {
  state: (typeof SETTLED_STATES)[number];
  relayStatus: (typeof RELAY_STATUSES)[number];
  installationId: string | null;
  installSucceeded: boolean;
  hasRelease: boolean;
  failureCode: string;
}): Recovery[] {
  const eligibility = retryEligibilityFor(input);
  const everRan = deploymentEverRan(input.state, input.hasRelease ? 'release-1' : null, eligibility);
  const found: Recovery[] = [];
  if (canRetryFirstInstall(input.state, everRan, null)) {
    const cta = retryCta(eligibility);
    if (cta === 'retry' || cta === 'legacy') {
      found.push(
        retryNeedsNewInstallLink(input.relayStatus, input.installationId)
          ? 'issue-new-install-link'
          : 'retry-deployment',
      );
    }
    if (cta === 'contact-support') found.push('contact-support');
  }
  if (everRan) {
    // Deploy update is enabled while the relay is connected; while it is
    // not, the relay's own heartbeat reconnects it.
    found.push(input.relayStatus === 'CONNECTED' ? 'deploy-update' : 'relay-heartbeat');
  }
  return found;
}

describe('failure recovery guard', () => {
  it('places every deployment state', () => {
    const placed = [...SETTLED_STATES, ...Object.keys(OTHER_STATES)].sort();
    expect(placed).toEqual([...DEPLOYMENT_STATES].sort());
  });

  for (const state of SETTLED_STATES) {
    for (const history of HISTORIES) {
      // A live state always has an installed application behind it.
      if (state !== 'FAILED' && !history.installSucceeded) continue;
      for (const relayStatus of RELAY_STATUSES) {
        for (const installationId of ['inst-1', null]) {
          it(`${state}, ${history.name}, relay ${relayStatus}, connector ${installationId ? 'registered' : 'absent'}: every failure code has a way out`, () => {
            for (const failureCode of FAILURE_CODES) {
              const input = { state, relayStatus, installationId, ...history, failureCode };
              const found = recoveries(input);
              expect(found, failureCode).not.toEqual([]);
              // Retry deployment is offered only where the API accepts it.
              if (found.includes('retry-deployment')) {
                expect(history.installSucceeded, failureCode).toBe(false);
              }
              // WAIT is only honest where the heartbeat self-heal can run.
              if (retryEligibilityFor(input).action === 'WAIT') {
                expect(state !== 'FAILED' || history.hasRelease, failureCode).toBe(true);
              }
            }
          });
        }
      }
    }
  }
});
