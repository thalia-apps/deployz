'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { DocsLink } from '@/components/docs-link';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  FIX_INSTRUCTIONS_REUSED_NOTE,
  fixInstructionsGeneratedLabel,
  generateFixInstructions,
  type FixInstructions,
} from '@/lib/readiness';
import { DOCS } from '@/lib/docs-links';

// Fix-instructions dialog — generates the consolidated coding-agent prompt
// for the unresolved readiness findings and hands it to the vendor to paste
// into their own coding agent. Deployz never changes the repository: the
// dialog says so, and the only follow-up action is re-running the analysis
// once the agent's changes are pushed. Generation failures are retryable and
// never affect the readiness result behind the dialog.

type GenerationState =
  | { status: 'generating' }
  | { status: 'error'; message: string }
  | { status: 'done'; result: FixInstructions };

export function FixInstructionsDialog({
  open,
  applicationId,
  onClose,
  onReanalyse,
}: {
  open: boolean;
  applicationId: string;
  onClose: () => void;
  /** Triggers a re-analysis (same action as the Re-analyse button). */
  onReanalyse: () => void;
}) {
  const [state, setState] = useState<GenerationState>({ status: 'generating' });
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Regenerate keeps the existing instructions on screen instead of blanking
  // the dialog back to the full-body "Generating…" state — only the initial
  // generation (and a retry after an outright failure) does that.
  const generate = useCallback((options: { regenerate?: boolean } = {}) => {
    if (options.regenerate) {
      setRegenerating(true);
    } else {
      setState({ status: 'generating' });
    }
    generateFixInstructions(applicationId, options)
      .then((result) => setState({ status: 'done', result }))
      .catch((error: unknown) => {
        const message =
          error instanceof Error
            ? error.message
            : "Couldn't generate instructions. Try again.";
        if (options.regenerate) {
          toast.error(message);
        } else {
          setState({ status: 'error', message });
        }
      })
      .finally(() => {
        if (options.regenerate) setRegenerating(false);
      });
  }, [applicationId]);

  // Generate on open. The API reuses the document it already produced for
  // this analysis and finding set; Regenerate asks for a fresh one.
  useEffect(() => {
    if (open) generate();
  }, [open, generate]);

  // Clear the "Copied" revert timer so it never fires after unmount.
  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  async function handleCopy(): Promise<void> {
    if (state.status !== 'done') return;
    try {
      await navigator.clipboard.writeText(state.result.instructions);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
      toast.success('Instructions copied.');
    } catch {
      toast.error("Couldn't copy. Select the text and copy it manually.");
    }
  }

  function handleReanalyse(): void {
    onReanalyse();
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent data-testid="fix-instructions-dialog" className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Fix deployment issues with your coding agent</DialogTitle>
          <DialogDescription>
            Paste into your coding agent. Deployz doesn&apos;t change your repository.
          </DialogDescription>
          <DocsLink href={DOCS.fixFindings}>How to fix analysis findings</DocsLink>
        </DialogHeader>

        {state.status === 'generating' ? (
          <p role="status" className="py-6 text-center text-sm text-muted-foreground">
            Generating instructions…
          </p>
        ) : null}

        {state.status === 'error' ? (
          <div className="flex flex-col items-start gap-3 py-2">
            <p role="alert" data-testid="fix-instructions-error" className="text-sm text-destructive">
              {state.message}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="fix-instructions-retry"
              onClick={() => generate()}
            >
              Try again
            </Button>
          </div>
        ) : null}

        {state.status === 'done' ? (
          <div className="flex min-h-0 flex-col gap-3">
            <pre
              data-testid="fix-instructions-content"
              className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg border bg-muted px-3 py-2.5 font-mono text-xs"
            >
              {state.result.instructions}
            </pre>
            <p className="text-xs text-muted-foreground" data-testid="fix-instructions-generated">
              {fixInstructionsGeneratedLabel(state.result.generatedAt)}
              {state.result.cached ? ` · ${FIX_INSTRUCTIONS_REUSED_NOTE}` : ''}
            </p>
            <p className="text-sm text-muted-foreground">
              Push the changes to GitHub, then re-analyse.
            </p>
          </div>
        ) : null}

        {state.status === 'done' ? (
          <DialogFooter className="gap-2 sm:justify-between">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="fix-instructions-regenerate"
                onClick={() => generate({ regenerate: true })}
                loading={regenerating}
                loadingText="Regenerating instructions…"
              >
                Regenerate
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="fix-instructions-reanalyse"
                onClick={handleReanalyse}
                disabled={regenerating}
              >
                Re-analyse application
              </Button>
            </div>
            <Button
              type="button"
              data-testid="fix-instructions-copy"
              onClick={handleCopy}
              disabled={regenerating}
            >
              {copied ? 'Copied' : 'Copy instructions'}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
