'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import type {
  CustomerDeploymentStatus,
  CustomerTechnicalDetails,
  DeploymentPlan,
} from '@deployz/contracts';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { StepList, type StepListItem } from '@/components/step-list';
import { AwsInfrastructureDetails } from '@/components/aws-infrastructure-details';
import { CustomDomainCard } from '@/components/custom-domain-card';
import { DocsLink } from '@/components/docs-link';
import {
  DeploymentTracker,
  WireStepList,
  type DeploymentTrackerLiveDetail,
} from '@/components/deployment-tracker';
import { FailurePanel } from '@/components/failure-panel';
import { LiveAwsActivity } from '@/components/live-aws-activity';
import { ResourcesTable } from '@/components/resources-table';
import { TechnicalDetails } from '@/components/technical-details';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { CustomDomainView } from '@/lib/domains';
import {
  customerStepperSteps,
  isTerminalStage,
  stepsFromStatus,
  stepWaitingOnInput,
  AWAITING_DOMAIN_STEP_DETAIL,
} from '@/lib/deployment-progress';
import { fetchDeployLinkStatus, type DeployLinkToken } from '@/lib/deploy-link-flow';
import { fetchInstallStatus } from '@/lib/install-status';
import { cloudFormationStacksUrl } from '@/lib/aws-console';
import {
  STARTUP_FAILURE_CUSTOMER_NOTE,
  STARTUP_FAILURE_TITLE,
} from '@/lib/diagnostic-vocabulary';
import { DOCS } from '@/lib/docs-links';
import { OWNERSHIP_NOTE } from '@/lib/security-details';
import { useStatusPoll } from '@/lib/use-status-poll';

/**
 * The customer's grouped step list. The active step's live detail (current
 * activity, duration/slow-step line, last-checked time) is supplied to
 * `StepList` as `liveDetail` so only it ticks — except while HTTPS waits on
 * a custom domain, when that promise-nothing's-happening nudge would be
 * wrong and the step instead carries the static waiting-on-input line.
 */
function customerStepListSteps(status: CustomerDeploymentStatus): StepListItem[] {
  const waitingOnInput = stepWaitingOnInput({
    step: status.step,
    needsDomainSetup: status.needsDomainSetup,
  });
  const steps = customerStepperSteps(
    stepsFromStatus({ steps: status.steps, step: status.step, stage: status.stage }),
  );
  if (!waitingOnInput) return steps;
  return steps.map((step) =>
    step.state === 'current' ? { ...step, detail: AWAITING_DOMAIN_STEP_DETAIL } : step,
  );
}

/**
 * §12/§44 the customer's whole install-to-ready experience in one place.
 * Polls the server-derived stage (never infers lifecycle client-side — see
 * deployment-progress.ts) and renders by `status.stage` alone. The same
 * component drives the waiting page (WAITING_FOR_AWS) and the
 * already-installed page (CONNECTING or later): as the stage advances the
 * card grows into the full progress view, then — for VERIFYING/READY — also
 * surfaces the Access section and the custom-domain card, so a customer who
 * stays on the page never needs to reload it to see their app come up.
 *
 * Layout, top to bottom: the dominant progress card (headline, the step list
 * with the current operation and the latest AWS event, or the failure
 * panel), any problem AWS reported, the one action, Access at
 * VERIFYING/READY, and one collapsed "Deployment details" holding the
 * detailed step list, the full AWS activity feed, the per-component status,
 * every identifier, raw AWS event and the AWS resource inventory
 * (ux-guidelines §8, §9).
 */
