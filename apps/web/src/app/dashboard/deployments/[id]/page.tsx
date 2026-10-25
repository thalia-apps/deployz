'use client';

import {
  REGION_LABELS,
  type DeploymentPlan,
  type Region,
} from '@deployz/contracts';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleMinus,
  Info,
  Loader2,
  MoreHorizontal,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { toast } from 'sonner';

import { PreflightSummary } from '@/components/preflight-summary';
import { ActivityFeed } from '@/components/activity-feed';
import { ConnectorUpdateAlert } from '@/components/connector-update-alert';
import { DeploymentHero } from '@/components/deployment-hero';
import { DocsLink } from '@/components/docs-link';
import { StatusBadge } from '@/components/status-badge';
import { TechnicalDetails } from '@/components/technical-details';
import { InfrastructureEvents } from '@/components/infrastructure-events';
import { InfrastructureSummary } from '@/components/infrastructure-summary';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchDeploymentPreflight, type PreflightResult } from '@/lib/preflight';
import { errorMessage } from '@/lib/api-client';
import { formatDate } from '@/lib/customers';
import { requirementDriftLine } from '@/lib/install-plan';
import {
  canRetryFirstInstall,
  deploymentEverRan,
  deriveHero,
  operationInFlight,
  retryNeedsNewInstallLink,
  statusPollSettled,
  type HeroModel,
} from '@/lib/deployment-hero';
import {
  DESTROY_PENDING_STALE_AFTER_MS,
  DeploymentActionError,
  actionErrorMessage,
  deployRelease,
  destroyDeployment,
  fetchDeployment,
  fetchDeploymentEvents,
  fetchDeploymentInfrastructure,
  fetchDeploymentPlan,
  forceCompleteDisconnect,
  isDeploymentNotFound,
  purgeDeployment,
  resetRelay,
  restartDeployment,
  retryInstall,
  rollbackDeployment,
  type ActivityEvent,
  type FleetDeploymentDetail,
  type InfrastructureResponse,
  type RelayCapabilities,
} from '@/lib/deployments';
import { deploymentBillingLabel } from '@/lib/deployment-billing';
import {
  JOB_STATE_LABEL,
  JOB_TYPE_LABEL,
  CONNECTOR_STATUS_LABEL,
  RELAY_STATUS_LABEL,
  RELAY_STUCK_GUIDANCE,
  actionSupported,
  actionsUnavailableReason,
  purgeProgress,
  relayWaitingStuck,
  retainedUntilDeletedSentence,
} from '@/lib/deployment-vocabulary';
import {
  relativeTime,
  fetchDiagnostics,
  infraCheckPresentation,
  infraCheckReport,
  readInfraChecks,
  retryCta,
  type Diagnostic,
  type InfraCheck,
  type InfraCheckOutcome,
  type RetryEligibility,
} from '@/lib/diagnostics';
import { isConfigurationFailure } from '@/lib/diagnostic-vocabulary';
import { DOCS } from '@/lib/docs-links';
import { TONE_TEXT } from '@/lib/status-tone';
import { cn } from '@/lib/utils';
import {
  NO_DEPLOYABLE_RELEASES_COPY,
  deployableReleases,
  fetchReleases,
  updateTargetRelease,
  type Release,
} from '@/lib/releases';
import { formatReleaseVersion, runningReleaseDisplay } from '@/lib/release-version';
import { useStatusPoll } from '@/lib/use-status-poll';

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string; notFound: boolean }
  | {
      status: 'loaded';
      detail: FleetDeploymentDetail;
      events: EventsState;
      releases: ReleasesState;
    };

/** The activity feed: loading, failed (the feed says so), or loaded. */
type EventsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'loaded'; data: ActivityEvent[] };

/** The resource inventory: loading, failed (the page stays up), or loaded. */
type InfrastructureState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'loaded'; data: InfrastructureResponse };

/** Releases the deploy picker may offer: loading, failed, or loaded. */
type ReleasesState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'loaded'; data: Release[] };

/** A `DeploymentPlan` fetch for a plan-driven dialog: loading, failed, or loaded. */
type PlanState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'loaded'; data: DeploymentPlan };

const NO_PREVIOUS_RELEASE_COPY = 'No previous successful release to roll back to.';
// After a rollback that followed a failed update, the previous successful
// release IS the running one (the API records the pointer the deployment
// carried into the rollback). Offering "Rollback" then would roll back to
// the version already serving.
const PREVIOUS_IS_CURRENT_COPY =
  'The previous release is already running.';
const INSTALL_STAGES = new Set(['WAITING_FOR_AWS', 'CONNECTING', 'PROVISIONING']);

