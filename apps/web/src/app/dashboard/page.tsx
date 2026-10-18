'use client';

import { AlertTriangle, ArrowRight, CircleCheck } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useState } from 'react';

import { SetupProgress } from '@/components/setup-progress';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchApplications } from '@/lib/applications';
import { fetchDeployments } from '@/lib/deployments';
import {
  deriveHomeState,
  OVERVIEW_METRIC_HREFS,
  type HomeState,
  type NextStep,
  type OverviewSummary,
} from '@/lib/home-state';
import { cn } from '@/lib/utils';
import { useStatusPoll } from '@/lib/use-status-poll';

/** How often to re-check while something is still being set up. */
const TRANSIENT_POLL_MS = 5000;

const METRICS: { key: keyof OverviewSummary; label: string }[] = [
  { key: 'live', label: 'Live' },
  { key: 'attention', label: 'Need attention' },
  { key: 'deploying', label: 'Deploying' },
  { key: 'awaiting', label: 'Awaiting customer' },
];

// The homepage ("Overview"). Two states, both derived from the organization's
// real applications and deployments: the onboarding checklist until a
// customer deployment exists, then one compact summary and at most three next
// steps. The full deployment table lives one click deeper, on
// /dashboard/deployments, and every count links to its filtered view there.
export default function HomePage() {
  const fetcher = useCallback(async (): Promise<HomeState> => {
    const [applications, deployments] = await Promise.all([
      fetchApplications(),
      fetchDeployments(),
    ]);
    return deriveHomeState({ applications, deployments });
  }, []);

  const poll = useStatusPoll<HomeState>({
    fetcher,
    intervalMs: TRANSIENT_POLL_MS,
    terminalIntervalMs: 60_000,
    isTerminal: (home) => home.settled,
  });

  const home = poll.data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        {home?.kind === 'overview' ? (
          <Button asChild size="sm">
            <Link href="/dashboard/deployments/new">Create deployment</Link>
          </Button>
        ) : null}
      </div>

      {home === null ? (
        poll.loading ? (
          <LoadingState />
        ) : (
          <ErrorState onRetry={poll.refresh} />
        )
      ) : (
        <>
          {poll.stale ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <AlertTriangle aria-hidden className="size-4 shrink-0" />
              Updates unavailable — showing last known state
            </p>
          ) : null}
          {home.kind === 'onboarding' ? (
            <OnboardingHome home={home} />
          ) : (
            <OverviewHome home={home} stale={poll.stale} />
          )}
        </>
      )}
    </div>
  );
}

function OnboardingHome({ home }: { home: Extract<HomeState, { kind: 'onboarding' }> }) {
  const firstDeployment = home.steps[2]!.state === 'current';
  return (
    <section aria-labelledby="get-started" className="flex max-w-xl flex-col gap-3">
      <h2 id="get-started" className="text-base font-semibold">
        {firstDeployment ? 'Create your first deployment' : 'Get started'}
      </h2>
      <SetupProgress steps={home.steps} />
    </section>
  );
}

function OverviewHome({
  home,
  stale,
}: {
  home: Extract<HomeState, { kind: 'overview' }>;
  stale: boolean;
}) {
  return (
    <>
      <Card className="py-0" data-testid="overview-summary">
        <CardContent className="grid grid-cols-2 p-0 sm:grid-cols-4">
          {METRICS.map((metric) => {
            const value = home.summary[metric.key];
            return (
              <Link
                key={metric.key}
                href={OVERVIEW_METRIC_HREFS[metric.key]}
                className="flex flex-col gap-0.5 p-4 outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
              >
                <span
                  className={cn(
                    'text-2xl font-semibold tabular-nums',
                    metric.key === 'attention' && value > 0 && 'text-destructive',
                  )}
                >
                  {value}
                </span>
                <span className="text-sm text-muted-foreground">{metric.label}</span>
              </Link>
            );
          })}
        </CardContent>
      </Card>

      <section aria-labelledby="next-steps" className="flex flex-col gap-3">
        <h2 id="next-steps" className="text-base font-semibold">
          Next steps
        </h2>
        {home.nextSteps.length > 0 ? (
          <NextSteps steps={home.nextSteps} />
        ) : stale ? null : (
          <AllClear home={home} />
        )}
      </section>
    </>
  );
}

function NextSteps({ steps }: { steps: NextStep[] }) {
  return (
    <Card className="py-0">
      <CardContent className="p-0">
        <ul className="divide-y" data-testid="next-steps">
          {steps.map((step) => (
            <li
              key={step.id}
              className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                {step.id === 'attention' ? (
                  <AlertTriangle aria-hidden className="size-4 shrink-0 text-destructive" />
                ) : null}
                {step.title}
              </span>
              <Button asChild variant="outline" size="sm" className="self-start sm:self-auto">
                <Link href={step.action.href}>
                  {step.action.label}
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// "All deployments healthy" is claimed only when every deployment is live and
// reports HEALTHY; deployments still in progress or without a health report
// only get the narrower "Nothing needs your attention".
function AllClear({ home }: { home: Extract<HomeState, { kind: 'overview' }> }) {
  return (
    <div className="flex items-start gap-3" data-testid="all-clear">
      <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex flex-col gap-0.5 text-sm">
        {home.allHealthy ? <p className="font-medium">All deployments healthy</p> : null}
        <p className={home.allHealthy ? 'text-muted-foreground' : 'font-medium'}>
          Nothing needs your attention.
        </p>
        {home.healthUnknown > 0 ? (
          <p className="text-muted-foreground">
            {home.healthUnknown === 1
              ? '1 deployment has not reported its health yet.'
              : `${home.healthUnknown} deployments have not reported their health yet.`}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" data-testid="home-loading">
      <span className="sr-only">Loading overview…</span>
      <Skeleton className="h-22 w-full rounded-xl" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => Promise<void> }) {
  const [retrying, setRetrying] = useState(false);

  async function handleRetry(): Promise<void> {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <section
      aria-labelledby="home-error"
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <h2 id="home-error" className="text-lg font-semibold">
        Something went wrong
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        We couldn&apos;t load your overview. Try again in a moment.
      </p>
      <Button variant="outline" onClick={() => void handleRetry()} loading={retrying} loadingText="Trying again…">
        Try again
      </Button>
    </section>
  );
}
