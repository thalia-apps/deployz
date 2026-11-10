import { eq } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';
import { PolarApiError, type PolarBilling } from './polar.js';

// The vendor's billing details, read live from Polar on every request: the
// next renewal, the payment method on file and the invoices. Polar is the
// source of truth for money, so nothing here is stored or cached.
//
// Tenant isolation: orders are scoped to the organization's own subscription
// id, and an invoice of any other subscription answers 404.

export interface AccountDeps {
  db: RuntimeDb;
  polar: PolarBilling | null;
}

/** Amounts are strings in the currency's minor unit (cents for USD). */
export interface BillingMoney {
  amount: string;
  currencyCode: string;
}

export interface BillingAccount {
  /** The next renewal, before tax and before any prorated adjustment Polar
   *  adds for deployments that started or stopped mid-period. */
  nextPayment:
    | (BillingMoney & {
        date: string;
        lines: Array<BillingMoney & { description: string; quantity: number }>;
      })
    | null;
  /** A cancellation the vendor scheduled for the end of the period. */
  scheduledChange: { action: string; effectiveAt: string } | null;
  paymentMethod: {
    type: string;
    cardBrand: string | null;
    last4: string | null;
    expiryMonth: number | null;
    expiryYear: number | null;
  } | null;
  transactions: Array<
    BillingMoney & {
      id: string;
      status: string;
      billedAt: string | null;
      invoiceNumber: string | null;
      /** What Polar has refunded of this order, in minor units; "0" if none. */
      refundedAmount: string;
    }
  >;
}

const LISTED_ORDER_STATUSES: ReadonlySet<string> = new Set(['paid', 'pending', 'refunded', 'partially_refunded']);
const ORDER_PAGE_SIZE = 24;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireSubscription(deps: AccountDeps, organizationId: string) {
  if (!deps.polar) {
    throw new ApiError(503, 'BILLING_DISABLED', 'Polar billing is not configured');
  }
  const [subscription] = await deps.db
    .select({
      providerSubscriptionId: schema.billingSubscriptions.providerSubscriptionId,
      providerCustomerId: schema.billingSubscriptions.providerCustomerId,
    })
    .from(schema.billingSubscriptions)
    .where(eq(schema.billingSubscriptions.organizationId, organizationId))
    .limit(1);
  if (!subscription) {
    throw new ApiError(409, 'NO_SUBSCRIPTION', 'There is no subscription yet.');
  }
  return {
    polar: deps.polar,
    subscriptionId: subscription.providerSubscriptionId,
    customerId: subscription.providerCustomerId,
  };
}

