import { fromNodeHeaders } from 'better-auth/node';
import { asc, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { isTeamAdmin } from './admin/auth.js';
import type { Auth } from './auth.js';
import { ApiError, UnauthorizedError } from './errors.js';
import type { OrganizationRole } from './organizations.js';

type SessionResult = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;
export type SessionUser = SessionResult['user'];
export type OrganizationRow = typeof schema.organization.$inferSelect;
export type MemberRow = typeof schema.member.$inferSelect;

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser | undefined;
    organization?: OrganizationRow | undefined;
    /** The caller's membership in `organization` — the source of their role. */
    member?: MemberRow | undefined;
    sessionId?: string | undefined;
    /** Set by requireTeamAdmin once the platform-admin check has passed. */
    isTeamAdmin?: boolean | undefined;
    /** True while `organization` is a Team Admin "View as Vendor" support
     *  target rather than the caller's own tenant. See admin/routes.ts. */
    supportMode?: boolean | undefined;
  }
}

export interface RequireAuthDeps {
  auth: Auth;
  db: RuntimeDb;
  /** Team Admin env-grant allowlist — needed here too, since a support
   *  session is only honored for a caller who currently passes the
   *  platform-admin check. Defaults to no grants. */
  teamAdminEmails?: string[];
  envGrantsEnabled?: boolean;
}

/** The caller's role in the active organization, or 401 when they have none. */
export function requireRole(request: FastifyRequest): OrganizationRole {
  const role = request.member?.role;
  if (!role) {
    throw new UnauthorizedError('An organization is required');
  }
  return role as OrganizationRole;
}

/** Destructive tenant actions (destroy, purge, delete) need owner or admin. */
export function requireOwnerOrAdmin(request: FastifyRequest): void {
  if (requireRole(request) === 'member') {
    throw new ApiError(403, 'INSUFFICIENT_ROLE', 'Your role does not allow this action');
  }
}

// Central read-only guard for Team Admin's "View as Vendor" support mode
// (docs/admin/team-admin.md's View as Vendor security model): no vendor-facing
// write is classified safe in the MVP, so every non-GET/HEAD/OPTIONS request
// outside /api/admin/* is rejected while a support session is active.
function enforceSupportModeReadOnly(request: FastifyRequest): void {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  if (request.url.startsWith('/api/admin/')) return;
  throw new ApiError(
    403,
    'SUPPORT_MODE_READ_ONLY',
    'Support mode is read-only. Exit support mode to make changes.',
  );
}

// Fastify preHandler factory: resolves the Better Auth session from the
// request cookie, attaches request.user plus the active tenant
// (request.organization + request.member), and throws UnauthorizedError
// otherwise — the error handler renders the structured envelope.
//
// The tenant is attached ONLY through a membership row. A session pointing at
// an organization the user is no longer in resolves to a tenant they still
// belong to (and the pointer is repaired), never to the one they lost — so
// removing a member takes effect on their very next request.
export function createRequireAuth({
  auth,
  db,
  teamAdminEmails = [],
  envGrantsEnabled = true,
}: RequireAuthDeps) {
  return async function requireAuth(request: FastifyRequest): Promise<void> {
    const result = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!result) {
      throw new UnauthorizedError();
    }
    request.user = result.user;
    request.sessionId = result.session.id;

    // Team Admin "View as Vendor": resolved ONLY for a caller who still
    // passes the platform-admin check right now — a support_organization_id
    // left over on a non-admin's session (e.g. a revoked grant) is ignored,
    // never treated as a cross-tenant read.
    const supportOrganizationId = result.session.supportOrganizationId;
    if (supportOrganizationId && isTeamAdmin(result.user, teamAdminEmails, envGrantsEnabled)) {
      const [supportOrganization] = await db
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.id, supportOrganizationId))
        .limit(1);
      if (supportOrganization) {
        request.organization = supportOrganization;
        // Synthetic lowest-privilege role: the admin never inherits a real
        // membership in the vendor's organization.
        request.member = {
          id: 'support-session',
          organizationId: supportOrganization.id,
          userId: result.user.id,
          role: 'member',
          createdAt: new Date(),
        };
        request.supportMode = true;
        enforceSupportModeReadOnly(request);
        return;
      }
      // The target organization no longer exists — ignore the stale
      // pointer and fall through to normal tenant resolution below.
    }

    const memberships = await db
      .select({ member: schema.member, organization: schema.organization })
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
      .where(eq(schema.member.userId, result.user.id))
      .orderBy(asc(schema.organization.name));

    const { activeOrganizationId } = result.session;
    const active =
      memberships.find((row) => row.organization.id === activeOrganizationId) ?? memberships[0];
    if (!active) {
      return;
    }

    request.organization = active.organization;
    request.member = active.member;
    if (active.organization.id !== activeOrganizationId) {
      await db
        .update(schema.session)
        .set({ activeOrganizationId: active.organization.id })
        .where(eq(schema.session.id, result.session.id));
    }
  };
}
