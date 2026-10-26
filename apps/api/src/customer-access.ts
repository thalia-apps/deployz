import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import { fromNodeHeaders } from 'better-auth/node';
import { and, desc, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import type { Auth } from './auth.js';
import { sendQuietly, type EmailSender } from './email.js';
import { env } from './env.js';
import { recordEvent } from './events.js';
import { normalizeEmail } from './organizations.js';

// Customer access to the customer deployment page (docs/customer-access.md).
// A customer has no Better Auth user. The identity is an email address,
// proven by an emailed one-time code. The deployment's owner is the first
// verified customer email; before that the allowed email is the
// deployment's customer record. A signed-in vendor of the deployment's
// organization may also open the page.

export const CUSTOMER_CODE_TTL_MS = 10 * 60 * 1000;
export const CUSTOMER_CODE_MAX_ATTEMPTS = 5;
export const CUSTOMER_CODE_RESEND_COOLDOWN_MS = 60 * 1000;
export const CUSTOMER_CODE_SENDS_PER_HOUR = 5;
/** Wrong codes per email per hour, across every challenge — a new challenge never resets it. */
export const CUSTOMER_FAILED_ATTEMPTS_PER_HOUR = 10;
export const CUSTOMER_SESSION_IDLE_MS = 30 * 60 * 1000;
export const CUSTOMER_SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const FLOW_COOKIE_MAX_AGE_S = 15 * 60;
// A request inside this window does not rewrite last_seen_at.
const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The events the customer page lists. Everything else in event_logs stays vendor-only. */
export const CUSTOMER_ACTIVITY_EVENTS = [
  'install.launched',
  'install.completed',
  'install.failed',
  'deploy.completed',
  'deploy.failed',
  'rollback.completed',
  'rollback.failed',
  'restart.completed',
  'config.updated',
  'domain.activated',
  'domain.removed',
  'destroy.completed',
  'purge.completed',
  'relay.connected',
  'connector.update_verified',
  'connector.update_rolled_back',
  'connector.update_failed',
  'customer.owner_claimed',
] as const;

export type InstallViewer = { kind: 'customer'; email: string; sessionId: string } | { kind: 'vendor' };

interface CookieNames {
  session: string;
  flow: string;
}

function cookieSecure(): boolean {
  return env.apiUrl.startsWith('https://');
}

/** Same naming as the Better Auth cookie, so the CSRF hook (it looks for `session_token=`) covers it. */
export function customerCookieNames(): CookieNames {
  const prefix = `${cookieSecure() ? '__Secure-' : ''}${env.cookiePrefix ?? 'deployz'}`;
  return { session: `${prefix}.customer_session_token`, flow: `${prefix}.customer_flow` };
}

export function serializeCustomerCookie(name: string, value: string, maxAgeSeconds: number): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(cookieSecure() ? ['Secure'] : []),
    ...(env.cookieDomain ? [`Domain=${env.cookieDomain}`] : []),
  ].join('; ');
}

export function sessionCookie(token: string): string {
  return serializeCustomerCookie(customerCookieNames().session, token, CUSTOMER_SESSION_ABSOLUTE_MS / 1000);
}

export function clearedSessionCookie(): string {
  return serializeCustomerCookie(customerCookieNames().session, '', 0);
}

export function flowCookie(token: string): string {
  return serializeCustomerCookie(customerCookieNames().flow, token, FLOW_COOKIE_MAX_AGE_S);
}

export function clearedFlowCookie(): string {
  return serializeCustomerCookie(customerCookieNames().flow, '', 0);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value === '' ? undefined : value;
    }
  }
  return undefined;
}

export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function codeHmac(challengeId: string, code: string): string {
  return createHmac('sha256', env.betterAuthSecret ?? 'deployz-dev-customer-code')
    .update(`customer-code:${challengeId}:${code}`)
    .digest('hex');
}

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The email that may own the deployment: the owner once claimed, else the customer record's email. */
export async function allowedOwnerEmail(
  db: RuntimeDb,
  deploymentId: string,
): Promise<{ email: string; claimed: boolean } | null> {
  const [owner] = await db
    .select({ email: schema.deploymentOwners.email })
    .from(schema.deploymentOwners)
    .where(eq(schema.deploymentOwners.deploymentId, deploymentId))
    .limit(1);
  if (owner) return { email: owner.email, claimed: true };
  const [customer] = await db
    .select({ email: schema.customers.email })
    .from(schema.deployments)
    .innerJoin(schema.customers, eq(schema.deployments.customerId, schema.customers.id))
    .where(eq(schema.deployments.id, deploymentId))
    .limit(1);
  return customer ? { email: normalizeEmail(customer.email), claimed: false } : null;
}

interface DeploymentRef {
  id: string;
  organizationId: string;
  customerId: string;
}

