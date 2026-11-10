'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

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
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api-client';
import { cancelSubscription } from '@/lib/billing-checkout';

// Ends the subscription when the paid period ends, without leaving Deployz.
// The dialog says what happens first; the billing page then shows the end
// date Polar reports, which stays the source of truth.
export function CancelSubscriptionButton({ endsOn }: { endsOn: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await cancelSubscription();
      setOpen(false);
      toast.success('Your subscription will end when the paid period ends.');
      router.refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)} data-testid="cancel-subscription">
        Cancel subscription
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !pending) setOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel your subscription?</AlertDialogTitle>
            <AlertDialogDescription>
              {endsOn
                ? `Your subscription stays active until ${endsOn}, then ends. `
                : 'Your subscription stays active until the end of the paid period, then ends. '}
              You are not refunded for the current period. Customer deployments keep running, and you can
              subscribe again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep subscription</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              loading={pending}
              loadingText="Cancelling…"
              onClick={(event) => {
                // Keep the dialog open until the request settles.
                event.preventDefault();
                void onConfirm();
              }}
            >
              Cancel subscription
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
