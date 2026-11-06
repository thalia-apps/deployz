import Link from 'next/link';
import { AlertTriangle, CreditCard } from 'lucide-react';

import { ManageBillingButton } from '@/components/manage-billing-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { SubscriptionStatus } from '@/lib/organization-vocabulary';

// Paddle migration Phase 11 — the two app-wide billing banners. Deliberately
// only two: a payment that failed, and a subscription that ended. Evaluation
// (no subscription at all) is the normal free state and gets no banner —
// nagging a vendor who is not yet a customer is exactly the pressure this
// product does not apply.
//
// Neither banner ever suggests a customer's deployment is at risk. Payment
// state never touches running customer infrastructure, and saying otherwise
// would frighten a vendor about something that is not happening.

const BANNERS: Partial<
  Record<SubscriptionStatus, { title: string; description: string; action: string }>
> = {
  PAST_DUE: {
    title: 'Your last payment did not go through',
    description:
      'Update your payment details to keep your subscription. Your customers’ deployments keep running.',
    action: 'Update payment details',
  },
  CANCELED: {
    title: 'Your subscription has ended',
    description:
      'Existing deployments keep running. You need an active subscription to add another customer deployment.',
    action: 'View billing',
  },
};

export function SubscriptionBanner({ status }: { status: SubscriptionStatus | null }) {
  const banner = status ? BANNERS[status] : undefined;
  if (!banner) return null;
  const Icon = status === 'PAST_DUE' ? CreditCard : AlertTriangle;

  return (
    <Alert variant="destructive" data-testid={`subscription-banner-${status?.toLowerCase()}`}>
      <Icon aria-hidden className="size-4" />
      <AlertTitle>{banner.title}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{banner.description}</span>
        {/* Phase 12: a failed payment goes straight to the billing portal —
            the one action that actually fixes it — rather than to a page
            that then asks the vendor to click again. */}
        {status === 'PAST_DUE' ? (
          <ManageBillingButton target="updatePaymentMethod">{banner.action}</ManageBillingButton>
        ) : (
          <Button asChild size="sm" variant="outline">
            <Link href="/dashboard/settings/billing">{banner.action}</Link>
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