export function InstallProgress({
  installLinkId,
  deploymentId,
  initialStatus,
  quickCreateUrl,
  initialDomain,
  routingTarget,
  plan = null,
  preinstall = false,
  deployLink = null,
  notice,
  details,
}: {
  installLinkId: string;
  deploymentId: string;
  initialStatus: CustomerDeploymentStatus | null;
  quickCreateUrl: string | null;
  initialDomain: CustomDomainView | null;
  routingTarget: string | null;
  /** The deployment's plan — supplies the AWS resource inventory under
   *  Technical details on the deploy page. */
  plan?: DeploymentPlan | null;
  /** True when mounted under the waiting page layout, whose surrounding
   *  server-rendered content is only correct while nothing has enrolled yet. */
  preinstall?: boolean;
  /** Set on the /deploy page: status and domain calls resolve through the
   *  deploy link (token header) instead of the install link. */
  deployLink?: DeployLinkToken | null;
  /** Page-level guidance that needs the customer's attention, shown above
   *  "Deployment details". */
  notice?: ReactNode;
  /** Page-level references (expected stack name, CloudFormation link) shown
   *  first inside "Deployment details". */
  details?: ReactNode;
}) {
  const router = useRouter();
  const poll = useStatusPoll({
    fetcher: () =>
      deployLink
        ? fetchDeployLinkStatus(deployLink.publicId, deployLink.token)
        : fetchInstallStatus(installLinkId),
    intervalMs: 5000,
    // A terminal stage can still change while the tab stays open: the vendor
    // retries a FAILED install, or health is lost after READY. Check once a
    // minute so the page never keeps showing a stale failure or success.
    terminalIntervalMs: 60_000,
    isTerminal: (status) => isTerminalStage(status.stage),
    initialData: initialStatus,
  });

  const status = poll.data;

  // The waiting layout is a server component, so this card advancing on its
  // own would leave stale waiting content around it. One refresh when the
  // stage first moves past WAITING_FOR_AWS re-renders the page from server
  // truth (alreadyInstalled is now set), which swaps the whole layout to the
  // progress view.
  const refreshed = useRef(false);
  const advanced = preinstall && status !== null && status.stage !== 'WAITING_FOR_AWS';
  useEffect(() => {
    if (advanced && !refreshed.current) {
      refreshed.current = true;
      router.refresh();
    }
  }, [advanced, router]);
  if (!status) {
    return (
      <div className="flex flex-col gap-6">
        <Card aria-busy="true">
          <CardContent className="flex flex-col gap-3 py-4">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </CardContent>
        </Card>
        {notice}
      </div>
    );
  }

  // A relay outage never regresses the displayed stage (the server already
  // holds the last confirmed one); it only earns this quiet notice. Repeated
  // client-side fetch failures get the same treatment.
  const stale = status.statusUpdatesUnavailable || poll.stale;
  const canAccess = status.stage === 'READY' || status.stage === 'VERIFYING';
  const active = !isTerminalStage(status.stage);
  const failed = status.stage === 'FAILED';
  const ready = status.stage === 'READY';
  const activity = status.recentActivity ?? [];

  const wireSteps = stepsFromStatus({ steps: status.steps, step: status.step, stage: status.stage });
  const trackerSteps = customerStepperSteps(wireSteps);
  const waitingOnInput = stepWaitingOnInput({
    step: status.step,
    needsDomainSetup: status.needsDomainSetup,
  });
  const liveDetail: DeploymentTrackerLiveDetail | undefined =
    !failed && !ready && !waitingOnInput
      ? {
          currentActivity: status.currentActivity,
          takingLongerThanUsual: status.takingLongerThanUsual,
          typicalDurationSeconds: status.typicalDurationSeconds,
          stepStartedAt: status.stepStartedAt ?? null,
          checkedAt: poll.checkedAt,
          active,
        }
      : undefined;

  return (
    <div className="flex flex-col gap-6">
      {failed ? (
        <Card>
          <CardContent className="flex flex-col gap-4 sm:px-6">
            {/* The only aria-live region in this component — every other
                update (steps, components, access) rides along with it. */}
            <div>
              <h2 aria-live="polite" className="text-lg font-semibold">
                Deployment failed
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Deployz stopped the deployment.
              </p>
            </div>
            <CustomerFailurePanel
              failure={status.failure}
              technicalDetails={status.technicalDetails}
              cleanup={status.cleanup ?? null}
            />
            {/* The attempt's own step list stays visible after the failure:
                completed steps remain done, the interrupted step is the
                failed one, and nothing is named as next — the operation
                stopped there. */}
            <StepList steps={customerStepListSteps(status)} />
          </CardContent>
        </Card>
      ) : (
        <DeploymentTracker
          stage={status.stage}
          steps={trackerSteps}
          currentStepLabel={
            wireSteps.find((step) => step.state === 'current' || step.state === 'attention')?.label
          }
          waitingOnInput={waitingOnInput}
          latestActivity={active ? activity[0] : undefined}
          stale={stale}
          {...(liveDetail ? { liveDetail } : {})}
        />
      )}

      {stale ? (
        <p className="text-xs text-muted-foreground">
          Status updates unavailable. Showing the last confirmed state.
        </p>
      ) : null}

      {/* AWS can report a resource failure well before the job
          itself lands on FAILED (a rollback can take many minutes) —
          this says so immediately instead of leaving the page silent. */}
      {!failed && status.provisioningIssue ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle>AWS reported a problem</AlertTitle>
          <AlertDescription>
            <p>{status.provisioningIssue.message}</p>
            <DocsLink href={DOCS.customerInstallFails}>If the deployment fails</DocsLink>
          </AlertDescription>
        </Alert>
      ) : null}

      {notice}

      {status.stage === 'WAITING_FOR_AWS' && quickCreateUrl ? (
        <Button asChild variant="outline" size="sm" className="self-start">
          <a href={quickCreateUrl} target="_blank" rel="noopener noreferrer">
            Open AWS setup
          </a>
        </Button>
      ) : null}

      {status.stage === 'VERIFYING' && status.needsDomainSetup ? (
        <p className="text-sm text-muted-foreground" data-testid="awaiting-domain-copy">
          Your application is healthy. Set up a custom domain below for a secure address.
        </p>
      ) : null}

      {ready && status.url ? (
        <Button asChild className="self-start">
          <a href={status.url} target="_blank" rel="noreferrer">
            Open application
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        </Button>
      ) : null}

      {canAccess ? (
        <>
          <section aria-labelledby="deployment-access" className="flex flex-col gap-3">
            <h2 id="deployment-access" className="text-base font-semibold">
              Access
            </h2>
            {status.url ? (
              status.url.startsWith('https://') ? (
                <p className="text-sm">
                  Your deployment is available at{' '}
                  <a className="font-medium underline underline-offset-4" href={status.url}>
                    {status.url}
                  </a>
                </p>
              ) : (
                // A bare ALB endpoint serves over plain HTTP — reachable, but
                // temporary and explicitly not secure. Never label it otherwise.
                <p className="text-sm">
                  Your deployment is temporarily available at{' '}
                  <a className="font-medium underline underline-offset-4" href={status.url}>
                    {status.url}
                  </a>
                  {' '}
                  — not secure. This address may change.
                </p>
              )
            ) : (
              <p className="text-sm text-muted-foreground">
                {routingTarget
                  ? 'Set up a custom domain below for a permanent address.'
                  : status.stage === 'VERIFYING'
                    ? 'The address appears here after health checks pass.'
                    : 'No public address configured yet.'}
              </p>
            )}
            {ready ? <p className="text-xs text-muted-foreground">{OWNERSHIP_NOTE}</p> : null}
          </section>

          <CustomDomainCard
            deploymentId={deploymentId}
            installLinkId={installLinkId}
            initialDomain={initialDomain}
            deployLink={deployLink}
          />
        </>
      ) : null}

      {!failed ? (
        <TechnicalDetails label="Deployment details" className="border-t pt-4 text-sm">
          {details}
          <WireStepList wireSteps={wireSteps} stage={status.stage} />
          {active && activity.length > 0 ? <LiveAwsActivity items={activity} stale={stale} /> : null}
          {/* Resources start with infrastructure work (ux-guidelines §8):
              while AWS is still connecting, every row would only say Waiting. */}
          {status.stage !== 'WAITING_FOR_AWS' && status.stage !== 'CONNECTING' ? (
            <ResourcesTable
              specComponents={status.specComponents}
              components={status.components}
              showState={!ready}
            />
          ) : null}
          <DeploymentDiagnostics
            technicalDetails={status.technicalDetails ?? null}
            awsSummary={ready ? (status.awsSummary ?? null) : null}
            updatedAt={status.updatedAt}
            routingTarget={canAccess ? routingTarget : null}
            plan={plan}
          />
        </TechnicalDetails>
      ) : null}
    </div>
  );
}

