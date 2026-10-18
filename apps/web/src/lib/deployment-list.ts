// The Deployments list's view logic: what the URL asks for, which rows that
// leaves, and in what order. Pure — the page owns fetching and the URL.

import {
  deploymentDisplayStatus,
  isStatusGroup,
  statusGroupRank,
  type StatusGroup,
} from '@/lib/deployment-status-groups';
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
import { regionName } from '@/lib/regions';

export const DEPLOYMENT_SORT_KEYS = ['status', 'customer', 'application', 'region', 'updated'] as const;
export type DeploymentSortKey = (typeof DEPLOYMENT_SORT_KEYS)[number];

/** Recent first for time; A→Z for names; most urgent first for status. */
export const DEPLOYMENT_SORT_NATURAL: Record<DeploymentSortKey, SortDirection> = {
  status: 'asc',
  customer: 'asc',
  application: 'asc',
  region: 'asc',
  updated: 'desc',
};

/** Operational priority: what needs the vendor first, latest change first. */
export const DEFAULT_DEPLOYMENT_SORT: SortState<DeploymentSortKey> = { key: 'status', dir: 'asc' };

export interface DeploymentListQuery {
  search: string;
  /** `null` = every live deployment (removed ones are opt-in). */
  status: StatusGroup | null;
  /** `null` = all. */
  application: string | null;
  region: string | null;
  sort: SortState<DeploymentSortKey>;
}

/** Reads the list's view from URL params. An unknown status or sort falls back
 *  to the default rather than producing an empty, unexplained list. */
export function parseDeploymentQuery(params: URLSearchParams): DeploymentListQuery {
  const status = params.get('status') ?? '';
  return {
    search: params.get('q') ?? '',
    status: isStatusGroup(status) ? status : null,
    application: params.get('application') || null,
    region: params.get('region') || null,
    sort: parseSort(params, DEPLOYMENT_SORT_KEYS, DEFAULT_DEPLOYMENT_SORT, DEPLOYMENT_SORT_NATURAL),
  };
}

/** True when any of search/status/application/region narrows the list. */
export function hasActiveFilters(query: DeploymentListQuery): boolean {
  return (
    query.search.trim() !== '' ||
    query.status !== null ||
    query.application !== null ||
    query.region !== null
  );
}

/** The best "last changed" moment: the derived status's own timestamp, else
 *  the row's. Null only when neither parses. */
export function deploymentUpdatedAt(deployment: FleetDeployment): string | null {
  for (const candidate of [deployment.deploymentStatus?.updatedAt, deployment.updatedAt]) {
    if (candidate && !Number.isNaN(Date.parse(candidate))) return candidate;
  }
  return null;
}

function inStatusFilter(group: StatusGroup, status: StatusGroup): boolean {
  return group === status || (status === 'healthy' && group === 'update-available');
}

export function filterDeployments(
  deployments: readonly FleetDeployment[],
  query: DeploymentListQuery,
): FleetDeployment[] {
  return deployments.filter((deployment) => {
    const { group, label } = deploymentDisplayStatus(deployment);
    // "All statuses" is the live fleet, as on Home: removed deployments only
    // appear when asked for. "Live" also keeps live deployments with an
    // update available — their badge reads Live, and Home counts them so.
    if (query.status === null ? group === 'removed' : !inStatusFilter(group, query.status)) return false;
    if (query.application !== null && deployment.applicationName !== query.application) return false;
    if (query.region !== null && deployment.region !== query.region) return false;
    return matchesSearch(
      [
        deployment.customerName,
        deployment.applicationName,
        deployment.version,
        deployment.id,
        deployment.region,
        regionName(deployment.region),
        label,
      ],
      query.search,
    );
  });
}

type Comparator = (a: FleetDeployment, b: FleetDeployment) => number;

const byCustomer: Comparator = (a, b) =>
  compareText(a.customerName, b.customerName) || compareText(a.applicationName, b.applicationName);

const COMPARATORS: Record<DeploymentSortKey, Comparator> = {
  // Group priority, then latest change first — the default order.
  status: (a, b) =>
    statusGroupRank(deploymentDisplayStatus(a).group) -
      statusGroupRank(deploymentDisplayStatus(b).group) ||
    compareTime(deploymentUpdatedAt(b), deploymentUpdatedAt(a)) ||
    byCustomer(a, b),
  customer: byCustomer,
  application: (a, b) =>
    compareText(a.applicationName, b.applicationName) || compareText(a.customerName, b.customerName),
  region: (a, b) =>
    compareText(regionName(a.region) ?? a.region, regionName(b.region) ?? b.region) ||
    compareText(a.region, b.region) ||
    byCustomer(a, b),
  updated: (a, b) => compareTime(deploymentUpdatedAt(a), deploymentUpdatedAt(b)) || byCustomer(a, b),
};

/** A total order: ties fall back to the id, so a refresh never reshuffles rows. */
export function sortDeployments(
  deployments: readonly FleetDeployment[],
  sort: SortState<DeploymentSortKey>,
): FleetDeployment[] {
  const compare = COMPARATORS[sort.key];
  return [...deployments].sort(
    (a, b) => withDirection(compare(a, b), sort.dir) || compareText(a.id, b.id),
  );
}
