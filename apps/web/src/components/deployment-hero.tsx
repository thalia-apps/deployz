'use client';

import type { VendorDeploymentStatus } from '@deployz/contracts';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { DeploymentUrlCard } from '@/components/deployment-url-card';
import { DiagnosticExplanation, DiagnosticTechnical } from '@/components/diagnostic-explanation';
import { ElapsedTime, timedSteps } from '@/components/deployment-progress-card';
import { DocsLink } from '@/components/docs-link';
import { FailurePanel } from '@/components/failure-panel';
import { StepList } from '@/components/step-list';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { showApplicationUrl, type HeroKind, type HeroModel, type HeroTone } from '@/lib/deployment-hero';
import { JOB_STATE_LABEL, JOB_TYPE_LABEL } from '@/lib/deployment-vocabulary';
import type { FleetDeploymentDetail } from '@/lib/deployments';
import { relativeTime, type Diagnostic } from '@/lib/diagnostics';
import { FAILURE_RECOVERABILITY, RECOVERABILITY_COPY } from '@/lib/diagnostic-vocabulary';
import { DOCS, failureCodeDocsUrl } from '@/lib/docs-links';
import { TONE_TEXT } from '@/lib/status-tone';
import { cn } from '@/lib/utils';

// Hero tone icons share the tone system's colors so they agree with the
// badges: success green, warning amber, failure red.
const TONE_ICON: Record<HeroTone, ReactNode> = {
  neutral: <Clock aria-hidden className="size-5 text-muted-foreground" />,
  progress: <Loader2 aria-hidden className="size-5 animate-spin text-primary" />,
  success: <CheckCircle2 aria-hidden className={cn('size-5', TONE_TEXT.positive)} />,
  warning: <AlertTriangle aria-hidden className={cn('size-5', TONE_TEXT.attention)} />,
  destructive: <AlertCircle aria-hidden className={cn('size-5', TONE_TEXT.negative)} />,
};

/**
 * The state-aware hero at the top of the vendor deployment detail page. The
 * words come from deriveHero (lib/deployment-hero.ts); this component lays
 * them out — as the §6 recovery panel (FailurePanel) for a failure or
 * needs-attention tone, or the plain headline otherwise — adds the
 * state-specific block (the live URL, the install step list) and hosts the
 * contextual action row. The failure code and reference live under the
 * page's Technical details, not here.
 */
export function DeploymentHero({
  detail,
  hero,
  actions,
  children,
  diagnostic,
}: {
  detail: FleetDeploymentDetail;
  hero: HeroModel;
  /** The contextual action row rendered in the card footer. */
  actions: ReactNode;
  /** State-specific extra content (disconnect progress, retained-resource alerts). */
  children?: ReactNode;
  /** The deployment's latest classified failure, when one has been fetched —
   *  drives the recovery panel's authoritative "who acts" copy. Never used
   *  to infer an owner the data does not state (UX-BACKEND-005). */
  diagnostic?: Diagnostic | null;
}) {
  const status = detail.deploymentStatus;
  // The address shows whenever the API has one and the deployment still
  // exists — including after a failed update or while health checks fail,
  // when the running release is exactly what the vendor may want to check.
  // This is the page's only place for the URL and the custom domain.
  const showUrl = showApplicationUrl(hero.kind, detail.appUrl);
  // §6 failure and recovery: a destructive or warning tone gets the one
  // failure/recovery pattern (what happened → impact → who acts) instead of
  // the plain headline. "Who acts" is shown only when the data is
  // authoritative — the classified recoverability of an actual failure, not
  // an inferred owner for a health condition.
  const isFailure = hero.tone === 'destructive' || hero.tone === 'warning';
  // The recoverability copy points at the fix in the explanation, so it only
  // shows beside a loaded diagnosis.
  const recoverability = diagnostic
    ? (diagnostic.recoverability ?? FAILURE_RECOVERABILITY[diagnostic.failureCode])
    : null;
  const whoActs = recoverability ? RECOVERABILITY_COPY[recoverability] : null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        {isFailure ? (
          <div id="recovery" className="scroll-mt-20">
            <FailurePanel
              title={<span aria-live="polite">{hero.title}</span>}
              description={hero.description}
              impact={hero.liveReleaseNote}
              whoActs={whoActs}
              explanation={
                <>
                  {diagnostic ? <DiagnosticExplanation diagnostic={diagnostic} /> : null}
                  <RecoveryDocsLink kind={hero.kind} diagnostic={diagnostic ?? null} />
                </>
              }
              technical={diagnostic ? <DiagnosticTechnical diagnostic={diagnostic} /> : undefined}
              testId="deployment-recovery-panel"
            />
          </div>
        ) : (
          <div className="flex items-start gap-3">
            <span className="mt-0.5 shrink-0">{TONE_ICON[hero.tone]}</span>
            <div className="min-w-0 flex-1">
              {/* The one aria-live region on this page: the headline itself,
                  so assistive tech announces a transition without re-reading
                  the whole card on every poll tick. */}
              <h2 aria-live="polite" className="text-xl font-semibold tracking-tight">
                {hero.title}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{hero.description}</p>
              {hero.liveReleaseNote ? (
                <p className="mt-1 text-sm font-medium">{hero.liveReleaseNote}</p>
              ) : null}
            </div>
          </div>
        )}
        {status.statusUpdatesUnavailable ? (
          <p className="text-sm text-muted-foreground">
            Status updates unavailable — showing the last confirmed state.
          </p>
        ) : null}

        {showUrl ? <DeploymentUrlCard detail={detail} /> : null}

        {hero.kind === 'updating' ? <OperationProgress detail={detail} /> : null}

        {hero.showSteps ? <InstallSteps status={status} /> : null}

        {children}
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2">{actions}</CardFooter>
    </Card>
  );
}

