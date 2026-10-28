import { AlertTriangle, CreditCard, Receipt } from 'lucide-react';

import { DocsLink } from '@/components/docs-link';
import { InvoiceDownloadButton } from '@/components/invoice-download-button';
import { ManageBillingButton } from '@/components/manage-billing-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
  fetchBillingSummary,
  formatBillingDate,
  formatDollars,
  formatMoney,
  type BillingAccount,
  type BillingAccountResult,
  type BillingSummary,
} from '@/lib/billing';
import { DOCS } from '@/lib/docs-links';
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
// The next payment, the payment method and the invoices are read live from
// the billing provider, and only for an owner or admin. The provider owns
// the money, so its numbers (with tax and proration) are the ones shown
// there; changes still happen on the provider's portal.
//
// §65: jargon-free. The provider is never named at the top level.
export default async function BillingPage() {
  const billing = await fetchBillingSummary();
  const account = billing.subscription ? await fetchBillingAccount() : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <DocsLink href={DOCS.billing}>How pricing and billing work</DocsLink>
      </div>

      {billing.subscription ? (
        <SubscribedCard billing={billing} account={account!} />
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
function SubscribedCard({
  billing,
  account,
}: {
  billing: BillingSummary;
  account: BillingAccountResult;
}) {
  const subscription = billing.subscription!;
  const counts = billing.productionDeployments;
  const nextBillingDate = subscription.currentPeriodEnd
    ? formatBillingDate(subscription.currentPeriodEnd)
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

      {account.status === 'forbidden' ? (
        <Card>
          <CardHeader>
            <CardTitle>Payments and invoices</CardTitle>
            <CardDescription>
              Only an owner or admin can see payments and invoices, or manage billing.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          {account.status === 'ok' ? <AccountDetails account={account.account} /> : null}
          {account.status === 'unavailable' ? (
            <Alert data-testid="billing-account-unavailable">
              <AlertTriangle aria-hidden className="size-4" />
              <AlertTitle>Payment details and invoices could not be loaded</AlertTitle>
              <AlertDescription>
                Reload the page to try again. You can also open the billing portal below.
              </AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Manage billing</CardTitle>
              <CardDescription>
                Change your payment details, billing address or subscription on our billing
                partner’s portal.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3">
              <ManageBillingButton target="overview" variant="default">
                Open billing portal
              </ManageBillingButton>
              {account.status === 'ok' ? null : (
                <ManageBillingButton target="updatePaymentMethod">
                  Update payment details
                </ManageBillingButton>
              )}
              {account.status === 'ok' &&
              account.account.scheduledChange?.action === 'cancel' ? null : (
                <ManageBillingButton target="cancel" variant="ghost">
                  Cancel subscription
                </ManageBillingButton>
              )}
            </CardContent>
          </Card>
        </>
      )}

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

/** What the billing provider holds: next payment, payment method, invoices. */
function AccountDetails({ account }: { account: BillingAccount }) {
  const { nextPayment, scheduledChange, paymentMethod, transactions } = account;
  return (
    <>
      {scheduledChange ? (
        <Alert data-testid="billing-scheduled-change">
          <AlertTriangle aria-hidden className="size-4" />
          <AlertTitle>
            {scheduledChange.action === 'cancel'
              ? `Your subscription ends on ${formatBillingDate(scheduledChange.effectiveAt)}`
              : `Your subscription is scheduled to ${scheduledChange.action} on ${formatBillingDate(scheduledChange.effectiveAt)}`}
          </AlertTitle>
          <AlertDescription>
            Existing deployments keep running. To keep your subscription, open the billing portal.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Next payment</CardTitle>
            <CardDescription>
              {nextPayment
                ? `${formatBillingDate(nextPayment.date)} · includes tax and changes made this period`
                : 'No payment is scheduled.'}
            </CardDescription>
          </CardHeader>
          {nextPayment ? (
            <CardContent className="flex flex-col gap-2 text-sm" data-testid="billing-next-payment">
              {nextPayment.lines.map((line, index) => (
                <div
                  key={`${line.description}-${index}`}
                  className="flex items-center justify-between gap-3"
                >
                  <span>
                    {line.description}
                    {line.quantity > 1 ? (
                      <span className="text-muted-foreground"> × {line.quantity}</span>
                    ) : null}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{formatMoney(line)}</span>
                </div>
              ))}
              <Separator />
              <div className="flex items-center justify-between font-semibold">
                <span>Total</span>
                <span className="tabular-nums">{formatMoney(nextPayment)}</span>
              </div>
            </CardContent>
          ) : null}
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CreditCard className="size-5 text-muted-foreground" aria-hidden />
              <CardTitle>Payment method</CardTitle>
            </div>
            <CardDescription data-testid="billing-payment-method">
              {paymentMethod ? paymentMethodLabel(paymentMethod) : 'No payment method on file yet.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ManageBillingButton target="updatePaymentMethod">
              Update payment details
            </ManageBillingButton>
          </CardContent>
        </Card>
      </div>

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
    </>
  );
}
