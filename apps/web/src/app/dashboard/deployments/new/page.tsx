'use client';

import { ArrowLeft, Check, CheckCircle2, CircleAlert, CircleX, Copy, ExternalLink, PackageX } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';

import { allowedSizeTiers, type InfrastructureSizeTier } from '@deployz/contracts';

import { copyInstallLink } from '@/components/copy-install-link';
import { CustomerPicker } from '@/components/customer-picker';
import { DocsLink } from '@/components/docs-link';
import { ManageBillingButton } from '@/components/manage-billing-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { ApiRequestError, errorMessage } from '@/lib/api-client';
import {
  defaultInviteApplication,
  fetchApplications,
  inviteApplicationLabel,
  type Application,
} from '@/lib/applications';
import {
  createCheckoutIntent,
  fetchBillingConfig,
  fetchSubscriptionStatus,
  openSubscriptionCheckout,
} from '@/lib/billing-checkout';
import type { SubscriptionStatus } from '@/lib/organization-vocabulary';
import {
  createCustomerRecord,
  createDeploymentErrorMessage,
  createDeploymentRecord,
  existingTestDeploymentId,
  matchesRememberedCustomer,
  readinessFindingMessages,
  type RememberedCustomer,
} from '@/lib/deployments';
import {
  createInvitation,
  fetchCustomers,
  initialCustomerSelection,
  matchingCustomerByEmail,
  NEW_CUSTOMER_VALUE,
  type Customer,
} from '@/lib/customers';
import { DOCS } from '@/lib/docs-links';
import { fetchApplicationPreflight, type PreflightResult } from '@/lib/preflight';
import { fetchRegions, type RegionOption } from '@/lib/regions';
import { sizeTierCompute, sizeTierLabel } from '@/lib/size-tiers';
import {
  BuildConfigurationMissingError,
  createRelease,
  fetchReleases,
  firstReleaseInput,
  installReleaseState,
  type InstallReleaseState,
} from '@/lib/releases';
import { TONE_TEXT } from '@/lib/status-tone';
import { cn } from '@/lib/utils';
import { PreflightSummary } from '@/components/preflight-summary';

/** Readiness rejection codes the "Review the application's readiness
 *  findings" link applies to (§19) — every other error is shown as plain
 *  text with no link. */
const READINESS_ERROR_CODES = new Set(['MANIFEST_NOT_COMPATIBLE', 'MANIFEST_NEEDS_CONFIGURATION']);

// §12/§41 screen 12 "Create installation" — the invitation-first model: the
// vendor picks a customer (creating one when needed) and an application, and
// may RECOMMEND an AWS region. No deployment exists yet — the customer opens
// the one-time installation link, chooses the final region, and confirms;
// only that confirmation creates the deployment (and only then is billing
// checked). A `?test=true` deployment stays the vendor's own free test: it
// is created directly with a vendor-chosen region because no customer is
// involved.
//
// Region options come from GET /api/regions (never hardcoded here): the
// control plane serves only regions whose regional bootstrap artifacts are
// confirmed published, so the UI cannot offer a region that would fail to
// install.

const selectClass =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 md:text-sm dark:bg-input/30';

export default function NewDeploymentPage() {
  return (
    <Suspense fallback={null}>
      <NewDeploymentScreen />
    </Suspense>
  );
}

type AppsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'empty' }
  | { status: 'loaded'; applications: Application[] };

type CustomersState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'loaded'; customers: Customer[] };

