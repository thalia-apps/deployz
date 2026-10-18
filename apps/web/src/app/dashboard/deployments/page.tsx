'use client';

import { Info } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { ListLoadingState, ListSearchInput, NoMatchesState, SortableHead } from '@/components/list-controls';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { VendorDeploymentStatus } from '@deployz/contracts';

import { isTestDeployment } from '@/lib/deployment-billing';
import {
  DEFAULT_DEPLOYMENT_SORT,
  DEPLOYMENT_SORT_NATURAL,
  deploymentUpdatedAt,
  filterDeployments,
  hasActiveFilters,
  parseDeploymentQuery,
  sortDeployments,
  type DeploymentSortKey,
} from '@/lib/deployment-list';
import { STAGE_LABEL, STEP_LABEL, removedProgress } from '@/lib/deployment-progress';
import { STATUS_FILTER_GROUPS, STATUS_GROUP_LABELS } from '@/lib/deployment-status-groups';
import { fetchDeployments, type FleetDeployment } from '@/lib/deployments';
import { relativeTime } from '@/lib/diagnostics';
import { formatDateTime, nextSort, sortParams, type SortState } from '@/lib/list-view';
import { regionName, regionOptionLabel } from '@/lib/regions';
import { useListParams } from '@/lib/use-list-params';
import { useStatusPoll } from '@/lib/use-status-poll';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'loaded'; deployments: FleetDeployment[] };

/** True once a deployment's derived stage can no longer advance on its own —
 *  the list slows its poll cadence the same way the detail page does. */
function isSettled(status: VendorDeploymentStatus): boolean {
  return status.stage === 'READY' || status.stage === 'FAILED';
}

/** The compact detail shown next to the stage on the fleet list: the
 *  server-derived step during PROVISIONING (more specific than the
 *  stage-level activity sentence), falling back to the component actively
 *  being created, then to the server's own currentActivity sentence. */
function progressDetail(status: VendorDeploymentStatus): string {
  // The step lookup tolerates an older API without `step` (a mixed-version
  // rollout window) by falling through to the activity sentence.
  if (status.stage === 'PROVISIONING' && status.step && STEP_LABEL[status.step]) {
    return STEP_LABEL[status.step].pending;
  }
  return status.currentActivity;
}

