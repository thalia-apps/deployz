'use client';

import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api-client';
import { openBillingPortal, openInNewTab, type BillingPortalTarget } from '@/lib/billing-checkout';

// The way into the billing provider's hosted customer portal, for the one
// thing only it can do: the card form. That makes this a hand-off, not a page: it mints a short-lived pre-authenticated
// session on the API and opens it in a new tab, never an iframe — the portal
// is where the vendor's card lives, and Deployz stays open behind it.
export function ManageBillingButton({
  target = 'overview',
  children,
  variant = 'outline',
  size = 'sm',
}: {
  /** Which portal page to land on. */
  target?: BillingPortalTarget;
  children: React.ReactNode;
  variant?: React.ComponentProps<typeof Button>['variant'];
  size?: React.ComponentProps<typeof Button>['size'];
}) {
  const [pending, setPending] = useState(false);

  async function onClick(): Promise<void> {
    setPending(true);
    try {
      await openInNewTab(() => openBillingPortal(target));
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      loading={pending}
      loadingText="Opening billing portal…"
      onClick={() => void onClick()}
      data-testid={`manage-billing-${target}`}
    >
      {children}
      <ExternalLink aria-hidden className="size-4" />
    </Button>
  );
}
