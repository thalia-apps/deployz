'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { signOutCustomer, type InstallViewer } from '@/lib/customer-access';

// Who the customer page is open for, and the way out. A vendor viewing the
// page through the dashboard session signs out from the dashboard instead.
export function CustomerSessionBar({ installLinkId, viewer }: { installLinkId: string; viewer: InstallViewer }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  if (viewer.kind === 'vendor') {
    return (
      <p className="text-xs text-muted-foreground" data-testid="customer-session-bar">
        You are viewing your customer&apos;s page with your publisher account.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground" data-testid="customer-session-bar">
      <span>Signed in as {viewer.email}</span>
      <Button
        variant="ghost"
        size="sm"
        loading={pending}
        loadingText="Signing out…"
        onClick={() => {
          setPending(true);
          void signOutCustomer(installLinkId)
            .catch(() => undefined)
            .finally(() => router.refresh());
        }}
      >
        Sign out
      </Button>
    </div>
  );
}
