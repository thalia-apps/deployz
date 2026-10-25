'use client';

import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, Circle, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { InfrastructureSection } from '@/components/infrastructure-section';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CONNECTOR_STATUS_LABEL,
  INFRASTRUCTURE_COMPONENT_NAME,
  infrastructureComponentStatusLabel,
  infrastructureMissingKinds,
  infrastructureNotRequiredKinds,
  operationalComponentStatus,
  operationalSummaryStatus,
  purgeProgress,
  showInfrastructureRows,
  visibleResources,
  type DeploymentState,
  type RelayStatus,
} from '@/lib/deployment-vocabulary';
import type {
  FleetDeploymentDetail,
  InfrastructureComponentStatus,
  InfrastructureResponse,
  InfrastructureSummaryStatus,
} from '@/lib/deployments';
import { relativeTime } from '@/lib/diagnostics';
import { TONE_TEXT } from '@/lib/status-tone';
import { cn } from '@/lib/utils';

// The default Infrastructure view: one plain-English summary line, a compact
// line of services with their status, and the connector's connectivity.
// Behind "View components and N AWS resources" sit the per-component rows
// and the full resource inventory (InfrastructureSection). Vendors see
// "Database ✓", never a stack of AWS resource cards, unless they ask.

const SUMMARY_LINE: Record<InfrastructureSummaryStatus, string> = {
  healthy: 'All required services are ready.',
  provisioning: 'Some services are still being set up.',
  updating: 'Services are being updated.',
  degraded: 'Some services need attention.',
  failed: 'A service failed.',
  deleting: 'Services are being removed.',
  retained: 'Retained services remain in the customer AWS account.',
  unknown: 'Service status unavailable.',
};

const SUMMARY_ICON: Record<InfrastructureSummaryStatus, ReactNode> = {
  healthy: <CheckCircle2 aria-hidden className={cn('size-4 shrink-0', TONE_TEXT.positive)} />,
  provisioning: <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-primary" />,
  updating: <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-primary" />,
  degraded: <AlertTriangle aria-hidden className={cn('size-4 shrink-0', TONE_TEXT.attention)} />,
  failed: <AlertCircle aria-hidden className="size-4 shrink-0 text-destructive" />,
  deleting: <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-muted-foreground" />,
  retained: <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
  unknown: <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground/50" />,
};

const STATUS_ICON: Record<InfrastructureComponentStatus, ReactNode> = {
  ready: <CheckCircle2 aria-hidden className={cn('size-4 shrink-0', TONE_TEXT.positive)} />,
  retained: <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
  failed: <AlertCircle aria-hidden className="size-4 shrink-0 text-destructive" />,
  provisioning: <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-primary" />,
  updating: <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-primary" />,
  deleting: <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-muted-foreground" />,
  pending: <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground/50" />,
  removed: <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground/50" />,
  unknown: <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground/50" />,
};

// A transitional status read from a snapshot nothing is refreshing is history,
// not activity: no spinner.
const TRANSITIONAL_STATUSES = new Set<string>(['provisioning', 'updating', 'deleting']);

const RELAY_DOT: Record<RelayStatus, string> = {
  CONNECTED: 'bg-primary',
  DISCONNECTED: 'bg-destructive',
  UNKNOWN: 'bg-muted-foreground',
};

