import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createEmailSender, sendQuietly, type EmailSender } from './email.js';
import { env } from './env.js';
import { organizationSlug, seedFixtureBillingSubscription } from './organizations.js';

/** Simulated E2E only: the last two-factor sign-in code sent to each email,
 *  read by GET /internal/fixture/two-factor-code. */
export const fixtureTwoFactorCodes = new Map<string, string>();

// Deployz uses only the emailed code. These two-factor plugin routes serve
// authenticator apps and backup codes, or turn 2FA on without proof that the
// code reaches the inbox, so they are off.
const DISABLED_TWO_FACTOR_PATHS = [
  '/two-factor/enable',
  '/two-factor/get-totp-uri',
  '/two-factor/verify-totp',
  '/two-factor/generate-backup-codes',
  '/two-factor/verify-backup-code',
  '/two-factor/view-backup-codes',
];

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
  opts: {
    billingFixtureMode?: boolean;
    cookiePrefix?: string;
    // Marks every new user's e-mail as verified (simulated E2E and unit tests
    // only — see env.emailVerificationFixtureMode).
    emailVerificationFixtureMode?: boolean;
    emailSender?: EmailSender;
  } = {},
) {
  const billingFixtureMode = opts.billingFixtureMode ?? env.billingFixtureMode;
  const emailVerificationFixtureMode =
    opts.emailVerificationFixtureMode ?? env.emailVerificationFixtureMode;
  const emailSender = opts.emailSender ?? createEmailSender();
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
    disabledPaths: DISABLED_TWO_FACTOR_PATHS,
    // Optional two-factor sign-in: after a correct password, a user with
    // twoFactorEnabled gets no session until they enter a 6-digit code sent
    // to their email. A signed-in user turns it on by asking for a code and
    // entering it (POST /two-factor/send-otp, then /two-factor/verify-otp),
    // so the code must reach the inbox first. Turning it off needs the
    // password. GitHub sign-in is not challenged; it relies on GitHub.
    plugins: [
      twoFactor({
        totpOptions: { disable: true },
        otpOptions: {
          period: 5,
          allowedAttempts: 5,
          storeOTP: 'hashed',
          sendOTP: async ({ user, otp }) => {
            if (emailVerificationFixtureMode) fixtureTwoFactorCodes.set(user.email, otp);
            await sendQuietly(emailSender, {
              to: user.email,
              subject: 'Your Deployz sign-in code',
              body: [
                `Your Deployz sign-in code is ${otp}. The code is valid for 5 minutes.`,
                '',
                'If you did not ask for this code, change your Deployz password now.',
              ].join('\n'),
            });
          },
        },
      }),
    ],
    emailAndPassword: {
      enabled: true,
      // The e-mail links straight to the web app's reset page with the token;
      // Better Auth's own callback URL would add a redirect through the API.
      // The response to a reset request is the same for unknown addresses.
      // A reset also signs out every session, so a stolen session ends.
      sendResetPassword: async ({ user, token }) => {
        await sendQuietly(emailSender, {
          to: user.email,
          subject: 'Reset your Deployz password',
          body: [
            'Use this link to choose a new Deployz password. The link is valid for 1 hour:',
            '',
            `${env.webUrl}/reset-password?token=${encodeURIComponent(token)}`,
            '',
            'If you did not ask for this, ignore this email. Your password does not change.',
          ].join('\n'),
        });
      },
      revokeSessionsOnPasswordReset: true,
      // NIST SP 800-63B: a minimum length, no character rules. Sign-in does
      // not check the minimum, so an older shorter password keeps working
      // until the user changes it.
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    // Sign-in stays open to unverified accounts; organization invitations
    // (the only way to join another tenant) require a verified e-mail.
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendQuietly(emailSender, {
          to: user.email,
          subject: 'Verify your Deployz email address',
          body: ['Confirm your email address to finish setting up Deployz:', '', url].join('\n'),
        });
      },
    },
    // A GitHub sign-in never links into an account whose e-mail was never
    // verified: otherwise whoever registered that address first with a
    // password would keep access to the real owner's account.
    account: { accountLinking: { requireLocalEmailVerified: true } },
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
      ...(emailVerificationFixtureMode
        ? {
            user: {
              create: {
                before: async (user) => ({ data: { ...user, emailVerified: true } }),
              },
            },
          }
        : {}),
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
