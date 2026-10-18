'use client';

import { useEffect, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import {
  allowedSizeTiers,
  currentInfrastructureSizeProfile,
  INFRASTRUCTURE_SIZE_TIERS,
  type DeploymentPlan,
  type InfrastructureSizeTier,
} from '@deployz/contracts';

import { SizeSelect } from '@/components/size-select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage } from '@/lib/api-client';
import { fetchApplicationPlan, updateApplicationSizes, type Application } from '@/lib/applications';
import { estimateKind } from '@/lib/configuration-inventory';
import { formatMonthlyRange } from '@/lib/footprint';
import { regionOptionLabel } from '@/lib/regions';
import { formatCompute, sizeTierCompute, sizeTierLabel } from '@/lib/size-tiers';

// `undefined` while the size's plan is loading, `null` when it could not be loaded.
type SizePlans = Partial<Record<InfrastructureSizeTier, DeploymentPlan | null>>;

/** The configuration value a footprint resource carries, as text. */
function resourceValue(plan: DeploymentPlan | null | undefined, id: string, key: string): string | null {
  const value = plan?.footprint?.resources.find((resource) => resource.id === id)?.configuration[key];
  return typeof value === 'string' ? value : null;
}

/** The configuration value a footprint resource carries, as a number. */
function resourceNumber(plan: DeploymentPlan | null | undefined, id: string, key: string): number | null {
  const value = plan?.footprint?.resources.find((resource) => resource.id === id)?.configuration[key];
  return typeof value === 'number' ? value : null;
}

// Deployment sizes and the per-deployment AWS estimate. The vendor sets the
// recommended size and the smallest size customers may use; both apply to
// links and deployments created later. Resources and costs come from each
// size's plan — this card only formats them.
export function DeploymentSize({
  application,
  plan,
  externalServices,
  unestimatedWorkload,
  onSaved,
}: {
  application: Application;
  plan: DeploymentPlan | null;
  externalServices: string[];
  unestimatedWorkload: boolean;
  onSaved: () => Promise<void>;
}) {
  const presetsId = useId();
  const defaultId = useId();
  const defaultHelpId = useId();
  const minimumId = useId();
  const minimumHelpId = useId();
  const [plans, setPlans] = useState<SizePlans>({});
  const [defaultSize, setDefaultSize] = useState(application.defaultSizeProfile);
  const [minimumSize, setMinimumSize] = useState(application.minimumSizeProfile);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPlans({});
    for (const tier of INFRASTRUCTURE_SIZE_TIERS) {
      fetchApplicationPlan(application.id, tier).then(
        (sizePlan) => !cancelled && setPlans((current) => ({ ...current, [tier]: sizePlan })),
        () => !cancelled && setPlans((current) => ({ ...current, [tier]: null })),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [application.id, plan]);

  useEffect(() => {
    setDefaultSize(application.defaultSizeProfile);
    setMinimumSize(application.minimumSizeProfile);
  }, [application.defaultSizeProfile, application.minimumSizeProfile]);

  function changeMinimum(tier: InfrastructureSizeTier): void {
    setMinimumSize(tier);
    if (!allowedSizeTiers(tier).includes(defaultSize)) setDefaultSize(tier);
    setSaved(false);
  }

  async function save(): Promise<void> {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await updateApplicationSizes(application.id, { defaultSizeProfile: defaultSize, minimumSizeProfile: minimumSize });
      await onSaved();
      setSaved(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  const dirty = defaultSize !== application.defaultSizeProfile || minimumSize !== application.minimumSizeProfile;
  const recommendedPlan = plans[defaultSize] ?? (defaultSize === application.defaultSizeProfile ? plan : null);
  const estimate = recommendedPlan?.costEstimate ?? null;
  const region = recommendedPlan?.region ?? null;
  const hasDatabase = plan ? plan.components.some((component) => component.kind === 'database') : application.databaseRequired;
  const hasCache = plan ? plan.components.some((component) => component.kind === 'cache') : application.redisRequired;

  const allowed = allowedSizeTiers(minimumSize);
  const presets = INFRASTRUCTURE_SIZE_TIERS.map((tier) => {
    const sizePlan = plans[tier];
    const profile = currentInfrastructureSizeProfile(tier);
    const workloads = sizePlan?.footprint?.workloads ?? [];
    const web = workloads.find((workload) => workload.role === 'web');
    const workers = workloads.filter((workload) => workload.role === 'worker').length;
    const compute = web ? formatCompute(web.compute) : sizeTierCompute(tier);
    const database = resourceValue(sizePlan, 'database', 'instanceType') ?? (hasDatabase ? profile.database.instanceClass : null);
    const storageGb = resourceNumber(sizePlan, 'database', 'storageGb') ?? (hasDatabase ? profile.database.storageGb : null);
    const cache = resourceValue(sizePlan, 'cache', 'nodeType') ?? (hasCache ? profile.cache.nodeType : null);
    const sizeEstimate = sizePlan?.costEstimate ?? null;
    const range = sizeEstimate ? formatMonthlyRange(sizeEstimate.monthlyMin, sizeEstimate.monthlyMax) : null;
    const kind = estimateKind(sizeEstimate);
    return {
      tier,
      compute: `${compute} per service`,
      workers: workers > 0 ? `${workers} × ${compute}` : null,
      database,
      storage: storageGb !== null ? `${storageGb} GB database storage` : null,
      cache,
      cost:
        sizePlan === undefined
          ? 'Loading estimate…'
          : range
            ? `${range}${kind === 'baseline-plus-usage' || kind === 'partial' ? ' + usage' : ''}`
            : 'Estimate unavailable',
    };
  });
  type Preset = (typeof presets)[number];
  const rows = (
    [
      ['Compute', (preset: Preset) => preset.compute],
      ['Workers', (preset: Preset) => preset.workers],
      ['Database', (preset: Preset) => preset.database],
      ['Storage', (preset: Preset) => preset.storage],
      ['Cache', (preset: Preset) => preset.cache],
    ] as const
  ).filter(([, value]) => presets.some((preset) => value(preset) !== null));

  return (
    <section
      id="deployment-size"
      aria-labelledby={presetsId}
      className="flex scroll-mt-20 flex-col gap-6"
      data-testid="deployment-size"
    >
      <div className="flex flex-col gap-3">
        <div>
          <h2 id={presetsId} className="text-base font-semibold">
            Size presets
          </h2>
          <p className="text-sm text-muted-foreground">Fixed capacity for each size. Presets cannot be edited.</p>
        </div>
        <div className="rounded-lg border">
          <Table data-testid="deployment-size-presets">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>
                  <span className="sr-only">Resource</span>
                </TableHead>
                {presets.map((preset) => (
                  <TableHead key={preset.tier} scope="col" data-testid={`deployment-size-${preset.tier}`}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span>{sizeTierLabel(preset.tier)}</span>
                      {preset.tier === application.defaultSizeProfile ? <Badge variant="secondary">Default</Badge> : null}
                      {allowedSizeTiers(application.minimumSizeProfile).includes(preset.tier) ? null : (
                        <Badge variant="outline">Below minimum</Badge>
                      )}
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(([label, value]) => (
                <TableRow key={label} className="hover:bg-transparent">
                  <TableHead scope="row" className="font-normal text-muted-foreground">
                    {label}
                  </TableHead>
                  {presets.map((preset) => (
                    <TableCell
                      key={preset.tier}
                      className="align-top whitespace-normal"
                      data-testid={`deployment-size-${preset.tier}-${label.toLowerCase()}`}
                    >
                      {value(preset) ?? '—'}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              <TableRow className="hover:bg-transparent">
                <TableHead scope="row" className="font-normal whitespace-nowrap text-muted-foreground">
                  Est. AWS cost
                </TableHead>
                {presets.map((preset) => (
                  <TableCell
                    key={preset.tier}
                    className="align-top font-medium whitespace-normal"
                    data-testid={`deployment-size-${preset.tier}-cost`}
                  >
                    {preset.cost}
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="flex flex-col gap-4 border-t pt-6">
        <div>
          <h3 className="text-sm font-semibold">Customer sizes</h3>
          <p className="text-sm text-muted-foreground">Changes apply to new install links and new deployments.</p>
        </div>
        <div className="grid gap-4 sm:max-w-xl sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor={defaultId}>Default size</Label>
            <SizeSelect
              id={defaultId}
              value={defaultSize}
              tiers={allowed}
              onValueChange={(tier) => {
                setDefaultSize(tier);
                setSaved(false);
              }}
              disabled={saving}
              describedBy={defaultHelpId}
            />
            <p id={defaultHelpId} className="text-xs text-muted-foreground">
              Preselected for customers.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={minimumId}>Minimum allowed size</Label>
            <SizeSelect
              id={minimumId}
              value={minimumSize}
              tiers={INFRASTRUCTURE_SIZE_TIERS}
              onValueChange={changeMinimum}
              disabled={saving}
              describedBy={minimumHelpId}
            />
            <p id={minimumHelpId} className="text-xs text-muted-foreground">
              Smallest size customers can select.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={!dirty}
            loading={saving}
            loadingText="Saving sizes…"
            onClick={() => void save()}
            data-testid="deployment-size-save"
          >
            Save sizes
          </Button>
          {saved ? (
            <p role="status" className="text-sm text-muted-foreground">
              Saved.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive" data-testid="deployment-size-error">
              {error}
            </p>
          ) : null}
          {dirty && !saving ? <p className="text-xs text-muted-foreground">Unsaved changes.</p> : null}
        </div>
      </div>

      <Collapsible className="border-t pt-4" data-testid="deployment-cost">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">Estimates only. AWS bills the customer’s account.</p>
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
            Estimate details
            <ChevronDown aria-hidden className="size-4 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <ul className="mt-2 flex flex-col gap-0.5 text-xs text-muted-foreground" data-testid="deployment-cost-details">
            <li data-testid="deployment-cost-assumptions">
              {region
                ? `Region: ${regionOptionLabel(region)}.`
                : 'Region: US East (N. Virginia) baseline. The customer’s region can change the price.'}{' '}
              On-demand prices, 730 hours a month, USD.
            </li>
            {estimate && estimate.usageDependent.length > 0 ? (
              <li>Not included: {estimate.usageDependent.join(', ')}.</li>
            ) : null}
            {estimateKind(estimate) === 'partial' ? (
              <li>Some resources could not be priced. The real cost is higher.</li>
            ) : null}
            {unestimatedWorkload ? <li>The background worker is not estimated.</li> : null}
            <li>Deployz fees are not included.</li>
            <li>
              External services
              {externalServices.length > 0 ? ` (${externalServices.join(', ')})` : ''} are billed separately and not
              estimated.
            </li>
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