/** Records the first verified customer email as the owner. A second claim is a no-op. */
export async function claimDeployment(
  db: RuntimeDb,
  deployment: DeploymentRef,
  email: string,
  sessionId: string,
): Promise<void> {
  const inserted = await db
    .insert(schema.deploymentOwners)
    .values({ deploymentId: deployment.id, email })
    .onConflictDoNothing()
    .returning();
  if (inserted.length > 0) {
    await recordEvent(db, {
      organizationId: deployment.organizationId,
      eventType: 'customer.owner_claimed',
      actorType: 'customer',
      actorId: `customer-session:${sessionId}`,
      deploymentId: deployment.id,
      customerId: deployment.customerId,
    });
  }
}

/**
 * Emails a sign-in code when `email` may own the deployment. The caller always
 * answers the same way, so the response never shows whether the email has
 * access. Returns the code only so a fixture-mode test can read it.
 */
export async function requestCustomerCode(
  db: RuntimeDb,
  emailSender: EmailSender,
  input: {
    deployment: { id: string };
    applicationName: string;
    publisherName: string;
    email: string;
    flowToken: string;
    now: Date;
  },
): Promise<{ sent: boolean; code?: string }> {
  const email = normalizeEmail(input.email);
  const allowed = await allowedOwnerEmail(db, input.deployment.id);
  if (!allowed || allowed.email !== email) return { sent: false };
  const recent = await db
    .select({ createdAt: schema.customerEmailChallenges.createdAt })
    .from(schema.customerEmailChallenges)
    .where(
      and(
        eq(schema.customerEmailChallenges.email, email),
        gte(schema.customerEmailChallenges.createdAt, new Date(input.now.getTime() - HOUR_MS)),
      ),
    )
    .orderBy(desc(schema.customerEmailChallenges.createdAt));
  if (recent.length >= CUSTOMER_CODE_SENDS_PER_HOUR) return { sent: false };
  const latest = recent[0];
  if (latest && input.now.getTime() - latest.createdAt.getTime() < CUSTOMER_CODE_RESEND_COOLDOWN_MS) {
    return { sent: false };
  }
  const flowHash = sha256(input.flowToken);
  // One active code per browser flow: a resend retires the previous code.
  await db
    .update(schema.customerEmailChallenges)
    .set({ consumedAt: input.now })
    .where(
      and(eq(schema.customerEmailChallenges.flowHash, flowHash), isNull(schema.customerEmailChallenges.consumedAt)),
    );
  const id = randomUUID();
  const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
  await db.insert(schema.customerEmailChallenges).values({
    id,
    email,
    deploymentId: input.deployment.id,
    flowHash,
    codeHmac: codeHmac(id, code),
    expiresAt: new Date(input.now.getTime() + CUSTOMER_CODE_TTL_MS),
  });
  await sendQuietly(emailSender, {
    to: email,
    subject: `Your sign-in code for ${input.applicationName}`,
    body: [
      `Your code to sign in to the ${input.applicationName} deployment page from ${input.publisherName} is:`,
      '',
      code,
      '',
      'The code expires in 10 minutes. If you did not ask for it, ignore this email.',
    ].join('\n'),
  });
  return { sent: true, code };
}

export type VerifyCodeResult = { ok: true; email: string } | { ok: false; reason: 'INVALID_CODE' | 'TOO_MANY_ATTEMPTS' };

/** Checks a code against the newest live challenge of this browser flow and consumes it on success. */
export async function verifyCustomerCode(
  db: RuntimeDb,
  input: { deploymentId: string; code: string; flowToken: string; now: Date },
): Promise<VerifyCodeResult> {
  const flowHash = sha256(input.flowToken);
  const [challenge] = await db
    .select()
    .from(schema.customerEmailChallenges)
    .where(
      and(
        eq(schema.customerEmailChallenges.flowHash, flowHash),
        eq(schema.customerEmailChallenges.deploymentId, input.deploymentId),
        isNull(schema.customerEmailChallenges.consumedAt),
        gt(schema.customerEmailChallenges.expiresAt, input.now),
      ),
    )
    .orderBy(desc(schema.customerEmailChallenges.createdAt))
    .limit(1);
  if (!challenge) return { ok: false, reason: 'INVALID_CODE' };
  const [usage] = await db
    .select({ attempts: sql<number>`coalesce(sum(${schema.customerEmailChallenges.attempts}), 0)::int` })
    .from(schema.customerEmailChallenges)
    .where(
      and(
        eq(schema.customerEmailChallenges.email, challenge.email),
        gte(schema.customerEmailChallenges.createdAt, new Date(input.now.getTime() - HOUR_MS)),
      ),
    );
  if ((usage?.attempts ?? 0) >= CUSTOMER_FAILED_ATTEMPTS_PER_HOUR) {
    return { ok: false, reason: 'TOO_MANY_ATTEMPTS' };
  }
  // Count the attempt before the comparison, atomically, so parallel guesses cannot pass the limit.
  const counted = await db
    .update(schema.customerEmailChallenges)
    .set({ attempts: sql`${schema.customerEmailChallenges.attempts} + 1` })
    .where(
      and(
        eq(schema.customerEmailChallenges.id, challenge.id),
        isNull(schema.customerEmailChallenges.consumedAt),
        sql`${schema.customerEmailChallenges.attempts} < ${CUSTOMER_CODE_MAX_ATTEMPTS}`,
      ),
    )
    .returning();
  if (counted.length === 0) return { ok: false, reason: 'TOO_MANY_ATTEMPTS' };
  if (!/^\d{8}$/.test(input.code) || !sameHex(codeHmac(challenge.id, input.code), challenge.codeHmac)) {
    return { ok: false, reason: 'INVALID_CODE' };
  }
  const consumed = await db
    .update(schema.customerEmailChallenges)
    .set({ consumedAt: input.now })
    .where(
      and(eq(schema.customerEmailChallenges.id, challenge.id), isNull(schema.customerEmailChallenges.consumedAt)),
    )
    .returning();
  if (consumed.length === 0) return { ok: false, reason: 'INVALID_CODE' };
  return { ok: true, email: challenge.email };
}

