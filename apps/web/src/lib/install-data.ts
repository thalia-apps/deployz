// §12/§44 public customer installation data — server-side fetch for the
// unauthenticated /install/:installLinkId page. Wired to the real
// (public, no-auth) `GET /api/install/:installLinkId` endpoint.
//
// The route parameter is the install-LINK id, which is not the relay's
// installation id. They used to be the same value, which made the link a
// customer is emailed also the identifier a relay authenticates against.

import type { DeploymentPlan } from '@deployz/contracts';

import { serverApiUrl } from '@/lib/api-url';
import type { CustomDomainView } from '@/lib/domains';

interface InstallData {
  applicationName: string;
  publisherName: string;
  customerName: string;
  region: string;
  /** §44 "Deployz will create" table renders from this — same schema
   *  `GET /api/deployments/:id/plan?action=install` serves once the
   *  deployment exists. Null only when the stored manifest is missing or
   *  invalid. */
  plan: DeploymentPlan | null;
  /**
   * CloudFormation Quick Create deep-link for THIS deployment, built by the
   * control plane: it owns the published template URL, the deployment's
   * region and the single-use enrollment code. Null when no bootstrap
   * template is published yet.
   */
  quickCreateUrl: string | null;
  /** Set instead of `quickCreateUrl` when the connector stack already exists in the customer's account (a reconnect): they update it. */
  existingStackUpdate: ExistingStackUpdate | null;
  /** True when the request lacked the link token, so the credentials above were left out. */
  credentialsWithheld: boolean;
  /** True once a relay has enrolled — the link has already been used. */
  alreadyInstalled: boolean;
  /** The deployment this install link names — needed once installed, to scope the domain card. */
  deploymentId: string;
  deploymentState: string;
  /** The release currently serving this deployment, if any. */
  releaseVersion: string | null;
  /** This deployment's active custom domain, if any. */
  domain: CustomDomainView | null;
  /** The CNAME target a customer without a custom domain yet would point at. */
  routingTarget: string | null;
  /** The expected bootstrap stack name for the current attempt. */
  bootstrapStackName: string;
  /** The customer launched the install and Deployz is waiting for the relay. */
  waitingForRelay: boolean;
  /** When this invitation stops accepting new installations (ISO). Null = no limit. */
  installLinkExpiresAt: string | null;
  /** waitingForRelay past the relay-staleness window — guidance, never a failure. */
  relayStuck: boolean;
  /** §24 component view, same derivation the fleet row uses. Null until enrolled. */
  components: Record<string, string> | null;
}

/** The connector stack that already exists in the customer's account; a reconnect updates it. */
export interface ExistingStackUpdate {
  stackName: string;
  consoleUrl: string;
  templateUrl: string | null;
  enrollmentCode: string;
  relayCredential: string | null;
  controlPlaneUrl: string;
}

/** The outcome of resolving a public install link. */
export type InstallLinkLookup =
  | { status: 'ok'; data: InstallData }
  | { status: 'not_found' }
  | { status: 'unavailable'; code: string; message: string }
  /** The control plane could not answer (network failure, 5xx, rate limit). Says nothing about the link. */
  | { status: 'error' };

/** Fetch the public install page data, distinguishing invalid, expired and
 *  revoked links (the API returns 410 with a code for the latter two). Any
 *  other failure is `error`, never a claim about the link. */
export async function fetchInstallData(
  installLinkId: string,
  token?: string | undefined,
): Promise<InstallLinkLookup> {
  let response: Response;
  try {
    response = await fetch(`${serverApiUrl()}/api/install/${encodeURIComponent(installLinkId)}`, {
      cache: 'no-store',
      ...(token ? { headers: { 'x-deployz-token': token } } : {}),
    });
  } catch {
    return { status: 'error' };
  }
  if (response.status === 404) return { status: 'not_found' };
  if (response.status !== 410 && !response.ok) return { status: 'error' };
  if (!response.ok) {
    let code = 'INSTALL_LINK_UNAVAILABLE';
    let message = 'This installation link is no longer available.';
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      code = body?.error?.code ?? code;
      message = body?.error?.message ?? message;
    } catch {
      // Non-JSON error body — keep the generic copy.
    }
    return { status: 'unavailable', code, message };
  }
  return { status: 'ok', data: (await response.json()) as InstallData };
}

// ── Pre-relay install lifecycle (public, no-auth — keyed on the link) ──────

/**
 * Fire-and-forget launch signal: the install page reports the customer
 * pressing "Deploy to AWS" so the deployment can show an explicit waiting
 * state. Best-effort — a failure must never block the handoff to AWS.
 */
export async function launchInstall(installLinkId: string): Promise<void> {
  try {
    await fetch(`${serverApiUrl()}/api/install/${encodeURIComponent(installLinkId)}/launched`, {
      method: 'POST',
      cache: 'no-store',
    });
  } catch {
    // The customer still goes to AWS; the signal is not worth blocking on.
  }
}

/** The fresh-attempt response from POST /api/install/:id/retry. */
export interface RetryInstallResult {
  state: 'NOT_INSTALLED';
  attemptNumber: number;
  bootstrapStackName: string;
  quickCreateUrl: string | null;
}

/** A failed retry that knows WHICH status and error code came back. */
export class InstallRetryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Install retry failed (${status})`);
    this.name = 'InstallRetryError';
  }
}

/**
 * Customer-facing retry for a failed install: fresh attempt (new enrollment
 * code, attempt+1). A connector that already registered keeps its stack
 * (the page then shows the update instructions); otherwise a new stack name. 409
 * INSTALL_ALREADY_SUCCEEDED when the deployment was ever installed
 * successfully.
 */
export async function retryInstallAttempt(
  installLinkId: string,
  token?: string | undefined,
): Promise<RetryInstallResult> {
  const response = await fetch(`${serverApiUrl()}/api/install/${encodeURIComponent(installLinkId)}/retry`, {
    method: 'POST',
    cache: 'no-store',
    ...(token ? { headers: { 'x-deployz-token': token } } : {}),
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const envelope = payload as { error?: { code?: string } } | null;
    throw new InstallRetryError(response.status, envelope?.error?.code ?? 'REQUEST_FAILED');
  }
  return (await response.json()) as RetryInstallResult;
}
