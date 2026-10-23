'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { CustomerInstallReview } from '@/components/customer-install-review';
import { DocsLink } from '@/components/docs-link';
import { Badge } from '@/components/ui/badge';
import { SecretInput } from '@/components/secret-input';
import { Spinner } from '@/components/ui/spinner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DOCS } from '@/lib/docs-links';
import { installPlanRegionLabel } from '@/lib/install-plan';
import { fetchPublicInstallPlan } from '@/lib/public-install-data';
import { confirmPublicInstall } from '@/lib/public-install-confirm';
import { SECRET_HANDLING_STATEMENT } from '@/lib/security-details';
import { formatCompute } from '@/lib/size-tiers';
import {
  publicInstallErrorMessage,
  type InfrastructureSizeTier,
  type PublicInstallInput,
  type PublicInstallPlan,
  type PublicInstallResolve,
  type PublicInstallSizeOption,
} from '@/lib/public-install-types';

interface PublicInstallFlowProps {
  linkId: string;
  resolve: PublicInstallResolve;
  /** Invitation token for targeted invitations; undefined for reusable links. */
  token?: string;
  /** A targeted invitation already names the customer — no details to enter. */
  customerKnown?: boolean;
}

export function PublicInstallFlow({ linkId, resolve, token, customerKnown = false }: PublicInstallFlowProps) {
  const router = useRouter();

  // Vendor recommendation is a preselection hint the customer may change.
  // Materially simpler and consistent with current UX. Otherwise the region
  // starts empty — the customer must pick explicitly, and confirm stays
  // disabled until they do (no silent first-region default).
  const [region, setRegion] = useState(
    resolve.recommendedRegion &&
      resolve.regions.some((option) => option.value === resolve.recommendedRegion)
      ? resolve.recommendedRegion
      : '',
  );
  const [size, setSize] = useState<InfrastructureSizeTier>(resolve.sizing.recommended);
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  // One key per selection: a retry of the same Region and size replays, a
  // new selection is a new confirmation.
  const [idempotencyKey, setIdempotencyKey] = useState(generateIdempotencyKey);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The plan is re-derived per selected Region and size: pricing stays on
  // the server; the client only renders it. `requestedPlanRef` is the
  // Region and size the in-flight (or last applied) fetch belongs to, so a
  // slow older response can never override a newer selection. The plan's
  // fingerprint is what the customer approves on confirm.
  const [plan, setPlan] = useState<PublicInstallPlan>({
    ...resolve.plan,
    sizeProfile: resolve.sizing.recommended,
    planFingerprint: null,
  });
  const [planLoading, setPlanLoading] = useState(false);
  const [planRefresh, setPlanRefresh] = useState(0);
  const [estimateUnavailable, setEstimateUnavailable] = useState(resolve.plan.costEstimate == null);
  const requestedPlanRef = useRef<string | null>(region === '' ? null : `${region}|${size}`);

  useEffect(() => {
    if (region === '') return;
    const requested = `${region}|${size}`;
    requestedPlanRef.current = requested;
    setPlanLoading(true);
    void fetchPublicInstallPlan(linkId, region, size, token).then((freshPlan) => {
      if (requestedPlanRef.current !== requested) return; // stale response
      setPlanLoading(false);
      if (freshPlan === null) {
        // Keep the previous infrastructure preview; the estimate degrades and
        // nothing can be approved without a fingerprint.
        setPlan((previous) => ({ ...previous, planFingerprint: null }));
        setEstimateUnavailable(true);
        return;
      }
      setPlan(freshPlan);
      setEstimateUnavailable(freshPlan.costEstimate == null);
    });
  }, [linkId, region, size, token, planRefresh]);

  const planFingerprint =
    !planLoading && plan.region === region && plan.sizeProfile === size ? plan.planFingerprint : null;
  const selectedSize = resolve.sizing.options.find((option) => option.id === size);

  const settingErrors = useMemo(
    () =>
      Object.fromEntries(
        resolve.requiredInputs.map((input) => [input.key, settingFieldError(input, configValues[input.key] ?? '')]),
      ),
    [resolve.requiredInputs, configValues],
  );
  const settingsValid = resolve.requiredInputs.every((input) => settingErrors[input.key] === null);
  const settingsCompleteCount = resolve.requiredInputs.filter((input) => settingErrors[input.key] === null).length;
  const settingsTotal = resolve.requiredInputs.length;
  const detailsMissing = !customerKnown && (customerName.trim() === '' || customerEmail.trim() === '');

  const canSubmit = region !== '' && planFingerprint !== null && settingsValid && !detailsMissing;
  // One line under the action names what still blocks it, in form order.
  const blockedReason =
    region === ''
      ? 'Select an AWS Region to continue.'
      : planFingerprint === null
        ? planLoading
          ? 'Updating the plan for your selection…'
          : 'This Region cannot be installed right now. Select a different Region.'
        : !settingsValid
        ? 'Complete the required application settings to continue.'
        : detailsMissing
          ? 'Enter your name and email to continue.'
          : null;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || pending || planFingerprint === null) {
      setTouched(Object.fromEntries(resolve.requiredInputs.map((input) => [input.key, true])));
      return;
    }

    setPending(true);
    setError(null);

    const config = resolve.requiredInputs
      .map((input) => {
        const value = configValues[input.key] ?? '';
        if (value.trim() === '') return null;
        return { key: input.key, value: input.secret ? value : value.trim(), isSecret: input.secret };
      })
      .filter((item): item is { key: string; value: string; isSecret: boolean } => item !== null);

    try {
      const result = await confirmPublicInstall(
        linkId,
        {
          idempotencyKey,
          region,
          sizeProfile: size,
          planFingerprint,
          // A targeted invitation forbids re-naming its customer; a reusable
          // link requires it.
          ...(customerKnown
            ? {}
            : { customer: { name: customerName.trim(), email: customerEmail.trim() } }),
          config,
        },
        token,
      );

      if (result.ok) {
        router.push(`/install/${result.installLinkId}#${result.installLinkToken}`);
        return;
      }

      // The reviewed plan is out of date: show the new one and ask again.
      if (result.code === 'PLAN_CHANGED') setPlanRefresh((count) => count + 1);
      setError(publicInstallErrorMessage(result.code));
    } catch {
      setError(publicInstallErrorMessage('UNKNOWN'));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Install {resolve.application.name}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Published by {resolve.publisher.name} · Release {resolve.release.version}
        </p>
        <DocsLink href={DOCS.customerInstall} className="mt-1">
          How the installation works
        </DocsLink>
      </div>

      <section aria-labelledby="public-region" className="flex flex-col gap-3">
        <h2 id="public-region" className="text-base font-semibold">
          AWS Region
        </h2>
        {resolve.recommendedRegion ? (
          <p className="text-sm text-muted-foreground">
            {resolve.publisher.name} recommends {installPlanRegionLabel(resolve.recommendedRegion) ?? resolve.recommendedRegion}.
          </p>
        ) : null}
        <Select
          value={region}
          onValueChange={(value) => {
            setRegion(value);
            setIdempotencyKey(generateIdempotencyKey());
          }}
        >
          <SelectTrigger aria-labelledby="public-region" className="w-full sm:w-[360px]">
            <SelectValue placeholder="Select a region" />
          </SelectTrigger>
          <SelectContent>
            {resolve.regions.map((regionOption) => (
              <SelectItem key={regionOption.value} value={regionOption.value}>
                <span className="flex items-center gap-2">
                  {regionOption.label}
                  {regionOption.value === resolve.recommendedRegion ? <Badge variant="secondary">Recommended</Badge> : null}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DocsLink href={DOCS.customerChooseRegion}>How to choose a Region</DocsLink>
      </section>

      <section aria-labelledby="public-size" className="flex flex-col gap-3">
        <h2 id="public-size" className="text-base font-semibold">
          Size
        </h2>
        <p className="text-sm text-muted-foreground">
          A larger size runs the application on more capacity and costs more.
        </p>
        <RadioGroup
          aria-labelledby="public-size"
          value={size}
          onValueChange={(value) => {
            setSize(value as InfrastructureSizeTier);
            setIdempotencyKey(generateIdempotencyKey());
          }}
        >
          {resolve.sizing.options.map((option) => (
            <SizeChoice key={option.id} option={option} plan={plan} />
          ))}
        </RadioGroup>
        {planLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <Spinner aria-hidden /> Updating for this selection…
          </p>
        ) : null}
      </section>

      <CustomerInstallReview
        plan={plan}
        estimateUnavailable={estimateUnavailable}
        estimatePending={region === ''}
        // A new tab has no copy of this tab's stored invitation token, so the
        // token travels the way the invitation link carries it: as a fragment.
        securityHref={`/install/${encodeURIComponent(linkId)}/security${token ? `#${encodeURIComponent(token)}` : ''}`}
        securityInNewTab
      />

      {settingsTotal > 0 ? (
        <section aria-labelledby="public-config" className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="public-config" className="text-base font-semibold">
              Application settings
            </h2>
            <p className="text-xs text-muted-foreground" data-testid="settings-completion">
              {settingsCompleteCount === settingsTotal
                ? 'All settings complete'
                : `${settingsCompleteCount} of ${settingsTotal} settings complete`}
            </p>
          </div>
          <div className="flex flex-col gap-4">
            {resolve.requiredInputs.map((input) => {
              const fieldError = settingErrors[input.key];
              const showError = touched[input.key] === true && fieldError !== null;
              return (
                <div key={input.key} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label htmlFor={input.key}>{input.label ?? humanizeSettingKey(input.key)}</Label>
                    <span className="text-xs text-muted-foreground">
                      {input.required ? 'Required' : 'Optional'}
                    </span>
                  </div>
                  {input.help ? <p className="text-xs text-muted-foreground">{input.help}</p> : null}
                  {input.secret ? (
                    <SecretInput
                      id={input.key}
                      value={configValues[input.key] ?? ''}
                      onChange={(event) => {
                        const value = event.target.value;
                        setConfigValues((previous) => ({
                          ...previous,
                          [input.key]: value,
                        }));
                      }}
                      onBlur={() => setTouched((previous) => ({ ...previous, [input.key]: true }))}
                      aria-required={input.required}
                      aria-invalid={showError || undefined}
                      aria-describedby={showError ? `${input.key}-error` : undefined}
                    />
                  ) : (
                    <Input
                      id={input.key}
                      type="text"
                      value={configValues[input.key] ?? ''}
                      onChange={(event) => {
                        const value = event.target.value;
                        setConfigValues((previous) => ({
                          ...previous,
                          [input.key]: value,
                        }));
                      }}
                      onBlur={() => setTouched((previous) => ({ ...previous, [input.key]: true }))}
                      autoComplete="off"
                      aria-required={input.required}
                      aria-invalid={showError || undefined}
                      aria-describedby={showError ? `${input.key}-error` : undefined}
                    />
                  )}
                  <p className="font-mono text-[11px] text-muted-foreground">{input.key}</p>
                  {showError ? (
                    <p id={`${input.key}-error`} role="alert" className="text-xs text-destructive">
                      {fieldError}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
          {resolve.requiredInputs.some((input) => input.secret) ? (
            <p className="text-xs text-muted-foreground">{SECRET_HANDLING_STATEMENT}</p>
          ) : null}
        </section>
      ) : null}

      {customerKnown ? null : (
        <section aria-labelledby="public-customer" className="flex flex-col gap-4">
          <h2 id="public-customer" className="text-base font-semibold">
            Your details
          </h2>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="customer-name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="customer-name"
                value={customerName}
                onChange={(event) => setCustomerName(event.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="customer-email">
                Email <span className="text-destructive">*</span>
              </Label>
              <Input
                id="customer-email"
                type="email"
                value={customerEmail}
                onChange={(event) => setCustomerEmail(event.target.value)}
                required
              />
            </div>
          </div>
        </section>
      )}

      <section aria-label="Deploy actions" className="flex flex-col gap-3">
        {selectedSize ? (
          <p className="text-sm" data-testid="selected-size">
            You are approving the <span className="font-medium">{selectedSize.label}</span> size
            {region !== '' ? ` in ${installPlanRegionLabel(region) ?? region}` : ''}.
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Next, you connect your AWS account. Nothing is created until you approve it there.
        </p>
        <Button
          size="lg"
          type="submit"
          className="w-fit"
          disabled={!canSubmit || pending}
          loading={pending}
          loadingText="Preparing deployment…"
        >
          Continue to setup
        </Button>
        {blockedReason ? <p className="text-sm text-muted-foreground">{blockedReason}</p> : null}
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Setup could not continue</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </section>
    </form>
  );
}

function SizeChoice({ option, plan }: { option: PublicInstallSizeOption; plan: PublicInstallPlan }) {
  const hasDatabase = plan.components.some((component) => component.kind === 'database');
  const hasCache = plan.components.some((component) => component.kind === 'cache');
  const resources = [
    `${formatCompute(option.workload)} per service`,
    hasDatabase ? `Database ${option.database.instanceClass}` : null,
    hasCache ? `Cache ${option.cache.nodeType}` : null,
  ].filter((line): line is string => line !== null);
  return (
    <Label
      htmlFor={`size-${option.id}`}
      className="items-start gap-3 rounded-lg border p-4 font-normal has-[[data-state=checked]]:border-primary"
    >
      <RadioGroupItem id={`size-${option.id}`} value={option.id} className="mt-0.5" />
      <span className="flex flex-col gap-1.5">
        <span className="flex flex-wrap items-center gap-2 font-medium">
          {option.label}
          {option.recommended ? <Badge variant="secondary">Recommended by your software provider</Badge> : null}
        </span>
        <span className="text-xs text-muted-foreground">{resources.join(' · ')}</span>
      </span>
    </Label>
  );
}

/** "DATABASE_URL" → "Database url" — used only when the vendor set no label. */
function humanizeSettingKey(key: string): string {
  const words = key.toLowerCase().split('_').filter((word) => word.length > 0);
  if (words.length === 0) return key;
  return words.map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(' ');
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An absolute URL of any scheme (https://, postgres://, redis://, …). */
function isAbsoluteUrl(value: string): boolean {
  try {
    return new URL(value).protocol !== 'javascript:';
  } catch {
    return false;
  }
}

/**
 * Presence + safe-format validation for one application setting. Trims
 * whitespace for non-secret values (a secret's exact bytes matter). Returns
 * a short plain-English error, or null when the value is acceptable.
 */
function settingFieldError(input: PublicInstallInput, rawValue: string): string | null {
  const value = input.secret ? rawValue : rawValue.trim();
  // A secret keeps its exact bytes, but spaces alone are not a value.
  if (value.trim() === '') return input.required ? 'This value is required.' : null;
  if (value.length > 4096) return 'This value must be 4096 characters or fewer.';
  if (/_URL$|_URI$/.test(input.key)) {
    if (!isAbsoluteUrl(value)) return 'Enter a full URL, for example https://example.com.';
  } else if (/_EMAIL$/.test(input.key)) {
    if (!EMAIL_PATTERN.test(value)) return 'Enter a valid email address.';
  } else if (/_PORT$/.test(input.key)) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return 'Enter a port number from 1 to 65535.';
    }
  }
  return null;
}

function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