/**
 * The diagnostics inside "Deployment details" for a deployment that has not
 * failed (the failure panel carries its own): the deployment reference and
 * facts, the READY-only stored AWS summary with its CloudFormation link, the
 * load-balancer endpoint, the raw AWS events, and the plan's AWS resource
 * inventory. Renders nothing until one of them exists.
 */
function DeploymentDiagnostics({
  technicalDetails,
  awsSummary,
  updatedAt,
  routingTarget,
  plan,
}: {
  technicalDetails: CustomerTechnicalDetails | null;
  awsSummary: CustomerDeploymentStatus['awsSummary'] | null;
  updatedAt: string;
  routingTarget: string | null;
  plan: DeploymentPlan | null;
}) {
  const hasInventory = (plan?.awsResources.length ?? 0) > 0;
  if (!technicalDetails && !awsSummary && !routingTarget && !hasInventory) return null;
  return (
    <div className="flex flex-col gap-3 border-t pt-3">
      {technicalDetails ? (
        <>
          <DetailRow label="Reference" value={technicalDetails.reference} />
          {technicalDetails.facts.map((fact) => (
            <DetailRow key={fact.label} label={fact.label} value={fact.value} />
          ))}
        </>
      ) : null}
      {awsSummary ? (
        <>
          <DetailRow label="Application stack name" value={awsSummary.applicationStackName} />
          <DetailRow label="AWS region" value={awsSummary.region} />
          {awsSummary.releaseVersion !== null ? (
            <DetailRow label="Installed release" value={awsSummary.releaseVersion} />
          ) : null}
          <DetailRow label="Last checked" value={formatEventTime(updatedAt)} />
        </>
      ) : null}
      {routingTarget ? <DetailRow label="Deployment endpoint" value={routingTarget} /> : null}
      {awsSummary ? (
        <a
          className="self-start font-medium underline underline-offset-4"
          href={cloudFormationStacksUrl(awsSummary.region, awsSummary.applicationStackName)}
          target="_blank"
          rel="noreferrer"
        >
          View in AWS CloudFormation
        </a>
      ) : null}
      {technicalDetails ? <TechnicalEvents events={technicalDetails.events} /> : null}
      {hasInventory ? <AwsInfrastructureDetails plan={plan} /> : null}
    </div>
  );
}