// §24 deployment detail, laid out as a status page rather than a console:
// compact header → state-aware hero with contextual actions → metadata →
// infrastructure summary → recent activity → collapsed technical details.
// M14: deployment health only — no application observability.
export default function DeploymentDetailPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  const [infrastructure, setInfrastructure] = useState<InfrastructureState>({ status: 'loading' });
  // Startup evidence + retry eligibility for a failed first install. Fetched
  // lazily (the detail page load must not wait on it) and kept null otherwise.
  const [diagnostics, setDiagnostics] = useState<Diagnostic[] | null>(null);
  const diagnosticsFetchedFor = useRef<string | null>(null);
  // Signature of the last (stage, state) pair the poll observed — refetching
  // the activity feed on every 5s tick would hammer it for nothing, so it
  // only happens when this actually moved.
  const lastSignature = useRef<{ stage: string; state: string } | null>(null);

  const refreshInfrastructure = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchDeploymentInfrastructure(id);
      setInfrastructure({ status: 'loaded', data });
    } catch {
      // Keep the last inventory if there is one; only a first load that
      // fails shows the section-level warning. The deployment itself is
      // unaffected either way.
      setInfrastructure((current) => (current.status === 'loaded' ? current : { status: 'error' }));
    }
  }, [id]);

  const refreshEvents = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchDeploymentEvents(id);
      setState((current) =>
        current.status === 'loaded' ? { ...current, events: { status: 'loaded', data } } : current,
      );
    } catch {
      // Keep the last feed if there is one; the poll refreshes it on the
      // next lifecycle change.
      setState((current) =>
        current.status === 'loaded' && current.events.status !== 'loaded'
          ? { ...current, events: { status: 'error' } }
          : current,
      );
    }
  }, [id]);

  // Shows the list it already has while it refreshes; only a first load or a
  // retry after a failure shows "Loading releases…".
  const refreshReleases = useCallback(async (applicationId: string): Promise<void> => {
    setState((current) =>
      current.status === 'loaded' && current.releases.status === 'error'
        ? { ...current, releases: { status: 'loading' } }
        : current,
    );
    try {
      const data = await fetchReleases(applicationId);
      setState((current) =>
        current.status === 'loaded' ? { ...current, releases: { status: 'loaded', data } } : current,
      );
    } catch {
      setState((current) =>
        current.status === 'loaded' ? { ...current, releases: { status: 'error' } } : current,
      );
    }
  }, []);

  const load = useCallback(async (): Promise<void> => {
    let detail: FleetDeploymentDetail;
    try {
      detail = await fetchDeployment(id);
    } catch (caught) {
      // Only the deployment itself decides whether this page exists. A 404
      // is permanent for this URL — no retry-oriented copy for it.
      setState(
        isDeploymentNotFound(caught)
          ? {
              status: 'error',
              notFound: true,
              message: "Not found, or you don't have access.",
            }
          : {
              status: 'error',
              notFound: false,
              message: "Couldn't load this deployment. Try again.",
            },
      );
      return;
    }
    // The deployment renders as soon as it loads. The supporting requests
    // run on their own and degrade independently: a failed inventory,
    // activity or releases fetch marks its own section, never the whole page.
    lastSignature.current = { stage: detail.deploymentStatus.stage, state: detail.state };
    setState((current) => ({
      status: 'loaded',
      detail,
      events: current.status === 'loaded' ? current.events : { status: 'loading' },
      releases: current.status === 'loaded' ? current.releases : { status: 'loading' },
    }));
    void refreshEvents();
    void refreshReleases(detail.applicationId);
    void refreshInfrastructure();
  }, [id, refreshEvents, refreshReleases, refreshInfrastructure]);

  useEffect(() => {
    void load();
  }, [load]);

  // Lazy, non-blocking fetch of diagnostics whenever the deployment is
  // failed, carries a classified failure, or needs attention (ux-guidelines
  // §2 — diagnostics folds into the recovery panel for all three, not only
  // state FAILED). The endpoint returns null fields when there is nothing to
  // explain, so calling it here is safe. Evidence chips and the recovery
  // panel's "who acts" copy are best-effort: a failed fetch must never
  // regress the page, which already renders from the deployment itself.
  // Keyed on this primitive boolean + the route id, not the whole `state`
  // object: the status poll replaces `state` with a fresh object every tick,
  // so depending on `state` re-runs this effect on every tick, which cancels
  // the in-flight fetch via the cleanup while the `diagnosticsFetchedFor`
  // guard suppresses the retry — leaving diagnostics permanently unloaded.
  const needsDiagnostics =
    state.status === 'loaded' &&
    (state.detail.state === 'FAILED' ||
      state.detail.deploymentStatus.failure !== null ||
      state.detail.healthStatus === 'UNHEALTHY' ||
      state.detail.healthStatus === 'DEGRADED' ||
      state.detail.relayStatus === 'DISCONNECTED');
  useEffect(() => {
    if (!needsDiagnostics) {
      if (diagnosticsFetchedFor.current !== null) {
        diagnosticsFetchedFor.current = null;
        setDiagnostics(null);
      }
      return;
    }
    if (diagnosticsFetchedFor.current === id) return;
    diagnosticsFetchedFor.current = id;
    let cancelled = false;
    fetchDiagnostics(id)
      .then((result) => {
        if (!cancelled) setDiagnostics(result);
      })
      .catch(() => {
        // Leave `diagnostics` null — the page keeps its existing copy.
      });
    return () => {
      cancelled = true;
    };
  }, [needsDiagnostics, id]);

  // Silent background refresh of the deployment's derived status. Only the
  // `detail` object is replaced — open dialogs and in-flight actions keep
  // their own local state, so a poll tick never resets them.
  const poll = useStatusPoll({
    fetcher: () => fetchDeployment(id),
    intervalMs: 5000,
    terminalIntervalMs: 60000,
    isTerminal: statusPollSettled,
    enabled: state.status === 'loaded',
  });

  useEffect(() => {
    if (poll.data === null) return;
    const detail = poll.data;
    setState((current) => (current.status === 'loaded' ? { ...current, detail } : current));

    const signature = { stage: detail.deploymentStatus.stage, state: detail.state };
    const moved =
      lastSignature.current === null ||
      lastSignature.current.stage !== signature.stage ||
      lastSignature.current.state !== signature.state;
    lastSignature.current = signature;
    if (moved) {
      void refreshEvents();
    }
    // Refresh the infrastructure snapshot on every poll tick so the
    // component list stays live during disconnect.
    void refreshInfrastructure();
  }, [poll.data, refreshEvents, refreshInfrastructure]);

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/dashboard/deployments">Deployments</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>
              {state.status === 'loaded' ? state.detail.applicationName : 'Deployment'}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {state.status === 'loading' ? <DetailSkeleton /> : null}
      {state.status === 'error' ? (
        <section
          aria-labelledby="detail-error"
          className="rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h2 id="detail-error" className="text-lg font-semibold">
            {state.notFound ? 'Deployment not found' : 'Something went wrong'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
        </section>
      ) : null}
      {state.status === 'loaded' ? (
        <DetailBody
          detail={state.detail}
          events={state.events}
          releases={state.releases}
          infrastructure={infrastructure}
          diagnostics={diagnostics}
          onChanged={load}
          onRefreshReleases={refreshReleases}
        />
      ) : null}
    </div>
  );
}

function DetailBody({
  detail,
  events,
  releases,
  infrastructure,
  diagnostics,
  onChanged,
  onRefreshReleases,
}: {
  detail: FleetDeploymentDetail;
  events: EventsState;
  releases: ReleasesState;
  infrastructure: InfrastructureState;
  diagnostics: Diagnostic[] | null;
  onChanged: () => void;
  onRefreshReleases: (applicationId: string) => void;
}) {
  const previousVersion =
    releases.status === 'loaded'
      ? (releases.data.find((r) => r.id === detail.previousReleaseId)?.version ?? null)
      : null;
  const hero = deriveHero(detail);
  const inventory = infrastructure.status === 'loaded' ? infrastructure.data : null;
  const diagnostic = diagnostics?.[0] ?? null;

  // Health and update availability are separate answers: a live deployment
  // shows its measured health, and — only from the §46 state — whether a
  // newer release is ready. The target version comes from the releases
  // list; while it is unknown, the badge says only that an update exists.
  const updateTarget =
    detail.state === 'UPDATE_AVAILABLE' && releases.status === 'loaded'
      ? updateTargetRelease(releases.data, detail.currentReleaseId)
      : null;

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight">
            {detail.applicationName}
          </h1>
          <StatusBadge deployment={detail} />
          {detail.state === 'UPDATE_AVAILABLE' ? (
            <Badge variant="info" data-testid="update-available">
              {updateTarget
                ? `Update available: ${formatReleaseVersion(updateTarget.version)}`
                : 'Update available'}
            </Badge>
          ) : null}
        </div>
        <DeploymentMetadata detail={detail} />
      </div>

      <section aria-labelledby="deployment-progress" className="flex flex-col gap-3">
        <h2 id="deployment-progress" className="sr-only">
          Deployment status
        </h2>
        <DeploymentHero
          detail={detail}
          hero={hero}
          diagnostic={diagnostic}
          actions={
            <DeploymentActions
              detail={detail}
              hero={hero}
              releases={releases}
              previousVersion={previousVersion}
              updateVersion={updateTarget?.version ?? null}
              retryEligibility={diagnostic?.retryEligibility ?? null}
              onChanged={onChanged}
              onRefreshReleases={onRefreshReleases}
            />
          }
        >
          {detail.state === 'DELETING' ? (
            <DisconnectStatusPanel
              detail={detail}
              infrastructure={inventory}
              onChanged={onChanged}
            />
          ) : null}
          {detail.state === 'DELETED' ? (
            <RemovedDeploymentNotes detail={detail} infrastructure={inventory} onChanged={onChanged} />
          ) : null}
        </DeploymentHero>
      </section>

      <ConnectorUpdateAlert connector={detail.deploymentStatus.connector} customerName={detail.customerName} />

      {detail.state === 'NOT_INSTALLED' || detail.state === 'WAITING_FOR_RELAY' ? (
        <InstallLinkCard detail={detail} />
      ) : null}

      <section aria-labelledby="infrastructure" className="flex flex-col gap-3">
        <h2 id="infrastructure" className="text-base font-semibold">
          Infrastructure
        </h2>
        <DocsLink href={DOCS.awsResources}>AWS resources Deployz creates</DocsLink>
        {detail.size ? (
          <p className="text-sm text-muted-foreground" data-testid="deployment-size-label">
            Size: {detail.size.label}
          </p>
        ) : null}
        <InfrastructureSummary
          detail={detail}
          infrastructure={inventory}
          infrastructureError={infrastructure.status === 'error'}
        />
      </section>

      <section aria-labelledby="activity" className="flex flex-col gap-3">
        <h2 id="activity" className="text-base font-semibold">
          Recent activity
        </h2>
        {events.status === 'loading' ? (
          <p className="text-sm text-muted-foreground">Loading activity…</p>
        ) : events.status === 'error' ? (
          <p className="text-sm text-muted-foreground">
            Activity unavailable. Refreshes automatically.
          </p>
        ) : (
          <ActivityFeed events={events.data} />
        )}
      </section>

      <DeploymentTechnicalDetails detail={detail} infrastructure={inventory} />
    </>
  );
}

