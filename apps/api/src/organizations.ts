import { and, asc, desc, eq, gt, gte, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { BillingSubscriptionStatus } from '@deployz/contracts';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { sendQuietly, type EmailSender } from './email.js';
import { env } from './env.js';
import { ApiError, NotFoundError } from './errors.js';

// User, account and organization management: organizations, memberships,
// roles and invitations.
//
// Two rules hold everywhere in this file:
//   1. Isolation — every read and every write is scoped by the organization
//      the CALLER is a member of. Ids from the client are only ever used
//      inside a query that also pins organization_id.
//   2. Exactly one owner — an organization always has one owner and only one.
//      Ownership moves through transferOwnership(), never through a plain
//      role change, so "the last owner" can never be demoted, removed or
//      leave by accident.

export const ORGANIZATION_ROLES = ['owner', 'admin', 'member'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

/** Roles an invitation or a role change may carry — never 'owner'. */
export const ASSIGNABLE_ROLES = ['admin', 'member'] as const;

export const INVITATION_TTL_DAYS = 7;

const ROLE_RANK: Record<OrganizationRole, number> = { owner: 0, admin: 1, member: 2 };

export const organizationNameSchema = z.string().trim().min(1).max(80);

export const createOrganizationBodySchema = z.object({ name: organizationNameSchema });

export const updateOrganizationBodySchema = z.object({ name: organizationNameSchema });

export const deleteOrganizationBodySchema = z.object({ confirmName: z.string() });

export const inviteMemberBodySchema = z.object({
  email: z.email().max(254),
  role: z.enum(ASSIGNABLE_ROLES).default('member'),
});

export const updateMemberRoleBodySchema = z.object({ role: z.enum(ASSIGNABLE_ROLES) });

export const transferOwnershipBodySchema = z.object({ memberId: z.string().min(1) });

export const deleteAccountBodySchema = z.object({ confirmEmail: z.string() });

export interface Actor {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

/** Invitations are tied to an e-mail address, so only an address the caller
 *  has proven to own may send, list or answer them. */
export function requireVerifiedEmail(actor: Actor): void {
  if (!actor.emailVerified) {
    throw new ApiError(
      403,
      'EMAIL_NOT_VERIFIED',
      'Verify your email address first. Open the verification link we sent to your inbox.',
    );
  }
}

export interface OrganizationDeps {
  readonly db: RuntimeDb;
  readonly emailSender: EmailSender;
  /** Web origin — the base for invitation links in outgoing email. */
  readonly webUrl: string;
}

// ── Small shared helpers ────────────────────────────────────────────────────

/** URL-safe slug from a display name plus a random-id suffix for uniqueness. */
export function organizationSlug(name: string, seed: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'org'}-${seed.replace(/-/g, '').slice(0, 8)}`;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function requireRole(role: OrganizationRole, allowed: readonly OrganizationRole[]): void {
  if (!allowed.includes(role)) {
    throw new ApiError(403, 'INSUFFICIENT_ROLE', 'Your role does not allow this action');
  }
}

/** Append-only §40/§62 audit row. Never throws into the caller's path. */
export async function recordAuditEvent(
  db: RuntimeDb,
  entry: {
    organizationId: string;
    actorId: string;
    eventType: string;
    previousState?: string | null;
    requestedState?: string | null;
    result?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(schema.eventLogs).values({
    actorType: 'user',
    actorId: entry.actorId,
    organizationId: entry.organizationId,
    eventType: entry.eventType,
    previousState: entry.previousState ?? null,
    requestedState: entry.requestedState ?? null,
    result: entry.result ?? 'success',
    payload: entry.payload ?? {},
  });
}

/** Loads a member BY ID BUT ALWAYS PINNED TO THE CALLER'S ORGANIZATION — a
 *  member id from another tenant resolves to 404, never to a cross-org write. */
async function loadOwnedMember(
  db: RuntimeDb,
  organizationId: string,
  memberId: string,
): Promise<typeof schema.member.$inferSelect> {
  const rows = await db
    .select()
    .from(schema.member)
    .where(and(eq(schema.member.id, memberId), eq(schema.member.organizationId, organizationId)))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Member not found');
  }
  return rows[0]!;
}

async function loadOwnedInvitation(
  db: RuntimeDb,
  organizationId: string,
  invitationId: string,
): Promise<typeof schema.invitation.$inferSelect> {
  const rows = await db
    .select()
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.id, invitationId),
        eq(schema.invitation.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError('Invitation not found');
  }
  return rows[0]!;
}

function expiryFromNow(): Date {
  return new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Points the caller at an organization. The session row is what
 * require-auth.ts reads on every request; the copy on the user row is what
 * survives sign-out, so the next sign-in resumes the same tenant.
 */
async function setActiveOrganization(
  db: RuntimeDb,
  userId: string,
  sessionId: string,
  organizationId: string,
): Promise<void> {
  await db
    .update(schema.session)
    .set({ activeOrganizationId: organizationId })
    .where(eq(schema.session.id, sessionId));
  await db
    .update(schema.user)
    .set({ lastActiveOrganizationId: organizationId })
    .where(eq(schema.user.id, userId));
}

// ── Views ───────────────────────────────────────────────────────────────────

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  // Null when the organization has no billing_subscriptions row — evaluation
  // mode, not any particular subscription state.
  subscriptionStatus: BillingSubscriptionStatus | null;
  role: OrganizationRole;
  memberCount: number;
  createdAt: Date;
}

export async function listOrganizations(
  db: RuntimeDb,
  userId: string,
): Promise<OrganizationSummary[]> {
  const rows = await db
    .select({
      id: schema.organization.id,
      name: schema.organization.name,
      slug: schema.organization.slug,
      subscriptionStatus: schema.billingSubscriptions.status,
      role: schema.member.role,
      createdAt: schema.organization.createdAt,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
    .leftJoin(
      schema.billingSubscriptions,
      eq(schema.billingSubscriptions.organizationId, schema.organization.id),
    )
    .where(eq(schema.member.userId, userId))
    .orderBy(asc(schema.organization.name));

  if (rows.length === 0) {
    return [];
  }

  const counts = await db
    .select({ organizationId: schema.member.organizationId, id: schema.member.id })
    .from(schema.member)
    .where(
      inArray(
        schema.member.organizationId,
        rows.map((row) => row.id),
      ),
    );
  const memberCounts = new Map<string, number>();
  for (const row of counts) {
    memberCounts.set(row.organizationId, (memberCounts.get(row.organizationId) ?? 0) + 1);
  }

  return rows.map((row) => ({
    ...row,
    role: row.role as OrganizationRole,
    memberCount: memberCounts.get(row.id) ?? 1,
  }));
}

export interface MemberView {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: OrganizationRole;
  createdAt: Date;
}

export async function listMembers(
  db: RuntimeDb,
  organizationId: string,
): Promise<MemberView[]> {
  const rows = await db
    .select({
      id: schema.member.id,
      userId: schema.member.userId,
      role: schema.member.role,
      createdAt: schema.member.createdAt,
      name: schema.user.name,
      email: schema.user.email,
    })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(eq(schema.member.organizationId, organizationId));

  return rows
    .map((row) => ({ ...row, role: row.role as OrganizationRole }))
    .sort(
      (a, b) =>
        ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.createdAt.getTime() - b.createdAt.getTime(),
    );
}

export interface InvitationView {
  id: string;
  email: string;
  role: string;
  status: string;
  expired: boolean;
  expiresAt: Date;
  createdAt: Date;
  invitedByName: string;
}

function toInvitationView(
  row: typeof schema.invitation.$inferSelect,
  invitedByName: string,
): InvitationView {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    expired: row.status === 'pending' && row.expiresAt.getTime() <= Date.now(),
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    invitedByName,
  };
}

export async function listInvitations(
  db: RuntimeDb,
  organizationId: string,
): Promise<InvitationView[]> {
  const rows = await db
    .select({ invitation: schema.invitation, inviterName: schema.user.name })
    .from(schema.invitation)
    .innerJoin(schema.user, eq(schema.invitation.inviterId, schema.user.id))
    .where(
      and(
        eq(schema.invitation.organizationId, organizationId),
        eq(schema.invitation.status, 'pending'),
      ),
    )
    .orderBy(desc(schema.invitation.createdAt));
  return rows.map((row) => toInvitationView(row.invitation, row.inviterName));
}

/** Pending invitations addressed to the signed-in user, across every tenant. */
export async function listInvitationsForEmail(
  db: RuntimeDb,
  email: string,
): Promise<{ id: string; organizationName: string; role: string; expiresAt: Date }[]> {
  const rows = await db
    .select({
      id: schema.invitation.id,
      role: schema.invitation.role,
      expiresAt: schema.invitation.expiresAt,
      organizationName: schema.organization.name,
    })
    .from(schema.invitation)
    .innerJoin(schema.organization, eq(schema.invitation.organizationId, schema.organization.id))
    .where(
      and(
        eq(schema.invitation.email, normalizeEmail(email)),
        eq(schema.invitation.status, 'pending'),
      ),
    )
    .orderBy(desc(schema.invitation.createdAt));
  return rows.filter((row) => row.expiresAt.getTime() > Date.now());
}

/** The organization's current subscription status, or null in evaluation
 *  mode (no billing_subscriptions row). */
export async function getSubscriptionStatus(
  db: RuntimeDb,
  organizationId: string,
): Promise<BillingSubscriptionStatus | null> {
  const [row] = await db
    .select({ status: schema.billingSubscriptions.status })
    .from(schema.billingSubscriptions)
    .where(eq(schema.billingSubscriptions.organizationId, organizationId))
    .limit(1);
  return row?.status ?? null;
}

// ── Organization lifecycle ──────────────────────────────────────────────────

/**
 * Paddle migration Phase 7 fixture mode: give a fresh organization a normal
 * ACTIVE billing_subscriptions row (fixture ids only — never a realistic
 * Paddle id), so a caller under billingFixtureMode exercises the real
 * entitlement gate in billing-entitlements.ts instead of always hitting 402
 * SUBSCRIPTION_REQUIRED. Called from here (POST /api/organizations) and from
 * auth.ts's signup session hook — the two places a fresh organization exists.
 */
export async function seedFixtureBillingSubscription(
  db: RuntimeDb,
  organizationId: string,
): Promise<void> {
  const now = new Date();
  await db.insert(schema.billingSubscriptions).values({
    organizationId,
    providerCustomerId: `ctm_fixture_${organizationId}`,
    providerSubscriptionId: `sub_fixture_${organizationId}`,
    status: 'ACTIVE',
    currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
  });
}

export async function createOrganization(
  db: RuntimeDb,
  actor: Actor,
  sessionId: string,
  body: z.infer<typeof createOrganizationBodySchema>,
  // Injectable so tests can flip it without mutating module-level env
  // (mirrors ServerDeps.githubFixtureMode's `?? env.x` fallback).
  billingFixtureMode: boolean = env.billingFixtureMode,
): Promise<OrganizationSummary> {
  const id = crypto.randomUUID();
  const [organization] = await db
    .insert(schema.organization)
    .values({ id, name: body.name, slug: organizationSlug(body.name, id) })
    .returning();
  await db
    .insert(schema.member)
    .values({ id: crypto.randomUUID(), organizationId: id, userId: actor.id, role: 'owner' });
  await setActiveOrganization(db, actor.id, sessionId, id);
  if (billingFixtureMode) {
    await seedFixtureBillingSubscription(db, id);
  }
  await recordAuditEvent(db, {
    organizationId: id,
    actorId: actor.id,
    eventType: 'organization.created',
    payload: { name: body.name },
  });

  return {
    id,
    name: organization!.name,
    slug: organization!.slug,
    // A brand-new organization has no billing_subscriptions row yet, unless
    // fixture mode just seeded one.
    subscriptionStatus: billingFixtureMode ? 'ACTIVE' : null,
    role: 'owner',
    memberCount: 1,
    createdAt: organization!.createdAt,
  };
}

export async function activateOrganization(
  db: RuntimeDb,
  actor: Actor,
  sessionId: string,
  organizationId: string,
): Promise<OrganizationSummary> {
  const organizations = await listOrganizations(db, actor.id);
  const target = organizations.find((organization) => organization.id === organizationId);
  if (!target) {
    // Not a member — the organization must not be distinguishable from one
    // that does not exist.
    throw new NotFoundError('Organization not found');
  }
  await setActiveOrganization(db, actor.id, sessionId, organizationId);
  return target;
}

export async function updateOrganization(
  db: RuntimeDb,
  actor: Actor,
  organizationId: string,
  role: OrganizationRole,
  body: z.infer<typeof updateOrganizationBodySchema>,
): Promise<typeof schema.organization.$inferSelect> {
  requireRole(role, ['owner', 'admin']);
  const [previous] = await db
    .select()
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);
  if (!previous) {
    throw new NotFoundError('Organization not found');
  }
  const [row] = await db
    .update(schema.organization)
    .set({ name: body.name })
    .where(eq(schema.organization.id, organizationId))
    .returning();
  await recordAuditEvent(db, {
    organizationId,
    actorId: actor.id,
    eventType: 'organization.updated',
    previousState: previous.name,
    requestedState: body.name,
  });
  return row!;
}

/**
 * Hard-deletes an organization and everything under it. Owner only, and only
 * once nothing is running in a customer account: a live deployment lives in
 * SOMEONE ELSE'S AWS account, so orphaning it by deleting the control-plane
 * record would leave real infrastructure nobody can reach.
 */
export async function deleteOrganization(
  db: RuntimeDb,
  deps: OrganizationDeps,
  actor: Actor,
  organizationId: string,
  role: OrganizationRole,
  body: z.infer<typeof deleteOrganizationBodySchema>,
): Promise<void> {
  requireRole(role, ['owner']);

  const [organization] = await db
    .select()
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);
  if (!organization) {
    throw new NotFoundError('Organization not found');
  }
  if (body.confirmName.trim() !== organization.name) {
    throw new ApiError(
      400,
      'CONFIRMATION_MISMATCH',
      'Type the organization name exactly to confirm',
    );
  }

  const deployments = await db
    .select({
      id: schema.deployments.id,
      state: schema.deployments.state,
      cleanupState: schema.deployments.cleanupState,
    })
    .from(schema.deployments)
    .where(eq(schema.deployments.organizationId, organizationId));
  const live = deployments.filter(
    (deployment) =>
      deployment.state !== 'DELETED' &&
      deployment.state !== 'NOT_INSTALLED' &&
      deployment.state !== 'WAITING_FOR_RELAY',
  );
  if (live.length > 0) {
    throw new ApiError(
      409,
      'ORGANIZATION_HAS_ACTIVE_DEPLOYMENTS',
      `Remove the ${live.length} remaining customer deployment${live.length === 1 ? '' : 's'} before you delete this organization`,
    );
  }

  // A removed deployment keeps its database, files and secrets in the
  // customer's account until a purge completes. Deleting the record now
  // would leave nobody able to purge them.
  const unpurged = deployments.filter(
    (deployment) => deployment.state === 'DELETED' && deployment.cleanupState !== 'COMPLETE',
  );
  if (unpurged.length > 0) {
    throw new ApiError(
      409,
      'ORGANIZATION_HAS_UNPURGED_RESOURCES',
      `Purge the retained resources of ${unpurged.length} removed deployment${unpurged.length === 1 ? '' : 's'} before you delete this organization`,
    );
  }

  const members = await listMembers(db, organizationId);
  const applications = await db
    .select({ id: schema.applications.id })
    .from(schema.applications)
    .where(eq(schema.applications.organizationId, organizationId));
  const applicationIds = applications.map((application) => application.id);
  const deploymentIds = deployments.map((deployment) => deployment.id);

  // Leaf-first so no foreign key is ever left dangling, all in one
  // transaction so a failure leaves the organization whole. event_logs is
  // deliberately untouched: the audit stream outlives what it describes.
  await db.transaction(async (tx) => {
    if (deploymentIds.length > 0) {
      await tx
        .delete(schema.deploymentStackEvents)
        .where(inArray(schema.deploymentStackEvents.deploymentId, deploymentIds));
      await tx
        .delete(schema.deploymentJobs)
        .where(inArray(schema.deploymentJobs.deploymentId, deploymentIds));
      await tx
        .delete(schema.deploymentResources)
        .where(inArray(schema.deploymentResources.deploymentId, deploymentIds));
    }
    if (applicationIds.length > 0) {
      await tx
        .delete(schema.applicationConfigs)
        .where(inArray(schema.applicationConfigs.applicationId, applicationIds));
      await tx
        .delete(schema.jevShadowVerifications)
        .where(inArray(schema.jevShadowVerifications.applicationId, applicationIds));
    }
    // These rows FK to deployments (and to applications and customers) — they
    // go leaf-first, before the rows they point at.
    await tx
      .delete(schema.billingCheckoutIntents)
      .where(eq(schema.billingCheckoutIntents.organizationId, organizationId));
    await tx.delete(schema.customDomains).where(eq(schema.customDomains.organizationId, organizationId));
    await tx.delete(schema.pendingSecrets).where(eq(schema.pendingSecrets.organizationId, organizationId));
    await tx.delete(schema.deployLinks).where(eq(schema.deployLinks.organizationId, organizationId));
    await tx.delete(schema.deployments).where(eq(schema.deployments.organizationId, organizationId));
    await tx
      .delete(schema.publicInstallLinks)
      .where(eq(schema.publicInstallLinks.organizationId, organizationId));
    if (applicationIds.length > 0) {
      await tx.delete(schema.releases).where(inArray(schema.releases.applicationId, applicationIds));
    }
    await tx.delete(schema.applications).where(eq(schema.applications.organizationId, organizationId));
    await tx.delete(schema.customers).where(eq(schema.customers.organizationId, organizationId));
    await tx
      .delete(schema.githubInstallations)
      .where(eq(schema.githubInstallations.organizationId, organizationId));
    // Billing rows FK to organization — leaf-first before the org itself goes.
    await tx
      .delete(schema.billingReconciliationEvents)
      .where(eq(schema.billingReconciliationEvents.organizationId, organizationId));
    await tx
      .delete(schema.billingProviderEvents)
      .where(eq(schema.billingProviderEvents.organizationId, organizationId));
    await tx
      .delete(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.organizationId, organizationId));
    await tx.delete(schema.invitation).where(eq(schema.invitation.organizationId, organizationId));
    await tx.delete(schema.member).where(eq(schema.member.organizationId, organizationId));
    // Sessions still pointing here must lose the pointer, or their next request
    // would resolve a tenant that no longer exists.
    await tx
      .update(schema.session)
      .set({ activeOrganizationId: null })
      .where(eq(schema.session.activeOrganizationId, organizationId));
    await tx
      .update(schema.user)
      .set({ lastActiveOrganizationId: null })
      .where(eq(schema.user.lastActiveOrganizationId, organizationId));
    await tx.delete(schema.organization).where(eq(schema.organization.id, organizationId));
  });

  await recordAuditEvent(db, {
    organizationId,
    actorId: actor.id,
    eventType: 'organization.deleted',
    payload: { name: organization.name, memberCount: members.length },
  });

  for (const member of members) {
    if (member.userId === actor.id) continue;
    await sendQuietly(deps.emailSender, {
      to: member.email,
      subject: `${organization.name} has been deleted`,
      body: `${actor.name} deleted the organization "${organization.name}" on Deployz. You no longer have access to it.`,
    });
  }
}

// ── Members ─────────────────────────────────────────────────────────────────

export async function updateMemberRole(
  db: RuntimeDb,
  deps: OrganizationDeps,
  actor: Actor,
  organizationId: string,
  role: OrganizationRole,
  memberId: string,
  body: z.infer<typeof updateMemberRoleBodySchema>,
): Promise<MemberView> {
  requireRole(role, ['owner', 'admin']);
  const target = await loadOwnedMember(db, organizationId, memberId);

  if (target.userId === actor.id) {
    throw new ApiError(403, 'SELF_ROLE_CHANGE', 'You cannot change your own role');
  }
  if (target.role === 'owner') {
    throw new ApiError(
      403,
      'OWNER_ROLE_LOCKED',
      'The owner keeps their role until ownership is transferred',
    );
  }
  if (role === 'admin' && target.role === 'admin') {
    throw new ApiError(403, 'INSUFFICIENT_ROLE', 'Only the owner can change an admin’s role');
  }

  await db
    .update(schema.member)
    .set({ role: body.role })
    .where(and(eq(schema.member.id, memberId), eq(schema.member.organizationId, organizationId)));

  const [organization] = await db
    .select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);
  const [targetUser] = await db
    .select({ name: schema.user.name, email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, target.userId))
    .limit(1);

  await recordAuditEvent(db, {
    organizationId,
    actorId: actor.id,
    eventType: 'member.role.changed',
    previousState: target.role,
    requestedState: body.role,
    payload: { memberId, userId: target.userId },
  });

  if (targetUser) {
    await sendQuietly(deps.emailSender, {
      to: targetUser.email,
      subject: `Your role in ${organization?.name ?? 'your organization'} changed`,
      body: `${actor.name} changed your role in "${organization?.name ?? 'your organization'}" from ${target.role} to ${body.role}.`,
    });
  }

  return {
    id: target.id,
    userId: target.userId,
    name: targetUser?.name ?? '',
    email: targetUser?.email ?? '',
    role: body.role,
    createdAt: target.createdAt,
  };
}

export async function removeMember(
  db: RuntimeDb,
  deps: OrganizationDeps,
  actor: Actor,
  organizationId: string,
  role: OrganizationRole,
  memberId: string,
): Promise<void> {
  requireRole(role, ['owner', 'admin']);
  const target = await loadOwnedMember(db, organizationId, memberId);

  if (target.userId === actor.id) {
    throw new ApiError(403, 'SELF_REMOVAL', 'Leave the organization instead of removing yourself');
  }
  if (target.role === 'owner') {
    throw new ApiError(
      403,
      'LAST_OWNER',
      'The owner cannot be removed — transfer ownership first',
    );
  }
  if (role === 'admin' && target.role === 'admin') {
    throw new ApiError(403, 'INSUFFICIENT_ROLE', 'Only the owner can remove an admin');
  }

  const [organization] = await db
    .select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);
  const [targetUser] = await db
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, target.userId))
    .limit(1);

  await db
    .delete(schema.member)
    .where(and(eq(schema.member.id, memberId), eq(schema.member.organizationId, organizationId)));
  // The removed member's sessions must stop resolving this tenant on their
  // very next request, not whenever they happen to sign in again.
  await db
    .update(schema.session)
    .set({ activeOrganizationId: null })
    .where(
      and(
        eq(schema.session.userId, target.userId),
        eq(schema.session.activeOrganizationId, organizationId),
      ),
    );
  await db
    .update(schema.user)
    .set({ lastActiveOrganizationId: null })
    .where(
      and(
        eq(schema.user.id, target.userId),
        eq(schema.user.lastActiveOrganizationId, organizationId),
      ),
    );

  await recordAuditEvent(db, {
    organizationId,
    actorId: actor.id,
    eventType: 'member.removed',
    previousState: target.role,
    payload: { memberId, userId: target.userId },
  });

  if (targetUser) {
    await sendQuietly(deps.emailSender, {
      to: targetUser.email,
      subject: `You were removed from ${organization?.name ?? 'an organization'}`,
      body: `${actor.name} removed you from "${organization?.name ?? 'an organization'}" on Deployz.`,
    });
  }
}

export async function leaveOrganization(
  db: RuntimeDb,
  actor: Actor,
  organizationId: string,
  role: OrganizationRole,
): Promise<void> {
  if (role === 'owner') {
    throw new ApiError(
      409,
      'LAST_OWNER',
      'Transfer ownership to another member before you leave, or delete the organization',
    );
  }

  await db
    .delete(schema.member)
    .where(
      and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, actor.id)),
    );

  // Every session of theirs that still points here — this one included —
  // moves to whatever organization they have left, or to none at all.
  const remaining = await listOrganizations(db, actor.id);
  const fallback = remaining[0]?.id ?? null;
  await db
    .update(schema.session)
    .set({ activeOrganizationId: fallback })
    .where(
      and(
        eq(schema.session.userId, actor.id),
        eq(schema.session.activeOrganizationId, organizationId),
      ),
    );
  await db
    .update(schema.user)
    .set({ lastActiveOrganizationId: fallback })
    .where(eq(schema.user.id, actor.id));

  await recordAuditEvent(db, {
    organizationId,
    actorId: actor.id,
    eventType: 'member.left',
    previousState: role,
    payload: { userId: actor.id },
  });
}

export async function transferOwnership(
  db: RuntimeDb,
  deps: OrganizationDeps,
  actor: Actor,
  organizationId: string,
  role: OrganizationRole,
  body: z.infer<typeof transferOwnershipBodySchema>,
): Promise<void> {
  requireRole(role, ['owner']);
  const target = await loadOwnedMember(db, organizationId, body.memberId);
  if (target.userId === actor.id) {
    throw new ApiError(400, 'ALREADY_OWNER', 'You already own this organization');
  }

  // The outgoing owner stays on as an admin — an organization must never be
  // left without someone who can administer it. Both updates commit together
  // and each one only matches the row the checks above saw, so a concurrent
  // transfer (or a removal of the target) changes nothing and the
  // organization keeps exactly one owner.
  await db.transaction(async (tx) => {
    const demoted = await tx
      .update(schema.member)
      .set({ role: 'admin' })
      .where(
        and(
          eq(schema.member.organizationId, organizationId),
          eq(schema.member.userId, actor.id),
          eq(schema.member.role, 'owner'),
        ),
      )
      .returning();
    if (demoted.length === 0) {
      throw new ApiError(403, 'INSUFFICIENT_ROLE', 'Your role does not allow this action');
    }
    const promoted = await tx
      .update(schema.member)
      .set({ role: 'owner' })
      .where(and(eq(schema.member.id, target.id), eq(schema.member.organizationId, organizationId)))
      .returning();
    if (promoted.length === 0) {
      throw new NotFoundError('Member not found');
    }
  });

  const [organization] = await db
    .select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);
  const [targetUser] = await db
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, target.userId))
    .limit(1);

  await recordAuditEvent(db, {
    organizationId,
    actorId: actor.id,
    eventType: 'organization.ownership.transferred',
    previousState: actor.id,
    requestedState: target.userId,
    payload: { memberId: target.id },
  });

  if (targetUser) {
    await sendQuietly(deps.emailSender, {
      to: targetUser.email,
      subject: `You now own ${organization?.name ?? 'your organization'}`,
      body: `${actor.name} transferred ownership of "${organization?.name ?? 'your organization'}" to you on Deployz.`,
    });
  }
}

// ── Invitations ─────────────────────────────────────────────────────────────

const INVITATIONS_PER_DAY = 50;
const MAX_MAIL_NAME_LENGTH = 80;

/** User-chosen text that goes into an e-mail: no control characters (no
 *  header or line injection) and a fixed maximum length. */
function mailText(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .trim()
    .slice(0, MAX_MAIL_NAME_LENGTH);
}

/** Invitation e-mails reach arbitrary addresses, so one organization or one
 *  sender may only send a fixed number per day (create and resend count). */
async function assertInvitationQuota(
  db: RuntimeDb,
  organizationId: string,
  actorId: string,
): Promise<void> {
  const [sent] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.eventLogs)
    .where(
      and(
        inArray(schema.eventLogs.eventType, ['member.invited', 'member.invitation.resent']),
        or(
          eq(schema.eventLogs.organizationId, organizationId),
          eq(schema.eventLogs.actorId, actorId),
        ),
        gte(schema.eventLogs.occurredAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
      ),
    );
  if ((sent?.count ?? 0) >= INVITATIONS_PER_DAY) {
    throw new ApiError(
      429,
      'INVITATION_LIMIT_REACHED',
      'You sent too many invitations today. Try again tomorrow.',
    );
  }
}

function invitationEmail(
  deps: OrganizationDeps,
  args: { to: string; organizationName: string; inviterName: string; invitationId: string; role: string },
): { to: string; subject: string; body: string } {
  const link = `${deps.webUrl}/accept-invitation/${args.invitationId}`;
  const inviterName = mailText(args.inviterName);
  const organizationName = mailText(args.organizationName);
  return {
    to: args.to,
    subject: `${inviterName} invited you to ${organizationName} on Deployz`,
    body: [
      `${inviterName} invited you to join "${organizationName}" on Deployz as a ${args.role}.`,
      '',
      `Accept the invitation: ${link}`,
      '',
      `The invitation expires in ${INVITATION_TTL_DAYS} days.`,
    ].join('\n'),
  };
}

export async function createInvitation(
  deps: OrganizationDeps,
  actor: Actor,
  organizationId: string,
  role: OrganizationRole,
  body: z.infer<typeof inviteMemberBodySchema>,
): Promise<InvitationView> {
  const { db } = deps;
  requireRole(role, ['owner', 'admin']);
  requireVerifiedEmail(actor);
  await assertInvitationQuota(db, organizationId, actor.id);
  const email = normalizeEmail(body.email);

  const existingMember = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(
      and(
        eq(schema.member.organizationId, organizationId),
        sql`lower(${schema.user.email}) = ${email}`,
      ),
    )
    .limit(1);
  if (existingMember.length > 0) {
    throw new ApiError(409, 'ALREADY_MEMBER', 'That person is already in this organization');
  }

  const [organization] = await db
    .select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);
  if (!organization) {
    throw new NotFoundError('Organization not found');
  }

  // A still-live invitation is a duplicate; an expired one is simply reissued.
  const [existing] = await db
    .select()
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.organizationId, organizationId),
        eq(schema.invitation.email, email),
        eq(schema.invitation.status, 'pending'),
      ),
    )
    .limit(1);

  let row: typeof schema.invitation.$inferSelect;
  if (existing) {
    if (existing.expiresAt.getTime() > Date.now()) {
      throw new ApiError(
        409,
        'ALREADY_INVITED',
        'That person already has a pending invitation — resend it instead',
      );
    }
    const [updated] = await db
      .update(schema.invitation)
      .set({ role: body.role, expiresAt: expiryFromNow(), inviterId: actor.id })
      .where(eq(schema.invitation.id, existing.id))
      .returning();
    row = updated!;
  } else {
    // A concurrent invite for the same address loses on the pending-invitation
    // unique index and gets the same answer as a sequential duplicate.
    const [inserted] = await db
      .insert(schema.invitation)
      .values({
        id: crypto.randomUUID(),
        organizationId,
        email,
        role: body.role,
        status: 'pending',
        expiresAt: expiryFromNow(),
        inviterId: actor.id,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) {
      throw new ApiError(
        409,
        'ALREADY_INVITED',
        'That person already has a pending invitation — resend it instead',
      );
    }
    row = inserted;
  }

  await recordAuditEvent(db, {
    organizationId,
    actorId: actor.id,
    eventType: 'member.invited',
    requestedState: body.role,
    payload: { invitationId: row.id, email },
  });

  await sendQuietly(
    deps.emailSender,
    invitationEmail(deps, {
      to: email,
      organizationName: organization.name,
      inviterName: actor.name,
      invitationId: row.id,
      role: body.role,
    }),
  );

  return toInvitationView(row, actor.name);
}

export async function resendInvitation(
  deps: OrganizationDeps,
  actor: Actor,
  organizationId: string,
  role: OrganizationRole,
  invitationId: string,
): Promise<InvitationView> {
  const { db } = deps;
  requireRole(role, ['owner', 'admin']);
  requireVerifiedEmail(actor);
  await assertInvitationQuota(db, organizationId, actor.id);
  const existing = await loadOwnedInvitation(db, organizationId, invitationId);
  if (existing.status !== 'pending') {
    throw new ApiError(
      409,
      'INVITATION_NOT_PENDING',
      'This invitation has already been answered',
    );
  }

  const [row] = await db
    .update(schema.invitation)
    .set({ expiresAt: expiryFromNow(), inviterId: actor.id })
    .where(eq(schema.invitation.id, invitationId))
    .returning();

  const [organization] = await db
    .select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, organizationId))
    .limit(1);

  await recordAuditEvent(db, {
    organizationId,
    actorId: actor.id,
    eventType: 'member.invitation.resent',
    payload: { invitationId, email: existing.email },
  });

  await sendQuietly(
    deps.emailSender,
    invitationEmail(deps, {
      to: existing.email,
      organizationName: organization?.name ?? 'your organization',
      inviterName: actor.name,
      invitationId,
      role: row!.role,
    }),
  );

  return toInvitationView(row!, actor.name);
}

export async function revokeInvitation(
  db: RuntimeDb,
  actor: Actor,
  organizationId: string,
  role: OrganizationRole,
  invitationId: string,
): Promise<void> {
  requireRole(role, ['owner', 'admin']);
  const existing = await loadOwnedInvitation(db, organizationId, invitationId);
  if (existing.status !== 'pending') {
    throw new ApiError(
      409,
      'INVITATION_NOT_PENDING',
      'This invitation has already been answered',
    );
  }
  await claimPendingInvitation(db, invitationId, 'canceled');
  await recordAuditEvent(db, {
    organizationId,
    actorId: actor.id,
    eventType: 'member.invitation.revoked',
    previousState: 'pending',
    requestedState: 'canceled',
    payload: { invitationId, email: existing.email },
  });
}

export interface PublicInvitationView {
  email: string;
  role: string;
  status: 'pending' | 'accepted' | 'rejected' | 'canceled' | 'expired';
  organizationName: string;
  inviterName: string;
}

/**
 * The invitation as the RECIPIENT sees it — unauthenticated, because the
 * invitee may not have an account yet. Only the fields the accept screen has
 * to show: no ids of other tenants, no member list, no organization internals.
 */
export async function getPublicInvitation(
  db: RuntimeDb,
  invitationId: string,
): Promise<PublicInvitationView> {
  const rows = await db
    .select({
      email: schema.invitation.email,
      role: schema.invitation.role,
      status: schema.invitation.status,
      expiresAt: schema.invitation.expiresAt,
      organizationName: schema.organization.name,
      inviterName: schema.user.name,
    })
    .from(schema.invitation)
    .innerJoin(schema.organization, eq(schema.invitation.organizationId, schema.organization.id))
    .innerJoin(schema.user, eq(schema.invitation.inviterId, schema.user.id))
    .where(eq(schema.invitation.id, invitationId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new NotFoundError('Invitation not found');
  }
  const expired = row.status === 'pending' && row.expiresAt.getTime() <= Date.now();
  return {
    email: row.email,
    role: row.role,
    status: expired ? 'expired' : (row.status as PublicInvitationView['status']),
    organizationName: row.organizationName,
    inviterName: row.inviterName,
  };
}

/** Shared gate for accept/reject: the invitation must be live AND addressed
 *  to the signed-in user. */
async function loadAnswerableInvitation(
  db: RuntimeDb,
  actor: Actor,
  invitationId: string,
): Promise<typeof schema.invitation.$inferSelect> {
  requireVerifiedEmail(actor);
  const rows = await db
    .select()
    .from(schema.invitation)
    .where(eq(schema.invitation.id, invitationId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new NotFoundError('Invitation not found');
  }
  if (row.email !== normalizeEmail(actor.email)) {
    // 404, not 403: an invitation for someone else must not be confirmable
    // by whoever holds the link.
    throw new NotFoundError('Invitation not found');
  }
  if (row.status !== 'pending') {
    throw new ApiError(409, 'INVITATION_NOT_PENDING', 'This invitation has already been answered');
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(410, 'INVITATION_EXPIRED', 'This invitation has expired — ask for a new one');
  }
  return row;
}

/** Moves an invitation out of 'pending' only if it is still pending (and,
 *  for the invitee's answer, unexpired), so a concurrent accept, reject or
 *  revoke settles it once. */
async function claimPendingInvitation(
  db: RuntimeDb,
  invitationId: string,
  status: 'accepted' | 'rejected' | 'canceled',
): Promise<void> {
  const claimed = await db
    .update(schema.invitation)
    .set({ status })
    .where(
      and(
        eq(schema.invitation.id, invitationId),
        eq(schema.invitation.status, 'pending'),
        status === 'canceled' ? undefined : gt(schema.invitation.expiresAt, new Date()),
      ),
    )
    .returning();
  if (claimed.length === 0) {
    throw new ApiError(409, 'INVITATION_NOT_PENDING', 'This invitation has already been answered');
  }
}

export async function acceptInvitation(
  deps: OrganizationDeps,
  actor: Actor,
  sessionId: string,
  invitationId: string,
): Promise<OrganizationSummary> {
  const { db } = deps;
  const row = await loadAnswerableInvitation(db, actor, invitationId);

  await db.transaction(async (tx) => {
    await claimPendingInvitation(tx, invitationId, 'accepted');
    await tx
      .insert(schema.member)
      .values({
        id: crypto.randomUUID(),
        organizationId: row.organizationId,
        userId: actor.id,
        role: row.role,
      })
      .onConflictDoNothing();
  });

  await recordAuditEvent(db, {
    organizationId: row.organizationId,
    actorId: actor.id,
    eventType: 'member.invitation.accepted',
    requestedState: row.role,
    payload: { invitationId, email: row.email },
  });

  const [inviter] = await db
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, row.inviterId))
    .limit(1);
  const [organization] = await db
    .select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, row.organizationId))
    .limit(1);
  if (inviter) {
    await sendQuietly(deps.emailSender, {
      to: inviter.email,
      subject: `${actor.name} joined ${organization?.name ?? 'your organization'}`,
      body: `${actor.name} (${actor.email}) accepted your invitation and is now a ${row.role} of "${organization?.name ?? 'your organization'}".`,
    });
  }

  // Land the new member inside the organization they just joined.
  return activateOrganization(db, actor, sessionId, row.organizationId);
}

export async function rejectInvitation(
  db: RuntimeDb,
  actor: Actor,
  invitationId: string,
): Promise<void> {
  const row = await loadAnswerableInvitation(db, actor, invitationId);
  await claimPendingInvitation(db, invitationId, 'rejected');
  await recordAuditEvent(db, {
    organizationId: row.organizationId,
    actorId: actor.id,
    eventType: 'member.invitation.rejected',
    previousState: 'pending',
    requestedState: 'rejected',
    payload: { invitationId, email: row.email },
  });
}

// ── Account ─────────────────────────────────────────────────────────────────

/**
 * Deletes the signed-in user. Organizations they own are only removed when
 * they are the sole member — an owned organization with other people in it
 * must have its ownership transferred first, so a team is never destroyed by
 * one person closing their account.
 */
export async function deleteAccount(
  db: RuntimeDb,
  deps: OrganizationDeps,
  actor: Actor,
  body: z.infer<typeof deleteAccountBodySchema>,
): Promise<void> {
  if (normalizeEmail(body.confirmEmail) !== normalizeEmail(actor.email)) {
    throw new ApiError(400, 'CONFIRMATION_MISMATCH', 'Type your email address exactly to confirm');
  }

  const organizations = await listOrganizations(db, actor.id);
  const owned = organizations.filter((organization) => organization.role === 'owner');
  const blocking = owned.filter((organization) => organization.memberCount > 1);
  if (blocking.length > 0) {
    throw new ApiError(
      409,
      'OWNERSHIP_REQUIRED',
      `Transfer ownership of ${blocking.map((organization) => `"${organization.name}"`).join(', ')} before you delete your account`,
    );
  }

  await db.transaction(async (tx) => {
    for (const organization of owned) {
      await deleteOrganization(tx, deps, actor, organization.id, 'owner', {
        confirmName: organization.name,
      });
    }

    await recordAuditEvent(tx, {
      organizationId: organizations[0]?.id ?? 'none',
      actorId: actor.id,
      eventType: 'account.deleted',
      payload: { email: actor.email },
    });

    // member / session / account rows all cascade from user.
    await tx.delete(schema.invitation).where(eq(schema.invitation.inviterId, actor.id));
    await tx.delete(schema.user).where(eq(schema.user.id, actor.id));
  });

  await sendQuietly(deps.emailSender, {
    to: actor.email,
    subject: 'Your Deployz account has been deleted',
    body: 'Your Deployz account and its personal organization have been deleted. If this was not you, contact support immediately.',
  });
}
