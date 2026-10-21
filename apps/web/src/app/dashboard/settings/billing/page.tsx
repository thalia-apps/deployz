import { Receipt } from 'lucide-react';

import { ManageBillingButton } from '@/components/manage-billing-button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { fetchBillingSummary, formatDollars, type BillingSummary } from '@/lib/billing';
import { subscriptionStatusLabel } from '@/lib/organization-vocabulary';

// §48 billing display. Paddle migration Phase 11 splits it in two, because
// the old page charged every vendor $49 on screen whether or not they had
// ever bought anything: an organization with no subscription is EVALUATING,
// which is free and never expires, and showing it a monthly total is simply
// untrue. Once a subscription exists the page shows the real rate, the next
// billing date and the per-customer breakdown.
//
// Included production deployments: the allowance is pooled across the
// organization, so the page never labels one deployment free and another
// paid — it shows active, paused, included and billed counts, and bills the
// pool. A paused deployment (failed or disconnected) is not billed.
//
// §65: jargon-free. The provider is never named at the top level.
export default async function BillingPage() {
  const billing = await fetchBillingSummary();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>

      {billing.subscription ? (
        <SubscribedCard billing={billing} />
      ) : (
        <EvaluationCard billing={billing} />
      )}
    </div>
  );
}

/** No subscription: free, no card, no expiry — and what would start billing. */
function EvaluationCard({ billing }: { billing: BillingSummary }) {
  const { included } = billing.productionDeployments;
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Evaluation — free</CardTitle>
          <CardDescription>No card and no time limit.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
            <li>Connecting applications, analysis and configuration</li>
            <li>One test deployment of your own app, per application</li>
            <li>Adding customers and building releases</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What starts billing</CardTitle>
          <CardDescription>Your subscription.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Platform</span>
            <span className="tabular-nums text-muted-foreground">
              {formatDollars(billing.base)}/month
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Each customer deployment, once live</span>
            <span className="tabular-nums text-muted-foreground">
              {formatDollars(billing.deploymentPrice)}/month
            </span>
          </div>
          {included > 0 ? (
            <div
              className="flex items-center justify-between text-sm"
              data-testid="billing-included-deployments"
            >
              <span className="font-medium">Included production deployments</span>
              <span className="tabular-nums text-muted-foreground">{included}</span>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            The platform fee starts when you subscribe. You subscribe before a customer can confirm an
            invitation. A test deployment of your own
            app is free. A customer deployment is charged only while it runs for your customer. A
            failed or disconnected deployment is not charged.
            {included > 0
              ? ` ${included} production ${included === 1 ? 'deployment is' : 'deployments are'} included. The per-deployment fee applies only to live deployments beyond the included ones.`
              : ''}
          </p>
        </CardContent>
      </Card>
    </>
  );
}

/** Subscribed: the real rate, the next billing date and the breakdown. */
function SubscribedCard({ billing }: { billing: BillingSummary }) {
  const subscription = billing.subscription!;
  const counts = billing.productionDeployments;
  const nextBillingDate = subscription.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Receipt className="size-5 text-muted-foreground" aria-hidden />
            <CardTitle>Current charges</CardTitle>
          </div>
          <CardDescription className="flex flex-wrap items-center gap-2">
            <Badge variant={subscription.status === 'ACTIVE' ? 'secondary' : 'destructive'}>
              {subscriptionStatusLabel(subscription.status)}
            </Badge>
            {nextBillingDate ? <span>Next billed {nextBillingDate}</span> : null}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Platform</span>
            <span className="font-medium tabular-nums">{formatDollars(billing.base)}</span>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">Production deployments</span>
              <span className="font-medium tabular-nums">
                {formatDollars(counts.billable * billing.deploymentPrice)}
              </span>
            </div>
            <p className="text-muted-foreground tabular-nums" data-testid="billing-production-counts">
              {counts.active} active
              {counts.paused > 0 ? ` · ${counts.paused} paused` : ''}
              {counts.included > 0 ? ` · ${counts.included} included` : ''}
              {` · ${counts.billable} billed × ${formatDollars(billing.deploymentPrice)}`}
            </p>
          </div>
          {billing.deployments.length > 0 ? (
            <ul className="flex flex-col gap-1 pl-4 text-sm">
              {billing.deployments.map((deployment, index) => (
                <li key={`${deployment.name}-${index}`}>
                  <span className="font-medium">{deployment.name}</span>
                  <span className="ml-1.5 text-muted-foreground">({deployment.applicationName})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No customer deployments are live yet.
            </p>
          )}
          <Separator />
          <div className="flex items-center justify-between text-sm font-semibold">
            <span>Monthly total</span>
            <span className="tabular-nums">{formatDollars(billing.total)}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Manage billing</CardTitle>
          <CardDescription>
            Invoices, payment details and cancellation are on our billing partner’s portal.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <ManageBillingButton target="overview" variant="default">
            Open billing portal
          </ManageBillingButton>
          <ManageBillingButton target="updatePaymentMethod">Update payment details</ManageBillingButton>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        A test deployment of your own app is not charged.
        {counts.included > 0
          ? ` ${counts.included} production ${counts.included === 1 ? 'deployment is' : 'deployments are'} included; ${formatDollars(billing.deploymentPrice)}/month applies to each live deployment beyond that.`
          : ` ${formatDollars(billing.deploymentPrice)}/month applies to each customer deployment while it runs for your customer, and stops when it is removed.`}
        {' A failed or disconnected deployment is paused and not charged. Charges start again when it is ready.'}
      </p>
    </>
  );
}
