'use client';

import { Bot, Copy, FileText, LifeBuoy, RotateCcw, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { DocsLink } from '@/components/docs-link';
import { FailurePanel } from '@/components/failure-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { AI_CONFIDENCE_COPY, releaseBuildFailureSummary } from '@deployz/copy-map';
import {
  BUILD_FAILURE_OWNER_LABEL,
  BUILD_LOG_STATUS_COPY,
  buildInvestigationPrompt,
  buildSupportReport,
  buildTechnicalDetails,
  explainBuildFailure,
  fetchBuildFailure,
  fetchBuildLog,
  type BuildExplanation,
  type BuildFailureDetails,
  type BuildFailureOwner,
  type BuildLogLines,
  type ExcerptLine,
} from '@/lib/release-build-failure';
import { DOCS } from '@/lib/docs-links';
import type { Release } from '@/lib/releases';
import { cn } from '@/lib/utils';

// The expanded row of a failed release: what happened, the earliest error the
// build log shows, who most likely has to act, and the copyable evidence.
// Everything loads on expand. The AI reading is on demand and optional — the
// panel is complete without it.

const OWNER_BADGE: Record<BuildFailureOwner, 'warning' | 'info' | 'destructive' | 'secondary'> = {
  repository: 'warning',
  transient: 'info',
  deployz: 'destructive',
  undetermined: 'secondary',
};

const FINAL_CHECK_NOTE =
  '"The image build did not produce an image" is a final check that runs after the build. It is not the cause.';

type DetailsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; details: BuildFailureDetails };

type ExplanationState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; explanation: BuildExplanation };

async function copyText(text: string, success: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(success);
  } catch {
    toast.error("Couldn't copy. Your browser blocked clipboard access.");
  }
}

