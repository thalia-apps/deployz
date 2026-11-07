'use client';

import { ArrowLeft, Eye } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { DeploymentStatusBadge } from '@/components/deployment-status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiRequestError, errorMessage } from '@/lib/api-client';
import {
  fetchAdminVendor,
  reconcileVendorBillingAdmin,
  startSupportSession,
  updateIncludedDeploymentsAdmin,
  type AdminVendorDetail,
} from '@/lib/admin';
import { previewIncludedDeploymentsChange } from '@/lib/admin-billing';
import {
  adminEventTypeLabel,
  analysisStatusLabel,
  compatibilityStatusLabel,
} from '@/lib/admin-vocabulary';
import { eventTypeLabel, RELAY_STATUS_LABEL } from '@/lib/deployment-vocabulary';
import { RELEASE_STATUS_BADGE, RELEASE_STATUS_LABEL } from '@/lib/releases';
import { formatReleaseVersion } from '@/lib/release-version';
import { subscriptionStatusLabel } from '@/lib/organization-vocabulary';
import { relativeTime } from '@/lib/diagnostics';

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string; notFound: boolean }
  | { status: 'loaded'; detail: AdminVendorDetail };

/** admin.* events use their own vocabulary (audit actions); every other
 *  event type reuses the shared §65 fleet vocabulary. */
function activityLabel(eventType: string): string {
  return eventType.startsWith('admin.') ? adminEventTypeLabel(eventType) : eventTypeLabel(eventType);
}

