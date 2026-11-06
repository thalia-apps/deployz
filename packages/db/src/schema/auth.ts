import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { INCLUDED_PRODUCTION_DEPLOYMENTS_MAX } from '@deployz/contracts';

// Better Auth core + organization-plugin schema. Todo 3 wires Better Auth
// against these tables, so table names, column names, and column types MUST
// match the Better Auth Drizzle adapter contract exactly:
//   - text primary keys (Better Auth generates ids, not the database)
//   - snake_case column names as below
//   - no uuid defaults, no extra NOT NULL columns the adapter does not write
// Shape source: better-auth.com docs (core schema + organization plugin).
// Timestamps are timestamptz for consistency with the rest of the platform;
// the adapter binds JS Date objects, which is compatible.

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  // Deployz field: the tenant this user last worked in. Sessions are deleted
  // on sign-out (and replaced on a password change), so the pointer cannot
  // live on the session alone — without this the switcher resets to the
  // user's oldest membership every time they sign in. No foreign key: a
  // stale id is simply ignored once membership is re-checked.
  lastActiveOrganizationId: text('last_active_organization_id'),
  // Deployz field: Team Admin platform role. 'ADMIN' grants cross-tenant
  // admin access (see apps/api/src/admin/auth.ts); null for every ordinary
  // vendor user. No role-management UI — granted via SQL/ops tooling only.
  platformRole: text('platform_role'),
  // Better Auth two-factor plugin: optional emailed sign-in code.
  twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // Organization plugin session augmentation (active tenant context).
    activeOrganizationId: text('active_organization_id'),
    // Deployz field: while set (and only for a platform admin), the Team
    // Admin "View as Vendor" support session — requireAuth resolves
    // request.organization to THIS org instead of the admin's own, with a
    // synthetic lowest-privilege role. See docs/admin/team-admin.md.
    supportOrganizationId: text('support_organization_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

// Better Auth two-factor plugin table. Deployz uses only the emailed code,
// which keeps no row here; the plugin still reads and deletes rows in this
// table, so it must exist.
export const twoFactor = pgTable(
  'two_factor',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    verified: boolean('verified').default(true),
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
  },
  (t) => [index('two_factor_user_id_idx').on(t.userId)],
);

// Organization / member / invitation — the multi-tenant membership model.
// Table and column names keep the Better Auth organization-plugin shape (the
// session still carries active_organization_id) so the vocabulary stays
// familiar, but the control plane owns every write: apps/api exposes the only
// endpoints that touch these tables, which is where the role checks and the
// last-owner safeguards live.
export const organization = pgTable(
  'organization',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    logo: text('logo'),
    metadata: text('metadata'),
    // Deployz field: how many live PRODUCTION deployments this organization
    // may run before the per-deployment charge applies (docs/billing/
    // included-deployments-implementation.md). A pooled, concurrent allowance
    // — not credits, not per app, not per customer. Lives on the organization
    // because it must exist before any subscription does. Written only by the
    // Team Admin route; default 0 preserves plain billing.
    includedProductionDeployments: integer('included_production_deployments').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
  },
  (t) => [
    check(
      'organization_included_production_deployments_range',
      sql`${t.includedProductionDeployments} >= 0 AND ${t.includedProductionDeployments} <= ${sql.raw(String(INCLUDED_PRODUCTION_DEPLOYMENTS_MAX))}`,
    ),
  ],
);

export const member = pgTable(
  'member',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('member_organization_id_idx').on(t.organizationId),
    index('member_user_id_idx').on(t.userId),
    // A user joins an organization once — accepting an invitation twice, or
    // racing two accepts, must not create a second membership row.
    uniqueIndex('member_org_user_uidx').on(t.organizationId, t.userId),
  ],
);

// Membership roles are 'owner' | 'admin' | 'member' (see apps/api's
// organizations.ts). Exactly ONE owner per organization is an invariant the
// API enforces: ownership moves by transfer, never by a plain role change.

// Pending team invitations. `status` is 'pending' | 'accepted' | 'rejected' |
// 'canceled'; expiry is a timestamp, not a status, so an untouched invitation
// simply ages out. Emails are stored lower-cased so the partial unique index
// below is a real duplicate guard.
export const invitation = pgTable(
  'invitation',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull().default('member'),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('invitation_organization_id_idx').on(t.organizationId),
    index('invitation_email_idx').on(t.email),
    // One live invitation per (organization, email) — a resend refreshes the
    // existing row instead of stacking duplicates.
    uniqueIndex('invitation_pending_org_email_uidx')
      .on(t.organizationId, t.email)
      .where(sql`status = 'pending'`),
  ],
);
