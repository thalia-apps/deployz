// Customer data access and the Customers-list rollup.
//
// The customer id is the only anchor: every fetch, edit and delete below
// addresses a customer by its immutable id, and deployments are joined to a
// customer by `deployment.customerId`. Email and name are contact metadata
// that the vendor can change at any time without anything else moving.

import type { InfrastructureSizeTier } from '@deployz/contracts';
import {
  CUSTOMER_DEPLOYMENT_STATUS_BADGE,
  CUSTOMER_DEPLOYMENT_STATUS_LABELS,
  type CustomerDeploymentRollup,
  type DeploymentBadgeVariant,
} from '@deployz/copy-map';

import { apiRequest } from '@/lib/api-client';
import { deploymentUpdatedAt } from '@/lib/deployment-list';
import { CUSTOMER_BUCKETS, customerBucket, type CustomerBucket } from '@/lib/deployment-status-groups';
import type { FleetDeployment } from '@/lib/deployments';
import {
  compareText,
  compareTime,
  matchesSearch,
  parseSort,
  withDirection,
  type SortDirection,
  type SortState,
} from '@/lib/list-view';

export interface Customer {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  company: string | null;
  externalReference: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Contact metadata — the only customer fields a vendor can edit. */
export interface CustomerContactInput {
  name: string;
  email: string;
  company: string | null;
}

export interface CustomerInvitation {
  id: string;
  applicationName: string;
  recommendedRegion: string | null;
  recommendedSizeProfile: InfrastructureSizeTier | null;
  regionSelection: 'customer' | 'legacy_publisher_fixed';
  status: 'active' | 'expired' | 'revoked' | 'used';
  expiresAt: string | null;
  createdAt: string;
}

export async function fetchCustomerInvitations(customerId: string): Promise<CustomerInvitation[]> {
  const body = await apiRequest<{ invitations?: CustomerInvitation[] }>(
    `/api/customers/${encodeURIComponent(customerId)}/invitations`,
  );
  return body.invitations ?? [];
}

/** Create a targeted installation invitation. The API returns the one-time
 *  token exactly once — it is never retrievable again. */
export interface CreateInvitationInput {
  customerId: string;
  applicationId: string;
  recommendedRegion?: string;
  recommendedSizeProfile?: InfrastructureSizeTier;
}

export interface CreatedInvitation {
  id: string;
  token: string;
  expiresAt: string;
  recommendedRegion: string | null;
  recommendedSizeProfile: InfrastructureSizeTier | null;
}

export function createInvitation(input: CreateInvitationInput): Promise<CreatedInvitation> {
  return apiRequest<CreatedInvitation>(
    `/api/customers/${encodeURIComponent(input.customerId)}/invitations`,
    {
      method: 'POST',
      body: {
        applicationId: input.applicationId,
        ...(input.recommendedRegion ? { recommendedRegion: input.recommendedRegion } : {}),
        ...(input.recommendedSizeProfile ? { recommendedSizeProfile: input.recommendedSizeProfile } : {}),
      },
    },
  );
}

export async function fetchCustomers(): Promise<Customer[]> {
  const body = await apiRequest<{ customers?: Customer[] }>('/api/customers');
  return body.customers ?? [];
}

export function fetchCustomer(id: string): Promise<Customer> {
  return apiRequest<Customer>(`/api/customers/${encodeURIComponent(id)}`);
}

/** Update contact metadata. Never reissues an install link or moves a
 *  deployment — the API updates three text columns and nothing else. */
export function updateCustomer(id: string, input: CustomerContactInput): Promise<Customer> {
  return apiRequest<Customer>(`/api/customers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { name: input.name, email: input.email, company: input.company },
  });
}

/** Remove a customer record. The API refuses a customer that has any
 *  deployment, so this can never remove anything from an AWS account. */
export function deleteCustomer(id: string): Promise<void> {
  return apiRequest<void>(`/api/customers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── Deployment rollup ───────────────────────────────────────────────────────

/**
 * One customer's deployment answer for the list: the rollup status, the
 * deployment it was read from, and the install link to copy. Built entirely
 * from the fleet rows the API already returns — the §46 `state`, the
 * server-derived `deploymentStatus.stage`, and `attentionReason`, which the
 * homepage and the fleet list already classify with.
 */
export interface CustomerDeployment {
  status: CustomerDeploymentRollup;
  label: string;
  badge: DeploymentBadgeVariant;
  /** The deployment this status was read from, or null when there is none. */
  deployment: FleetDeployment | null;
  /** All of this customer's deployments, newest activity first. */
  deployments: FleetDeployment[];
  /** When this customer's deployments last changed, or null if never. */
  lastActivityAt: string | null;
}

/** Most actionable first: what the vendor should look at is what the row
 *  shows, and which deployment a single-destination action opens. */
const ROLLUP_RANK: Record<CustomerDeploymentRollup, number> = {
  NEEDS_ATTENTION: 0,
  INSTALLING: 1,
  LIVE: 2,
  NOT_INSTALLED: 3,
  REMOVING: 4,
  REMOVED: 5,
};

/**
 * One deployment's §46 state, said the way the Customers list says it.
 *
 * The §46 `state` is the anchor — the same column the fleet list badges — not
 * the derived progress stage: a deployment can be HEALTHY while its stage is
 * still VERIFYING (READY additionally waits on HTTPS), and a customer whose
 * application is up must read as Live, not as still installing. The buckets
 * come from `customerBucket`, the classification the Customers list and the
 * Deployments list share, so none of them can disagree about a deployment.
 */
function rollupFor(deployment: FleetDeployment): CustomerDeploymentRollup {
  switch (customerBucket(deployment)) {
    case 'removed':
      return 'REMOVED';
    case 'removing':
      return 'REMOVING';
    case 'attention':
      return 'NEEDS_ATTENTION';
    case 'active':
      return 'LIVE';
    case 'pending':
      return deployment.state === 'NOT_INSTALLED' ? 'NOT_INSTALLED' : 'INSTALLING';
  }
}

function activityAt(deployment: FleetDeployment): string {
  return deploymentUpdatedAt(deployment) ?? deployment.createdAt;
}

/** Roll one customer's deployments up into the single answer the list shows. */
export function customerDeployment(deployments: FleetDeployment[]): CustomerDeployment {
  const sorted = [...deployments].sort(
    (a, b) => Date.parse(activityAt(b)) - Date.parse(activityAt(a)),
  );
  const primary =
    [...sorted].sort((a, b) => ROLLUP_RANK[rollupFor(a)] - ROLLUP_RANK[rollupFor(b)])[0] ?? null;
  const status = primary ? rollupFor(primary) : 'NOT_INSTALLED';
  return {
    status,
    label: CUSTOMER_DEPLOYMENT_STATUS_LABELS[status],
    badge: CUSTOMER_DEPLOYMENT_STATUS_BADGE[status],
    deployment: primary,
    deployments: sorted,
    lastActivityAt: sorted[0] ? activityAt(sorted[0]) : null,
  };
}

/** Group fleet rows by the customer id they belong to. */
export function deploymentsByCustomer(
  deployments: FleetDeployment[],
): Map<string, FleetDeployment[]> {
  const grouped = new Map<string, FleetDeployment[]>();
  for (const deployment of deployments) {
    const existing = grouped.get(deployment.customerId);
    if (existing) existing.push(deployment);
    else grouped.set(deployment.customerId, [deployment]);
  }
  return grouped;
}

/**
 * The deployment "View deployment" should open, or null when there is no
 * unambiguous destination — with several live deployments the customer page
 * is the honest answer, so the caller falls back to it.
 */
export function singleDeploymentDestination(rollup: CustomerDeployment): FleetDeployment | null {
  const live = rollup.deployments.filter((deployment) => deployment.state !== 'DELETED');
  if (live.length === 1) return live[0]!;
  if (live.length === 0 && rollup.deployments.length === 1) return rollup.deployments[0]!;
  return null;
}

// ── Install links ───────────────────────────────────────────────────────────

/**
 * The customer's install URL. Reading it is a pure read of the deployment's
 * existing `installLinkId` — copying a link never mints, rotates or revokes
 * one.
 */
export function installLinkUrl(deployment: FleetDeployment, origin: string): string {
  return `${origin}/install/${deployment.installLinkId}#${deployment.installLinkToken}`;
}

/** The install link to offer for a customer: the one non-removed deployment's,
 *  or none when the customer has no deployment to install. */
export function installLinkDeployment(rollup: CustomerDeployment): FleetDeployment | null {
  return rollup.deployments.find((deployment) => deployment.state !== 'DELETED') ?? null;
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Matches a customer against the list's search box: name, email, company. */
export function matchesCustomerSearch(customer: Customer, search: string): boolean {
  return matchesSearch([customer.name, customer.email, customer.company], search);
}

// ── Customers list view ─────────────────────────────────────────────────────

/** How many of a customer's deployments sit in each bucket, and the sentence
 *  the list shows for it. Derived from deployments on every render — there is
 *  no second status to keep in step. */
export interface CustomerSummary {
  counts: Record<CustomerBucket, number>;
  /** The badges the summary reads as, most important first. */
  parts: { bucket: CustomerBucket; text: string }[];
  /** The same as one sentence — "1 active · 1 needs attention". */
  text: string;
}

function summaryPart(bucket: CustomerBucket, count: number, onlyOne: boolean): string {
  switch (bucket) {
    case 'active':
      return `${count} active`;
    case 'attention':
      return `${count} ${count === 1 ? 'needs' : 'need'} attention`;
    case 'pending':
      // A lone pending deployment reads as a state, not a count.
      return onlyOne && count === 1 ? 'Setup pending' : `${count} setup pending`;
    case 'removing':
      return `${count} removing`;
    case 'removed':
      return `${count} removed`;
  }
}

/** Aggregates a customer's deployments into counts and one line of text.
 *  Removed deployments are history: they only speak when nothing else does. */
export function customerSummary(deployments: FleetDeployment[]): CustomerSummary {
  const counts: Record<CustomerBucket, number> = {
    active: 0,
    attention: 0,
    pending: 0,
    removing: 0,
    removed: 0,
  };
  for (const deployment of deployments) counts[customerBucket(deployment)] += 1;

  const shown = CUSTOMER_BUCKETS.filter((bucket) => bucket !== 'removed' && counts[bucket] > 0);
  const parts = shown.map((bucket) => ({
    bucket,
    text: summaryPart(bucket, counts[bucket], shown.length === 1),
  }));
  if (parts.length === 0) {
    parts.push({
      bucket: 'removed',
      text: deployments.length === 0 ? 'No deployments' : 'Removed',
    });
  }
  return { counts, parts, text: parts.map((part) => part.text).join(' · ') };
}

export const CUSTOMER_STATE_FILTERS = ['active', 'attention', 'pending', 'none', 'removed'] as const;
export type CustomerStateFilter = (typeof CUSTOMER_STATE_FILTERS)[number];

export const CUSTOMER_STATE_FILTER_LABELS: Record<CustomerStateFilter, string> = {
  active: 'Active',
  attention: 'Needs attention',
  pending: 'Setup pending',
  none: 'No active deployments',
  removed: 'Removed',
};

export function isCustomerStateFilter(value: string): value is CustomerStateFilter {
  return (CUSTOMER_STATE_FILTERS as readonly string[]).includes(value);
}

/** A customer matches a bucket filter when any deployment is in it. "No active
 *  deployments" is the customers with nothing running or being set up —
 *  including the ones whose every deployment was removed. */
export function matchesCustomerState(summary: CustomerSummary, filter: CustomerStateFilter): boolean {
  const { counts } = summary;
  const live = counts.active + counts.attention + counts.pending;
  const total = live + counts.removing + counts.removed;
  switch (filter) {
    case 'active':
    case 'attention':
    case 'pending':
      return counts[filter] > 0;
    case 'none':
      return live === 0;
    case 'removed':
      return total > 0 && live === 0;
  }
}

export interface CustomerListRow {
  customer: Customer;
  rollup: CustomerDeployment;
  summary: CustomerSummary;
  /** The applications this customer uses: live ones, or every one when all were removed. */
  applications: string[];
  /** The newest deployment change, else when the customer was created. */
  lastActivityAt: string;
}

export function customerListRow(customer: Customer, deployments: FleetDeployment[]): CustomerListRow {
  const rollup = customerDeployment(deployments);
  const live = deployments.filter((deployment) => deployment.state !== 'DELETED');
  const source = live.length > 0 ? live : deployments;
  // `rollup.deployments` is newest first, so the first application named is
  // the one most recently active.
  const named = rollup.deployments.filter((deployment) => source.includes(deployment));
  return {
    customer,
    rollup,
    summary: customerSummary(deployments),
    applications: [...new Set(named.map((deployment) => deployment.applicationName))],
    lastActivityAt: rollup.lastActivityAt ?? customer.createdAt,
  };
}

export const CUSTOMER_SORT_KEYS = ['activity', 'customer', 'created'] as const;
export type CustomerSortKey = (typeof CUSTOMER_SORT_KEYS)[number];

export const CUSTOMER_SORT_NATURAL: Record<CustomerSortKey, SortDirection> = {
  activity: 'desc',
  customer: 'asc',
  created: 'desc',
};

export const DEFAULT_CUSTOMER_SORT: SortState<CustomerSortKey> = { key: 'activity', dir: 'desc' };

export interface CustomerListQuery {
  search: string;
  state: CustomerStateFilter | null;
  application: string | null;
  sort: SortState<CustomerSortKey>;
}

export function parseCustomerQuery(params: URLSearchParams): CustomerListQuery {
  const state = params.get('state') ?? '';
  return {
    search: params.get('q') ?? '',
    state: isCustomerStateFilter(state) ? state : null,
    application: params.get('application') || null,
    sort: parseSort(params, CUSTOMER_SORT_KEYS, DEFAULT_CUSTOMER_SORT, CUSTOMER_SORT_NATURAL),
  };
}

export function hasActiveCustomerFilters(query: CustomerListQuery): boolean {
  return query.search.trim() !== '' || query.state !== null || query.application !== null;
}

export function filterCustomerRows(rows: CustomerListRow[], query: CustomerListQuery): CustomerListRow[] {
  return rows.filter(
    (row) =>
      matchesCustomerSearch(row.customer, query.search) &&
      (query.state === null || matchesCustomerState(row.summary, query.state)) &&
      (query.application === null || row.applications.includes(query.application)),
  );
}

const CUSTOMER_COMPARATORS: Record<
  CustomerSortKey,
  (a: CustomerListRow, b: CustomerListRow) => number
> = {
  activity: (a, b) => compareTime(a.lastActivityAt, b.lastActivityAt),
  customer: (a, b) => compareText(a.customer.name, b.customer.name),
  created: (a, b) => compareTime(a.customer.createdAt, b.customer.createdAt),
};

/** A total order: ties fall back to name, then id, so the list never reshuffles. */
export function sortCustomerRows(
  rows: CustomerListRow[],
  sort: SortState<CustomerSortKey>,
): CustomerListRow[] {
  const compare = CUSTOMER_COMPARATORS[sort.key];
  return [...rows].sort(
    (a, b) =>
      withDirection(compare(a, b), sort.dir) ||
      compareText(a.customer.name, b.customer.name) ||
      compareText(a.customer.id, b.customer.id),
  );
}

// ── Create-deployment customer picker ───────────────────────────────────────

/** The customer picker's sentinel value for "create a new customer" — never
 *  a real customer id, so it can share the same string field as one. */
export const NEW_CUSTOMER_VALUE = '__new_customer__';

/** The picker's default selection: the `?customerId=` from the URL when it
 *  names a customer the organization actually has, else "create new" — an
 *  unknown or missing id must never leave the picker pointing at nothing. */
export function initialCustomerSelection(
  customers: Customer[],
  preselectedCustomerId: string | null,
): string {
  if (preselectedCustomerId && customers.some((customer) => customer.id === preselectedCustomerId)) {
    return preselectedCustomerId;
  }
  return NEW_CUSTOMER_VALUE;
}

/** The existing customer whose email matches the one just typed (trimmed,
 *  case-insensitive), for the create-deployment form's non-blocking duplicate
 *  hint — null when the field is empty or nothing matches. */
export function matchingCustomerByEmail(customers: Customer[], email: string): Customer | null {
  const needle = email.trim().toLowerCase();
  if (needle === '') return null;
  return customers.find((customer) => customer.email.trim().toLowerCase() === needle) ?? null;
}