/**
 * The customer failure projection, plus the derived startup flag the API
 * computes from the §61 code behind the message. The raw code itself never
 * reaches this unauthenticated surface (§65). The flag is optional here so
 * an older cached response that predates it still renders today's exact
 * behavior.
 */
type CustomerFailure = NonNullable<CustomerDeploymentStatus['failure']> & {
  ownedByApplication?: boolean;
  customerActionRequired?: boolean;
};

/** Cleanup copy for a failed install — which of the three states applies is
 *  derived server-side from the live stack status and cleanupState; the
 *  page never guesses. */
const CLEANUP_COPY: Record<NonNullable<CustomerDeploymentStatus['cleanup']>, string> = {
  IN_PROGRESS: 'Deployz stopped the deployment and is cleaning up resources from this attempt.',
  COMPLETE: 'The failed deployment has been cleaned up.',
  RETAINED: 'Some data or resources may remain in your AWS account. The technical details below have more information.',
};

/** The default customer next step after a failed install: the vendor owns
 *  the retry, and the customer is explicitly told no action is needed. */
const DEFAULT_NEXT_STEPS =
  'No action is required. Your software provider has been notified and can retry the deployment.';

/**
 * The customer's failure in the one recovery pattern (ux-guidelines §6):
 * what happened → impact (the cleanup state) → next step → technical
 * details. Who acts comes only from the server's flags — the page never
 * decides it (UX-BACKEND-005).
 */
function CustomerFailurePanel({
  failure,
  technicalDetails,
  cleanup,
}: {
  failure: CustomerFailure | null;
  technicalDetails: CustomerDeploymentStatus['technicalDetails'];
  cleanup: CustomerDeploymentStatus['cleanup'];
}) {
  if (!failure) return null;
  const technical = failure.technical;
  // The app-owned startup failures are the vendor's to fix — the customer is
  // told it is not their fault. Gated strictly on the derived flag.
  const startup = failure.ownedByApplication === true;
  // A USER_ACTION failure that is not the application's own needs a change
  // on the customer side before a retry can succeed — the default
  // "no action required" copy would then be wrong.
  const actionRequired = failure.customerActionRequired === true;
  return (
    <FailurePanel
      title={startup ? STARTUP_FAILURE_TITLE : 'What happened'}
      description={
        <>
          {failure.customerMessage}
          {startup ? <span className="mt-1 block">{STARTUP_FAILURE_CUSTOMER_NOTE}</span> : null}
        </>
      }
      impact={cleanup ? CLEANUP_COPY[cleanup] : undefined}
      explanation={<DocsLink href={DOCS.customerInstallFails}>If the deployment fails</DocsLink>}
      whoActs={
        actionRequired
          ? 'Something in the AWS account or setup must change before a retry can succeed. Contact your software provider to retry after that change.'
          : DEFAULT_NEXT_STEPS
      }
      technical={
        <div className="flex flex-col gap-1.5 text-sm">
          {technical ? <DetailRow label="Stage" value={technical.stage} /> : null}
          {technical?.component ? <DetailRow label="Component" value={technical.component} /> : null}
          {/* The API maps the raw CloudFormation status to a jargon-free
              phrase before it reaches this projection (§65). */}
          {technical?.awsStatus ? <DetailRow label="Infrastructure" value={technical.awsStatus} /> : null}
          <DetailRow label="Reference" value={failure.reference} />
          {technicalDetails ? (
            <>
              {technicalDetails.facts.map((fact) => (
                <DetailRow key={fact.label} label={fact.label} value={fact.value} />
              ))}
              <TechnicalEvents events={technicalDetails.events} />
            </>
          ) : null}
        </div>
      }
    />
  );
}
/** Raw CloudFormation events, compact monospace rows — customer-owned AWS
 *  account detail, shown only inside a collapsed disclosure. */
function TechnicalEvents({ events }: { events: CustomerTechnicalDetails['events'] }) {
  if (events.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 pt-1">
      {events.map((event) => (
        <p
          key={`${event.at}-${event.logicalResourceId}-${event.resourceStatus}`}
          className="font-mono text-xs text-muted-foreground"
        >
          {formatEventTime(event.at)} · {event.logicalResourceId} · {event.resourceType} ·{' '}
          {event.resourceStatus}
          {event.resourceStatusReason ? ` · ${event.resourceStatusReason}` : ''}
        </p>
      ))}
    </div>
  );
}

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-mono text-xs">{value}</span>
    </div>
  );
}
