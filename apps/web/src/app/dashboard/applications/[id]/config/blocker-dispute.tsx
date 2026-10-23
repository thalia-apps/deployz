'use client';

import { STORAGE_DISPUTE_FINDING_IDS, type VendorDismissedRejection } from '@deployz/contracts';
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { TechnicalDetails } from '@/components/technical-details';
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
import { Button } from '@/components/ui/button';
import type { BlockerDispute } from '@/lib/configuration-inventory';
import { BlockerDisputeError, disputeBlocker, withdrawBlockerDispute } from '@/lib/readiness';

/** What the vendor marks as not used, in application words. */
const DISPUTE_SUBJECTS: Record<string, string> = {
  'unsupported-database-mongo': 'MongoDB',
  'unsupported-database-elasticsearch': 'Elasticsearch or OpenSearch',
  'unsupported-database-other': 'this database',
  'unsupported-database-sqlite': 'SQLite',
  'unsupported-database-mariadb': 'MariaDB',
  'unsupported-redis-setup': 'this Redis setup',
  'unsupported-message-queue': 'this message queue',
  'unsupported-multi-service': 'the extra services',
  'unsupported-persistent-volume': 'the persistent disk volume',
  'local-file-storage': 'local file storage',
};

function subjectOf(findingId: string): string {
  return DISPUTE_SUBJECTS[findingId] ?? 'this item';
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Confirms a "not used in production" answer. The API analyses the application again. */
export function BlockerDisputeDialog({
  applicationId,
  dispute,
  onClose,
  onSaved,
}: {
  applicationId: string;
  dispute: BlockerDispute | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close(): void {
    setError(null);
    onClose();
  }

  async function onConfirm(target: BlockerDispute): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await disputeBlocker(applicationId, target.findingId, target.reason);
      close();
      await onSaved();
    } catch (caught) {
      if (caught instanceof BlockerDisputeError && caught.code === 'FINDING_CHANGED') {
        setError('The analysis changed. Review the item again.');
        await onSaved();
      } else {
        setError(caught instanceof Error ? caught.message : "Couldn't save your answer. Try again.");
      }
    } finally {
      setPending(false);
    }
  }

  const subject = dispute ? subjectOf(dispute.findingId) : '';
  return (
    <AlertDialog open={dispute !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <AlertDialogContent data-testid="blocker-dispute-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Mark {subject} as not used in production?</AlertDialogTitle>
          <AlertDialogDescription>
            Deployz analyses the application again without this item. Deployz does not create it. If your
            application needs it, the test deployment fails.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {dispute && STORAGE_DISPUTE_FINDING_IDS.has(dispute.findingId) ? (
          <Alert variant="destructive" data-testid="blocker-dispute-storage-warning">
            <TriangleAlert aria-hidden />
            <AlertTitle>Files can be lost</AlertTitle>
            <AlertDescription>
              Files that the application writes to its disk are lost when it restarts or updates. Confirm only if the
              application does not need these files later.
            </AlertDescription>
          </Alert>
        ) : null}
        {dispute ? (
          <TechnicalDetails label="Why Deployz found it">
            <code className="font-mono text-xs break-words whitespace-pre-wrap" data-testid="blocker-dispute-evidence">
              {dispute.reason}
            </code>
          </TechnicalDetails>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              // The action closes the dialog by default; the request needs it
              // open until the API has answered.
              event.preventDefault();
              if (dispute) void onConfirm(dispute);
            }}
            loading={pending}
            loadingText="Saving…"
            data-testid="blocker-dispute-confirm"
          >
            Mark as not used
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The vendor's "not used in production" answers, each with Undo. */
export function VendorAnswers({
  applicationId,
  answers,
  analyzing,
  onChanged,
}: {
  applicationId: string;
  answers: VendorDismissedRejection[];
  analyzing: boolean;
  onChanged: () => Promise<void>;
}) {
  const [undoing, setUndoing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (answers.length === 0) return null;

  async function undo(findingId: string): Promise<void> {
    setUndoing(findingId);
    setError(null);
    try {
      await withdrawBlockerDispute(applicationId, findingId);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't undo your answer. Try again.");
    } finally {
      setUndoing(null);
    }
  }

  return (
    <section aria-labelledby="vendor-answers-heading" className="flex flex-col gap-1" data-testid="vendor-answers">
      <h3 id="vendor-answers-heading" className="text-sm font-medium">
        Your answers
      </h3>
      <ul className="flex flex-col divide-y text-sm">
        {answers.map((answer) => (
          <li
            key={answer.findingId}
            className="flex flex-wrap items-center justify-between gap-2 py-2"
            data-testid={`vendor-answer-${answer.findingId}`}
          >
            <span className="flex flex-wrap items-center gap-2">
              <span>{capitalize(subjectOf(answer.findingId))}: not used in production</span>
              {answer.stale ? <Badge variant="warning">Evidence changed</Badge> : null}
            </span>
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => void undo(answer.findingId)}
              disabled={analyzing || (undoing !== null && undoing !== answer.findingId)}
              loading={undoing === answer.findingId}
              loadingText="Undoing…"
              data-testid={`vendor-answer-undo-${answer.findingId}`}
            >
              Undo
            </Button>
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
