import { cookies } from 'next/headers';

import type { OrgRole, OrganizationSummary, SubscriptionStatus } from './organization-vocabulary';

interface Me {
  user: { id: string; name: string; email: string; emailVerified: boolean; image: string | null };
  organization: {
    id: string;
    name: string;
    slug: string;
    /** `null` means evaluation — no subscription has ever been bought. */
    subscriptionStatus: SubscriptionStatus | null;
  } | null;
  /** The user's role in the active organization, null when they have none. */
  role: OrgRole | null;
  /** Every organization the user belongs to — the tenant switcher's data. */
  organizations: OrganizationSummary[];
  /** Platform-staff flag (docs/admin/team-admin.md) — gates /admin access. */
  isTeamAdmin: boolean;
  /** Non-null only while an admin's session is pointed at a vendor
   *  organization via "View as Vendor". `organization` above is already the
   *  vendor's in that case — this is only the banner's display data. */
  supportMode: { organizationId: string; organizationName: string } | null;
}

import { serverApiUrl } from '@/lib/api-url';

// Server-side session resolution: forward the incoming request's cookies to
// the control-plane API. Returns null when the session is absent or invalid.
export async function fetchMe(): Promise<Me | null> {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${serverApiUrl()}/api/me`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  });
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as Me;
}

export interface PendingInvitation {
  id: string;
  organizationName: string;
  role: string;
  expiresAt: string;
}

/** Live invitations addressed to the signed-in user, across every tenant. */
export async function fetchMyInvitations(): Promise<PendingInvitation[]> {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${serverApiUrl()}/api/invitations`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  });
  if (!response.ok) {
    return [];
  }
  const { invitations } = (await response.json()) as { invitations: PendingInvitation[] };
  return invitations;
}

export interface PublicInvitation {
  email: string;
  role: string;
  status: 'pending' | 'accepted' | 'rejected' | 'canceled' | 'expired';
  organizationName: string;
  inviterName: string;
}

/** The invitation as its recipient sees it. Unauthenticated: the invitee may
 *  not have an account yet. Returns null when the link is unknown. */
export async function fetchPublicInvitation(id: string): Promise<PublicInvitation | null> {
  const response = await fetch(`${serverApiUrl()}/api/invitations/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as PublicInvitation;
}