export function ReleaseFailureDetails({
  applicationId,
  release,
  installedInstead,
  onCreateRelease,
}: {
  applicationId: string;
  release: Release;
  /** The release customers still get while this one failed — set only when
   *  `installReleaseState` says a different release is the one installing. */
  installedInstead: Release | null;
  onCreateRelease: () => void;
}) {
  const [state, setState] = useState<DetailsState>({ status: 'loading' });
  const [explanation, setExplanation] = useState<ExplanationState>({ status: 'idle' });
  const [logOpen, setLogOpen] = useState(false);

  const load = useCallback(() => {
    setState({ status: 'loading' });
    fetchBuildFailure(applicationId, release.id)
      .then((details) => setState({ status: 'loaded', details }))
      .catch((error: unknown) =>
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : "Couldn't load the failure details.",
        }),
      );
  }, [applicationId, release.id]);

  useEffect(load, [load]);

  function explain(): void {
    setExplanation({ status: 'loading' });
    explainBuildFailure(applicationId, release.id)
      .then((result) => setExplanation({ status: 'done', explanation: result }))
      .catch((error: unknown) =>
        setExplanation({
          status: 'error',
          message: error instanceof Error ? error.message : 'The AI explanation is unavailable.',
        }),
      );
  }

  if (state.status === 'loading') {
    return (
      <div className="flex flex-col gap-2 p-4" aria-busy="true" data-testid="release-failure-loading">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-sm" data-testid="release-failure-error">
        <p>{releaseBuildFailureSummary(release.failureReason)}</p>
        <p className="text-muted-foreground">{state.message}</p>
        <Button variant="outline" size="sm" onClick={load}>
          <RotateCcw aria-hidden />
          Try again
        </Button>
      </div>
    );
  }

  const { details } = state;
  const excerpt = details.evidence?.excerpt ?? [];
  const aiResult = explanation.status === 'done' ? explanation.explanation : null;
  const deployzIssue = details.cause.owner === 'deployz';

  return (
    <div className="p-4" data-testid={`release-failure-details-${release.id}`}>
      <FailurePanel
        testId={`release-failure-panel-${release.id}`}
        title={details.summary}
        description={
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">Failed while: {details.stageLabel}</span>
              {details.finalCheckOnly ? <span className="text-xs text-muted-foreground">{FINAL_CHECK_NOTE}</span> : null}
            </div>

            <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="font-medium">Earliest error found</dt>
              <dd className="min-w-0">
                {details.observedError ? (
                  <code className="block rounded bg-muted px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap">
                    {details.observedError}
                  </code>
                ) : (
                  <span className="text-muted-foreground" data-testid="release-failure-no-error">
                    {details.cause.owner === 'undetermined'
                      ? 'Not found in the available evidence. The cause is unknown.'
                      : 'Not found in the available evidence.'}
                  </span>
                )}
              </dd>
              <dt className="font-medium">Next step</dt>
              <dd className="flex min-w-0 flex-col gap-1">
                <span data-testid="release-failure-next-step">{details.cause.nextStep}</span>
                <span className="text-xs text-muted-foreground">{details.cause.basis}</span>
              </dd>
            </dl>

            {details.logs.status === 'available' ? (
              <details className="group rounded-lg border" open>
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                  Relevant log lines ({excerpt.length} of {details.logs.lineCount})
                </summary>
                <LogLines lines={excerpt} className="max-h-72 border-t" />
              </details>
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="release-failure-log-status">
                {BUILD_LOG_STATUS_COPY[details.logs.status]}
              </p>
            )}

            {deployzIssue ? null : (
              <p className="text-xs text-muted-foreground">
                The prompt asks your agent to find the cause before changing code. Copying it grants
                no access to Deployz or AWS.
              </p>
            )}

            <div aria-live="polite">
              <ExplanationResult state={explanation} />
            </div>

            {deployzIssue ? (
              <DocsLink href={DOCS.contactSupport}>How to contact Deployz support</DocsLink>
            ) : (
              <DocsLink href={DOCS.buildFailures}>How to fix a failed build</DocsLink>
            )}
          </div>
        }
        impact={installedInstead ? `Customers still get ${installedInstead.version}.` : null}
        whoActs={
          <Badge variant={OWNER_BADGE[details.cause.owner]} data-testid="release-failure-owner">
            {BUILD_FAILURE_OWNER_LABEL[details.cause.owner]}
          </Badge>
        }
        action={
          <>
            {deployzIssue ? (
              <Button
                size="sm"
                onClick={() =>
                  void copyText(buildSupportReport(details), 'Report copied. Send it to Deployz support.')
                }
              >
                <LifeBuoy aria-hidden />
                Copy report for Deployz support
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() =>
                  void copyText(
                    buildInvestigationPrompt(details, aiResult),
                    'Investigation prompt copied. Paste it into your coding agent.',
                  )
                }
              >
                <Bot aria-hidden />
                Copy prompt for coding agent
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLogOpen(true)}
              disabled={details.logs.status !== 'available'}
            >
              <FileText aria-hidden />
              View build logs
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={explain}
              disabled={excerpt.length === 0}
              loading={explanation.status === 'loading'}
              loadingText="Explaining…"
            >
              <Sparkles aria-hidden />
              Explain with AI
            </Button>
            {details.cause.owner === 'repository' || details.cause.owner === 'transient' ? (
              <Button variant="ghost" size="sm" onClick={onCreateRelease}>
                Create release
              </Button>
            ) : null}
          </>
        }
        technical={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copyText(buildTechnicalDetails(details), 'Technical details copied.')}
          >
            <Copy aria-hidden />
            Copy technical details
          </Button>
        }
      />

      <BuildLogDialog
        open={logOpen}
        onOpenChange={setLogOpen}
        applicationId={applicationId}
        release={release}
      />
    </div>
  );
}

