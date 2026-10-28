import { AlertTriangle, ChevronDown, CreditCard, Receipt } from 'lucide-react';

import { DocsLink } from '@/components/docs-link';
import { InvoiceDownloadButton } from '@/components/invoice-download-button';
import { ManageBillingButton } from '@/components/manage-billing-button';
import { StartSubscriptionButton } from '@/components/start-subscription-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  fetchBillingAccount,
  fetchBillingEnabled,
  fetchBillingSummary,
  formatBillingDate,
  formatDollars,
  formatMoney,
  type BillingAccount,
  type BillingAccountResult,
  type BillingSummary,
} from '@/lib/billing';
import { DOCS } from '@/lib/docs-links';
import { fetchOrganization } from '@/lib/organization';
import { subscriptionStatusLabel, type SubscriptionStatus } from '@/lib/organization-vocabulary';

// §48 billing display. One page, driven by the subscription status: the Plan
// card at the top says where the organization stands and carries the one
// action that state needs (subscribe, restart, fix the card, resume). Below
// it: what the live deployments cost, then the invoices.
//
// Evaluation is free and never expires, so it shows the price and a way to
// subscribe, never a monthly total. A CANCELED organization restarts here.
//
// Included production deployments: the allowance is pooled across the
// organization, so the page never labels one deployment free and another
// paid — it shows active, paused, included and billed counts, and bills the
// pool. A paused deployment (failed or disconnected) is not billed.
//
// The next payment, the payment method and the invoices are read live from
// the billing provider, and only for an owner or admin. Changes happen on the
// provider's portal; only starting a subscription happens here.
//
// §65: jargon-free. The provider is never named at the top level.
export default async function BillingPage() {
  const [billing, organization, billingEnabled] = await Promise.all([
    fetchBillingSummary(),
    fetchOrganization(),
    fetchBillingEnabled(),
  ]);
  const account = billing.subscription ? await fetchBillingAccount() : null;
  const canManage = organization.role === 'owner' || organization.role === 'admin';
  const status = billing.subscription?.status ?? null;
  const live = status === 'ACTIVE' || status === 'PAST_DUE' || status === 'PAUSED';
  const included = billing.productionDeployments.included;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
          <Badge variant={statusBadgeVariant(status)} data-testid="billing-status">
            {subscriptionStatusLabel(status)}
          </Badge>
        </div>
        <DocsLink href={DOCS.billing}>How pricing and billing work</DocsLink>
      </div>

      <PlanCard
        billing={billing}
        account={account}
        canManage={canManage}
        billingEnabled={billingEnabled}
      />

      {live ? <ChargesCard billing={billing} /> : null}

      {account?.status === 'ok' ? <InvoicesCard account={account.account} /> : null}

      <p className="text-xs text-muted-foreground">
        A test deployment of your own app is never charged.
        {included > 0
          ? ` ${included} production ${included === 1 ? 'deployment is' : 'deployments are'} included; ${formatDollars(billing.deploymentPrice)}/month applies to each live deployment beyond that.`
          : ` ${formatDollars(billing.deploymentPrice)}/month applies to each customer deployment while it runs for your customer, and stops when it is removed.`}
        {' A failed or disconnected deployment is paused and not charged. Your customers’ deployments keep running whatever the payment state.'}
      </p>
    </div>
  );
}

function statusBadgeVariant(
  status: SubscriptionStatus | null,
): 'secondary' | 'outline' | 'destructive' {
  if (status === 'ACTIVE') return 'secondary';
  if (status === 'PAST_DUE') return 'destructive';
  return 'outline';
}

const ROLE_NOTE = 'Only an owner or admin can change billing.';