/** The documentation for the failure in the recovery panel: the failure
 *  code's own entry when the failure is classified, else the page for the
 *  condition the hero shows. */
function RecoveryDocsLink({ kind, diagnostic }: { kind: HeroKind; diagnostic: Diagnostic | null }) {
  if (diagnostic) {
    return <DocsLink href={failureCodeDocsUrl(diagnostic.failureCode)}>What this failure means</DocsLink>;
  }
  if (kind === 'lost-contact') {
    return <DocsLink href={DOCS.connectorOffline}>When a connector goes offline</DocsLink>;
  }
  if (kind === 'unhealthy' || kind === 'degraded') {
    return <DocsLink href={DOCS.startupAndHealth}>Fix startup and health check failures</DocsLink>;
  }
  if (kind === 'removal-failed') {
    return <DocsLink href={DOCS.removeDeployment}>How removal works</DocsLink>;
  }
  return <DocsLink href={DOCS.troubleshooting}>Troubleshooting</DocsLink>;
}

const ACTIVE_JOB_STATES = ['REQUESTED', 'QUEUED', 'WAITING', 'RUNNING'];

/** The running day-2 operation: which job, and for how long. The install
 *  step list does not apply here — an update never re-creates the stack. */
function OperationProgress({ detail }: { detail: FleetDeploymentDetail }) {
  const job =
    detail.jobs
      .filter((candidate) => ACTIVE_JOB_STATES.includes(candidate.state))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  if (!job) return null;
  const startedAt = job.startedAt ?? job.createdAt;
  return (
    <p className="text-sm text-muted-foreground">
      {JOB_TYPE_LABEL[job.type as keyof typeof JOB_TYPE_LABEL] ?? job.type} ·{' '}
      {JOB_STATE_LABEL[job.state as keyof typeof JOB_STATE_LABEL] ?? job.state} ·{' '}
      <span className="tabular-nums">
        <ElapsedTime startedAt={startedAt} />
      </span>
    </p>
  );
}

/**
 * The install step list (first → last, the process order) with the shared
 * per-step timing and when Deployz last heard about it. Services and the
 * connector have their own rows under Infrastructure; job and stack detail
 * sit under the page's Technical details.
 */
function InstallSteps({ status }: { status: VendorDeploymentStatus }) {
  const steps = timedSteps(status);
  const lastUpdate = relativeTime(status.updatedAt);

  return (
    <div className="flex flex-col gap-2">
      {steps.length > 0 ? <StepList steps={steps} /> : null}
      {lastUpdate ? (
        <p className="text-xs text-muted-foreground" data-testid="status-updated">
          Checked {lastUpdate}
        </p>
      ) : null}
    </div>
  );
}
