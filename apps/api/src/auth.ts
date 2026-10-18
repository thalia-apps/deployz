import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { eq } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { env } from './env.js';
import { organizationSlug, seedFixtureBillingSubscription } from './organizations.js';

// Better Auth instance for the control plane: email/password + GitHub OAuth
// (env-driven). Better Auth owns identity ONLY — user, session, account and
// verification. Organizations, memberships, roles and invitations are the
// control plane's own tables (packages/db/src/schema/auth.ts) written solely
// through apps/api/src/organizations.ts, so every membership write goes past
// one set of role checks and last-owner safeguards. The session keeps the
// familiar `activeOrganizationId` field as the tenant pointer.
export function createAuth(
  db: RuntimeDb,
  // Injectable Paddle migration Phase 7 fixture-mode override (mirrors
  // ServerDeps.billingFixtureMode's `?? env.x` pattern) — tests can enable it
  // without mutating module-level env.
  opts: { billingFixtureMode?: boolean; cookiePrefix?: string } = {},
) {
  const billingFixtureMode = opts.billingFixtureMode ?? env.billingFixtureMode;
  const cookiePrefix = opts.cookiePrefix ?? env.cookiePrefix;
  return betterAuth({
    appName: 'Deployz',
    baseURL: env.apiUrl,
    basePath: '/api/auth',
    ...(env.betterAuthSecret ? { secret: env.betterAuthSecret } : {}),
    // The dashboard and the marketing site are separate origins from the API,
    // so both must be trusted for Better Auth's origin check to pass.
    trustedOrigins: [...env.webOrigins],
    // Production splits the app across api./app./apex of one registrable
    // domain, so the session cookie has to be domain-scoped or the dashboard
    // never sees the cookie the API sets. SameSite=Lax (not None) is correct
    // here: app.deployz.dev -> api.deployz.dev is cross-ORIGIN but same-SITE,
    // so Lax cookies are still sent, and Lax avoids the third-party-cookie
    // blocking that None invites in Safari and Firefox. Absent COOKIE_DOMAIN
    // (local dev) this whole block is omitted and cookies stay host-scoped.
    // COOKIE_PREFIX renames the session cookie, so staging and production can
    // share the cookie domain without one reading or overwriting the other's
    // session.
    ...(env.cookieDomain || cookiePrefix
      ? {
          advanced: {
            ...(env.cookieDomain
              ? {
                  crossSubDomainCookies: { enabled: true, domain: env.cookieDomain },
                  defaultCookieAttributes: { secure: true, sameSite: 'lax' as const },
                }
              : {}),
            ...(cookiePrefix ? { cookiePrefix } : {}),
          },
        }
      : {}),
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: { enabled: true },
    socialProviders: {
      github: {
        clientId: env.githubClientId,
        clientSecret: env.githubClientSecret,
      },
    },
    session: {
      additionalFields: {
        // The active tenant. `input: false` — a client can never assert it;
        // the session hook below and POST /api/organizations/:id/activate are
        // the only writers.
        activeOrganizationId: { type: 'string', required: false, input: false },
        // Team Admin "View as Vendor" support target. `input: false` — only
        // POST /api/admin/vendors/:id/support-session and DELETE
        // /api/admin/support-session write it. See require-auth.ts.
        supportOrganizationId: { type: 'string', required: false, input: false },
      },
    },
    user: {
      additionalFields: {
        // Team Admin platform role ('ADMIN' or unset). `input: false` — no
        // client-writable path exists; granted via SQL/ops tooling only.
        platformRole: { type: 'string', required: false, input: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Tenant resolution, single code path: every session gets an active
          // organization. A brand-new user gets their own tenant created
          // inline (signup); a returning user resumes the tenant they last
          // worked in. Doing this in session.create.before (not
          // user.create.after) matters: user after-hooks are queued
          // post-transaction, so a signup session created there would race
          // ahead with activeOrganizationId = null.
          before: async (session) => {
            const memberships = await db
              .select({ organizationId: schema.member.organizationId })
              .from(schema.member)
              .where(eq(schema.member.userId, session.userId))
              .orderBy(schema.member.createdAt);

            const users = await db
              .select({
                email: schema.user.email,
                lastActiveOrganizationId: schema.user.lastActiveOrganizationId,
              })
              .from(schema.user)
              .where(eq(schema.user.id, session.userId))
              .limit(1);

            // Resume the tenant they last worked in, but only while they are
            // still a member of it — a stale pointer falls back to their
            // oldest membership.
            const last = users[0]?.lastActiveOrganizationId;
            let organizationId =
              last && memberships.some((row) => row.organizationId === last)
                ? last
                : memberships[0]?.organizationId;

            if (!organizationId) {
              const localPart = users[0]?.email.split('@')[0] ?? 'tenant';
              organizationId = crypto.randomUUID();
              await db.insert(schema.organization).values({
                id: organizationId,
                name: localPart,
                slug: organizationSlug(localPart, session.userId),
              });
              await db.insert(schema.member).values({
                id: crypto.randomUUID(),
                organizationId,
                userId: session.userId,
                role: 'owner',
              });
              if (billingFixtureMode) {
                await seedFixtureBillingSubscription(db, organizationId);
              }
              await db
                .update(schema.user)
                .set({ lastActiveOrganizationId: organizationId })
                .where(eq(schema.user.id, session.userId));
            }

            return { data: { ...session, activeOrganizationId: organizationId } };
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
