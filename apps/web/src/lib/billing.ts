// §48 billing display — data access for the billing page. Wired to the real
// `GET /api/billing/summary` endpoint: {base, deploymentPrice, deployments:
// [{name (customer name), applicationName}], productionDeployments: {active,
// paused, included, billable}, total}. No fixture fallback — a failure here is a real
// failure, not a loading state. §65: all copy is jargon-free.

import { cookies } from 'next/headers';

import { serverApiUrl } from '@/lib/api-url';
import type { SubscriptionStatus } from '@/lib/organization-vocabulary';

// ── Wire shapes ────────────────────────────────────────────────────────────

/** One live production deployment — labelled by CUSTOMER name (§48). It
 *  carries no amount: the allowance is pooled, so no single deployment is
 *  the free one or the paid one. */
export interface BillingDeploymentLine {
  /** Customer name — the §48 line item label. */
  name: string;
  applicationName: string;
}

/** Live production deployments, the included allowance, and what is billed. */
export interface ProductionDeploymentCounts {
  active: number;
  /** Live once, but failed or disconnected now: not billed until it serves again. */
  paused: number;
  included: number;
  /** max(active − included, 0) — the quantity actually billed. */
  billable: number;
}

/** The §48 billing summary: base platform fee + the pooled deployment line. */
export interface BillingSummary {
  /** Base platform fee in whole dollars ($49). */
  base: number;
  /** Price of one billed production deployment in whole dollars ($19). */
  deploymentPrice: number;
  deployments: BillingDeploymentLine[];
  productionDeployments: ProductionDeploymentCounts;
  /** base + billable × deploymentPrice, in whole dollars. */
  total: number;
  /** `null` means the organization has no subscription yet (evaluation). */
  subscription: {
    status: SubscriptionStatus;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
  } | null;
}

/** A Paddle amount: a string in the currency's minor unit (cents for USD). */
export interface BillingMoney {
  amount: string;
  currencyCode: string;
}

/** `GET /api/billing/account` — read live from the billing provider. */
export interface BillingAccount {
  nextPayment:
    | (BillingMoney & {
        date: string;
        lines: Array<BillingMoney & { description: string; quantity: number }>;
      })
    | null;
  scheduledChange: { action: 'cancel' | 'pause' | 'resume'; effectiveAt: string } | null;
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
      status: 'billed' | 'paid' | 'completed' | 'past_due';
      billedAt: string | null;
      invoiceNumber: string | null;
    }
  >;
}

/** Billing details, or why the page cannot show them. A member who is not an
 *  owner or admin is `forbidden`; billing switched off is `disabled`; a
 *  provider failure is `unavailable`. */
export type BillingAccountResult =
  | { status: 'ok'; account: BillingAccount }
  | { status: 'forbidden' | 'disabled' | 'unavailable' };

// ── Fetch ───────────────────────────────────────────────────────────────────

async function getJson<T>(path: string): Promise<T> {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${serverApiUrl()}${path}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Billing request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

/** Fetch the org's §48 billing summary. */
export async function fetchBillingSummary(): Promise<BillingSummary> {
  return getJson<BillingSummary>('/api/billing/summary');
}

/** Fetch the org's billing details. Never throws for a 403 or a provider
 *  failure: the rest of the billing page still renders. */
export async function fetchBillingAccount(): Promise<BillingAccountResult> {
  const cookieHeader = (await cookies()).toString();
  try {
    const response = await fetch(`${serverApiUrl()}/api/billing/account`, {
      headers: cookieHeader ? { cookie: cookieHeader } : {},
      cache: 'no-store',
    });
    if (response.status === 403) return { status: 'forbidden' };
    if (response.status === 503) return { status: 'disabled' };
    if (!response.ok) return { status: 'unavailable' };
    return { status: 'ok', account: (await response.json()) as BillingAccount };
  } catch {
    return { status: 'unavailable' };
  }
}

// ── Formatting helpers ──────────────────────────────────────────────────────

/** Format a whole-dollar amount for display (e.g. 49 → "$49"). */
export function formatDollars(amount: number): string {
  return `$${amount}`;
}

/** Format a provider amount in minor units (e.g. "4900", "USD" → "$49.00"). */
export function formatMoney({ amount, currencyCode }: BillingMoney): string {
  const format = new Intl.NumberFormat('en-US', { style: 'currency', currency: currencyCode });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(Number(amount) / 10 ** digits);
}

/** Format an ISO date for billing copy (e.g. "Nov 1, 2026"). */
export function formatBillingDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