function NewDeploymentScreen() {
  const searchParams = useSearchParams();
  const preselectedApplicationId = searchParams.get('applicationId');
  const preselectedCustomerId = searchParams.get('customerId');
  const isTestDeployment = searchParams.get('test') === 'true';

  const [appsState, setAppsState] = useState<AppsState>({ status: 'loading' });
  const [customersState, setCustomersState] = useState<CustomersState>({ status: 'loading' });
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>(NEW_CUSTOMER_VALUE);
  const [customerSelectionInitialized, setCustomerSelectionInitialized] = useState(false);
  const [customerEmailInput, setCustomerEmailInput] = useState('');
  // Guards a duplicate submit fired before React re-renders the disabled
  // submit button — `pending` state alone lags one tick behind a fast second
  // click.
  const submittingRef = useRef(false);
  const [regions, setRegions] = useState<RegionOption[]>([]);
  const [regionsError, setRegionsError] = useState(false);
  // Test mode only: the created deployment's install link.
  const [installLink, setInstallLink] = useState<{ url: string; deploymentId: string } | null>(null);
  // Customer mode: the created invitation's one-time reveal — the URL carries
  // the token as its fragment, plus the token shown separately.
  const [invitation, setInvitation] = useState<{ url: string; token: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdCustomerId, setCreatedCustomerId] = useState<string | null>(null);
  const [createdApplicationId, setCreatedApplicationId] = useState<string | null>(null);
  // The customer created by an earlier failed attempt (§12) — reused on
  // retry instead of inserting a duplicate customer row (CANARY-004).
  const [rememberedCustomer, setRememberedCustomer] = useState<RememberedCustomer | null>(null);
  // Set only for a readiness rejection, so the error can link to the
  // application's readiness findings.
  const [readinessApplicationId, setReadinessApplicationId] = useState<string | null>(null);
  const [readinessFindings, setReadinessFindings] = useState<string[]>([]);
  // Set only for a TEST_DEPLOYMENT_EXISTS conflict, so the error can link to
  // the application's existing test deployment (Paddle migration Phase 7).
  const [conflictingTestDeploymentId, setConflictingTestDeploymentId] = useState<string | null>(null);
  const [selectedApplicationId, setSelectedApplicationId] = useState<string | null>(preselectedApplicationId);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [preflightError, setPreflightError] = useState(false);
  // Null while no application is selected.
  const [releaseState, setReleaseState] = useState<ReleaseCheck | null>(null);
  // Customer mode: the vendor's subscription status. An evaluation or
  // canceled vendor needs a self-serve way to start a subscription before
  // customers can confirm installations; past-due/paused vendors need the
  // portal instead. Test mode never hits this (test deployments are free).
  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null | undefined>(undefined);
  const [checkoutState, setCheckoutState] = useState<'idle' | 'opening' | 'paid'>('idle');
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const applications = await fetchApplications();
        if (cancelled) return;
        setAppsState(
          applications.length === 0 ? { status: 'empty' } : { status: 'loaded', applications },
        );
      } catch {
        if (!cancelled) setAppsState({ status: 'error' });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const customers = await fetchCustomers();
        if (!cancelled) setCustomersState({ status: 'loaded', customers });
      } catch {
        // The new-customer path still works without the list.
        if (!cancelled) setCustomersState({ status: 'error' });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // The customer list decides the default selection: the `?customerId=` from
  // the URL when it names a real customer, else "create new" — set once, the
  // same pattern as the application default below.
  useEffect(() => {
    if (customersState.status !== 'loaded' || customerSelectionInitialized) return;
    setSelectedCustomerId(initialCustomerSelection(customersState.customers, preselectedCustomerId));
    setCustomerSelectionInitialized(true);
  }, [customersState, customerSelectionInitialized, preselectedCustomerId]);

  // The applications list decides the default selection; the preflight
  // follows whichever application is selected.
  useEffect(() => {
    if (appsState.status !== 'loaded' || selectedApplicationId !== null) return;
    setSelectedApplicationId(defaultInviteApplication(appsState.applications)?.id ?? null);
  }, [appsState, selectedApplicationId]);

  // An existing customer's own saved values count, exactly as deployment
  // creation evaluates them; a new customer has only the vendor defaults.
  useEffect(() => {
    if (!selectedApplicationId) return;
    let cancelled = false;
    setPreflight(null);
    setPreflightError(false);
    fetchApplicationPreflight(
      selectedApplicationId,
      selectedCustomerId !== NEW_CUSTOMER_VALUE ? selectedCustomerId : undefined,
    )
      .then((result) => {
        if (!cancelled) setPreflight(result);
      })
      .catch(() => {
        // The form still works without the preview; the API enforces the gate.
        if (!cancelled) setPreflightError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedApplicationId, selectedCustomerId]);

  // Customer mode: fetch the vendor's subscription status so the page can
  // show the self-serve subscription entry (evaluation/canceled) or the
  // portal link (past-due/paused). Test mode skips this (free deployments).
  useEffect(() => {
    if (isTestDeployment) return;
    let cancelled = false;
    fetchSubscriptionStatus()
      .then((status) => {
        if (!cancelled) setSubscriptionStatus(status);
      })
      .catch(() => {
        // The page still works without the notice; the API enforces the gate.
      });
    return () => {
      cancelled = true;
    };
  }, [isTestDeployment]);

  // Region options come from the control plane so only confirmed-deployable
  // regions are ever offered. A failure to load them is a hard error — a form
  // that defaulted to a stale hardcoded region would let the vendor create a
  // deployment in a region that cannot install.
  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const options = await fetchRegions();
        if (cancelled) return;
        setRegions(options);
        setRegionsError(false);
      } catch {
        if (!cancelled) setRegionsError(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // A `?customerId=` preselection is not known until the list loads. The
  // new-customer inputs stay hidden until then, so they do not flash.
  const awaitingPreselection =
    preselectedCustomerId !== null && customersState.status === 'loading';
  const usingExistingCustomer = selectedCustomerId !== NEW_CUSTOMER_VALUE;
  const selectedApplication =
    appsState.status === 'loaded'
      ? appsState.applications.find((app) => app.id === selectedApplicationId)
      : undefined;
  const duplicateCustomer =
    !usingExistingCustomer && customersState.status === 'loaded'
      ? matchingCustomerByEmail(customersState.customers, customerEmailInput)
      : null;

  // A test deployment is created only when its preflight passes — the API
  // runs the same gate. An invitation is not gated here: the customer
  // supplies their own values before they confirm.
  const preflightLoading = selectedApplicationId !== null && preflight === null && !preflightError;
  const preflightBlocked = isTestDeployment && preflight !== null && !preflight.ready;
  const submitHint = preflightBlocked
    ? 'Fix the issues above to continue'
    : releaseState?.kind === 'none'
      ? 'Available after a release is built'
      : releaseState?.kind === 'building'
        ? 'Available when the build completes'
        : (isTestDeployment && preflightLoading) || releaseState?.kind === 'loading'
          ? 'Available when checks complete'
          : null;

  // A submit error describes the previous selection; a new selection clears it.
  function clearSubmitError(): void {
    setError(null);
    setReadinessApplicationId(null);
    setReadinessFindings([]);
    setConflictingTestDeploymentId(null);
  }

  function selectCustomer(customerId: string): void {
    clearSubmitError();
    setSelectedCustomerId(customerId);
  }

  function resetCustomerSelection(): void {
    setSelectedCustomerId(
      initialCustomerSelection(
        customersState.status === 'loaded' ? customersState.customers : [],
        preselectedCustomerId,
      ),
    );
    setCustomerEmailInput('');
  }

  // Customer mode: a subscribe-only checkout intent (no parked deployment)
  // opens Paddle's overlay; when the vendor pays, the webhook activates the
  // subscription and customers can then confirm their invitations.
  async function onStartSubscription(): Promise<void> {
    setCheckoutError(null);
    setCheckoutState('opening');
    try {
      const config = await fetchBillingConfig();
      const intent = await createCheckoutIntent({});
      const outcome = await openSubscriptionCheckout(config, intent.transactionId);
      setCheckoutState(outcome === 'completed' ? 'paid' : 'idle');
    } catch (caught) {
      setCheckoutError(errorMessage(caught));
      setCheckoutState('idle');
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // A second submit while the first is still in flight must do nothing —
    // `pending` alone can lag a tick behind a fast double click.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setError(null);
    setReadinessApplicationId(null);
    setReadinessFindings([]);
    setConflictingTestDeploymentId(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const customerName = String(form.get('customerName') ?? '').trim();
    const customerEmail = String(form.get('customerEmail') ?? '').trim();
    const customerCompany = String(form.get('customerCompany') ?? '').trim();
    const applicationId = String(form.get('application') ?? '');
    const region = String(form.get('region') ?? '');
    const size = String(form.get('size') ?? '') as InfrastructureSizeTier | '';

    let customerId: string | null = null;
    try {
      if (usingExistingCustomer) {
        // The vendor picked a customer that already exists — never create a
        // second row for them.
        customerId = selectedCustomerId;
      } else if (matchesRememberedCustomer(rememberedCustomer, customerName, customerEmail)) {
        // A prior failed attempt may already have created this customer —
        // reuse it rather than inserting a duplicate (CANARY-004).
        customerId = rememberedCustomer.id;
      } else {
        const customer = await createCustomerRecord({
          name: customerName,
          email: customerEmail,
          company: customerCompany || null,
        });
        customerId = customer.id;
        // "Create another" must offer this customer in the picker.
        setCustomersState((current) =>
          current.status === 'loaded'
            ? {
                status: 'loaded',
                customers: [...current.customers, { ...customer, updatedAt: customer.createdAt }],
              }
            : current,
        );
        setRememberedCustomer({ id: customer.id, name: customerName, email: customerEmail });
      }
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      if (isTestDeployment) {
        // The vendor's own free test: created directly with the chosen region.
        const deployment = await createDeploymentRecord({
          applicationId,
          customerId,
          region: region || regions[0]?.value || '',
          deploymentType: 'TEST',
          ...(size !== '' ? { sizeProfile: size } : {}),
        });
        setCreatedCustomerId(customerId);
        setCreatedApplicationId(applicationId);
        setInstallLink({
          url: `${origin}/install/${deployment.installLinkId}#${deployment.installLinkToken}`,
          deploymentId: deployment.id,
        });
      } else {
        // The invitation-first path: no deployment row and no entitlement
        // use here — the customer confirms later, and billing is checked at
        // that confirmation, not before.
        const created = await createInvitation({
          customerId,
          applicationId,
          ...(region !== '' ? { recommendedRegion: region } : {}),
          ...(size !== '' ? { recommendedSizeProfile: size } : {}),
        });
        setCreatedCustomerId(customerId);
        setCreatedApplicationId(applicationId);
        // One shareable URL: the one-time token rides as its fragment.
        setInvitation({
          url: `${origin}/install/${created.id}#${created.token}`,
          token: created.token,
        });
      }
    } catch (caught) {
      setError(createDeploymentErrorMessage(caught));
      if (caught instanceof ApiRequestError && READINESS_ERROR_CODES.has(caught.code)) {
        setReadinessApplicationId(applicationId);
        setReadinessFindings(readinessFindingMessages(caught.details));
      }
      setConflictingTestDeploymentId(existingTestDeploymentId(caught));
    } finally {
      setPending(false);
      submittingRef.current = false;
    }
  }

  return (
    <div className="flex w-full max-w-240 flex-col gap-6">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/dashboard/deployments">
            <ArrowLeft aria-hidden className="size-4" />
            Deployments
          </Link>
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {isTestDeployment ? 'Create test deployment' : 'Invite customer'}
        </h1>
        {isTestDeployment ? null : (
          <p className="mt-1 text-sm text-muted-foreground">
            The customer picks the AWS region and confirms. A deployment is created only after they confirm.
          </p>
        )}
        <DocsLink href={isTestDeployment ? DOCS.testDeployment : DOCS.invitations} className="mt-1">
          {isTestDeployment ? 'About test deployments' : 'How customer invitations work'}
        </DocsLink>
      </div>

      {/* Customer mode: an evaluation or canceled vendor needs a self-serve
          way to start a subscription before customers can confirm invitations. */}
      {!isTestDeployment && (subscriptionStatus === null || subscriptionStatus === 'CANCELED') ? (
        <Card>
          <CardHeader>
            <CardTitle>Start your subscription</CardTitle>
            <CardDescription>
              Customers can confirm invitations only with an active subscription. Billing starts
              with your subscription — see What it costs. Test deployments stay free.
            </CardDescription>
            <DocsLink href={DOCS.billing}>How pricing and billing work</DocsLink>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            {checkoutState === 'paid' ? (
              <p className="text-sm text-muted-foreground">
                Payment received. Customers can now confirm installations.
              </p>
            ) : (
              <Button
                onClick={() => void onStartSubscription()}
                loading={checkoutState === 'opening'}
                loadingText="Opening checkout…"
              >
                Start subscription
              </Button>
            )}
            {checkoutError ? (
              <p role="alert" className="text-sm text-destructive">
                {checkoutError}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* Customer mode: a past-due or paused vendor needs the Paddle portal
          to fix their subscription, not a new checkout. */}
      {!isTestDeployment && (subscriptionStatus === 'PAST_DUE' || subscriptionStatus === 'PAUSED') ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {subscriptionStatus === 'PAST_DUE' ? 'Update your payment details' : 'Resume your subscription'}
            </CardTitle>
            <CardDescription>
              {subscriptionStatus === 'PAST_DUE'
                ? 'Your last payment failed. Customers can confirm installations once it is resolved.'
                : 'Subscription paused. Resume it in the billing portal so customers can confirm installations.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ManageBillingButton
              target={subscriptionStatus === 'PAST_DUE' ? 'updatePaymentMethod' : 'overview'}
              variant="default"
            >
              {subscriptionStatus === 'PAST_DUE' ? 'Update payment details' : 'Open billing portal'}
            </ManageBillingButton>
          </CardContent>
        </Card>
      ) : null}

      {invitation ? (
        <InvitationLinkCard
          url={invitation.url}
          customerId={createdCustomerId}
          applicationId={createdApplicationId}
          onReset={() => {
            setInvitation(null);
            resetCustomerSelection();
          }}
        />
      ) : installLink ? (
        <InstallLinkCard
          link={installLink.url}
          deploymentId={installLink.deploymentId}
          customerId={createdCustomerId}
          applicationId={createdApplicationId}
          onReset={() => {
            setInstallLink(null);
            resetCustomerSelection();
          }}
        />
      ) : appsState.status === 'loading' ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading applications…
        </p>
      ) : appsState.status === 'empty' ? (
        <section className="rounded-xl border border-dashed px-6 py-16 text-center">
          <h2 className="text-lg font-semibold">Connect an application first</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            A deployment needs at least one application.
          </p>
          <Button asChild className="mt-4">
            <Link href="/dashboard/applications">Connect GitHub</Link>
          </Button>
        </section>
      ) : appsState.status === 'error' ? (
        <p className="text-sm text-destructive">
          Couldn&apos;t load applications. Try again.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-6">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <CustomerPicker
                customers={customersState.status === 'loaded' ? customersState.customers : []}
                value={selectedCustomerId}
                onChange={selectCustomer}
                disabled={pending}
                loading={customersState.status === 'loading'}
              />
              {customersState.status === 'error' ? (
                <p className="text-sm text-muted-foreground">
                  Couldn&apos;t load customers. You can still add a new one.
                </p>
              ) : null}
            </div>

            {usingExistingCustomer || awaitingPreselection ? null : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="customerName">Customer name</Label>
                  <Input id="customerName" name="customerName" required />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="customerEmail">Customer email</Label>
                  <Input
                    id="customerEmail"
                    name="customerEmail"
                    type="email"
                    required
                    value={customerEmailInput}
                    onChange={(event) => setCustomerEmailInput(event.currentTarget.value)}
                  />
                  {duplicateCustomer ? (
                    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                      <span>A customer with this email already exists.</span>
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="h-auto p-0"
                        onClick={() => selectCustomer(duplicateCustomer.id)}
                      >
                        Use existing customer
                      </Button>
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="customerCompany">Company (optional)</Label>
                  <Input id="customerCompany" name="customerCompany" />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-2">
                <Label htmlFor="application">Application</Label>
                <select
                  id="application"
                  name="application"
                  className={selectClass}
                  required
                  defaultValue={preselectedApplicationId ?? defaultInviteApplication(appsState.applications)?.id}
                  onChange={(event) => {
                    clearSubmitError();
                    setSelectedApplicationId(event.currentTarget.value);
                  }}
                >
                  {appsState.applications.map((app) => (
                    <option key={app.id} value={app.id}>
                      {inviteApplicationLabel(app)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <Label htmlFor="region">
                  {isTestDeployment ? 'AWS region' : 'Recommended AWS region'}
                </Label>
                {regionsError ? (
                  <p className="text-sm text-destructive">
                    Couldn&apos;t load regions. Try again.
                  </p>
                ) : regions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No regions available yet.
                  </p>
                ) : (
                  <>
                    <select
                      id="region"
                      name="region"
                      className={selectClass}
                      onChange={clearSubmitError}
                      {...(isTestDeployment ? { required: true, defaultValue: regions[0]?.value } : { defaultValue: '' })}
                    >
                      {isTestDeployment ? null : <option value="">No recommendation</option>}
                      {regions.map((region) => (
                        <option key={region.value} value={region.value}>
                          {region.label}
                        </option>
                      ))}
                    </select>
                    {isTestDeployment ? null : (
                      <p className="text-xs text-muted-foreground">
                        Optional. The customer chooses the final region.
                      </p>
                    )}
                    <DocsLink href={DOCS.regions} className="text-xs">
                      About AWS Regions
                    </DocsLink>
                  </>
                )}
              </div>
              {selectedApplication ? (
                <div className="flex min-w-0 flex-col gap-2">
                  <Label htmlFor="size">{isTestDeployment ? 'Size' : 'Recommended size'}</Label>
                  <select
                    key={selectedApplication.id}
                    id="size"
                    name="size"
                    className={selectClass}
                    defaultValue={selectedApplication.defaultSizeProfile}
                    onChange={clearSubmitError}
                  >
                    {allowedSizeTiers(selectedApplication.minimumSizeProfile).map((tier) => (
                      <option key={tier} value={tier}>
                        {sizeTierLabel(tier)} ({sizeTierCompute(tier)})
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
          </div>

          <Separator />

          <div className="flex flex-col gap-3">
            {preflight ? (
              <PreflightSummary result={preflight} />
            ) : preflightLoading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Spinner aria-hidden />
                Running deployment checks…
              </p>
            ) : preflightError ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CircleAlert aria-hidden className="size-4 shrink-0" />
                Couldn&apos;t run the checks. They run again when you deploy.
              </p>
            ) : null}

            {selectedApplication ? (
              <ReleaseRequirement
                key={selectedApplication.id}
                application={selectedApplication}
                onStateChange={setReleaseState}
              />
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button
                type="submit"
                disabled={
                  (isTestDeployment && (regionsError || regions.length === 0)) ||
                  awaitingPreselection ||
                  submitHint !== null
                }
                loading={pending}
                loadingText={isTestDeployment ? 'Creating deployment…' : 'Creating invitation…'}
                aria-describedby={submitHint ? 'submit-hint' : undefined}
              >
                {isTestDeployment ? 'Run free test deployment' : 'Invite customer'}
              </Button>
              {submitHint ? (
                <p id="submit-hint" className="text-sm text-muted-foreground">
                  {submitHint}
                </p>
              ) : null}
            </div>
            {error ? (
              <div role="alert" className="flex flex-col gap-1 text-sm text-destructive">
                <p>{error}</p>
                {readinessFindings.length > 0 ? (
                  <ul className="list-disc pl-5">
                    {readinessFindings.map((finding) => (
                      <li key={finding}>{finding}</li>
                    ))}
                  </ul>
                ) : null}
                {readinessApplicationId ? (
                  <Link
                    href={`/dashboard/applications/${readinessApplicationId}`}
                    className="underline underline-offset-4"
                  >
                    Review the application&apos;s readiness findings
                  </Link>
                ) : null}
                {conflictingTestDeploymentId ? (
                  <Link
                    href={`/dashboard/deployments/${conflictingTestDeploymentId}`}
                    className="underline underline-offset-4"
                  >
                    View the existing test deployment
                  </Link>
                ) : null}
              </div>
            ) : null}
          </div>
        </form>
      )}
    </div>
  );
}

/** How often a building release is re-checked. */
const RELEASE_POLL_MS = 10_000;

/** The release check: loading, unavailable (the releases did not load — the
 *  API stays the authority then), or the install release state. */
type ReleaseCheck = { kind: 'loading' } | { kind: 'unavailable' } | InstallReleaseState;

/**
 * The release a new deployment installs, as one status line. The install
 * runs the application's newest built release, so an application with none
 * cannot be deployed yet: say which release will run, or offer to build the
 * first one and follow the build until it is ready.
 */
function ReleaseRequirement({
  application,
  onStateChange,
}: {
  application: Application;
  onStateChange: (state: ReleaseCheck) => void;
}) {
  const [state, setState] = useState<ReleaseCheck>({ kind: 'loading' });
  const [lastFailed, setLastFailed] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [missingBuildKeys, setMissingBuildKeys] = useState<string[] | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const firstRelease = firstReleaseInput(application.detectedMetadata);
  const releasesHref = `/dashboard/applications/${application.id}/releases`;

  useEffect(() => {
    onStateChange(state);
  }, [state, onStateChange]);

  useEffect(() => {
    let cancelled = false;
    fetchReleases(application.id)
      .then((releases) => {
        if (cancelled) return;
        setState(installReleaseState(releases));
        setLastFailed(releases.some((r) => r.status === 'FAILED'));
      })
      .catch(() => {
        // Unknown is not "none": the API still refuses a deployment without a release.
        if (!cancelled) setState({ kind: 'unavailable' });
      });
    return () => {
      cancelled = true;
    };
  }, [application.id, reloadTick]);

  useEffect(() => {
    if (state.kind !== 'building') return;
    const timer = setTimeout(() => setReloadTick((tick) => tick + 1), RELEASE_POLL_MS);
    return () => clearTimeout(timer);
  }, [state]);

  async function onBuild(): Promise<void> {
    setBuilding(true);
    setBuildError(null);
    setMissingBuildKeys(null);
    try {
      const existing = await fetchReleases(application.id);
      const input = firstReleaseInput(
        application.detectedMetadata,
        existing.map((r) => r.version),
      );
      if (!input) return;
      const release = await createRelease(application.id, input);
      setState(installReleaseState([release]));
    } catch (err) {
      if (err instanceof BuildConfigurationMissingError) {
        setMissingBuildKeys(err.keys);
      } else {
        setBuildError(errorMessage(err, "Couldn't start the build. Try again or use the Releases page."));
      }
    } finally {
      setBuilding(false);
    }
  }

  if (state.kind === 'loading') {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Spinner aria-hidden />
        Checking the release…
      </p>
    );
  }

  if (state.kind === 'unavailable') {
    return (
      <div className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground" data-testid="install-release-unavailable">
        <p className="flex items-center gap-2">
          <CircleAlert aria-hidden className="size-4 shrink-0" />
          Couldn&apos;t check the release. It is checked again when you deploy.
        </p>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0"
          onClick={() => {
            setState({ kind: 'loading' });
            setReloadTick((tick) => tick + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  if (state.kind === 'ready') {
    return (
      <p className="flex items-center gap-2 text-sm" data-testid="install-release">
        <Check aria-hidden className={cn('size-4 shrink-0', TONE_TEXT.positive)} />
        Release {state.release.version} is ready
      </p>
    );
  }

  if (state.kind === 'building') {
    return (
      <p className="flex items-center gap-2 text-sm" role="status" data-testid="install-release-building">
        <Spinner aria-hidden />
        Building release {state.release.version}…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="install-release-missing">
      <p className="flex items-center gap-2">
        {lastFailed ? (
          <CircleX aria-hidden className="size-4 shrink-0 text-destructive" />
        ) : (
          <PackageX aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        )}
        {lastFailed ? 'The last release build failed' : `${application.name} has no built release`}
      </p>
      {buildError ? (
        <p className="text-destructive">
          {buildError}
        </p>
      ) : null}
      {missingBuildKeys ? (
        <p className="text-destructive">
          Set these build values before you build a release: {missingBuildKeys.join(', ')}.{' '}
          <Link
            href={`/dashboard/applications/${application.id}/config#environment-variables`}
            className="underline underline-offset-4"
          >
            Review configuration
          </Link>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {firstRelease ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void onBuild()}
            loading={building}
            loadingText="Starting build…"
          >
            Build release from commit {firstRelease.gitSha.slice(0, 7)}
          </Button>
        ) : null}
        <Button asChild size="sm" variant={firstRelease ? 'ghost' : 'outline'}>
          <Link href={releasesHref}>{lastFailed ? 'Review build failure' : 'Go to Releases'}</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * The invitation-first success state. The URL carries the one-time token as
 * its fragment, so one copy action hands the customer everything they need.
 * No deployment exists yet — the customer's confirmation creates it.
 */
function InvitationLinkCard({
  url,
  customerId,
  applicationId,
  onReset,
}: {
  url: string;
  customerId: string | null;
  applicationId: string | null;
  onReset: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-5 text-primary" aria-hidden />
          <CardTitle>Invitation created</CardTitle>
        </div>
        <CardDescription>
          Send this link to your customer. It includes the one-time token, which is shown only
          once and cannot be retrieved again.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2 rounded-lg border bg-muted px-3 py-2.5">
          <code className="flex-1 break-all font-mono text-sm">{url}</code>
          <Button size="sm" onClick={() => void copyInstallLink(url)}>
            <Copy aria-hidden className="size-4" />
            Copy link
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={url} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden className="size-4" />
              Open
            </a>
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/deployments">Back to deployments</Link>
          </Button>
          {applicationId && customerId ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/dashboard/applications/${applicationId}/config?customer=${customerId}`}>
                Set up configuration
              </Link>
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onReset}>
            Create another
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function InstallLinkCard({
  link,
  deploymentId,
  customerId,
  applicationId,
  onReset,
}: {
  link: string;
  deploymentId: string;
  customerId: string | null;
  applicationId: string | null;
  onReset: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CheckCircle2 className="size-5 text-primary" aria-hidden />
          <CardTitle>Deployment created</CardTitle>
        </div>
        <CardDescription>
          Open this install link and connect your own AWS account to run the test. Your AWS credentials never touch
          Deployz.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2 rounded-lg border bg-muted px-3 py-2.5">
          <code className="flex-1 break-all font-mono text-sm">{link}</code>
          <Button size="sm" onClick={() => void copyInstallLink(link)}>
            <Copy aria-hidden className="size-4" />
            Copy install link
          </Button>
          <Button asChild variant="outline" size="sm">
            <a href={link} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden className="size-4" />
              Open
            </a>
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="outline" size="sm">
            <Link href={`/dashboard/deployments/${deploymentId}`}>View deployment</Link>
          </Button>
          {applicationId && customerId ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/dashboard/applications/${applicationId}/config?customer=${customerId}`}>
                Set up configuration
              </Link>
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onReset}>
            Create another
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