export async function createCustomerSession(
  db: RuntimeDb,
  email: string,
  now: Date,
): Promise<{ id: string; token: string }> {
  const token = newOpaqueToken();
  const [row] = await db
    .insert(schema.customerSessions)
    .values({
      tokenHash: sha256(token),
      email,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + CUSTOMER_SESSION_ABSOLUTE_MS),
    })
    .returning();
  return { id: row!.id, token };
}

/** The live customer session the cookie names, or null. Idle and absolute expiry are both enforced here. */
export async function resolveCustomerSession(
  db: RuntimeDb,
  cookieHeader: string | undefined,
  now: Date,
): Promise<{ id: string; email: string } | null> {
  const token = readCookie(cookieHeader, customerCookieNames().session);
  if (!token) return null;
  const [row] = await db
    .select()
    .from(schema.customerSessions)
    .where(eq(schema.customerSessions.tokenHash, sha256(token)))
    .limit(1);
  if (!row || row.revokedAt !== null || row.expiresAt.getTime() <= now.getTime()) return null;
  const idleFor = now.getTime() - row.lastSeenAt.getTime();
  if (idleFor > CUSTOMER_SESSION_IDLE_MS) return null;
  if (idleFor > SESSION_TOUCH_INTERVAL_MS) {
    await db
      .update(schema.customerSessions)
      .set({ lastSeenAt: now })
      .where(eq(schema.customerSessions.id, row.id));
  }
  return { id: row.id, email: row.email };
}

export async function revokeCustomerSession(db: RuntimeDb, cookieHeader: string | undefined, now: Date): Promise<string | null> {
  const token = readCookie(cookieHeader, customerCookieNames().session);
  if (!token) return null;
  const revoked = await db
    .update(schema.customerSessions)
    .set({ revokedAt: now })
    .where(and(eq(schema.customerSessions.tokenHash, sha256(token)), isNull(schema.customerSessions.revokedAt)))
    .returning();
  return revoked[0]?.id ?? null;
}

/**
 * Who may see this deployment's customer page: its owner (claimed on the
 * first verified visit), or a signed-in member of the deployment's
 * organization. Null for everyone else, including other customers.
 */
export async function resolveInstallViewer(
  db: RuntimeDb,
  auth: Auth,
  headers: Record<string, string | string[] | undefined>,
  deployment: DeploymentRef,
  now: Date,
): Promise<InstallViewer | null> {
  const cookieHeader = typeof headers.cookie === 'string' ? headers.cookie : undefined;
  const session = await resolveCustomerSession(db, cookieHeader, now);
  if (session) {
    const allowed = await allowedOwnerEmail(db, deployment.id);
    if (allowed && allowed.email === session.email) {
      if (!allowed.claimed) await claimDeployment(db, deployment, session.email, session.id);
      return { kind: 'customer', email: session.email, sessionId: session.id };
    }
  }
  if (!cookieHeader?.includes('session_token=')) return null;
  const vendor = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
  if (!vendor) return null;
  const [membership] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(and(eq(schema.member.userId, vendor.user.id), eq(schema.member.organizationId, deployment.organizationId)))
    .limit(1);
  return membership ? { kind: 'vendor' } : null;
}

/** The customer-safe activity list: allowlisted event types, newest first, with the release version where one applies. */
export async function loadCustomerActivity(
  db: RuntimeDb,
  deploymentId: string,
  limit = 20,
): Promise<Array<{ id: number; type: string; occurredAt: string; releaseVersion: string | null }>> {
  const rows = await db
    .select({
      id: schema.eventLogs.id,
      type: schema.eventLogs.eventType,
      occurredAt: schema.eventLogs.occurredAt,
      releaseVersion: schema.releases.version,
    })
    .from(schema.eventLogs)
    .leftJoin(schema.releases, eq(schema.eventLogs.releaseId, schema.releases.id))
    .where(
      and(
        eq(schema.eventLogs.deploymentId, deploymentId),
        inArray(schema.eventLogs.eventType, [...CUSTOMER_ACTIVITY_EVENTS]),
      ),
    )
    .orderBy(desc(schema.eventLogs.occurredAt), desc(schema.eventLogs.id))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    occurredAt: row.occurredAt.toISOString(),
    releaseVersion: row.releaseVersion ?? null,
  }));
}
