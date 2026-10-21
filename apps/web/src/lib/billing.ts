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

// ── Formatting helpers ──────────────────────────────────────────────────────

/** Format a whole-dollar amount for display (e.g. 49 → "$49"). */
export function formatDollars(amount: number): string {
  return `$${amount}`;
}
