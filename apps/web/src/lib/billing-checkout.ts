// Starting a subscription. The API parks a checkout intent and hands back
// the URL of Polar's hosted checkout; the browser goes there, and Polar sends
// the vendor back with `?checkout=complete`. The subscription is created by
// the API when Polar reports it as active, so the page only has to wait for
// it.

import { apiRequest } from '@/lib/api-client';
import type { SubscriptionStatus } from '@/lib/organization-vocabulary';

export interface CheckoutIntent {
  checkoutIntentId: string;
  /** Polar's hosted checkout page. */
  checkoutUrl: string;
}

export interface CreateCheckoutIntentInput {
  /** The dashboard page Polar sends the vendor back to after paying. */
  returnPath?: string;
}

/** The query parameter Polar's success URL carries back to the page. */
export const CHECKOUT_COMPLETE_PARAM = 'checkout';

/** The active organization's subscription status — `null` means evaluation.
 *  Client-side counterpart of lib/organization.ts, which is server-only. */
export async function fetchSubscriptionStatus(): Promise<SubscriptionStatus | null> {
  const organization = await apiRequest<{ subscriptionStatus: SubscriptionStatus | null }>(
    '/api/organization',
  );
  return organization.subscriptionStatus;
}

/** `POST /api/billing/checkout` — parks the request and opens a Polar
 *  checkout. Nothing is provisioned until the payment lands. */
export function createCheckoutIntent(input: CreateCheckoutIntentInput): Promise<CheckoutIntent> {
  return apiRequest<CheckoutIntent>('/api/billing/checkout', { method: 'POST', body: input });
}

/** Which part of the billing portal the button is for. Polar's portal has
 *  one entry page, so every target opens it. */
export type BillingPortalTarget = 'overview' | 'updatePaymentMethod' | 'cancel';

/** `POST /api/billing/portal` — a short-lived, pre-authenticated link into
 *  Polar's customer portal. Minted on every click and never cached: the
 *  session is temporary by design. */
export async function openBillingPortal(target: BillingPortalTarget): Promise<string> {
  const links = await apiRequest<Record<BillingPortalTarget, string>>('/api/billing/portal', {
    method: 'POST',
  });
  return links[target];
}

/** `GET /api/billing/invoices/:id` — a short-lived link to one invoice PDF.
 *  Minted on every click; the link expires. */
export async function fetchInvoiceUrl(orderId: string): Promise<string> {
  const { url } = await apiRequest<{ url: string }>(
    `/api/billing/invoices/${encodeURIComponent(orderId)}`,
  );
  return url;
}
