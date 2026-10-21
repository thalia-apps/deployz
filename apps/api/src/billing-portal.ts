import { eq } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';
import type { PaddleBilling } from './paddle.js';

// Paddle migration Phase 12 — the customer portal. Everything a vendor does
// with their own subscription (card, invoices, cancel) happens on Paddle's
// hosted portal, never on a screen Deployz builds: Deployz owns eligibility
// and the live-deployment count, Paddle owns money, cards and invoices.
//
// A portal session is a short-lived, pre-authenticated set of links for ONE
// Paddle customer. It is minted on demand for the signed-in organization's
// own customer id — that id is the authorization; nothing about the session
// is ever cached or shared, and it is never embedded in an iframe.

export interface PortalDeps {
  db: RuntimeDb;
  paddle: PaddleBilling | null;
}

export interface BillingPortalLinks {
  /** The portal home: invoices, transaction history, account details. */
  overview: string;
  /** Straight to the card form for the organization's subscription. */
  updatePaymentMethod: string;
  /** Paddle's own cancellation flow for the subscription. */
  cancel: string;
}

/**
 * Mints portal links for the organization's subscription. The organization
 * must have bought something — evaluation has no Paddle customer and nothing
 * to manage, which is a 409 the UI never reaches (it shows no button).
 */
export async function createBillingPortalLinks(
  deps: PortalDeps,
  organizationId: string,
): Promise<BillingPortalLinks> {
  const { db, paddle } = deps;
  if (!paddle) {
    throw new ApiError(503, 'BILLING_DISABLED', 'Paddle billing is not configured');
  }

  const [subscription] = await db
    .select({
      providerCustomerId: schema.billingSubscriptions.providerCustomerId,
      providerSubscriptionId: schema.billingSubscriptions.providerSubscriptionId,
    })
    .from(schema.billingSubscriptions)
    .where(eq(schema.billingSubscriptions.organizationId, organizationId))
    .limit(1);
  if (!subscription) {
    throw new ApiError(
      409,
      'NO_SUBSCRIPTION',
      'There is no subscription to manage yet. Start a subscription on the Invite customer page.',
    );
  }

  let session;
  try {
    session = await paddle.client.customerPortalSessions.create(subscription.providerCustomerId, [
      subscription.providerSubscriptionId,
    ]);
  } catch (error) {
    // Same operability rule as the checkout: log the provider's reason, never
    // return it.
    console.error(
      JSON.stringify({
        event: 'billing:portal-session-failed',
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw new ApiError(502, 'PORTAL_UNAVAILABLE', 'Could not open billing. Try again.');
  }

  // Paddle returns one deep-link set per subscription id it was asked for;
  // it was asked for exactly one. Fall back to the overview rather than fail
  // if it ever returns none — the vendor can still reach everything from
  // there.
  const links = session.urls.subscriptions.find(
    (entry) => entry.id === subscription.providerSubscriptionId,
  );
  return {
    overview: session.urls.general.overview,
    updatePaymentMethod: links?.updateSubscriptionPaymentMethod ?? session.urls.general.overview,
    cancel: links?.cancelSubscription ?? session.urls.general.overview,
  };
}