/** The state of the subscription and the one action it needs. */
function PlanCard({
  billing,
  account,
  canManage,
  billingEnabled,
}: {
  billing: BillingSummary;
  account: BillingAccountResult | null;
  canManage: boolean;
  billingEnabled: boolean;
}) {
  const status = billing.subscription?.status ?? null;
  if (status === null || status === 'CANCELED') {
    return (
      <SubscribeCard
        billing={billing}
        restart={status === 'CANCELED'}
        canManage={canManage}
        billingEnabled={billingEnabled}
      />
    );
  }

  const details = account?.status === 'ok' ? account.account : null;
  const nextPaymentText = details?.nextPayment
    ? `${formatMoney(details.nextPayment)} on ${formatBillingDate(details.nextPayment.date)}`
    : billing.subscription?.currentPeriodEnd && !details?.scheduledChange
      ? formatBillingDate(billing.subscription.currentPeriodEnd)
      : null;

  return (
    <Card data-testid="billing-plan">
      <CardHeader>
        <CardTitle>
          {status === 'PAST_DUE'
            ? 'Your last payment did not go through'
            : status === 'PAUSED'
              ? 'Your subscription is paused'
              : 'Deployz subscription'}
        </CardTitle>
        <CardDescription>
          {status === 'PAST_DUE'
            ? 'Update your payment details to keep your subscription. Your customers’ deployments keep running.'
            : status === 'PAUSED'
              ? 'Existing deployments keep running. Resume your subscription to add customer deployments.'
              : 'Customers can confirm invitations, and you can add customer deployments.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {details?.scheduledChange ? (
          <Alert data-testid="billing-scheduled-change">
            <AlertTriangle aria-hidden className="size-4" />
            <AlertTitle>
              {details.scheduledChange.action === 'cancel'
                ? `Your subscription ends on ${formatBillingDate(details.scheduledChange.effectiveAt)}`
                : `Your subscription is scheduled to ${details.scheduledChange.action} on ${formatBillingDate(details.scheduledChange.effectiveAt)}`}
            </AlertTitle>
            <AlertDescription>
              Existing deployments keep running. To keep your subscription, open the billing portal.
            </AlertDescription>
          </Alert>
        ) : null}
        {account?.status === 'unavailable' ? (
          <Alert data-testid="billing-account-unavailable">
            <AlertTriangle aria-hidden className="size-4" />
            <AlertTitle>Payment details and invoices could not be loaded</AlertTitle>
            <AlertDescription>Reload the page to try again, or open the billing portal.</AlertDescription>
          </Alert>
        ) : null}
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground">Next payment</dt>
            <dd className="font-medium tabular-nums" data-testid="billing-next-payment">
              {nextPaymentText ?? 'No payment is scheduled'}
            </dd>
          </div>
          {details ? (
            <div className="flex flex-col gap-1">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <CreditCard aria-hidden className="size-4" />
                Payment method
              </dt>
              <dd className="font-medium" data-testid="billing-payment-method">
                {details.paymentMethod
                  ? paymentMethodLabel(details.paymentMethod)
                  : 'No payment method on file yet'}
              </dd>
            </div>
          ) : null}
        </dl>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-3">
        {!canManage ? (
          <p className="text-sm text-muted-foreground">{ROLE_NOTE}</p>
        ) : status === 'PAST_DUE' ? (
          <>
            <ManageBillingButton target="updatePaymentMethod" variant="default">
              Update payment details
            </ManageBillingButton>
            <ManageBillingButton target="overview">Open billing portal</ManageBillingButton>
          </>
        ) : status === 'PAUSED' ? (
          <ManageBillingButton target="overview" variant="default">
            Resume in billing portal
          </ManageBillingButton>
        ) : (
          <>
            <ManageBillingButton target="updatePaymentMethod">
              Update payment details
            </ManageBillingButton>
            <ManageBillingButton target="overview">Open billing portal</ManageBillingButton>
            {details?.scheduledChange?.action === 'cancel' ? null : (
              <ManageBillingButton target="cancel" variant="ghost">
                Cancel subscription
              </ManageBillingButton>
            )}
          </>
        )}
      </CardFooter>
    </Card>
  );
}