/**
 * The deployment's facts, each shown once. The address and custom domain
 * live in the hero's access block; the AWS account, stack status and
 * version identifiers live under Technical details.
 */
function DeploymentMetadata({ detail }: { detail: FleetDeploymentDetail }) {
  const created = new Date(detail.createdAt);
  const regionName = REGION_LABELS[detail.region as Region];
  const release = runningReleaseDisplay(detail.version, detail.deploymentStatus.servingRelease.confirmed);

  return (
    <section aria-labelledby="overview">
      <h2 id="overview" className="sr-only">
        Deployment details
      </h2>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-5">
        <MetaRow label="Customer" value={detail.customerName} />
        <MetaRow
          label="AWS region"
          value={
            regionName ? (
              <>
                {regionName}{' '}
                <span className="font-normal whitespace-nowrap text-muted-foreground">{detail.region}</span>
              </>
            ) : (
              detail.region
            )
          }
        />
        <MetaRow
          label="Running release"
          value={
            <>
              <span className={detail.version ? 'tabular-nums' : undefined}>{release.text}</span>
              {release.note ? (
                <span className="block text-xs font-normal text-muted-foreground">{release.note}</span>
              ) : null}
            </>
          }
        />
        {/* Paddle migration Phase 11 — the vendor's one-line answer to "what
            does this cost me?". Reads the deployment's billing state, never
            its health: a temporarily unhealthy deployment is still billed. */}
        <MetaRow
          label="Deployment type"
          value={
            detail.deploymentType === 'TEST' ? (
              deploymentBillingLabel(detail)
            ) : (
              <>
                Production
                <span className="block text-xs font-normal text-muted-foreground">
                  {deploymentBillingLabel(detail)}
                </span>
              </>
            )
          }
        />
        <MetaRow
          label="Created"
          value={
            <time dateTime={detail.createdAt} title={created.toLocaleString()}>
              {created.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </time>
          }
        />
      </dl>
    </section>
  );
}

const TECHNICAL_DETAILS_ANCHORS = new Set(['technical-details', 'infrastructure-check']);

/**
 * Implementation detail progressively disclosed (ux-guidelines §8) — nothing
 * here is required reading; the hero and metadata above carry the state that
 * matters. Holds the deployment's identifiers, the infrastructure check
 * (folded in from the former /diagnostics route) and the raw CloudFormation
 * event feed. `/dashboard/deployments/[id]/diagnostics` deep-links here.
 */
function DeploymentTechnicalDetails({
  detail,
  infrastructure,
}: {
  detail: FleetDeploymentDetail;
  infrastructure: InfrastructureResponse | null;
}) {
  const status = detail.deploymentStatus;
  const checks = readInfraChecks(detail.observedState);
  const [defaultOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    return TECHNICAL_DETAILS_ANCHORS.has(window.location.hash.replace('#', ''));
  });

  useEffect(() => {
    const hash = window.location.hash.replace('#', '');
    if (!TECHNICAL_DETAILS_ANCHORS.has(hash)) return;
    // The section only exists in the DOM once open — wait a tick for the
    // Collapsible's defaultOpen content to mount before scrolling to it.
    const frame = requestAnimationFrame(() => {
      document.getElementById(hash)?.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <TechnicalDetails id="technical-details" defaultOpen={defaultOpen}>
      <Card>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <MetaRow label="AWS account" value={detail.awsAccountId ?? 'Not connected yet'} />
            <MetaRow label="Infrastructure version" value={detail.infraVersion} />
            {detail.relayVersion ? (
              <MetaRow label="Connector version" value={detail.relayVersion} />
            ) : null}
            {detail.bootstrapStackName ? (
              <MetaRow label="Connector stack" value={<Mono>{detail.bootstrapStackName}</Mono>} />
            ) : null}
            <MetaRow
              label="Stack status"
              value={
                status.aws.stackStatus ?? infrastructure?.stackStatus ? (
                  <Mono>{status.aws.stackStatus ?? infrastructure?.stackStatus}</Mono>
                ) : (
                  '—'
                )
              }
            />
            {status.job ? (
              <MetaRow
                label="Latest job"
                value={`${JOB_TYPE_LABEL[status.job.type]} · ${JOB_STATE_LABEL[status.job.status]}`}
              />
            ) : null}
            {status.failure?.code ? (
              <MetaRow label="Failure code" value={<Mono>{status.failure.code}</Mono>} />
            ) : null}
            {status.failure?.reference ? (
              <MetaRow label="Failure reference" value={<Mono>{status.failure.reference}</Mono>} />
            ) : null}
            {status.failure?.awsStatus ? (
              <MetaRow label="Failure status" value={<Mono>{status.failure.awsStatus}</Mono>} />
            ) : null}
            <MetaRow
              label="Deployz connector"
              value={
                <span data-testid="status-updated">
                  {CONNECTOR_STATUS_LABEL[detail.relayStatus]}
                  {relativeTime(detail.lastHealthAt) ? ` · ${relativeTime(detail.lastHealthAt)}` : ''}
                </span>
              }
            />
            <MetaRow label="Deployment ID" value={<Mono>{detail.id}</Mono>} />
          </dl>
        </CardContent>
      </Card>
      <InfrastructureCheckSection detail={detail} checks={checks} />
      <InfrastructureEvents deploymentId={detail.id} stage={status.stage} />
    </TechnicalDetails>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{children}</code>
  );
}

const INFRA_CHECK_RESULT_ICON: Record<InfraCheckOutcome, ReactNode> = {
  passed: <CheckCircle2 aria-hidden className={cn('mt-0.5 size-4 shrink-0', TONE_TEXT.positive)} />,
  issue: <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />,
  not_required: <CircleMinus aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />,
};

/**
 * The infrastructure check table, folded in from the former /diagnostics
 * route (ux-guidelines §2). It never stands in for application health, and
 * it never reconciles against events — UX-BACKEND-002 stays open, so this
 * only carries the freshness line the API can support today.
 */
function InfrastructureCheckSection({
  detail,
  checks,
}: {
  detail: FleetDeploymentDetail;
  checks: InfraCheck[];
}) {
  const report = infraCheckReport(checks, detail.lastHealthAt, detail.relayStatus);
  const checkedAgo = relativeTime(detail.lastHealthAt);
  const checkedAt = detail.lastHealthAt ? new Date(detail.lastHealthAt).toLocaleString() : undefined;
  const checkedLine = checkedAgo ? (
    <span data-testid="relay-last-checked" title={checkedAt}>
      Checked {checkedAgo}.
    </span>
  ) : null;
  const notInstalled = detail.state === 'NOT_INSTALLED' || detail.state === 'WAITING_FOR_RELAY';

  return (
    <section id="infrastructure-check" aria-labelledby="infra-check" className="flex scroll-mt-20 flex-col gap-3">
      <h3 id="infra-check" className="text-sm font-medium">
        Infrastructure check
      </h3>

      {report.kind === 'passed' ? (
        <Alert data-testid="infra-check-outcome">
          <CheckCircle2 aria-hidden className={TONE_TEXT.positive} />
          <AlertTitle>No issues found in the latest infrastructure check.</AlertTitle>
          <AlertDescription>
            <p>
              {checkedLine} AWS infrastructure only. Application health is shown above.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {report.kind === 'stale' ? (
        <Alert data-testid="infra-check-outcome">
          <AlertTriangle aria-hidden className={TONE_TEXT.attention} />
          <AlertTitle>The latest infrastructure check is out of date.</AlertTitle>
          <AlertDescription>
            <p>
              {checkedLine} No new connector report since then. Results may not match the
              customer&apos;s AWS account.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {report.kind === 'issues' ? (
        <Alert variant="destructive" data-testid="infra-check-outcome">
          <AlertCircle aria-hidden />
          <AlertTitle>
            {report.issues.length === 1
              ? '1 issue found in the latest infrastructure check.'
              : `${report.issues.length} issues found in the latest infrastructure check.`}
          </AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-2" data-testid="relay-report-issues">
              {report.issues.map((check) => {
                const presentation = infraCheckPresentation(check);
                return (
                  <li key={check.name} className="flex flex-col gap-0.5">
                    <span className="font-medium text-foreground">{presentation.label}</span>
                    <span>{presentation.problem}</span>
                    <span>Next step: {presentation.nextAction}</span>
                  </li>
                );
              })}
            </ul>
            <p>
              {checkedLine}
              {report.stale ? ' No connector report since then.' : null}
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {report.kind === 'unavailable' ? (
        <Alert data-testid="infra-check-outcome">
          <Info aria-hidden />
          <AlertTitle>
            {notInstalled ? 'Nothing to check yet' : 'No infrastructure check has completed yet'}
          </AlertTitle>
          <AlertDescription>
            <p>
              {notInstalled
                ? 'Not installed yet.'
                : detail.relayStatus === 'CONNECTED'
                  ? 'Results appear after the Deployz connector reports.'
                  : 'The Deployz connector is not connected, so the infrastructure cannot be checked.'}
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {checks.length > 0 ? (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Check
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Result
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {checks.map((check) => {
                const presentation = infraCheckPresentation(check);
                return (
                  <tr key={check.name}>
                    <th scope="row" className="px-3 py-2 text-left align-top font-medium">
                      {presentation.label}
                    </th>
                    <td className="px-3 py-2 align-top">
                      <span className="inline-flex items-start gap-1.5">
                        {INFRA_CHECK_RESULT_ICON[presentation.outcome]}
                        <span
                          className={cn(
                            presentation.outcome === 'issue' && 'text-destructive',
                            presentation.outcome === 'not_required' && 'text-muted-foreground',
                          )}
                        >
                          {presentation.statusText}
                        </span>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {checks.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
            Raw check output
            <ChevronDown aria-hidden className="size-4 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div
              className="mt-2 flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-xs text-muted-foreground"
              data-testid="relay-report-technical"
            >
              {checks.map((check) => (
                <div key={check.name} className="flex flex-col gap-0.5">
                  <span className="font-medium text-foreground">{check.name}</span>
                  <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono">{check.detail}</code>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </section>
  );
}

// The contextual action row. Day-2 actions are gated on the installed relay
// advertising the matching capability — an enabled button over a stub
// executor would report success having done nothing — on the deployment
// having ever completed an install (a relay can connect and advertise
// capabilities before that happens), and on the relay currently being
// connected (a job queued for an offline relay would sit until the watchdog
// fails it). Disconnect is exempt from the install and relay gates: a
// deployment that failed to ever come up must still be removable, and a lost
// relay routes through the force-complete escape hatch.
// Rare and destructive actions live behind "More actions" so they never
// compete with the one thing the vendor should do next.
type FocusTarget = RefObject<HTMLElement | null>;

// A dialog opened from the More actions menu has no trigger of its own, so
// Radix would drop focus on the page body when it closes. Send it back to the
// menu button instead.
function returnFocus(target: FocusTarget) {
  return (event: Event) => {
    if (target.current) {
      event.preventDefault();
      target.current.focus();
    }
  };
}

function DeploymentActions({
  detail,
  hero,
  releases,
  previousVersion,
  updateVersion,
  retryEligibility,
  onChanged,
  onRefreshReleases,
}: {
  detail: FleetDeploymentDetail;
  hero: HeroModel;
  releases: ReleasesState;
  previousVersion: string | null;
  /** The release UPDATE_AVAILABLE points at, when the releases list names it. */
  updateVersion: string | null;
  retryEligibility: RetryEligibility | null;
  onChanged: () => void;
  onRefreshReleases: (applicationId: string) => void;
}) {
  const [open, setOpen] = useState<
    'deploy' | 'rollback' | 'restart' | 'disconnect' | 'retryInstall' | null
  >(null);
  const { applicationId } = detail;
  // The release list may have changed since the page loaded (a new build, a
  // withdrawn release), so opening the picker refreshes it.
  useEffect(() => {
    if (open === 'deploy') onRefreshReleases(applicationId);
  }, [open, applicationId, onRefreshReleases]);
  const moreActionsRef = useRef<HTMLButtonElement>(null);
  const capabilities: RelayCapabilities | null = detail.relayCapabilities;
  // §24: day-2 actions act on a running application: nothing to act on
  // before the first install has completed (an install in flight included),
  // while another mutating operation owns the deployment (the API answers
  // DEPLOYMENT_BUSY), or while the relay that must fetch the queued job is
  // not connected (§9.5 liveness — the API refuses with RELAY_DISCONNECTED /
  // RELAY_NOT_CONNECTED). Each signal mirrors a server-side gate, so the
  // buttons are disabled up front with the why, never enabled into a 409.
  // Disconnect is exempt from the install and relay gates: a deployment that
  // failed to ever come up must still be removable, and a lost relay routes
  // through the force-complete escape hatch.
  const everRan =
    deploymentEverRan(detail.state, detail.currentReleaseId, retryEligibility) &&
    !INSTALL_STAGES.has(detail.deploymentStatus.stage);
  // A pending DESTROY owns the deployment: every other mutating action
  // targets a stack that is about to disappear underneath it. A running
  // update owns it the same way (the API answers DEPLOYMENT_BUSY).
  const disconnecting = detail.state === 'DELETING';
  const removed = detail.state === 'DELETED';
  // The API refuses a second mutating operation while one is running
  // (requireDeploymentIdle), disconnect included — so every action here is
  // gated on the same signal rather than on the lifecycle state alone.
  const inFlightOperation = operationInFlight(detail.jobs);
  const busy = inFlightOperation !== null;
  const relayOnline = detail.relayStatus === 'CONNECTED';
  const available = relayOnline && everRan && !disconnecting && !busy && !removed;
  const canDeploy = available && actionSupported(capabilities, 'deploy');
  const canRollback = available && actionSupported(capabilities, 'rollback');
  const canRestart = available && actionSupported(capabilities, 'restart');
  const canConfig = available && actionSupported(capabilities, 'configUpdate');
  // A deployment that never connected a relay has no capabilities yet; the
  // API removes it directly, without a relay job.
  const neverConnected = detail.state === 'NOT_INSTALLED' || detail.state === 'WAITING_FOR_RELAY';
  const canDisconnect =
    !disconnecting &&
    !removed &&
    !busy &&
    (neverConnected || actionSupported(capabilities, 'disconnect'));
  // Recovery for a failed FIRST install: the API refuses it once any install
  // has succeeded, so it is offered exactly where the day-2 actions are not.
  const canRetryInstall = canRetryFirstInstall(detail.state, everRan, inFlightOperation);
  const retryCtaKind = canRetryInstall ? retryCta(retryEligibility) : null;
  // Capability copy applies only while the deployment would otherwise be
  // actionable — an offline/busy/removed deployment reports its own reason.
  const anyCapabilityGatedOff =
    available &&
    (!actionSupported(capabilities, 'deploy') ||
      !actionSupported(capabilities, 'rollback') ||
      !actionSupported(capabilities, 'restart') ||
      !actionSupported(capabilities, 'configUpdate') ||
      !actionSupported(capabilities, 'disconnect'));
  const actionsUnavailable = actionsUnavailableReason({
    state: detail.state,
    everRan,
    relayStatus: detail.relayStatus,
    busy,
    anyCapabilityGatedOff,
  });
  // After a failure, Configuration is offered only when the failure's fix is
  // on that screen; for any other failure a changed value would not help.
  const failureCode = detail.deploymentStatus.failure?.code;
  const showConfiguration = !failureCode || isConfigurationFailure(failureCode);
  const previousIsCurrent =
    detail.previousReleaseId !== null && detail.previousReleaseId === detail.currentReleaseId;
  const hasPreviousRelease = detail.previousReleaseId !== null && !previousIsCurrent;
  const deployIsPrimary =
    detail.state === 'UPDATE_AVAILABLE' || hero.kind === 'operation-failed';

  // Removed: the primary action ("Delete retained data", when retained
  // resources exist) is already rendered by RemovedDeploymentNotes as the
  // hero's own content — nothing else belongs in the action row.
  if (removed) return null;

  return (
    <section aria-labelledby="actions" className="flex flex-col gap-2">
      <h2 id="actions" className="sr-only">
        Actions
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        {retryCtaKind === 'retry' || retryCtaKind === 'legacy' ? (
          <Button size="sm" onClick={() => setOpen(open === 'retryInstall' ? null : 'retryInstall')}>
            Retry deployment
          </Button>
        ) : null}
        {retryCtaKind === 'contact-support' ? (
          <DocsLink href={DOCS.contactSupport}>Contact Deployz support</DocsLink>
        ) : null}
        {hero.kind === 'removal-failed' ? (
          <Button
            size="sm"
            variant="destructive"
            disabled={!canDisconnect}
            onClick={() => setOpen('disconnect')}
          >
            Retry removal
          </Button>
        ) : null}
        {everRan ? (
          <Button
            size="sm"
            variant={deployIsPrimary ? 'default' : 'outline'}
            disabled={!canDeploy}
            onClick={() => setOpen(open === 'deploy' ? null : 'deploy')}
          >
            {hero.failedJobType === 'DEPLOY_RELEASE'
              ? 'Retry update'
              : updateVersion && detail.state === 'UPDATE_AVAILABLE'
                ? `Deploy update to ${formatReleaseVersion(updateVersion)}`
                : 'Deploy update'}
          </Button>
        ) : null}
        {everRan && showConfiguration ? (
          canConfig ? (
            <Button asChild size="sm" variant="outline">
              <Link
                href={`/dashboard/applications/${detail.applicationId}/config?customer=${detail.customerId}`}
              >
                Configuration
              </Link>
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled>
              Configuration
            </Button>
          )
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={moreActionsRef}
              size="icon-sm"
              variant="outline"
              aria-label="More actions"
              className="ml-auto"
            >
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {everRan ? (
              <>
                <DropdownMenuItem disabled={!canRestart} onSelect={() => setOpen('restart')}>
                  Restart
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canRollback || !hasPreviousRelease}
                  onSelect={() => setOpen('rollback')}
                  className="flex-col items-start gap-0"
                >
                  <span>Rollback{hasPreviousRelease && previousVersion ? ` to ${formatReleaseVersion(previousVersion)}` : ''}</span>
                  {!hasPreviousRelease ? (
                    <span className="text-xs text-muted-foreground">
                      {previousIsCurrent ? PREVIOUS_IS_CURRENT_COPY : NO_PREVIOUS_RELEASE_COPY}
                    </span>
                  ) : null}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem
              variant="destructive"
              disabled={!canDisconnect}
              onSelect={() => setOpen('disconnect')}
            >
              Remove deployment
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* A failed first install offers its own recovery action; a note about
          day-2 actions it never shows would compete with it. */}
      {actionsUnavailable && !canRetryInstall ? (
        <p className="text-xs text-muted-foreground">{actionsUnavailable}</p>
      ) : null}

      <DeployUpdateDialog
        open={open === 'deploy'}
        deploymentId={detail.id}
        applicationName={detail.applicationName}
        currentVersion={detail.version}
        releases={releases}
        currentReleaseId={detail.currentReleaseId}
        onDone={() => {
          setOpen(null);
          onChanged();
        }}
        onCancel={() => setOpen(null)}
        onRetryReleases={() => onRefreshReleases(detail.applicationId)}
      />

      <RollbackDialog
        open={open === 'rollback' && hasPreviousRelease}
        deploymentId={detail.id}
        previousReleaseId={detail.previousReleaseId}
        previousVersion={previousVersion}
        currentVersion={detail.version}
        returnFocusRef={moreActionsRef}
        onDone={() => {
          setOpen(null);
          onChanged();
        }}
        onCancel={() => setOpen(null)}
      />

      <RestartDialog
        open={open === 'restart'}
        deploymentId={detail.id}
        applicationName={detail.applicationName}
        returnFocusRef={moreActionsRef}
        onDone={() => {
          setOpen(null);
          onChanged();
        }}
        onCancel={() => setOpen(null)}
      />

      <RetryInstallDialog
        open={open === 'retryInstall'}
        deploymentId={detail.id}
        applicationName={detail.applicationName}
        needsNewInstallLink={retryNeedsNewInstallLink(detail.relayStatus, detail.installationId)}
        onDone={() => {
          setOpen(null);
          onChanged();
        }}
        onCancel={() => setOpen(null)}
      />

      <DisconnectDialog
        open={open === 'disconnect'}
        deploymentId={detail.id}
        applicationName={detail.applicationName}
        customerName={detail.customerName}
        counted={detail.deploymentType === 'PRODUCTION' && detail.billingState === 'ACTIVE'}
        neverConnected={neverConnected}
        returnFocusRef={moreActionsRef}
        onDone={() => {
          setOpen(null);
          onChanged();
        }}
        onCancel={() => setOpen(null)}
      />
    </section>
  );
}

function OperationError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  );
}

function DeployUpdateDialog({
  open,
  deploymentId,
  applicationName,
  currentVersion,
  releases,
  currentReleaseId,
  onDone,
  onCancel,
  onRetryReleases,
}: {
  open: boolean;
  deploymentId: string;
  applicationName: string;
  currentVersion: string | null;
  releases: ReleasesState;
  currentReleaseId: string | null;
  onDone: () => void;
  onCancel: () => void;
  onRetryReleases: () => void;
}) {
  const loading = releases.status === 'loading';
  const failed = releases.status === 'error';
  const candidates = releases.status === 'loaded' ? deployableReleases(releases.data, currentReleaseId) : [];
  const [chosenReleaseId, setChosenReleaseId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanState>({ status: 'loading' });
  // Releases refresh when the dialog opens, so a choice made on an older list
  // may be gone; the first candidate stands in until one is picked.
  const selected = candidates.find((release) => release.id === chosenReleaseId) ?? candidates[0];
  const releaseId = selected?.id ?? '';

  // The update plan drives the requirement-drift warning below — this
  // application's requirements may have changed since the deployment was
  // created. The MVP boundary never changes topology in place, so drift is
  // disclosed, never blocked (a new deployment is the way to apply it).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPlan({ status: 'loading' });
    fetchDeploymentPlan(deploymentId, 'update')
      .then((data) => {
        if (!cancelled) setPlan({ status: 'loaded', data });
      })
      .catch(() => {
        if (!cancelled) setPlan({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [open, deploymentId]);

  const requirementDrift = plan.status === 'loaded' ? plan.data.requirementDrift : [];

  async function onConfirm(): Promise<void> {
    if (!releaseId) return;
    setPending(true);
    setError(null);
    try {
      await deployRelease(deploymentId, releaseId);
      toast.success('Update requested');
      onDone();
    } catch (caught) {
      setError(actionErrorMessage(caught, "Couldn't start this update. Try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent data-testid="deploy-update-panel" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Deploy update</DialogTitle>
          <DialogDescription>
            Choose a release for {applicationName}.
          </DialogDescription>
          <DocsLink href={DOCS.deployUpdate}>How updates work</DocsLink>
        </DialogHeader>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading releases…</p>
        ) : failed ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Couldn&apos;t load releases. Try again.
            </p>
            <Button variant="outline" size="sm" className="self-start" onClick={onRetryReleases}>
              Try again
            </Button>
          </div>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">{NO_DEPLOYABLE_RELEASES_COPY}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 rounded-lg border px-3 py-2.5 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Current</span>
                <span className="font-medium">{currentVersion ? formatReleaseVersion(currentVersion) : '—'}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">New</span>
                <span className="font-medium">{selected ? formatReleaseVersion(selected.version) : '—'}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Infrastructure</span>
                <span className="font-medium">
                  {requirementDrift.length > 0
                    ? 'Requirements changed'
                    : 'Unchanged'}
                </span>
              </div>
            </div>
            {requirementDrift.length > 0 ? (
              <Alert data-testid="requirement-drift-alert">
                <AlertTriangle aria-hidden />
                <AlertTitle>
                  This application&apos;s requirements changed since this deployment was created.
                </AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-5">
                    {requirementDrift.map((entry) => (
                      <li key={`${entry.kind}:${entry.name ?? ''}`}>{requirementDriftLine(entry)}</li>
                    ))}
                  </ul>
                  A new deployment is needed to change infrastructure.
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-col gap-2">
              <Label htmlFor="release-to-deploy">Release to deploy</Label>
              <Select value={releaseId} onValueChange={setChosenReleaseId}>
                <SelectTrigger id="release-to-deploy" className="w-full">
                  <SelectValue placeholder="Pick a release" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((release) => (
                    <SelectItem key={release.id} value={release.id}>
                      {formatReleaseVersion(release.version)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Alert>
              <AlertTriangle aria-hidden />
              <AlertTitle>The application will restart behind the load balancer.</AlertTitle>
              <AlertDescription>
                Existing persistent resources are preserved.
              </AlertDescription>
            </Alert>
            <OperationError error={error} />
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!releaseId} loading={pending} loadingText="Starting update…" onClick={onConfirm}>
            Deploy update
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RollbackDialog({
  open,
  deploymentId,
  previousReleaseId,
  previousVersion,
  currentVersion,
  returnFocusRef,
  onDone,
  onCancel,
}: {
  open: boolean;
  deploymentId: string;
  previousReleaseId: string | null;
  previousVersion: string | null;
  currentVersion: string | null;
  returnFocusRef: FocusTarget;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm(): Promise<void> {
    if (!previousReleaseId) return;
    setPending(true);
    setError(null);
    try {
      await rollbackDeployment(deploymentId, previousReleaseId);
      toast.success('Rollback requested');
      onDone();
    } catch (caught) {
      setError(actionErrorMessage(caught, "Couldn't start the rollback. Try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <AlertDialogContent data-testid="rollback-panel" onCloseAutoFocus={returnFocus(returnFocusRef)}>
        <AlertDialogHeader>
          <AlertDialogTitle>Rollback deployment?</AlertDialogTitle>
          <AlertDialogDescription>
            The application returns to its previous release. Data the application has stored is
            kept as it is.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3 rounded-lg border px-3 py-2.5 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Current version</span>
            <span className="font-medium">{currentVersion ? formatReleaseVersion(currentVersion) : '—'}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Rollback to</span>
            <span className="font-medium">
              {previousVersion ? formatReleaseVersion(previousVersion) : 'the previous version'}
            </span>
          </div>
        </div>
        {/* §26 required copy — verbatim. */}
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle>Application rollback does not automatically reverse database migrations.</AlertTitle>
          <AlertDescription>
            <DocsLink href={DOCS.rollbackSafeMigrations}>Keep migrations safe for rollback</DocsLink>
          </AlertDescription>
        </Alert>
        <OperationError error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            loading={pending}
            loadingText="Rolling back…"
            onClick={(event) => {
              event.preventDefault();
              void onConfirm();
            }}
          >
            Rollback
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RestartDialog({
  open,
  deploymentId,
  applicationName,
  returnFocusRef,
  onDone,
  onCancel,
}: {
  open: boolean;
  deploymentId: string;
  applicationName: string;
  returnFocusRef: FocusTarget;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await restartDeployment(deploymentId);
      toast.success('Restart requested');
      onDone();
    } catch (caught) {
      setError(actionErrorMessage(caught, "Couldn't restart this application. Try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <AlertDialogContent data-testid="restart-panel" onCloseAutoFocus={returnFocus(returnFocusRef)}>
        <AlertDialogHeader>
          <AlertDialogTitle>Restart {applicationName}?</AlertDialogTitle>
          <AlertDialogDescription>
            The application will restart behind the load balancer. The running version does not
            change.
          </AlertDialogDescription>
          <DocsLink href={DOCS.restart}>When to restart a deployment</DocsLink>
        </AlertDialogHeader>
        <OperationError error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            loading={pending}
            loadingText="Restarting deployment…"
            onClick={(event) => {
              event.preventDefault();
              void onConfirm();
            }}
          >
            Restart
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RetryInstallDialog({
  open,
  deploymentId,
  applicationName,
  needsNewInstallLink,
  onDone,
  onCancel,
}: {
  open: boolean;
  deploymentId: string;
  applicationName: string;
  /** The connector is disconnected or not registered: lead with the new link. */
  needsNewInstallLink: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [action, setAction] = useState<'retry' | 'reconnect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [relayRefused, setRelayRefused] = useState(false);
  const relayDisconnected = needsNewInstallLink || relayRefused;

  async function onConfirm(): Promise<void> {
    setAction('retry');
    setError(null);
    setRelayRefused(false);
    try {
      await retryInstall(deploymentId);
      toast.success('Retry requested');
      onDone();
    } catch (caught) {
      // A disconnected or unregistered relay never picks the retry job up —
      // the fix is re-enrollment, so point at the reconnect path instead.
      if (
        caught instanceof DeploymentActionError &&
        (caught.code === 'RELAY_DISCONNECTED' || caught.code === 'RELAY_NOT_CONNECTED')
      ) {
        setRelayRefused(true);
      } else {
        setError(actionErrorMessage(caught, "Couldn't start the retry. Try again."));
      }
    } finally {
      setAction(null);
    }
  }

  async function onReconnect(): Promise<void> {
    setAction('reconnect');
    setError(null);
    try {
      await resetRelay(deploymentId);
      window.location.reload();
    } catch (caught) {
      setError(actionErrorMessage(caught, "Couldn't issue a new install link. Try again."));
      setAction(null);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <AlertDialogContent data-testid="retry-install-panel">
        <AlertDialogHeader>
          <AlertDialogTitle>Retry deploying {applicationName}?</AlertDialogTitle>
          <AlertDialogDescription>
            Failed infrastructure from the previous attempt is removed from the customer&apos;s
            account, then the install runs again. No data is lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {relayDisconnected ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              The Deployz connector is disconnected. Issue a new install link, then send it to the
              customer to connect again.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              disabled={action === 'retry'}
              loading={action === 'reconnect'}
              loadingText="Issuing new install link…"
              onClick={() => void onReconnect()}
            >
              Issue new install link
            </Button>
          </div>
        ) : null}
        <OperationError error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={action !== null}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={action === 'reconnect' || relayDisconnected}
            loading={action === 'retry'}
            loadingText="Starting installation…"
            onClick={(event) => {
              event.preventDefault();
              void onConfirm();
            }}
          >
            Retry deployment
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// P1 dead-relay disconnect: while a DESTROY is pending, the disconnect owns
// this deployment — the hero keeps the relay's state, last contact and the
// per-service removal progress visible. When the relay is confirmed offline
// and the DESTROY has been pending past the shared threshold, the vendor can
// settle the control-plane side alone. That never claims the AWS resources
// were removed — the retained-resources note stays until a purge runs.
function DisconnectStatusPanel({
  detail,
  infrastructure,
  onChanged,
}: {
  detail: FleetDeploymentDetail;
  infrastructure: InfrastructureResponse | null;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeJobStates = ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING'];
  const pendingDestroy =
    detail.jobs
      .filter((job) => job.type === 'DESTROY' && activeJobStates.includes(job.state))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const pendingSince = pendingDestroy
    ? Date.parse(
        pendingDestroy.lastProgressAt ?? pendingDestroy.startedAt ?? pendingDestroy.createdAt,
      )
    : Number.NaN;
  const forceCompleteEligible =
    detail.relayStatus === 'DISCONNECTED' &&
    Number.isFinite(pendingSince) &&
    Date.now() - pendingSince >= DESTROY_PENDING_STALE_AFTER_MS;
  const lastContact = relativeTime(detail.lastHealthAt);

  async function onForceComplete(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await forceCompleteDisconnect(detail.id);
      toast.success('Removal completed');
      onChanged();
    } catch (caught) {
      setError(actionErrorMessage(caught, "Couldn't complete this removal. Try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {lastContact
          ? `${RELAY_STATUS_LABEL[detail.relayStatus]} · ${lastContact}`
          : RELAY_STATUS_LABEL[detail.relayStatus]}
      </p>
      {infrastructure ? (
        <ul className="flex flex-col divide-y rounded-lg border text-sm">
          {infrastructure.components.map((component) => (
            <li
              key={component.kind}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <span className="font-medium">{component.name}</span>
              <span className="text-muted-foreground">
                {disconnectStatusLabel(component.lifecycle)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {forceCompleteEligible ? (
        <div className="flex flex-col gap-3 rounded-lg border border-destructive/50 p-4">
          <p className="text-sm font-medium">The Deployz connector is offline.</p>
          <p className="text-sm text-muted-foreground">
            Deployz cannot verify or remove resources in the customer AWS account. Everything in
            the account may remain and keep costing money.
          </p>
          <Button
            size="sm"
            variant="destructive"
            className="self-start"
            loading={pending}
            loadingText="Completing removal…"
            onClick={() => void onForceComplete()}
          >
            Complete removal anyway
          </Button>
        </div>
      ) : null}
      <OperationError error={error} />
    </div>
  );
}

function disconnectStatusLabel(lifecycle: 'delete' | 'retain' | 'snapshot' | 'conditional'): string {
  if (lifecycle === 'delete') return 'Removing';
  if (lifecycle === 'retain') return 'Retained';
  if (lifecycle === 'snapshot') return 'Snapshot retained';
  return 'Retained conditionally';
}

/** Names of the retained (or snapshot-retained) infrastructure components,
 *  from the already-fetched inventory — null when the inventory itself is
 *  unavailable, so callers can fall back to neutral wording instead of
 *  naming a specific resource type that may not exist for this deployment. */
function retainedComponentNames(infrastructure: InfrastructureResponse | null): string[] | null {
  if (!infrastructure) return null;
  return infrastructure.components
    .filter((component) => component.lifecycle === 'retain' || component.lifecycle === 'snapshot')
    .map((component) => component.name);
}

/** What a removed deployment left behind, and the one action that clears it. */
function RemovedDeploymentNotes({
  detail,
  infrastructure,
  onChanged,
}: {
  detail: FleetDeploymentDetail;
  infrastructure: InfrastructureResponse | null;
  onChanged: () => void;
}) {
  const retainedNames = retainedComponentNames(infrastructure);

  // The hero already says the retained data is being deleted.
  if (purgeProgress(detail) === 'running') return null;

  if (detail.cleanupState !== 'COMPLETE') {
    return (
      <div className="flex flex-col gap-3">
        <Alert>
          <AlertTriangle aria-hidden />
          {detail.cleanupState === 'SKIPPED_RELAY_OFFLINE' || detail.cleanupState === 'PURGE_FAILED' ? (
            <>
              <AlertTitle>Resources may remain in the customer AWS account</AlertTitle>
              <AlertDescription>
                Deployz could not verify or remove resources because the Deployz connector was
                offline during removal. Everything in the customer AWS account may remain and
                keep costing money.
              </AlertDescription>
            </>
          ) : (
            <>
              <AlertTitle>Retained resources remain in the customer AWS account</AlertTitle>
              <AlertDescription>
                {retainedNames && retainedNames.length > 0
                  ? `${retainedUntilDeletedSentence(retainedNames)}, and may continue to generate AWS charges. The Deployz connector also stays; your customer deletes that stack once retained data is gone.`
                  : 'Retained resources remain in the customer AWS account until you delete them, and may continue to generate AWS charges. The Deployz connector also stays; your customer deletes that stack once retained data is gone.'}
              </AlertDescription>
            </>
          )}
        </Alert>
        <PurgeRetainedResources
          deploymentId={detail.id}
          applicationName={detail.applicationName}
          retainedNames={retainedNames}
          onChanged={onChanged}
        />
      </div>
    );
  }

  if (detail.bootstrapStackName) {
    return (
      <Alert>
        <AlertTriangle aria-hidden />
        <AlertTitle>The Deployz connector is still installed in the customer AWS account</AlertTitle>
        <AlertDescription>
          Deployz removed everything it created for this deployment. The connector stack{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            {detail.bootstrapStackName}
          </code>{' '}
          was created by your customer, so only they can delete it — ask them to delete that
          stack in CloudFormation. Their install link shows the same step.
        </AlertDescription>
      </Alert>
    );
  }

  return null;
}

// P2 purge: the explicit destructive action for resources a disconnect left
// behind. Typed application-name confirmation, because this permanently
// deletes the retained resources. The bootstrap/relay stack stays; the
// customer deletes it.
function PurgeRetainedResources({
  deploymentId,
  applicationName,
  retainedNames,
  onChanged,
}: {
  deploymentId: string;
  applicationName: string;
  /** From the inventory; null when it is unavailable — never a guess at
   *  which resource types a stateless deployment doesn't have. */
  retainedNames: string[] | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = confirmText.trim() === applicationName;

  async function onConfirm(): Promise<void> {
    if (!confirmed) return;
    setPending(true);
    setError(null);
    try {
      await purgeDeployment(deploymentId);
      toast.success('Deletion requested');
      setOpen(false);
      setConfirmText('');
      onChanged();
    } catch (caught) {
      setError(actionErrorMessage(caught, "Couldn't start the deletion. Try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        size="sm"
        variant="destructive"
        className="self-start"
        onClick={() => {
          setConfirmText('');
          setError(null);
          setOpen(true);
        }}
      >
        Delete retained data
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : setOpen(false))}>
        <AlertDialogContent data-testid="purge-panel" className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive">
              Delete {applicationName}&apos;s retained data?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. No final database snapshot is taken. The Deployz connector
              is not deleted — your customer deletes that stack separately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-1 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">This deletes</p>
            {retainedNames && retainedNames.length > 0 ? (
              <ul className="list-disc pl-5">
                {retainedNames.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            ) : (
              <p>The retained resources in your customer&apos;s AWS account.</p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="purge-confirm">
              Type <span className="font-medium text-foreground">{applicationName}</span> to confirm.
            </Label>
            <Input
              id="purge-confirm"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              aria-label={`Type ${applicationName} to confirm`}
              autoComplete="off"
            />
          </div>
          <OperationError error={error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!confirmed}
              loading={pending}
              loadingText="Deleting retained data…"
              onClick={(event) => {
                event.preventDefault();
                void onConfirm();
              }}
            >
              Delete retained data
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function DisconnectDialog({
  open,
  deploymentId,
  applicationName,
  customerName,
  counted,
  neverConnected,
  returnFocusRef,
  onDone,
  onCancel,
}: {
  open: boolean;
  deploymentId: string;
  applicationName: string;
  customerName: string;
  /** Whether this deployment counts toward the production deployment total. */
  counted: boolean;
  /** No relay ever connected: Deployz created nothing in the customer's account. */
  neverConnected: boolean;
  returnFocusRef: FocusTarget;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanState>({ status: 'loading' });
  const confirmed = confirmText.trim() === customerName;

  // What "Disconnect" will actually do is the deterministic destroy plan
  // (Phase 5), not a derivation from the resource inventory — the plan and
  // the relay's real teardown can never disagree about which components are
  // removed vs. retained.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setConfirmText('');
    setError(null);
    setPlan({ status: 'loading' });
    fetchDeploymentPlan(deploymentId, 'destroy')
      .then((data) => {
        if (!cancelled) setPlan({ status: 'loaded', data });
      })
      .catch(() => {
        if (!cancelled) setPlan({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [open, deploymentId]);

  const loading = plan.status === 'loading';
  const data = plan.status === 'loaded' ? plan.data : null;

  const removed = data?.components.filter((component) => component.action === 'DELETE') ?? [];
  const retained = data?.components.filter((component) => component.action === 'RETAIN') ?? [];

  async function onConfirm(): Promise<void> {
    if (!confirmed) return;
    setPending(true);
    setError(null);
    try {
      await destroyDeployment(deploymentId);
      toast.success('Removal requested');
      onDone();
    } catch (caught) {
      setError(actionErrorMessage(caught, "Couldn't remove this deployment. Try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <AlertDialogContent
        data-testid="disconnect-panel"
        className="max-w-lg"
        onCloseAutoFocus={returnFocus(returnFocusRef)}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="text-destructive">
            Remove {applicationName} for {customerName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {neverConnected
              ? "Nothing is installed yet, so nothing is removed from your customer's AWS account. The install link stops working."
              : 'Removing the deployment takes down the running application and its networking.'}
          </AlertDialogDescription>
          <DocsLink href={DOCS.removeDeployment}>What removal deletes and keeps</DocsLink>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3 text-sm text-muted-foreground">
          {neverConnected ? null : loading ? (
            <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-foreground">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              <span>Preparing the removal plan…</span>
            </div>
          ) : plan.status === 'error' ? (
            <Alert variant="destructive">
              <AlertTriangle aria-hidden className="size-4" />
              <AlertTitle>Could not load the removal plan</AlertTitle>
              <AlertDescription>
                Removing the deployment may leave billable resources in your customer&apos;s AWS
                account.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              {removed.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="font-medium text-foreground">Will be removed</p>
                  <ul className="list-disc pl-5">
                    {removed.map((component) => (
                      <li key={component.kind}>{component.name}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {retained.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="font-medium text-foreground">Will be retained</p>
                  <ul className="list-disc pl-5">
                    {retained.map((component) => (
                      <li key={component.kind}>{component.name}</li>
                    ))}
                  </ul>
                  <p>
                    Retained resources remain in your customer&apos;s AWS account, and may continue
                    generating charges. Delete retained data removes them later, and needs the connector, so your
                    customer should keep it until then.
                  </p>
                </div>
              ) : null}
            </>
          )}
          <p>
            {neverConnected
              ? "If your customer already created the Deployz connector stack, it stays in their AWS account until they delete it."
              : "The Deployz connector stays in your customer's AWS account until they delete its stack."}
          </p>
          {/* Only for a live production deployment: a test deployment is
              free, and one that never went live never counted. The allowance
              is pooled, so this never claims a per-deployment charge stops —
              whether the bill changes depends on the organization's included
              deployments. Retained AWS resources are the customer's own AWS
              bill and keep costing whatever they cost. */}
          {counted ? (
            <p>
              Removing this deployment reduces your active production deployment count. Billing
              adjusts automatically if the billable quantity changes.
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="disconnect-confirm">
            Type <span className="font-medium text-foreground">{customerName}</span> to confirm.
          </Label>
          <Input
            id="disconnect-confirm"
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
            aria-label={`Type ${customerName} to confirm`}
            autoComplete="off"
          />
        </div>
        <OperationError error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!confirmed || loading}
            loading={pending}
            loadingText="Removing deployment…"
            onClick={(event) => {
              event.preventDefault();
              void onConfirm();
            }}
          >
            Remove deployment
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MetaRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-medium">{value}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-testid="detail-loading" aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-40" />
      </div>
      <Skeleton className="h-44 w-full rounded-xl" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
      <Skeleton className="h-32 w-full rounded-xl" />
    </div>
  );
}

/**
 * §67 step 8 — the install link, after the moment it was created.
 *
 * It used to appear only on the success screen right after creating the
 * deployment: not on this page, not on the customers table, nowhere. A vendor
 * who closed that tab, or whose customer lost the email, had no way to get it
 * back, which made sending a customer their install link a one-shot.
 */
function InstallLinkCard({ detail }: { detail: FleetDeploymentDetail }) {
  const [copied, setCopied] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phase 5: the gate this deployment must pass before provisioning, against
  // this customer's configuration as it is now.
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchDeploymentPreflight(detail.id)
      .then((result) => {
        if (!cancelled) setPreflight(result);
      })
      .catch(() => {
        // Guidance only — the install link stays usable; the API enforces the gate.
      });
    return () => {
      cancelled = true;
    };
  }, [detail.id]);
  const url =
    typeof window === 'undefined'
      ? ''
      : `${window.location.origin}/install/${detail.installLinkId}#${detail.installLinkToken}`;
  // The customer launched the install but no relay has enrolled within the
  // staleness window — guidance, never a failure.
  const stuck =
    detail.state === 'WAITING_FOR_RELAY' && relayWaitingStuck(detail.installStartedAt);
  // An expired link cannot start an install; a new install link renews it.
  const expiresAt = detail.installLinkExpiresAt;
  const expired = expiresAt !== null && new Date(expiresAt).getTime() <= Date.now();

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copying failed. Select the link and copy it by hand.');
    }
  }

  async function reconnect(): Promise<void> {
    setResetting(true);
    setError(null);
    try {
      await resetRelay(detail.id);
      window.location.reload();
    } catch (caught) {
      setError(errorMessage(caught));
      setResetting(false);
    }
  }

  return (
    <section aria-labelledby="install-link" className="flex flex-col gap-3">
      <h2 id="install-link" className="text-base font-semibold">
        Install link
      </h2>
      {preflight ? <PreflightSummary result={preflight} /> : null}
      <Card>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Send this to {detail.customerName}. Their AWS credentials never touch Deployz.
          </p>
          <code className="block overflow-x-auto rounded-lg border bg-muted px-3 py-2 font-mono text-xs">
            {url}
          </code>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={copy}>
              {copied ? 'Copied' : 'Copy install link'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={resetting}
              loadingText="Issuing new install link…"
              onClick={reconnect}
            >
              Issue new install link
            </Button>
          </div>
          <DocsLink href={DOCS.newInstallLink}>What a new install link changes</DocsLink>
          {expiresAt ? (
            <p className="text-sm text-muted-foreground" data-testid="install-link-expiry">
              {expired
                ? `This link expired on ${formatDate(expiresAt)}. Issue a new install link to make it work again.`
                : `This link expires on ${formatDate(expiresAt)}.`}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            A new install link keeps the same address, but it changes the connection code and
            credential. A setup started with the old values stops working. If the connector is
            already installed, the customer updates the existing connector stack with the new
            values on the link page.
          </p>
          {stuck ? (
            <div className="flex flex-col gap-1">
              <p className="text-sm text-muted-foreground">{RELAY_STUCK_GUIDANCE}</p>
              {detail.bootstrapStackName ? (
                <p className="text-xs text-muted-foreground">
                  Expected stack name:{' '}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {detail.bootstrapStackName}
                  </code>
                </p>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
