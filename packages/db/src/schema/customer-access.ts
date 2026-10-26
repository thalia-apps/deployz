import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { createdAt, id } from './common.js';
import { deployments } from './deployments.js';

// Customer access to the customer deployment page (/install/:installLinkId).
// A customer has no Better Auth user: the identity is a verified email
// address, proven by a one-time email code. See docs/customer-access.md.

// The one owner of a deployment's customer page. Written on the first
// verified sign-in by the deployment's customer email; after that the vendor
// changing the customer record does not change the owner.
export const deploymentOwners = pgTable('deployment_owners', {
  deploymentId: uuid('deployment_id')
    .primaryKey()
    .references(() => deployments.id),
  email: text('email').notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
});

// One emailed sign-in code. Only a keyed HMAC of the code is stored, bound to
// the browser flow cookie that requested it.
export const customerEmailChallenges = pgTable(
  'customer_email_challenges',
  {
    id: id(),
    email: text('email').notNull(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => deployments.id),
    flowHash: text('flow_hash').notNull(),
    codeHmac: text('code_hmac').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('customer_email_challenges_email_created_idx').on(t.email, t.createdAt),
    index('customer_email_challenges_flow_idx').on(t.flowHash),
  ],
);

// A signed-in customer. Only the sha256 of the cookie token is stored.
export const customerSessions = pgTable('customer_sessions', {
  id: id(),
  tokenHash: text('token_hash').notNull().unique(),
  email: text('email').notNull(),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