export function InfrastructureSummary({
  detail,
  infrastructure,
  infrastructureError,
}: {
  detail: FleetDeploymentDetail;
  infrastructure: InfrastructureResponse | null;
  /** The inventory request failed; the rest of the page still renders. */
  infrastructureError: boolean;
}) {
  const state = detail.state as DeploymentState;
  const listable = showInfrastructureRows(state, detail.currentReleaseId) || state === 'DELETED';
  const relay = (
    <RelayLine
      status={detail.relayStatus}
      lastContact={relativeTime(detail.lastHealthAt)}
      accessRevoked={state === 'DELETED' && detail.cleanupState === 'COMPLETE'}
    />
  );

  if (!listable) {
    return (
      <SummaryCard>
        <p className="text-sm text-muted-foreground">
          {state === 'NOT_INSTALLED' || state === 'WAITING_FOR_RELAY'
            ? 'Not installed yet.'
            : state === 'FAILED'
              ? "This deployment isn't running."
              : 'This deployment has been removed.'}
        </p>
        {relay}
      </SummaryCard>
    );
  }

  if (infrastructureError) {
    return (
      <div className="flex flex-col gap-3">
        <Alert>
          <AlertTriangle aria-hidden />
          <AlertTitle>Infrastructure details unavailable</AlertTitle>
          <AlertDescription>
            The deployment is unaffected. Refreshes automatically.
          </AlertDescription>
        </Alert>
        <SummaryCard>{relay}</SummaryCard>
      </div>
    );
  }

  if (infrastructure === null) {
    return (
      <div className="flex flex-col gap-2" data-testid="infrastructure-loading" aria-busy="true">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    );
  }

  // Requirement-aware verification (Phase 6): the server compares what the
  // deployment's manifest requires (the catalog) against the inventory, so
  // the page never re-derives infrastructure intent itself (docs/ui-system.md).
  // A catalog kind absent from the inventory reads "Not required" (the
  // manifest never asked for it) or, once past the install phase, "Missing"
  // (the manifest asked for it and it is not there).
  const notRequiredKinds = infrastructureNotRequiredKinds(infrastructure.expectations);
  // A kind that already has a row (the application, when only its worker
  // service exists) is not listed a second time as missing.
  const missingKinds = infrastructureMissingKinds(infrastructure.expectations, state).filter(
    (kind) => !infrastructure.components.some((component) => component.kind === kind),
  );
  const purge = purgeProgress(detail);
  const summaryStatus = operationalSummaryStatus(infrastructure, state, purge);
  const stale = infrastructure.connectionState === 'disconnected';
  const resourceCount = infrastructure.components.reduce(
    (total, component) => total + visibleResources(component.resources, state).length,
    0,
  );

  return (
    <div className="flex flex-col gap-3">
      <SummaryCard>
        {infrastructure.snapshotState === 'none' ? (
          // A failed install that never created a stack's worth of resources
          // has nothing the inventory could add — say so honestly (the hero
          // and activity above carry the failure itself). Live states get the
          // "details appear as they are created" line instead.
          <p className="text-sm text-muted-foreground">
            {state === 'FAILED'
              ? "This deployment isn't running."
              : 'Service details appear as they are created.'}
          </p>
        ) : (
          <p className="flex items-center gap-2 text-sm font-medium">
            {stale && TRANSITIONAL_STATUSES.has(summaryStatus) ? SUMMARY_ICON.unknown : SUMMARY_ICON[summaryStatus]}
            {stale ? 'Last known: ' : ''}
            {purge === 'complete' && summaryStatus === 'retained'
              ? 'Retained data was deleted.'
              : SUMMARY_LINE[summaryStatus]}
          </p>
        )}
        {infrastructure.connectionState === 'disconnected' ? (
          <p className="text-sm text-muted-foreground">
            Showing the last verified state
            {infrastructure.disconnectWarning
              ? ` (${relativeTime(infrastructure.disconnectWarning.lastVerifiedAt)})`
              : ''}
            .
          </p>
        ) : null}
        {infrastructure.components.length > 0 || notRequiredKinds.length > 0 || missingKinds.length > 0 ? (
          <ul aria-label="Services" className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {infrastructure.components.map((component) => {
              const status = operationalComponentStatus(component, state, purge);
              const label = infrastructureComponentStatusLabel({ ...component, status }, state);
              return (
                <li key={component.kind} className="inline-flex min-w-0 items-center gap-1.5">
                  {stale && TRANSITIONAL_STATUSES.has(status) ? STATUS_ICON.unknown : STATUS_ICON[status]}
                  <span className="min-w-0 break-words">
                    {INFRASTRUCTURE_COMPONENT_NAME[component.kind] ?? component.name}
                  </span>
                  {/* Ready is the icon; any other status is spelled out. */}
                  {status === 'ready' && label === 'Ready' ? (
                    <span className="sr-only">{label}</span>
                  ) : (
                    <span className="text-muted-foreground">{label}</span>
                  )}
                </li>
              );
            })}
            {missingKinds.map((kind) => (
              <li key={kind} className="inline-flex items-center gap-1.5">
                <AlertCircle aria-hidden className="size-4 shrink-0 text-destructive" />
                <span>{INFRASTRUCTURE_COMPONENT_NAME[kind]}</span>
                <span className="text-destructive">Missing</span>
              </li>
            ))}
            {notRequiredKinds.map((kind) => (
              <li key={kind} className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground/40" />
                <span>{INFRASTRUCTURE_COMPONENT_NAME[kind]}</span>
                <span>Not required</span>
              </li>
            ))}
          </ul>
        ) : null}
        {relay}
      </SummaryCard>
      {infrastructure.components.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground">
            View components and {resourceCount} AWS resource{resourceCount === 1 ? '' : 's'}
            <ChevronDown
              aria-hidden
              className="size-4 transition-transform group-data-[state=open]:rotate-180"
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <InfrastructureSection
              data={infrastructure}
              deploymentId={detail.id}
              deploymentState={detail.state}
              purge={purge}
              customDomainFailed={detail.customDomain?.status === 'error'}
            />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

function SummaryCard({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3 rounded-lg border px-3 py-3">{children}</div>;
}

function RelayLine({
  status,
  lastContact,
  accessRevoked,
}: {
  status: RelayStatus;
  lastContact: string | null;
  /** Delete retained data finished: Deployz's access to the connector is revoked. */
  accessRevoked: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-sm first:border-t-0 first:pt-0">
      <span
        className={`mx-1 size-2 shrink-0 rounded-full ${RELAY_DOT[accessRevoked ? 'DISCONNECTED' : status]}`}
        aria-hidden
      />
      <span className="font-medium">Deployz connector</span>
      <span className="ml-auto text-right text-muted-foreground" data-testid="status-updated">
        {accessRevoked
          ? 'Disconnected · access revoked'
          : lastContact
            ? `${CONNECTOR_STATUS_LABEL[status]} · ${lastContact}`
            : CONNECTOR_STATUS_LABEL[status]}
      </span>
    </div>
  );
}
