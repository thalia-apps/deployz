import { eq } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';
import type { PolarBilling } from './polar.js';

// The customer portal. Everything a vendor does with their own subscription
// (card, invoices, cancel) happens on Polar's hosted portal, never on a
// screen Deployz builds: Deployz owns eligibility and the live-deployment
// count, Polar owns money, cards and invoices.
//
// A portal session is a short-lived, pre-authenticated link for ONE Polar
// customer. It is minted on demand for the signed-in organization's own
// customer id — that id is the authorization; nothing about the session is
// ever cached or shared, and it is never embedded in an iframe.

export interface PortalDeps {
  db: RuntimeDb;
  polar: PolarBilling | null;
}

/** Polar's portal has one entry page, where the card form, the invoices and
 *  the cancel action all are. The three targets the web app asks for land
 *  there. */
export interface BillingPortalLinks {
  overview: string;
  updatePaymentMethod: string;
  cancel: string;
}

/**
 * Mints a portal link for the organization's subscription. The organization
 * must have bought something — evaluation has no Polar customer and nothing
 * to manage, which is a 409 the UI never reaches (it shows no button).
 */
export async function createBillingPortalLinks(
  deps: PortalDeps,
  organizationId: string,
): Promise<BillingPortalLinks> {
  const { db, polar } = deps;
  if (!polar) {
    throw new ApiError(503, 'BILLING_DISABLED', 'Polar billing is not configured');
  }

  const [subscription] = await db
    .select({ providerCustomerId: schema.billingSubscriptions.providerCustomerId })
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

  let url: string;
  try {
    url = await polar.client.createCustomerPortalUrl(subscription.providerCustomerId);
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

  return { overview: url, updatePaymentMethod: url, cancel: url };
}