// The 360° support view: identity, owner, applications, deployments,
// connections, and recent activity for one vendor — the jumping-off point
// for "View as Vendor" and every deployment/job/connection deep link.
export default function AdminVendorDetailPage() {
  const params = useParams();
  const id = Array.isArray(params.id) ? (params.id[0] ?? '') : (params.id ?? '');
  const [state, setState] = useState<DetailState>({ status: 'loading' });

  const load = useCallback(async (): Promise<void> => {
    setState((current) => (current.status === 'loaded' ? current : { status: 'loading' }));
    try {
      const detail = await fetchAdminVendor(id);
      setState({ status: 'loaded', detail });
    } catch (caught) {
      const notFound = caught instanceof ApiRequestError && caught.code === 'NOT_FOUND';
      setState({
        status: 'error',
        notFound,
        message: notFound
          ? "This vendor doesn't exist."
          : errorMessage(caught),
      });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2 self-start">
        <Link href="/admin/vendors">
          <ArrowLeft aria-hidden className="size-4" />
          Vendors
        </Link>
      </Button>

      {state.status === 'loading' ? <DetailSkeleton /> : null}
      {state.status === 'error' ? (
        <section
          aria-labelledby="vendor-error"
          className="rounded-xl border border-dashed px-6 py-16 text-center"
        >
          <h2 id="vendor-error" className="text-lg font-semibold">
            {state.notFound ? 'Vendor not found' : 'Something went wrong'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
          {!state.notFound ? (
            <Button variant="outline" className="mt-4" onClick={() => void load()}>
              Try again
            </Button>
          ) : null}
        </section>
      ) : null}
      {state.status === 'loaded' ? <VendorDetailBody detail={state.detail} onReload={() => void load()} /> : null}
    </div>
  );
}

function VendorDetailBody({ detail, onReload }: { detail: AdminVendorDetail; onReload: () => void }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const owner = detail.members.find((member) => member.role === 'owner') ?? null;

  async function onViewAsVendor(): Promise<void> {
    setPending(true);
    try {
      await startSupportSession(detail.organization.id);
      toast.success(`Viewing as ${detail.organization.name}`);
      router.push('/dashboard');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{detail.organization.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{detail.organization.slug}</p>
        </div>
        <Button
          data-testid="view-as-vendor"
          loading={pending}
          loadingText="Starting support session…"
          onClick={() => void onViewAsVendor()}
        >
          <Eye aria-hidden />
          View as Vendor
        </Button>
      </div>

      <section aria-labelledby="account" className="flex flex-col gap-3">
        <h2 id="account" className="text-base font-semibold">
          Account
        </h2>
        <Card>
          <CardContent className="flex flex-col gap-3 py-4">
            <MetaRow label="Organization ID" value={detail.organization.id} />
            <MetaRow label="Owner" value={owner ? `${owner.name} (${owner.email})` : 'No owner found'} />
            <MetaRow label="Billing" value={subscriptionStatusLabel(detail.organization.subscriptionStatus)} />
            <MetaRow
              label="Created"
              value={new Date(detail.organization.createdAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            />
            <MetaRow label="Members" value={String(detail.members.length)} />
          </CardContent>
        </Card>
      </section>

      {/* Phase 14: a reconcile changes the facts on screen — re-run the
          page's own loader rather than track a second piece of state. */}
      <VendorBillingSection detail={detail} onReconciled={onReload} />

      <section aria-labelledby="applications" className="flex flex-col gap-3">
        <h2 id="applications" className="text-base font-semibold">
          Applications
        </h2>
        {detail.applications.length === 0 ? (
          <p className="text-sm text-muted-foreground">No applications yet.</p>
        ) : (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table data-testid="vendor-applications-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Application</TableHead>
                    <TableHead>Repository</TableHead>
                    <TableHead>Analysis</TableHead>
                    <TableHead>Latest release</TableHead>
                    <TableHead>Deployments</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.applications.map((app) => (
                    <TableRow key={app.id}>
                      <TableCell className="font-medium">{app.name}</TableCell>
                      <TableCell className="text-muted-foreground">{app.repoFullName}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {analysisStatusLabel(app.analysisStatus)}
                        {app.compatibilityStatus ? ` · ${compatibilityStatusLabel(app.compatibilityStatus)}` : ''}
                      </TableCell>
                      <TableCell>
                        {app.latestRelease ? (
                          <Badge variant={RELEASE_STATUS_BADGE[app.latestRelease.releaseStatus]}>
                            {formatReleaseVersion(app.latestRelease.version)} ·{' '}
                            {RELEASE_STATUS_LABEL[app.latestRelease.releaseStatus]}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">No releases</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {app.deploymentCount}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </section>

      <section aria-labelledby="deployments" className="flex flex-col gap-3">
        <h2 id="deployments" className="text-base font-semibold">
          Deployments
        </h2>
        {detail.deployments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No deployments yet.</p>
        ) : (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table data-testid="vendor-deployments-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Application</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Region</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.deployments.map((deployment) => (
                    <TableRow key={deployment.id}>
                      <TableCell>
                        <Link
                          href={`/admin/deployments/${deployment.id}`}
                          className="font-medium hover:underline"
                        >
                          {deployment.customerName}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{deployment.applicationName}</TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {deployment.version ?? '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{deployment.region}</TableCell>
                      <TableCell>
                        <DeploymentStatusBadge state={deployment.state} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {relativeTime(deployment.updatedAt) ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </section>

      <section aria-labelledby="connections" className="flex flex-col gap-3">
        <h2 id="connections" className="text-base font-semibold">
          AWS Connections
        </h2>
        {detail.connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No AWS connections yet.</p>
        ) : (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table data-testid="vendor-connections-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>AWS account</TableHead>
                    <TableHead>Region</TableHead>
                    <TableHead>Relay</TableHead>
                    <TableHead>Last check-in</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.connections.map((connection) => (
                    <TableRow key={connection.deploymentId}>
                      <TableCell>
                        <Link
                          href={`/admin/connections/${connection.deploymentId}`}
                          className="font-medium hover:underline"
                        >
                          {connection.customerName}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {connection.awsAccountId ?? '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{connection.region}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {RELAY_STATUS_LABEL[connection.relayStatus]}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {relativeTime(connection.lastHealthAt) ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </section>

      <section aria-labelledby="activity" className="flex flex-col gap-3">
        <h2 id="activity" className="text-base font-semibold">
          Recent activity
        </h2>
        {detail.recentEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity yet.</p>
        ) : (
          <Card>
            <CardContent className="flex flex-col gap-2 py-4">
              {detail.recentEvents.map((event) => (
                <div
                  key={event.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 text-sm last:border-b-0 last:pb-0"
                >
                  <span>{activityLabel(event.eventType)}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(event.occurredAt).toLocaleString(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </section>
    </>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-testid="vendor-detail-loading" aria-busy="true">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-32 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}


// Paddle migration Phase 14 — the billing facts an admin needs to settle a
// "why was I billed for N?" question, and the one action that fixes drift.
// The live count is Deployz's number; the provider column is what Polar had
// on the last pass. Reconcile runs the SAME code the safety job runs.
function VendorBillingSection({
  detail,
  onReconciled,
}: {
  detail: AdminVendorDetail;
  onReconciled: () => void;
}) {
  const [pending, setPending] = useState(false);

  async function onReconcile(): Promise<void> {
    setPending(true);
    try {
      const result = await reconcileVendorBillingAdmin(detail.organization.id);
      if (result.status === 'SUCCEEDED') {
        toast.success(
          result.action === 'NONE'
            ? `Already in sync — ${result.expected} live deployment${result.expected === 1 ? '' : 's'}.`
            : `Reconciled — Polar now billing ${result.expected} live deployment${result.expected === 1 ? '' : 's'} (was ${result.provider ?? 0}).`,
        );
      } else {
        toast.error(`Reconciliation ${result.status.toLowerCase()}: ${result.reason ?? 'no reason recorded'}`);
      }
      onReconciled();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  const { billing } = detail;
  const fmt = (value: string | null) =>
    value ? new Date(value).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

  // Included production deployments — the admin-set pooled allowance
  // (see AdminVendorBilling.includedProductionDeployments). Kept in sync
  // with the loaded value; onReconciled() reloads detail after a save, so
  // this effect also picks up the post-save value without extra local state.
  const [includedInput, setIncludedInput] = useState(String(billing.includedProductionDeployments));
  const [includedReason, setIncludedReason] = useState('');
  const [includedDialogOpen, setIncludedDialogOpen] = useState(false);
  const [includedPending, setIncludedPending] = useState(false);

  useEffect(() => {
    setIncludedInput(String(billing.includedProductionDeployments));
  }, [billing.includedProductionDeployments]);

  const parsedIncluded = Number(includedInput);
  const isValidIncluded =
    includedInput.trim() !== '' && Number.isInteger(parsedIncluded) && parsedIncluded >= 0 && parsedIncluded <= 10000;
  const includedUnchanged = isValidIncluded && parsedIncluded === billing.includedProductionDeployments;
  const canSubmitIncluded = isValidIncluded && !includedUnchanged && includedReason.trim() !== '';
  const includedPreview = isValidIncluded
    ? previewIncludedDeploymentsChange({
        activeProductionDeployments: billing.activeProductionDeployments,
        currentIncluded: billing.includedProductionDeployments,
        nextIncluded: parsedIncluded,
      })
    : null;

  async function onConfirmIncludedUpdate(): Promise<void> {
    if (!canSubmitIncluded) return;
    setIncludedPending(true);
    try {
      const result = await updateIncludedDeploymentsAdmin(
        detail.organization.id,
        parsedIncluded,
        includedReason.trim(),
      );
      if (result.reconciliation === null) {
        toast.success('Allowance updated — nothing to reconcile yet.');
      } else if (result.reconciliation.status === 'SUCCEEDED') {
        toast.success(
          `Allowance updated — Polar now billing ${result.reconciliation.expected} deployment${result.reconciliation.expected === 1 ? '' : 's'}.`,
        );
      } else if (result.reconciliation.status === 'FAILED') {
        toast.error(
          `Allowance saved, but Polar could not be updated: ${result.reconciliation.reason ?? 'no reason recorded'}. Use Reconcile with Polar to retry.`,
        );
      } else {
        toast.success(`Allowance saved — reconciliation skipped: ${result.reconciliation.reason ?? 'no reason recorded'}.`);
      }
      setIncludedReason('');
      setIncludedDialogOpen(false);
      onReconciled();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setIncludedPending(false);
    }
  }

  return (
    <section aria-labelledby="billing" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="billing" className="text-base font-semibold">
          Billing
        </h2>
        {billing.subscription ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            loading={pending}
            loadingText="Reconciling billing…"
            onClick={() => void onReconcile()}
            data-testid="admin-reconcile-billing"
          >
            Reconcile with Polar
          </Button>
        ) : null}
      </div>
      <Card>
        <CardContent className="flex flex-col gap-3 py-4">
          <MetaRow label="Status" value={subscriptionStatusLabel(detail.organization.subscriptionStatus)} />
          <MetaRow label="Active production deployments" value={String(billing.activeProductionDeployments)} />
          <MetaRow label="Included deployments" value={String(billing.includedProductionDeployments)} />
          <MetaRow label="Billable deployment quantity" value={String(billing.billableDeploymentQuantity)} />
          {billing.providerDeploymentQuantity !== null ? (
            <MetaRow
              label="Polar unit count"
              value={`${billing.providerDeploymentQuantity} (as of ${fmt(billing.providerQuantityAsOf)})`}
            />
          ) : null}
          {billing.monthlyRateDollars !== null ? (
            <MetaRow label="Current monthly rate" value={`$${billing.monthlyRateDollars}`} />
          ) : null}
          {billing.subscription ? (
            <>
              <MetaRow label="Subscription" value={billing.subscription.providerSubscriptionId} />
              <MetaRow label="Next billed" value={fmt(billing.subscription.currentPeriodEnd)} />
              <MetaRow label="Last reconciled" value={fmt(billing.subscription.lastReconciledAt)} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Evaluating — no subscription, nothing to reconcile.</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 py-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="included-deployments-input">Included production deployments</Label>
            <Input
              id="included-deployments-input"
              type="number"
              min={0}
              max={10000}
              step={1}
              value={includedInput}
              onChange={(event) => setIncludedInput(event.target.value)}
              className="w-28"
              data-testid="admin-included-deployments-input"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="included-deployments-reason">Reason</Label>
            <Input
              id="included-deployments-reason"
              value={includedReason}
              onChange={(event) => setIncludedReason(event.target.value)}
              placeholder="Why is the allowance changing?"
              className="w-64"
              data-testid="admin-included-deployments-reason"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canSubmitIncluded}
            onClick={() => setIncludedDialogOpen(true)}
            data-testid="admin-included-deployments-submit"
          >
            Update allowance
          </Button>
        </CardContent>
      </Card>
      <Dialog
        open={includedDialogOpen}
        onOpenChange={(next) => (next || includedPending ? undefined : setIncludedDialogOpen(false))}
      >
        <DialogContent data-testid="admin-included-deployments-dialog" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Update included deployments?</DialogTitle>
            <DialogDescription>
              {includedPreview?.direction === 'decrease'
                ? "This may increase the vendor's next invoice."
                : "This may reduce the vendor's next invoice."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Included deployments</span>
              <span className="font-medium tabular-nums">
                {billing.includedProductionDeployments} → {isValidIncluded ? parsedIncluded : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Billable deployments</span>
              <span className="font-medium tabular-nums">
                {includedPreview?.previousBillable ?? '—'} → {includedPreview?.nextBillable ?? '—'}
              </span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            The $49/month platform fee is unaffected. This changes the production deployment
            quantity only. Invoice adjustments and proration are handled by Polar.
          </p>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Reason</span>
            <p className="text-sm">{includedReason}</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" disabled={includedPending} onClick={() => setIncludedDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant={includedPreview?.direction === 'decrease' ? 'destructive' : 'default'}
              loading={includedPending}
              loadingText="Updating allowance…"
              onClick={() => void onConfirmIncludedUpdate()}
              data-testid="admin-included-deployments-confirm"
            >
              Update allowance
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {billing.recentReconciliations.length > 0 ? (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table data-testid="vendor-reconciliations-table">
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Expected</TableHead>
                  <TableHead>Polar had</TableHead>
                  <TableHead>Outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {billing.recentReconciliations.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-muted-foreground">{fmt(row.createdAt)}</TableCell>
                    <TableCell>{row.action}</TableCell>
                    <TableCell className="tabular-nums">{row.expected}</TableCell>
                    <TableCell className="tabular-nums">{row.provider ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant={row.status === 'SUCCEEDED' ? 'secondary' : 'destructive'}>
                        {row.status}
                      </Badge>
                      {row.error ? <span className="ml-2 text-xs text-muted-foreground">{row.error}</span> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