function LogLines({ lines, className }: { lines: readonly ExcerptLine[]; className?: string }) {
  return (
    <pre
      className={cn('overflow-auto bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed', className)}
      tabIndex={0}
      aria-label="Build log lines"
    >
      {lines.map((line, index) => {
        const gap = index > 0 && line.number !== lines[index - 1]!.number + 1;
        return (
          <span key={line.number} className="block">
            {gap ? <span className="block text-muted-foreground">⋯</span> : null}
            <span className="inline-block w-12 pr-2 text-right text-muted-foreground select-none">
              {line.number}
            </span>
            <span className={cn('whitespace-pre-wrap break-all', line.error && 'font-semibold text-destructive')}>
              {line.error ? <span className="sr-only">Error: </span> : null}
              {line.text}
            </span>
          </span>
        );
      })}
    </pre>
  );
}

function ExplanationResult({ state }: { state: ExplanationState }) {
  if (state.status === 'idle' || state.status === 'loading') return null;
  if (state.status === 'error') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="release-ai-error">
        {state.message}
      </p>
    );
  }
  const { explanation } = state;
  if (explanation.status === 'no_evidence') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="release-ai-no-evidence">
        No build log lines are available for the AI to read.
      </p>
    );
  }
  if (explanation.status === 'inconclusive') {
    return (
      <div className="flex flex-col gap-1 rounded-lg border p-3 text-sm" data-testid="release-ai-inconclusive">
        <p className="font-medium">The AI could not find the cause in these log lines.</p>
        <p className="text-muted-foreground">{explanation.uncertainty}</p>
      </div>
    );
  }
  const hedge = AI_CONFIDENCE_COPY[explanation.confidence];
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm" data-testid="release-ai-explanation">
      <p className="font-medium">AI reading — verify before you act</p>
      {hedge ? <p className="text-muted-foreground">{hedge}</p> : null}
      <dl className="grid gap-2 sm:grid-cols-[10rem_1fr]">
        <dt className="font-medium">Likely cause</dt>
        <dd>{explanation.likelyCause}</dd>
        <dt className="font-medium">Suggested next step</dt>
        <dd>{explanation.nextStep}</dd>
        {explanation.uncertainty ? (
          <>
            <dt className="font-medium">Not certain</dt>
            <dd className="text-muted-foreground">{explanation.uncertainty}</dd>
          </>
        ) : null}
      </dl>
      <LogLines
        lines={explanation.supportingLines.map((line) => ({ ...line, error: true }))}
        className="rounded-md border"
      />
      <p className="text-xs text-muted-foreground">
        Written by AI from the redacted log lines above.
      </p>
    </div>
  );
}

function BuildLogDialog({
  open,
  onOpenChange,
  applicationId,
  release,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: string;
  release: Release;
}) {
  const [log, setLog] = useState<BuildLogLines | 'loading' | 'error'>('loading');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLog('loading');
    fetchBuildLog(applicationId, release.id)
      .then((result) => {
        if (!cancelled) setLog(result);
      })
      .catch(() => {
        if (!cancelled) setLog('error');
      });
    return () => {
      cancelled = true;
    };
  }, [open, applicationId, release.id]);

  const lines = typeof log === 'object' ? log.lines : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl" data-testid="release-build-log-dialog">
        <DialogHeader>
          <DialogTitle>Build log · {release.version}</DialogTitle>
          <DialogDescription>
            {typeof log === 'object' && log.truncated
              ? `Last ${lines.length} lines only.`
              : 'Full build log.'}{' '}
            Secrets and Deployz infrastructure details are removed.
          </DialogDescription>
        </DialogHeader>
        {log === 'loading' ? <Skeleton className="h-64 w-full" /> : null}
        {log === 'error' ? (
          <p className="text-sm text-muted-foreground">Couldn&apos;t load the build log. Try again.</p>
        ) : null}
        {typeof log === 'object' && log.status !== 'available' ? (
          <p className="text-sm text-muted-foreground">{BUILD_LOG_STATUS_COPY[log.status]}</p>
        ) : null}
        {lines.length > 0 ? (
          <>
            <LogLines
              lines={lines.map((text, index) => ({ number: index + 1, text, error: false }))}
              className="max-h-[60vh] rounded-md border"
            />
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copyText(lines.join('\n'), 'Build log copied.')}
              >
                <Copy aria-hidden />
                Copy log
              </Button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
