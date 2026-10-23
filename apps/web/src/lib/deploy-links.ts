// Deploy link data access (vendor side). A deploy link is a tokenized,
// customer-specific URL that lets one customer deploy one application into
// their own AWS account. The raw token exists only in the generate/regenerate
// response — the API stores a hash — so the full URL is copyable exactly once
// per minted secret.

import { apiRequest } from '@/lib/api-client';

/** Mirrors `deploymentStateEnum` values the link views expose. */
export type DeployLinkStatus = 'active' | 'revoked' | 'expired';

export interface DeployLinkView {
  id: string;
  customerId: string;
  applicationId: string;
  applicationName: string | null;
  deploymentId: string;
  deploymentState: string | null;
  region: string | null;
  status: DeployLinkStatus;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface DeployLinkMutationResult {
  link: DeployLinkView;
  deployment: { id: string; state: string; source: string };
  /** The raw secret, shown once. Never returned again by any other route. */
  token: string;
}

export function generateDeployLink(
  customerId: string,
  input: { applicationId: string; region: string },
): Promise<DeployLinkMutationResult> {
  return apiRequest<DeployLinkMutationResult>(
    `/api/customers/${encodeURIComponent(customerId)}/deploy-links`,
    { method: 'POST', body: input },
  );
}

export async function fetchDeployLinks(customerId: string): Promise<DeployLinkView[]> {
  const body = await apiRequest<{ links?: DeployLinkView[] }>(
    `/api/customers/${encodeURIComponent(customerId)}/deploy-links`,
  );
  return body.links ?? [];
}

export function revokeDeployLink(linkId: string): Promise<{ link: DeployLinkView }> {
  return apiRequest<{ link: DeployLinkView }>(
    `/api/deploy-links/${encodeURIComponent(linkId)}/revoke`,
    { method: 'POST' },
  );
}

export function regenerateDeployLink(linkId: string): Promise<DeployLinkMutationResult> {
  return apiRequest<DeployLinkMutationResult>(
    `/api/deploy-links/${encodeURIComponent(linkId)}/regenerate`,
    { method: 'POST' },
  );
}

/** The customer-facing URL for a freshly minted secret. */
export function deployLinkUrl(linkId: string, token: string, origin: string): string {
  return `${origin}/deploy/${linkId}#${token}`;
}

/** Badge label + shadcn variant for a link status. */
export function deployLinkStatusBadge(status: DeployLinkStatus): {
  label: string;
  variant: 'success' | 'secondary';
} {
  if (status === 'active') return { label: 'Active', variant: 'success' };
  if (status === 'expired') return { label: 'Expired', variant: 'secondary' };
  return { label: 'Revoked', variant: 'secondary' };
}