/** Evaluation or CANCELED: what is free, the price, and the way to subscribe. */
function SubscribeCard({
  billing,
  restart,
  canManage,
  billingEnabled,
}: {
  billing: BillingSummary;
  restart: boolean;
  canManage: boolean;
  billingEnabled: boolean;
}) {
  const included = billing.productionDeployments.included;
  return (
    <Card data-testid="billing-plan">
      <CardHeader>
        <CardTitle>
          {restart ? 'Your subscription has ended' : 'You are evaluating Deployz — free'}
        </CardTitle>
        <CardDescription>
          {restart
            ? 'Existing deployments keep running. Restart your subscription so customers can confirm new invitations.'
            : 'No card and no time limit. Subscribe before your first customer confirms an invitation.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-2 text-sm">
          <p className="font-medium">Always free</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
            <li>Connecting applications, analysis and configuration</li>
            <li>One test deployment of your own app, per application</li>
            <li>Adding customers and building releases</li>
          </ul>
        </div>
        <div className="flex flex-col gap-2 rounded-lg border p-4 text-sm" data-testid="billing-price">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-medium">Platform</span>
            <span className="tabular-nums">
              <span className="text-lg font-semibold">{formatDollars(billing.base)}</span>
              <span className="text-muted-foreground">/month</span>
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-medium">Each live customer deployment</span>
            <span className="tabular-nums text-muted-foreground">
              + {formatDollars(billing.deploymentPrice)}/month
            </span>
          </div>
          {included > 0 ? (
            <div
              className="flex items-baseline justify-between gap-3"
              data-testid="billing-included-deployments"
            >
              <span className="font-medium">Included production deployments</span>
              <span className="tabular-nums text-muted-foreground">{included}</span>
            </div>
          ) : null}
          <Separator />
          <p className="text-muted-foreground">
            You pay {formatDollars(billing.base)} today, then monthly. A customer deployment adds{' '}
            {formatDollars(billing.deploymentPrice)}/month only while it is live.
          </p>
        </div>
      </CardContent>
      <CardFooter>
        {!billingEnabled ? (
          <p className="text-sm text-muted-foreground">Subscriptions are not available yet.</p>
        ) : canManage ? (
          <StartSubscriptionButton>
            {restart ? 'Restart subscription' : 'Start subscription'}
          </StartSubscriptionButton>
        ) : (
          <p className="text-sm text-muted-foreground">{ROLE_NOTE}</p>
        )}
      </CardFooter>
    </Card>
  );
}

/** What the live production deployments cost each month, before tax. */
function ChargesCard({ billing }: { billing: BillingSummary }) {
  const counts = billing.productionDeployments;
  const deploymentCount = billing.deployments.length;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Receipt className="size-5 text-muted-foreground" aria-hidden />
          <CardTitle>Current charges</CardTitle>
        </div>
        <CardDescription>Your monthly rate today, before tax.</CardDescription>
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
        {deploymentCount > 0 ? (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="group -ml-2">
                Show {deploymentCount} live {deploymentCount === 1 ? 'deployment' : 'deployments'}
                <ChevronDown
                  aria-hidden
                  className="size-4 transition-transform group-data-[state=open]:rotate-180"
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="flex flex-col gap-1 pt-2 pl-4 text-sm">
                {billing.deployments.map((deployment, index) => (
                  <li key={`${deployment.name}-${index}`}>
                    <span className="font-medium">{deployment.name}</span>
                    <span className="ml-1.5 text-muted-foreground">({deployment.applicationName})</span>
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <p className="text-sm text-muted-foreground">No customer deployments are live yet.</p>
        )}
        <Separator />
        <div className="flex items-center justify-between text-sm font-semibold">
          <span>Monthly total</span>
          <span className="tabular-nums">{formatDollars(billing.total)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

const TRANSACTION_STATUS_LABELS: Record<
  BillingAccount['transactions'][number]['status'],
  { label: string; variant: 'secondary' | 'outline' | 'destructive' }
> = {
  completed: { label: 'Paid', variant: 'secondary' },
  paid: { label: 'Paid', variant: 'secondary' },
  billed: { label: 'Due', variant: 'outline' },
  past_due: { label: 'Past due', variant: 'destructive' },
};

function capitalize(text: string): string {
  const words = text.replace(/_/g, ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function paymentMethodLabel(method: NonNullable<BillingAccount['paymentMethod']>): string {
  if (!method.last4) return capitalize(method.type);
  const label = `${capitalize(method.cardBrand ?? 'card')} ending in ${method.last4}`;
  return method.expiryMonth && method.expiryYear
    ? `${label}, expires ${String(method.expiryMonth).padStart(2, '0')}/${method.expiryYear}`
    : label;
}

/** The invoices of the current subscription, each with a PDF. */
function InvoicesCard({ account }: { account: BillingAccount }) {
  const { transactions } = account;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Invoices</CardTitle>
        <CardDescription>
          Payments for your current subscription. Earlier invoices are on the billing portal.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {transactions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="billing-invoices">
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>
                    <span className="sr-only">Download</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transactions.map((transaction) => {
                  const status = TRANSACTION_STATUS_LABELS[transaction.status];
                  return (
                    <TableRow key={transaction.id}>
                      <TableCell className="whitespace-nowrap">
                        {transaction.billedAt ? formatBillingDate(transaction.billedAt) : '—'}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {transaction.invoiceNumber ?? '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(transaction)}
                      </TableCell>
                      <TableCell className="text-right">
                        {transaction.invoiceNumber ? (
                          <InvoiceDownloadButton
                            transactionId={transaction.id}
                            invoiceNumber={transaction.invoiceNumber}
                          />
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
