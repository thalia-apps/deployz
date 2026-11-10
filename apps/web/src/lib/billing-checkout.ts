// Starting a subscription. The API parks a checkout intent and hands back
// the URL of a Polar checkout; the page shows it embedded, on top of the
// current page. The subscription is created by the API when Polar reports it
// as active, so the page only has to wait for it. A checkout that cannot be
// embedded sends the vendor back with `?checkout=complete` instead.

import { apiRequest } from '@/lib/api-client';
import type { SubscriptionStatus } from '@/lib/organization-vocabulary';

export interface CheckoutIntent {
  checkoutIntentId: string;
  /** Polar's checkout, shown embedded in the page. */
  checkoutUrl: string;
}

export interface CreateCheckoutIntentInput {
  /** The dashboard page Polar sends the vendor back to after paying. */
  returnPath?: string;
}

/**
 * Opens a billing provider page (checkout, portal, invoice) in a new tab, so
 * the vendor keeps their place in Deployz. The tab is opened during the click
 * (browsers block a window opened after an await) and pointed at the URL once
 * the API has minted it; it is cut off from this page (`opener = null`). A
 * browser that blocks the tab gets the page in this tab instead. A failure
 * closes the empty tab and rethrows.
 */
export async function openInNewTab(mintUrl: () => Promise<string>): Promise<'new-tab' | 'same-tab'> {
  const tab = window.open('', '_blank');
  let url: string;
  try {
    url = await mintUrl();
  } catch (error) {
    tab?.close();
    throw error;
  }
  if (!tab) {
    window.location.assign(url);
    return 'same-tab';
  }
  tab.opener = null;
  tab.location.href = url;
  return 'new-tab';
}

/**
 * Shows Polar's checkout embedded on top of the page. Resolves `paid` when
 * the payment goes through, or when the vendor closes the overlay after Polar
 * confirmed the order (the payment is then processing); the page waits for
 * the webhook either way. Resolves `closed` when the vendor leaves without
 * paying. The embed script is loaded on the click, so no other page pays for
 * it.
 */
export async function openEmbeddedCheckout(
  url: string,
  theme: 'light' | 'dark' = 'light',
): Promise<'paid' | 'closed'> {
  const { PolarEmbedCheckout } = await import('@polar-sh/checkout/embed');
  const checkout = await PolarEmbedCheckout.create(url, { theme });
  return new Promise((resolve) => {
    let confirmed = false;
    checkout.addEventListener('confirmed', () => {
      confirmed = true;
    });
    checkout.addEventListener('success', (event) => {
      // Stay on this page: the embed would otherwise redirect to the success URL.
      event.preventDefault();
      resolve('paid');
      checkout.close();
    });
    checkout.addEventListener('close', () => resolve(confirmed ? 'paid' : 'closed'));
  });
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
