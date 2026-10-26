// Customer page access (docs/customer-access.md). The browser calls the API
// directly with credentials, like the dashboard: the API sets the customer
// session cookie. Safe in client components — nothing here reads next/headers.

import { apiUrl } from '@/lib/api-url';

/** Who opened the customer page, as the API resolved it. */
export type InstallViewer = { kind: 'customer'; email: string } | { kind: 'vendor' };

export class CustomerAccessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Customer access request failed (${status} ${code})`);
    this.name = 'CustomerAccessError';
  }
}

async function postJson(path: string, body: unknown): Promise<Response> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const code = (payload as { error?: { code?: string } } | null)?.error?.code ?? 'REQUEST_FAILED';
    throw new CustomerAccessError(response.status, code);
  }
  return response;
}

/** Asks for a sign-in code. The answer is the same whether or not the email has access. */
export async function requestSignInCode(installLinkId: string, email: string): Promise<void> {
  await postJson('/api/customer/sign-in/code', { installLinkId, email });
}

export async function verifySignInCode(installLinkId: string, code: string): Promise<void> {
  await postJson('/api/customer/sign-in/verify', { installLinkId, code });
}

export async function signOutCustomer(installLinkId: string): Promise<void> {
  await postJson('/api/customer/sign-out', { installLinkId });
}

export type ConnectorConnectivity = 'NEVER_CONNECTED' | 'CONNECTED' | 'OFFLINE' | 'UNKNOWN';
export type ConnectorStackState = 'STABLE' | 'UPDATING' | 'ROLLED_BACK' | 'FAILED' | 'UNKNOWN';

/** GET /api/install/:id/overview. The connector block is the vendor derivation's `connector` object. */
export interface InstallOverview {
  connector: {
    connectivity: ConnectorConnectivity;
    lastContactAt: string | null;
    stackName: string | null;
    updateAvailable: boolean;
    upgradeRequired: boolean;
    updateUrl: string | null;
    updateTemplateUrl: string | null;
    installedBuildId?: string | null;
    publishedBuildId?: string | null;
    stackState?: ConnectorStackState;
  };
  aws: { accountId: string | null; region: string };
  activity: Array<{ id: number; type: string; occurredAt: string; releaseVersion: string | null }>;
}

export async function fetchInstallOverview(installLinkId: string): Promise<InstallOverview> {
  const response = await fetch(`${apiUrl}/api/install/${encodeURIComponent(installLinkId)}/overview`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Overview request failed (${response.status})`);
  return (await response.json()) as InstallOverview;
}

/** Customer words for the activity list; types without an entry are not shown. */
export const CUSTOMER_ACTIVITY_LABELS: Record<string, string> = {
  'install.launched': 'Setup started in AWS',
  'install.completed': 'Installation completed',
  'install.failed': 'Installation failed',
  'deploy.completed': 'Update installed',
  'deploy.failed': 'Update failed. The previous version keeps running',
  'rollback.completed': 'Previous version restored',
  'rollback.failed': 'Restore of the previous version failed',
  'restart.completed': 'Application restarted',
  'config.updated': 'Settings updated',
  'domain.activated': 'Custom domain active',
  'domain.removed': 'Custom domain removed',
  'destroy.completed': 'Deployment removed',
  'purge.completed': 'Retained data deleted',
  'relay.connected': 'Connector connected',
  'connector.update_verified': 'Connector update verified',
  'connector.update_rolled_back': 'Connector update rolled back by AWS',
  'connector.update_failed': 'Connector update failed',
  'customer.owner_claimed': 'Owner email verified',
};