// The fleet dashboard — the vendor's primary recurring-value view: what is
// happening in each customer's environment. Customer / Application / Version /
// Region / Status / Updated, with client-side search, filters and sorting kept
// in the URL (e.g. /dashboard/deployments?status=attention&sort=updated), all
// derived from data the list already carries. Statuses come from
// lib/deployment-status-groups, the same classification the Customers list
// summarises; bulk deploy is not MVP scope, so the list carries no selection
// controls.
export default function DeploymentsPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const { params, setParams } = useListParams();
  const parsed = useMemo(() => parseDeploymentQuery(params), [params]);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      try {
        const deployments = await fetchDeployments({ includeDeleted: true });
        if (cancelled) return;
        setState(
          deployments.length === 0
            ? { status: 'empty' }
            : { status: 'loaded', deployments },
        );
      } catch {
        if (!cancelled) {
          setState({
            status: 'error',
            message: "Couldn't load deployments. Try again.",
          });
        }
      } finally {
        if (!cancelled) setRetrying(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Background refresh of the fleet's derived status, once the initial load
  // has already produced a list to update — the loading/error skeleton above
  // never re-triggers from this. Filters/search stay untouched: they are
  // client-side and URL-persisted, derived fresh from the updated rows below.
  const poll = useStatusPoll({
    fetcher: () => fetchDeployments({ includeDeleted: true }),
    intervalMs: 12_000,
    terminalIntervalMs: 60_000,
    isTerminal: (list) =>
      list.length === 0 || list.every((deployment) => isSettled(deployment.deploymentStatus)),
    enabled: state.status === 'loaded' || state.status === 'empty',
  });

  useEffect(() => {
    if (poll.data === null) return;
    setState(
      poll.data.length === 0 ? { status: 'empty' } : { status: 'loaded', deployments: poll.data },
    );
  }, [poll.data]);

  const deployments = useMemo(
    () => (state.status === 'loaded' ? state.deployments : []),
    [state],
  );

  const applications = useMemo(
    () => [...new Set(deployments.map((deployment) => deployment.applicationName))].sort(),
    [deployments],
  );
  const regions = useMemo(
    () => [...new Set(deployments.map((deployment) => deployment.region))].sort(),
    [deployments],
  );

  // A link naming an application or region this fleet no longer has would
  // filter to nothing behind a blank select, so it is treated as "all".
  const query = useMemo(
    () => ({
      ...parsed,
      application:
        parsed.application !== null && applications.includes(parsed.application)
          ? parsed.application
          : null,
      region: parsed.region !== null && regions.includes(parsed.region) ? parsed.region : null,
    }),
    [parsed, applications, regions],
  );

  const rows = useMemo(
    () => sortDeployments(filterDeployments(deployments, query), query.sort),
    [deployments, query],
  );

  const filtersActive = hasActiveFilters(query);
  const removedCount = deployments.filter((deployment) => deployment.state === 'DELETED').length;

  function clearFilters(): void {
    setParams({ q: null, status: null, application: null, region: null });
  }

  function onSort(key: DeploymentSortKey): void {
    setParams(sortParams(nextSort(query.sort, key, DEPLOYMENT_SORT_NATURAL), DEFAULT_DEPLOYMENT_SORT));
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Deployments</h1>
        {/* The empty state owns the sole call to action; a header copy of it
            would show the same button twice on one screen. */}
        {state.status === 'empty' ? null : (
          <Button asChild size="sm">
            <Link href="/dashboard/deployments/new">Create deployment</Link>
          </Button>
        )}
      </div>

      {state.status === 'loading' ? <ListLoadingState testId="deployments-loading" /> : null}
      {state.status === 'error' ? (
        <ErrorState
          message={state.message}
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            setAttempt((n) => n + 1);
          }}
        />
      ) : null}
      {state.status === 'empty' ? <EmptyState /> : null}
      {state.status === 'loaded' ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <ListSearchInput
              value={query.search}
              onCommit={(value) => setParams({ q: value })}
              placeholder="Search deployments"
              label="Search deployments"
            />
            <Select
              value={query.status ?? 'all'}
              onValueChange={(value) => setParams({ status: value === 'all' ? null : value })}
            >
              <SelectTrigger aria-label="Filter by status" className="w-full sm:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUS_FILTER_GROUPS.map((group) => (
                  <SelectItem key={group} value={group}>
                    {STATUS_GROUP_LABELS[group]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {applications.length > 1 ? (
              <Select
                value={query.application ?? 'all'}
                onValueChange={(value) => setParams({ application: value === 'all' ? null : value })}
              >
                <SelectTrigger aria-label="Filter by application" className="w-full sm:w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All applications</SelectItem>
                  {applications.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {regions.length > 1 ? (
              <Select
                value={query.region ?? 'all'}
                onValueChange={(value) => setParams({ region: value === 'all' ? null : value })}
              >
                <SelectTrigger aria-label="Filter by region" className="w-full sm:w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All regions</SelectItem>
                  {regions.map((code) => (
                    <SelectItem key={code} value={code}>
                      {regionOptionLabel(code)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {filtersActive ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : null}
          </div>

          {rows.length === 0 ? (
            filtersActive ? (
              <NoMatchesState heading="No deployments match these filters." onClear={clearFilters} />
            ) : removedCount > 0 ? (
              <p className="px-1 text-sm text-muted-foreground">
                No active deployments.{' '}
                <button
                  type="button"
                  className="underline underline-offset-4"
                  onClick={() => setParams({ status: 'removed' })}
                >
                  {removedCount === 1
                    ? '1 removed deployment may still have retained resources.'
                    : `${removedCount} removed deployments may still have retained resources.`}
                </button>
              </p>
            ) : null
          ) : (
            <FleetTable
              deployments={rows}
              activeSort={query.sort}
              onSort={onSort}
            />
          )}
        </>
      ) : null}
    </div>
  );
}

function ErrorState({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <section
      aria-labelledby="deployments-error"
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <h2 id="deployments-error" className="text-lg font-semibold">
        Something went wrong
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" loading={retrying} loadingText="Trying again…" onClick={onRetry}>
        Try again
      </Button>
    </section>
  );
}

// One action: create the first deployment.
function EmptyState() {
  return (
    <section
      aria-labelledby="empty-deployments"
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <h2 id="empty-deployments" className="text-lg font-semibold">
        No customer deployments yet
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Create a deployment to install your application in a customer&apos;s AWS account.
      </p>
      <Button asChild className="mt-2">
        <Link href="/dashboard/deployments/new">Create deployment</Link>
      </Button>
    </section>
  );
}

function FleetTable({
  deployments,
  activeSort,
  onSort,
}: {
  deployments: FleetDeployment[];
  activeSort: SortState<DeploymentSortKey>;
  onSort: (key: DeploymentSortKey) => void;
}) {
  const direction = (key: DeploymentSortKey) => (activeSort.key === key ? activeSort.dir : null);
  return (
    // A container query, not a viewport one: the sidebar takes 256px at
    // tablet widths, so the table's own width says how many columns fit.
    <Card className="@container py-0">
      <CardContent className="overflow-x-auto p-0">
        <Table data-testid="deployment-list">
          <TableHeader>
            <TableRow>
              <SortableHead label="Customer" direction={direction('customer')} onSort={() => onSort('customer')} />
              <SortableHead
                label="Application"
                direction={direction('application')}
                onSort={() => onSort('application')}
                className="hidden @4xl:table-cell"
              />
              <TableHead className="hidden @4xl:table-cell">Version</TableHead>
              <SortableHead
                label="Region"
                direction={direction('region')}
                onSort={() => onSort('region')}
                className="hidden @4xl:table-cell"
              />
              <SortableHead label="Status" direction={direction('status')} onSort={() => onSort('status')} />
              <SortableHead
                label="Updated"
                direction={direction('updated')}
                onSort={() => onSort('updated')}
                className="hidden @2xl:table-cell"
              />
            </TableRow>
          </TableHeader>
          <TableBody>
            {deployments.map((deployment) => (
              <FleetRow key={deployment.id} deployment={deployment} />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function FleetRow({ deployment }: { deployment: FleetDeployment }) {
  const region = regionName(deployment.region);
  const updatedAt = deploymentUpdatedAt(deployment);
  return (
    <TableRow>
      <TableCell>
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={`/dashboard/deployments/${deployment.id}`}
            title={deployment.customerName}
            className="max-w-24 truncate font-medium hover:underline @sm:max-w-48"
          >
            {deployment.customerName}
          </Link>
          {isTestDeployment(deployment) ? (
            <Badge variant="secondary" className="shrink-0">
              Test · Free
            </Badge>
          ) : null}
        </div>
        {/* Application and Updated are columns only when the table is wide
            enough; below that they sit beneath the customer instead. */}
        <p className="max-w-24 truncate text-xs text-muted-foreground @sm:max-w-48 @4xl:hidden">
          {deployment.applicationName}
          <span className="@2xl:hidden" data-testid="deployment-updated">
            {updatedAt ? ` · ${relativeTime(updatedAt)}` : null}
          </span>
        </p>
      </TableCell>
      <TableCell className="hidden text-muted-foreground @4xl:table-cell">
        <span className="block max-w-44 truncate" title={deployment.applicationName}>
          {deployment.applicationName}
        </span>
      </TableCell>
      <TableCell className="hidden text-muted-foreground tabular-nums @4xl:table-cell">
        {deployment.version ?? '—'}
      </TableCell>
      <TableCell className="hidden @4xl:table-cell">
        <div className="flex flex-col leading-tight">
          <span className="text-muted-foreground">{region ?? deployment.region}</span>
          {region ? <span className="text-xs text-muted-foreground/80">{deployment.region}</span> : null}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Long reasons ("Needs attention · Not responding") wrap on a phone. */}
          <StatusBadge deployment={deployment} className="h-auto shrink whitespace-normal" />
          {deployment.state === 'UPDATE_AVAILABLE' ? <Badge variant="info">Update available</Badge> : null}
          <StatusDetails deployment={deployment} />
        </div>
      </TableCell>
      <TableCell className="hidden whitespace-nowrap text-muted-foreground @2xl:table-cell">
        {updatedAt ? (
          // data-testid: masked in visual regression — relative time drifts
          // with the clock.
          <time dateTime={updatedAt} title={formatDateTime(updatedAt)} data-testid="deployment-updated">
            {relativeTime(updatedAt)}
          </time>
        ) : (
          '—'
        )}
      </TableCell>
    </TableRow>
  );
}

// One info affordance next to the status badge: the stage detail behind the
// label, and relay connectivity, which is observed (last check-in) and never
// inferred from the lifecycle state.
function StatusDetails({ deployment }: { deployment: FleetDeployment }) {
  const detail =
    removedProgress(deployment.state)?.body ??
    `${STAGE_LABEL[deployment.deploymentStatus.stage]} · ${progressDetail(deployment.deploymentStatus)}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Status details for ${deployment.customerName}`}
          className="hidden text-muted-foreground @2xl:inline-flex"
        >
          <Info aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-1.5">
        <p className="text-sm">{detail}</p>
        {deployment.relayStatus === 'DISCONNECTED' ? (
          <p className="text-xs font-medium text-destructive">Deployz connector offline</p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
