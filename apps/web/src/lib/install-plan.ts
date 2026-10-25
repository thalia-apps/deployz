// Plan-driven presentation for the customer-facing install surfaces (the
// install page and the hosted deploy-link page). Both surfaces render the
// same `DeploymentPlan` the API derives from the deployment's frozen
// manifest — the UI never derives infrastructure intent itself (see
// docs/ui-system.md).

import {
  AWS_RESOURCE_GROUP_DISPLAY,
  AWS_RESOURCE_GROUP_ORDER,
  INFRASTRUCTURE_COMPONENT_DISPLAY,
  PLAN_COMPONENT_GROUP_BY_KIND,
  PLAN_COMPONENT_GROUP_DISPLAY,
  PLAN_COMPONENT_GROUP_ORDER,
  REGION_LABELS,
  type AwsResourceGroup,
  type DeploymentPlan,
  type DeploymentPlanAwsResource,
  type PlanComponentGroup,
  type Region,
} from '@deployz/contracts';

/** "Database: not provisioned here, now required" / the reverse — one line per
 *  requirement-drift entry (Phase 4's `DeploymentPlan['requirementDrift']`
 *  and the application-page drift notice). Shared so the wording never
 *  diverges. */
export function requirementDriftLine(entry: {
  kind: 'database' | 'cache' | 'storage' | 'engine' | 'workload' | 'queue' | 'schedule';
  name?: string | undefined;
  deployed: boolean;
  desired: boolean;
}): string {
  if (entry.kind === 'engine') {
    return `Database: the application now uses ${entry.name === 'mysql' ? 'MySQL' : 'PostgreSQL'}, which this deployment does not have`;
  }
  if (entry.kind === 'workload' || entry.kind === 'queue' || entry.kind === 'schedule') {
    const label = { workload: 'Process', queue: 'Queue', schedule: 'Schedule' }[entry.kind];
    return entry.desired && !entry.deployed
      ? `${label} "${entry.name}": not set up here, now required`
      : `${label} "${entry.name}": set up here, no longer required`;
  }
  const name = INFRASTRUCTURE_COMPONENT_DISPLAY[entry.kind].name;
  return entry.desired && !entry.deployed
    ? `${name}: not provisioned here, now required`
    : `${name}: provisioned here, no longer required`;
}

/** One row of the customer "Deployz will create" table. */
export interface InstallPlanRow {
  kind: string;
  /** Resolved presentation group — never missing, even for unknown kinds. */
  group: PlanComponentGroup;
  name: string;
  whatHappens: string;
  /** Stays in the customer's AWS account after the deployment is removed. */
  retained: boolean;
}

// A missing/invalid stored manifest never guesses resources into existence —
// the API sends `plan: null` in that case. The install page still needs
// something to show, so it falls back to the one component every
// deployment has.
const FALLBACK_ROWS: InstallPlanRow[] = [
  {
    kind: 'application',
    group: 'application',
    name: INFRASTRUCTURE_COMPONENT_DISPLAY.application.name,
    whatHappens: INFRASTRUCTURE_COMPONENT_DISPLAY.application.purpose,
    retained: false,
  },
];

function resolveComponentGroup(component: DeploymentPlan['components'][number]): PlanComponentGroup {
  if (component.group && PLAN_COMPONENT_GROUP_ORDER.includes(component.group)) return component.group;
  const byKind = PLAN_COMPONENT_GROUP_BY_KIND[component.kind];
  if (byKind) return byKind;
  return 'application';
}

function componentPurpose(component: DeploymentPlan['components'][number]): string {
  if (component.kind === 'worker') return 'Runs background work for your application';
  return (
    INFRASTRUCTURE_COMPONENT_DISPLAY[component.kind as keyof typeof INFRASTRUCTURE_COMPONENT_DISPLAY]?.purpose ??
    component.name
  );
}

/** The install plan's CREATE components, in catalog order, as table rows. */
export function installPlanRows(plan: DeploymentPlan | null): InstallPlanRow[] {
  if (!plan) return FALLBACK_ROWS;
  return plan.components
    .filter((component) => component.action === 'CREATE')
    .map((component) => ({
      kind: component.kind,
      group: resolveComponentGroup(component),
      name: component.name,
      whatHappens: componentPurpose(component),
      retained: component.lifecycle === 'retain',
    }));
}

/** One heading group of the customer 'Deployz will create' component table. */
export interface InstallPlanRowGroup {
  group: PlanComponentGroup;
  label: string;
  rows: InstallPlanRow[];
}

/**
 * The install plan's CREATE components grouped by their presentation group,
 * in canonical order, with empty groups omitted. Unknown or missing groups
 * fall back through component.group → kind → 'application' so a future
 * component never crashes or disappears.
 */
export function installPlanRowGroups(plan: DeploymentPlan | null): InstallPlanRowGroup[] {
  const rows = installPlanRows(plan);
  return PLAN_COMPONENT_GROUP_ORDER.map((group) => ({
    group,
    label: PLAN_COMPONENT_GROUP_DISPLAY[group],
    rows: rows.filter((row) => row.group === group),
  })).filter((entry) => entry.rows.length > 0);
}

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/** The plan's retained components, in plan order. */
export function installPlanRetainedComponents(plan: DeploymentPlan | null): DeploymentPlan['components'] {
  if (!plan) return [];
  return plan.components.filter((component) => component.lifecycle === 'retain');
}

/**
 * "When this deployment is removed, Database and Storage stay in your AWS
 * account." Null when the plan is unavailable or nothing is retained — a
 * fully stateless deployment has nothing to disclose here.
 */
export function installPlanRetentionNote(plan: DeploymentPlan | null): string | null {
  const retainedNames = installPlanRetainedComponents(plan).map((component) => component.name);
  if (retainedNames.length === 0) return null;
  const verb = retainedNames.length === 1 ? 'stays' : 'stay';
  return `When this deployment is removed, ${joinNames(retainedNames)} ${verb} in your AWS account.`;
}

/**
 * The charges warning that always accompanies a retention note, wherever the
 * note renders — one sentence, never two wordings.
 */
export const RETENTION_CHARGES_NOTE =
  'Kept resources can keep costing money in your AWS account until they are deleted.';

/**
 * The region label for the install/deploy pages ("US East (N. Virginia)").
 * Null for a region Deployz does not recognize — the page hides the region
 * line rather than showing a raw AWS region code.
 */
export function installPlanRegionLabel(region: string): string | null {
  return REGION_LABELS[region as Region] ?? null;
}

/** "Deleted" / "Kept in your AWS account" — the only two removal labels the
 *  "AWS infrastructure details" table shows for a resource's lifecycle. */
export function awsResourceRemovalLabel(lifecycle: DeploymentPlanAwsResource['lifecycle']): string {
  return lifecycle === 'retain' ? 'Kept in your AWS account' : 'Deleted';
}

/** One heading group of the "AWS infrastructure details" table. */
export interface AwsResourceGroupRows {
  group: AwsResourceGroup;
  label: string;
  resources: DeploymentPlanAwsResource[];
}

/**
 * The plan's AWS resources, grouped and ordered for display (Compute &
 * Networking, Data, Security & Operations); empty groups are omitted.
 */
export function awsResourceGroups(plan: DeploymentPlan | null): AwsResourceGroupRows[] {
  if (!plan) return [];
  return AWS_RESOURCE_GROUP_ORDER.map((group) => ({
    group,
    label: AWS_RESOURCE_GROUP_DISPLAY[group],
    resources: plan.awsResources.filter((resource) => resource.group === group),
  })).filter((entry) => entry.resources.length > 0);
}