function logProviderFailure(event: string, organizationId: string, error: unknown): void {
  // Log the provider's reason, never return it.
  console.error(
    JSON.stringify({
      event,
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

function providerFailure(event: string, organizationId: string, error: unknown): ApiError {
  logProviderFailure(event, organizationId, error);
  return new ApiError(502, 'BILLING_DETAILS_UNAVAILABLE', 'Could not load billing details. Try again.');
}

export async function getBillingAccount(
  deps: AccountDeps,
  organizationId: string,
): Promise<BillingAccount> {
  const { polar, subscriptionId, customerId } = await requireSubscription(deps, organizationId);

  let subscription;
  let orders;
  try {
    [subscription, orders] = await Promise.all([
      polar.client.getSubscription(subscriptionId),
      polar.client.listSubscriptionOrders(subscriptionId, ORDER_PAGE_SIZE),
    ]);
  } catch (error) {
    throw providerFailure('billing:account-failed', organizationId, error);
  }

  // The card is a convenience on this page; without it the rest still shows.
  let card: BillingAccount['paymentMethod'] = null;
  try {
    const [method] = await polar.client.listPaymentMethods(customerId);
    if (method) {
      card = {
        type: method.type,
        cardBrand: method.method_metadata?.brand ?? null,
        last4: method.method_metadata?.last4 ?? null,
        expiryMonth: method.method_metadata?.exp_month ?? null,
        expiryYear: method.method_metadata?.exp_year ?? null,
      };
    }
  } catch (error) {
    logProviderFailure('billing:payment-method-failed', organizationId, error);
  }

  const currencyCode = subscription.currency.toUpperCase();
  const fixed = subscription.prices?.find((price) => price.amount_type === 'fixed')?.price_amount ?? 0;
  const renews = subscription.status === 'active' && !subscription.cancel_at_period_end;
  const nextPayment = renews
    ? {
        date: subscription.current_period_end,
        amount: String(subscription.amount),
        currencyCode,
        lines: [
          { description: 'Platform', quantity: 1, amount: String(fixed), currencyCode },
          {
            description: 'Customer deployments',
            quantity: subscription.units ?? 0,
            amount: String(subscription.amount - fixed),
            currencyCode,
          },
        ],
      }
    : null;

  return {
    nextPayment,
    scheduledChange:
      subscription.cancel_at_period_end && subscription.status !== 'canceled'
        ? { action: 'cancel', effectiveAt: subscription.ends_at ?? subscription.current_period_end }
        : null,
    paymentMethod: card,
    transactions: orders
      .filter((order) => order.subscription_id === subscriptionId && LISTED_ORDER_STATUSES.has(order.status))
      .map((order) => ({
        id: order.id,
        status: order.status,
        billedAt: order.created_at,
        invoiceNumber: order.invoice_number,
        amount: String(order.total_amount),
        refundedAmount: String(order.refunded_amount),
        currencyCode: order.currency.toUpperCase(),
      })),
  };
}

/**
 * A short-lived link to one invoice PDF. The order must belong to the
 * organization's own subscription; any other id answers 404, the same as an
 * id that does not exist. Polar generates invoices on request: the first
 * request starts it and answers 409, and a retry a moment later gets the URL.
 */
export async function getInvoiceUrl(
  deps: AccountDeps,
  organizationId: string,
  orderId: string,
): Promise<{ url: string }> {
  const { polar, subscriptionId } = await requireSubscription(deps, organizationId);
  const notFound = new ApiError(404, 'INVOICE_NOT_FOUND', 'Invoice not found.');
  if (!UUID.test(orderId)) throw notFound;

  let order;
  try {
    order = await polar.client.getOrder(orderId);
  } catch (error) {
    if (error instanceof PolarApiError && error.status === 404) throw notFound;
    throw providerFailure('billing:invoice-failed', organizationId, error);
  }
  if (order.subscription_id !== subscriptionId || !order.paid) throw notFound;

  let url: string | null;
  try {
    url = await polar.client.getOrderInvoiceUrl(order);
  } catch (error) {
    throw providerFailure('billing:invoice-failed', organizationId, error);
  }
  if (!url) {
    throw new ApiError(409, 'INVOICE_NOT_READY', 'The invoice is being prepared. Try again in a moment.');
  }
  return { url };
}

/**
 * Ends the organization's subscription when the paid period ends. Polar sends
 * the status change as a webhook, which stays the authority for what the
 * page shows; this only asks for it and returns the date it will end.
 */
export async function cancelSubscriptionAtPeriodEnd(
  deps: AccountDeps,
  organizationId: string,
): Promise<{ endsAt: string }> {
  const { polar, subscriptionId } = await requireSubscription(deps, organizationId);
  try {
    const subscription = await polar.client.cancelSubscriptionAtPeriodEnd(subscriptionId);
    return { endsAt: subscription.current_period_end };
  } catch (error) {
    if (error instanceof PolarApiError && error.code === 'AlreadyCanceledSubscription') {
      throw new ApiError(409, 'ALREADY_CANCELLING', 'This subscription already ends at the end of the paid period.');
    }
    logProviderFailure('billing:cancel-failed', organizationId, error);
    throw new ApiError(502, 'CANCEL_FAILED', 'Could not cancel the subscription. Try again.');
  }
}

const INVOICE_MAX_BYTES = 10 * 1024 * 1024;

/** One invoice PDF, read from Polar by the API so the vendor downloads it
 *  from Deployz and never visits a Polar page. */
export async function getInvoicePdf(
  deps: AccountDeps,
  organizationId: string,
  orderId: string,
): Promise<{ pdf: Buffer }> {
  const { url } = await getInvoiceUrl(deps, organizationId, orderId);
  if (!url.startsWith('https://')) {
    throw providerFailure('billing:invoice-failed', organizationId, new Error('invoice link is not https'));
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`invoice download answered ${response.status}`);
    const pdf = Buffer.from(await response.arrayBuffer());
    if (pdf.length > INVOICE_MAX_BYTES) throw new Error('invoice is larger than expected');
    return { pdf };
  } catch (error) {
    throw providerFailure('billing:invoice-failed', organizationId, error);
  }
}
