import { eq } from 'drizzle-orm';

import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';
import type { PaddleBilling } from './paddle.js';

// The vendor's billing details, read live from Paddle on every request:
// the next payment, the payment method on file and the invoices. Paddle is
// the source of truth for money, so nothing here is stored or cached.
//
// Tenant isolation: everything is scoped to the organization's own
// subscription id. A Paddle customer is keyed by email and can be shared by
// two organizations, so the customer id alone is not a safe filter.

export interface AccountDeps {
  db: RuntimeDb;
  paddle: PaddleBilling | null;
}

/** Paddle amounts are strings in the currency's minor unit (cents for USD). */
export interface BillingMoney {
  amount: string;
  currencyCode: string;
}

export interface BillingAccount {
  nextPayment:
    | (BillingMoney & {
        date: string;
        lines: Array<BillingMoney & { description: string; quantity: number }>;
      })
    | null;
  /** A cancel or pause the vendor scheduled for the end of the period. */
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
    }
  >;
}

const LISTED_TRANSACTION_STATUSES = ['billed', 'paid', 'completed', 'past_due'] as const;
const TRANSACTION_PAGE_SIZE = 24;

async function requireSubscription(deps: AccountDeps, organizationId: string) {
  if (!deps.paddle) {
    throw new ApiError(503, 'BILLING_DISABLED', 'Paddle billing is not configured');
  }
  const [subscription] = await deps.db
    .select({ providerSubscriptionId: schema.billingSubscriptions.providerSubscriptionId })
    .from(schema.billingSubscriptions)
    .where(eq(schema.billingSubscriptions.organizationId, organizationId))
    .limit(1);
  if (!subscription) {
    throw new ApiError(409, 'NO_SUBSCRIPTION', 'There is no subscription yet.');
  }
  return { paddle: deps.paddle, subscriptionId: subscription.providerSubscriptionId };
}

function providerFailure(event: string, organizationId: string, error: unknown): ApiError {
  // Log the provider's reason, never return it.
  console.error(
    JSON.stringify({
      event,
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return new ApiError(502, 'BILLING_DETAILS_UNAVAILABLE', 'Could not load billing details. Try again.');
}

export async function getBillingAccount(
  deps: AccountDeps,
  organizationId: string,
): Promise<BillingAccount> {
  const { paddle, subscriptionId } = await requireSubscription(deps, organizationId);

  let subscription;
  let transactions;
  try {
    [subscription, transactions] = await Promise.all([
      paddle.client.subscriptions.get(subscriptionId, { include: ['next_transaction'] }),
      paddle.client.transactions
        .list({
          subscriptionId: [subscriptionId],
          status: [...LISTED_TRANSACTION_STATUSES],
          orderBy: 'created_at[DESC]',
          perPage: TRANSACTION_PAGE_SIZE,
        })
        .next(),
    ]);
  } catch (error) {
    throw providerFailure('billing:account-failed', organizationId, error);
  }

  const next = subscription.nextTransaction;
  const nextPayment =
    subscription.nextBilledAt && next
      ? {
          date: subscription.nextBilledAt,
          amount: next.details.totals.grandTotal,
          currencyCode: next.details.totals.currencyCode,
          lines: next.details.lineItems.map((line) => ({
            description: line.product.name,
            quantity: line.quantity,
            amount: line.totals.total,
            currencyCode: next.details.totals.currencyCode,
          })),
        }
      : null;

  // Transactions arrive newest first. A payment-method change is a $0
  // transaction, so the newest captured payment is the method on file.
  const captured = transactions
    .flatMap((transaction) => transaction.payments)
    .find((payment) => payment.status === 'captured' && payment.methodDetails);
  const method = captured?.methodDetails ?? null;

  return {
    nextPayment,
    scheduledChange: subscription.scheduledChange
      ? {
          action: subscription.scheduledChange.action,
          effectiveAt: subscription.scheduledChange.effectiveAt,
        }
      : null,
    paymentMethod: method
      ? {
          type: method.type,
          cardBrand: method.card?.type ?? null,
          last4: method.card?.last4 ?? null,
          expiryMonth: method.card?.expiryMonth ?? null,
          expiryYear: method.card?.expiryYear ?? null,
        }
      : null,
    transactions: transactions
      .filter((transaction) => transaction.origin !== 'subscription_payment_method_change')
      .map((transaction) => ({
        id: transaction.id,
        status: transaction.status,
        billedAt: transaction.billedAt ?? transaction.createdAt,
        invoiceNumber: transaction.invoiceNumber,
        amount: transaction.details?.totals?.grandTotal ?? '0',
        currencyCode: transaction.currencyCode,
      })),
  };
}

/**
 * A short-lived link to one invoice PDF. The transaction must belong to the
 * organization's own subscription; any other id answers 404, the same as an
 * id that does not exist.
 */
export async function getInvoiceUrl(
  deps: AccountDeps,
  organizationId: string,
  transactionId: string,
): Promise<{ url: string }> {
  const { paddle, subscriptionId } = await requireSubscription(deps, organizationId);
  const notFound = new ApiError(404, 'INVOICE_NOT_FOUND', 'Invoice not found.');
  if (!/^txn_[a-z0-9]+$/.test(transactionId)) throw notFound;

  let transaction;
  try {
    transaction = await paddle.client.transactions.get(transactionId);
  } catch (error) {
    if ((error as { code?: string }).code === 'not_found') throw notFound;
    throw providerFailure('billing:invoice-failed', organizationId, error);
  }
  if (transaction.subscriptionId !== subscriptionId || !transaction.invoiceNumber) throw notFound;

  try {
    const pdf = await paddle.client.transactions.getInvoicePDF(transactionId);
    return { url: pdf.url };
  } catch (error) {
    throw providerFailure('billing:invoice-failed', organizationId, error);
  }
}
