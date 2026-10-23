// Configuration-tab "Services & resources" mapper — folds the readiness
// setting rows (`deriveConfigurationRows`), the architecture's unresolved
// questions, and the plan's footprint, AWS resource inventory and cost
// estimate into ONE grouped table. Every AWS resource and every cost item is
// assigned to exactly one row; what no service owns lands in a "Shared
// resources" row, never dropped. Nothing here derives infrastructure or
// prices itself: sizes, resources and prices are the API's.

import {
  isDisputableFinding,
  type DeploymentPlan,
  type DeploymentPlanAwsResource,
  type FootprintCostEstimate,
  type FootprintCostItem,
  type InfrastructureComponentKind,
} from '@deployz/contracts';

import type { Application } from './applications';
import { deriveConfigurationRows, type ConfigurationRow, type ConfigurationResultVariant } from './application-configuration';
import { footprintComponentRows, type FootprintComponentRow } from './footprint';
import type { ApplicationReadiness, ArchitectureUnresolved, EditableReadinessField } from './readiness';

export type InventoryGroupId = 'application' | 'data' | 'network' | 'integrations';

export const INVENTORY_GROUP_LABELS: Readonly<Record<InventoryGroupId, string>> = {
  application: 'Application & runtime',
  data: 'Data services',
  network: 'Networking & HTTPS',
  integrations: 'External integrations',
};

export interface InventoryResource {
  id: string;
  name: string;
  purpose: string;
  afterRemoval: 'Kept' | 'Removed';
}

/** A row's summed share of the baseline estimate. `min`/`max` are null when no item of the row has a price. */
export interface CostSummary {
  min: number | null;
  max: number | null;
  /** At least one item is billed by usage only. */
  usageBased: boolean;
  /** At least one item has no price. The sum is then a lower bound, never complete. */
  unpriced: boolean;
}

export type RowCost = CostSummary | 'billed-separately' | 'not-estimated' | null;

export type RowAfterRemoval = 'Kept' | 'Removed' | 'Mixed' | 'Not determined' | null;

export interface InventoryIssue {
  label: string;
  variant: ConfigurationResultVariant;
  text: string | null;
}

export type InventoryAction =
  | { kind: 'edit'; field: EditableReadinessField; label: string; testId: string }
  | { kind: 'fix'; label: string; testId: string }
  | { kind: 'link'; href: string; label: string; testId: string };

/** A blocking finding on the row that the vendor can mark as "not used in production". */
export interface BlockerDispute {
  findingId: string;
  /** The evidence the vendor sees; the API accepts the answer only for this evidence. */
  reason: string;
  testId: string;
}

export interface InventoryRow {
  /** Unique within the table; the row's anchor is `config-row-${id}`. */
  id: string;
  label: string;
  /** A detail row of the service above it (runtime, commands, port, …). */
  indent: boolean;
  configuration: string | null;
  /** Render the configuration as a full, wrapping command. */
  command: boolean;
  /** Secondary line under the configuration ("Set by you · detected: …"). */
  detail: string | null;
  help: string | null;
  resources: InventoryResource[];
  cost: RowCost;
  afterRemoval: RowAfterRemoval;
  issues: InventoryIssue[];
  action: InventoryAction | null;
  /** Fix instructions for a recommendation on a row whose own action edits the setting. */
  fixInstructions?: InventoryAction;
  dispute?: BlockerDispute;
  testId: string;
  /** Readiness findings and architecture questions (by index) shown on this row — the attention summary links to it. */
  findingIds: string[];
  questionIndexes: number[];
}

export interface InventoryGroup {
  id: InventoryGroupId;
  label: string;
  rows: InventoryRow[];
}

export interface ServiceInventory {
  groups: InventoryGroup[];
  /** Names of detected external services, for the charge split. */
  externalServices: string[];
  /** True when a detected workload is not in the plan, so it has no estimate. */
  unestimatedWorkload: boolean;
}

const SETTING_LABELS: Readonly<Record<string, string>> = {
  runtime: 'Runtime',
  build: 'Build command',
  start: 'Start command',
  port: 'Port',
  health: 'Health check',
  migrations: 'Database migrations',
  worker: 'Worker command',
};

const COMMAND_ROW_IDS = new Set(['build', 'start', 'migrations', 'worker']);

// Which plan-resource component kinds each service row owns. Anything not
// listed (configuration secret, container registry, …) is shared.
const WEB_RESOURCE_KINDS: readonly InfrastructureComponentKind[] = ['application', 'monitoring'];
const NETWORK_RESOURCE_KINDS: readonly InfrastructureComponentKind[] = ['network', 'endpoint'];

const UNRESOLVED_LABELS: Readonly<Record<string, string>> = {
  compatibility: 'Supported architecture',
  queue_relationship: 'Queue',
  schedule: 'Scheduled job',
};

function actionLabel(verb: string, label: string): string {
  return `${verb} ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

function afterRemovalFor(resources: readonly InventoryResource[]): RowAfterRemoval {
  if (resources.length === 0) return null;
  const kept = resources.some((resource) => resource.afterRemoval === 'Kept');
  const removed = resources.some((resource) => resource.afterRemoval === 'Removed');
  return kept && removed ? 'Mixed' : kept ? 'Kept' : 'Removed';
}

/** Sums cost items once each; an empty list is no cost at all. */
const EXTERNAL_SERVICE_LABELS: Record<string, string> = {
  stripe: 'Stripe',
  clerk: 'Clerk',
  auth0: 'Auth0',
  resend: 'Resend',
  sendgrid: 'SendGrid',
  smtp: 'SMTP email',
  sentry: 'Sentry',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  twilio: 'Twilio',
  shopify: 'Shopify',
};

/** The product name for a detected service id; an unknown id stays as sent. */
export function externalServiceLabel(id: string): string {
  return EXTERNAL_SERVICE_LABELS[id] ?? id;
}

export function summarizeCostItems(items: readonly FootprintCostItem[]): CostSummary | null {
  if (items.length === 0) return null;
  let min: number | null = null;
  let max: number | null = null;
  let usageBased = false;
  let unpriced = false;
  for (const item of items) {
    if (item.pricingStatus === 'estimated' && item.monthlyMin !== undefined && item.monthlyMax !== undefined) {
      min = (min ?? 0) + item.monthlyMin;
      max = (max ?? 0) + item.monthlyMax;
    } else if (item.pricingStatus === 'usage_based') {
      usageBased = true;
    } else {
      unpriced = true;
    }
  }
  return { min, max, usageBased, unpriced };
}

/** "~$38–51", "~$38–51 + usage", "Usage-based", "Price unavailable". Never "$0" for an unknown price. */
export function formatRowCost(cost: CostSummary): string {
  if (cost.min === null || cost.max === null) {
    return cost.usageBased && !cost.unpriced ? 'Usage-based' : 'Price unavailable';
  }
  const range = cost.min === cost.max ? `~$${cost.min}` : `~$${cost.min}–${cost.max}`;
  const extras = [cost.usageBased ? 'usage' : null, cost.unpriced ? 'unpriced items' : null].filter(Boolean);
  return extras.length > 0 ? `${range} + ${extras.join(' + ')}` : range;
}

export type EstimateKind = 'complete' | 'baseline-plus-usage' | 'partial' | 'unavailable';

/**
 * How complete the plan's estimate is. Partial when any item has no price
 * (the total is then a lower bound); baseline-plus-usage when usage charges
 * come on top; complete only when neither applies.
 */
export function estimateKind(estimate: FootprintCostEstimate | null | undefined): EstimateKind {
  if (!estimate || (estimate.monthlyMin === null && estimate.monthlyMax === null)) return 'unavailable';
  if (!estimate.complete) return 'partial';
  const usage =
    estimate.usageDependent.length > 0 || estimate.items.some((item) => item.pricingStatus === 'usage_based');
  return usage ? 'baseline-plus-usage' : 'complete';
}

// ── The inventory ───────────────────────────────────────────────────────────

interface Pools {
  resources: DeploymentPlanAwsResource[];
  costItems: Map<string, FootprintCostItem>;
}

const UNPRICED: CostSummary = { min: null, max: null, usageBased: false, unpriced: true };

function takeResources(pools: Pools, kinds: readonly string[]): InventoryResource[] {
  const taken = pools.resources.filter((resource) => kinds.includes(resource.componentKind));
  pools.resources = pools.resources.filter((resource) => !kinds.includes(resource.componentKind));
  return taken.map((resource) => ({
    id: resource.id,
    name: resource.name,
    purpose: resource.purpose,
    afterRemoval: resource.lifecycle === 'retain' ? 'Kept' : 'Removed',
  }));
}

/** A planned row with no cost item (no estimate, or an item missing) is unpriced, never free. */
function takeCost(pools: Pools, ids: readonly string[], planned: boolean): RowCost {
  const items: FootprintCostItem[] = [];
  for (const id of ids) {
    const item = pools.costItems.get(id);
    if (!item) continue;
    items.push(item);
    pools.costItems.delete(id);
  }
  if (items.length > 0) return summarizeCostItems(items);
  return planned ? UNPRICED : null;
}

function settingIssues(row: ConfigurationRow): InventoryIssue[] {
  const label = row.result.label;
  if (label === 'Ready' || label === 'Not used') return [];
  return [{ label, variant: row.result.variant, text: row.help }];
}

function settingAction(row: ConfigurationRow, label: string): InventoryAction | null {
  const action = row.action;
  if (action === null) return null;
  const firstFindingId = row.findingIds[0];
  if (action.kind === 'fix') {
    return { kind: 'fix', label: 'Get fix instructions', testId: `readiness-finding-fix-${firstFindingId}` };
  }
  return {
    kind: 'edit',
    field: action.field,
    label: actionLabel(action.label === 'Fix' ? 'Fix' : action.label, label),
    testId: `readiness-setting-edit-${row.id}`,
  };
}

function settingRow(row: ConfigurationRow, overrides: Partial<InventoryRow> = {}): InventoryRow {
  const label = SETTING_LABELS[row.id] ?? row.label;
  const finding = row.id.startsWith('finding-');
  return {
    id: row.id,
    label,
    indent: !finding,
    configuration: row.value,
    command: COMMAND_ROW_IDS.has(row.id) && row.value !== 'Not detected' && row.value !== 'None',
    detail: row.detail,
    help: finding ? null : row.help,
    resources: [],
    cost: null,
    afterRemoval: null,
    issues: settingIssues(row),
    action: settingAction(row, label),
    ...(row.result.label === 'Recommended' && row.action?.kind === 'edit'
      ? { fixInstructions: { kind: 'fix', label: 'Get fix instructions', testId: `readiness-finding-fix-${row.findingIds[0]}` } as const }
      : {}),
    testId: finding ? `readiness-finding-${row.findingIds[0]}` : `readiness-setting-${row.id}`,
    findingIds: row.findingIds,
    questionIndexes: [],
    ...overrides,
  };
}

const STALE_DISPUTE_TEXT = 'The evidence changed after you marked this as not used. Check it again.';

/** The row's first disputable blocking finding, and a notice when the vendor's earlier answer no longer matches it. */
function addBlockerDispute(row: InventoryRow, readiness: ApplicationReadiness): void {
  const finding = row.findingIds
    .map((id) => readiness.findings.find((candidate) => candidate.id === id))
    .find((candidate) => candidate !== undefined && candidate.blocking && isDisputableFinding(candidate.id));
  if (!finding) return;
  row.dispute = { findingId: finding.id, reason: finding.technicalEvidence, testId: `readiness-finding-dispute-${finding.id}` };
  const stale = readiness.vendorDismissedRejections?.some((entry) => entry.findingId === finding.id && entry.stale === true);
  if (stale) row.issues.push({ label: 'Evidence changed', variant: 'warning', text: STALE_DISPUTE_TEXT });
}

/** Unsupported reasons with fixed text in the manifest (packages/analysis/src/manifest.ts), by the finding that shows them. */
const FIXED_UNSUPPORTED_REASONS: Readonly<Record<string, string>> = {
  'Persistent local filesystem storage is not supported': 'local-file-storage',
  'The Dockerfile copies or reads the .git directory, which the source archive Deployz builds from does not contain':
    'build-context-git-metadata',
};

/**
 * The architecture questions that need their own row. An unsupported reason
 * ("compatibility") that a blocking finding already shows is the same
 * blocker: it stays on that finding's row, with its actions, and is not
 * counted twice.
 */
export function openArchitectureQuestions(readiness: ApplicationReadiness): { item: ArchitectureUnresolved; index: number }[] {
  const blockers = readiness.findings.filter((finding) => finding.blocking);
  const shown = (question: string): boolean =>
    blockers.some((finding) => finding.technicalEvidence === question || finding.id === FIXED_UNSUPPORTED_REASONS[question]);
  return (readiness.architecture?.unresolved ?? [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !(item.kind === 'compatibility' && shown(item.question)));
}

function unresolvedIssue(item: ArchitectureUnresolved): InventoryIssue {
  return { label: item.blocking ? 'Blocking' : 'Needs input', variant: 'destructive', text: item.question };
}

function unresolvedAction(item: ArchitectureUnresolved, index: number): InventoryAction {
  if (item.kind === 'port') {
    return { kind: 'edit', field: 'containerPort', label: 'Edit port', testId: `architecture-unresolved-edit-${item.kind}-${index}` };
  }
  return { kind: 'fix', label: 'Get fix instructions', testId: `architecture-unresolved-fix-${item.kind}-${index}` };
}

function emptyRow(id: string, label: string, overrides: Partial<InventoryRow>): InventoryRow {
  return {
    id,
    label,
    indent: false,
    configuration: null,
    command: false,
    detail: null,
    help: null,
    resources: [],
    cost: null,
    afterRemoval: null,
    issues: [],
    action: null,
    testId: `inventory-row-${id}`,
    findingIds: [],
    questionIndexes: [],
    ...overrides,
  };
}

function sizingText(component: FootprintComponentRow | undefined, sizeLabel: string | null): string | null {
  if (!component) return null;
  const parts = [component.provisionedAs, component.configuration, sizeLabel].filter((part): part is string => Boolean(part));
  return parts.join(' · ');
}

/** Adds the unresolved questions of one kind to a row; returns whether any matched. */
function attachUnresolved(
  row: InventoryRow | undefined,
  unresolved: { item: ArchitectureUnresolved; index: number }[],
  kind: string,
  consumed: Set<number>,
): boolean {
  if (!row) return false;
  const matches = unresolved.filter(({ item, index }) => item.kind === kind && !consumed.has(index));
  for (const { item, index } of matches) {
    row.issues.push(unresolvedIssue(item));
    row.action ??= unresolvedAction(item, index);
    row.questionIndexes.push(index);
    consumed.add(index);
  }
  return matches.length > 0;
}

/**
 * The grouped Services & resources table. Empty until an analysis has
 * completed — never a fabricated row. With a missing plan the rows still
 * show their configuration, and every price reads as unavailable.
 */
export function deriveServiceInventory(input: {
  application: Application;
  readiness: ApplicationReadiness;
  plan: DeploymentPlan | null;
}): ServiceInventory {
  const { application, readiness, plan } = input;
  const settings = deriveConfigurationRows(application, readiness);
  const footprint = plan?.footprint ?? null;
  const components = new Map((footprint ? footprintComponentRows(footprint) : []).map((row) => [row.id, row]));
  const unresolved = openArchitectureQuestions(readiness);
  const consumed = new Set<number>();
  const pools: Pools = {
    resources: [...(plan?.awsResources ?? [])],
    costItems: new Map((plan?.costEstimate?.items ?? []).map((item) => [item.resourceId, item])),
  };

  if (settings.length === 0 && footprint === null) {
    return { groups: [], externalServices: [], unestimatedWorkload: false };
  }

  const setting = (id: string): ConfigurationRow | undefined => settings.find((row) => row.id === id);
  const applicationRows: InventoryRow[] = [];
  const dataRows: InventoryRow[] = [];
  const networkRows: InventoryRow[] = [];
  let unestimatedWorkload = false;

  // Application & runtime: the web workload, its build/runtime details, then
  // each further workload.
  const workloads = footprint?.workloads ?? [];
  const web = workloads.find((workload) => workload.role === 'web') ?? null;
  const webResources = takeResources(pools, WEB_RESOURCE_KINDS);
  applicationRows.push(
    emptyRow('web', components.get(web?.id ?? 'web')?.component ?? 'Web application', {
      configuration: sizingText(components.get(web?.id ?? 'web'), web?.compute.sizeLabel ?? null),
      resources: webResources,
      cost: takeCost(pools, [web?.id ?? 'web'], true),
      afterRemoval: afterRemovalFor(webResources) ?? (web ? 'Removed' : null),
    }),
  );
  for (const id of ['runtime', 'build', 'start', 'port', 'health']) {
    const row = setting(id);
    if (row) applicationRows.push(settingRow(row));
  }
  attachUnresolved(applicationRows.find((row) => row.id === 'port'), unresolved, 'port', consumed);

  const workerCommand = setting('worker');
  const otherWorkloads = workloads.filter((workload) => workload !== web);
  for (const workload of otherWorkloads) {
    const row = emptyRow(workload.id, components.get(workload.id)?.component ?? workload.label, {
      configuration: sizingText(components.get(workload.id), workload.compute.sizeLabel),
      cost: takeCost(pools, [workload.id], true),
      afterRemoval: 'Removed',
    });
    applicationRows.push(row);
    if (workload.id === 'worker' && workerCommand) applicationRows.push(settingRow(workerCommand, { id: 'worker-command' }));
  }
  if (otherWorkloads.length === 0 && workerCommand) {
    applicationRows.push(settingRow(workerCommand, { label: 'Background worker', indent: false }));
  } else if (workerCommand && !otherWorkloads.some((workload) => workload.id === 'worker')) {
    // Named workers carry no command of their own here; the saved worker
    // command (and its findings) still shows, once, after them.
    applicationRows.push(settingRow(workerCommand, { id: 'worker-command' }));
  }
  const firstWorker = applicationRows.find((row) => otherWorkloads.some((workload) => workload.id === row.id));
  if (!attachUnresolved(firstWorker, unresolved, 'worker_command', consumed)) {
    const worker = unresolved.find(({ item }) => item.kind === 'worker_command');
    if (worker) {
      unestimatedWorkload = true;
      const row = emptyRow('worker-detected', 'Background worker', {
        configuration: 'Background jobs detected',
        cost: 'not-estimated',
        afterRemoval: 'Not determined',
      });
      attachUnresolved(row, unresolved, 'worker_command', consumed);
      applicationRows.push(row);
    }
  }

  // Data services: database (+ migrations), cache, storage, then any other
  // planned resource through the same generic path.
  const footprintResources = footprint?.resources ?? [];
  const handledResourceIds = new Set<string>();
  // Matched by category, not id: a compiled footprint names its resources
  // itself ('mysql', 'redis', …).
  const serviceRow = (
    id: 'database' | 'redis' | 'storage',
    category: 'database' | 'cache' | 'storage',
  ): InventoryRow | null => {
    const row = setting(id);
    const resource = footprintResources.find((entry) => entry.category === category);
    if (!row && !resource) return null;
    if (resource) handledResourceIds.add(resource.id);
    const resources = takeResources(pools, [category]);
    const sizing = resource ? sizingText(components.get(resource.id), null) : null;
    const base = row ? settingRow(row, { indent: false }) : emptyRow(resource!.id, resource!.label, {});
    return {
      ...base,
      // Storage's value says whether the bucket is connected, which its
      // sizing ("S3") does not; the other services read best by their sizing.
      configuration: id === 'storage' ? (row?.value ?? sizing) : (sizing ?? base.configuration),
      resources,
      cost: takeCost(pools, resource ? [resource.id] : [], resource !== undefined || resources.length > 0),
      afterRemoval:
        afterRemovalFor(resources) ?? (resource ? (resource.lifecycle.retainOnDelete ? 'Kept' : 'Removed') : null),
    };
  };

  const database = serviceRow('database', 'database');
  if (database) dataRows.push(database);
  const migrations = setting('migrations');
  if (migrations) {
    const row = settingRow(migrations);
    attachUnresolved(row, unresolved, 'migration_strategy', consumed);
    dataRows.push(row);
  }
  const cache = serviceRow('redis', 'cache');
  if (cache) dataRows.push(cache);
  const storage = serviceRow('storage', 'storage');
  if (storage) dataRows.push(storage);

  for (const resource of footprintResources) {
    if (handledResourceIds.has(resource.id) || resource.category === 'network') continue;
    // 'other' is no component kind of its own — its AWS resources stay shared.
    const resources = resource.category === 'other' ? [] : takeResources(pools, [resource.category]);
    dataRows.push(
      emptyRow(resource.id, resource.label, {
        configuration: sizingText(components.get(resource.id), null),
        resources,
        cost: takeCost(pools, [resource.id], true),
        afterRemoval: afterRemovalFor(resources) ?? (resource.lifecycle.retainOnDelete ? 'Kept' : 'Removed'),
      }),
    );
  }

  // Networking & HTTPS: one row for the private network and the endpoint.
  const networkFootprint = footprintResources.filter((resource) => resource.category === 'network');
  const networkResources = takeResources(pools, NETWORK_RESOURCE_KINDS);
  if (networkResources.length > 0 || networkFootprint.length > 0) {
    networkRows.push(
      emptyRow('network', 'Networking & HTTPS', {
        resources: networkResources,
        cost: takeCost(pools, networkFootprint.map((resource) => resource.id), true),
        afterRemoval: afterRemovalFor(networkResources) ?? 'Removed',
      }),
    );
  }

  // Findings that belong to no setting, and questions that belong to no row.
  // A worker finding joins the worker row, so one worker never shows twice.
  const workerRow = applicationRows.find((row) => row.id === 'worker-detected' || row === firstWorker);
  for (const row of settings.filter((entry) => entry.id.startsWith('finding-'))) {
    const category = readiness.findings.find((finding) => finding.id === row.findingIds[0])?.category;
    if (category === 'workers' && workerRow) {
      workerRow.issues.push(...settingIssues(row).map((issue) => ({ ...issue, text: `${row.label}: ${issue.text ?? row.value}` })));
      workerRow.findingIds.push(...row.findingIds);
      continue;
    }
    applicationRows.push(settingRow(row));
  }
  for (const { item, index } of unresolved) {
    if (consumed.has(index)) continue;
    applicationRows.push(
      emptyRow(`question-${index}`, UNRESOLVED_LABELS[item.kind] ?? 'Detected component', {
        issues: [unresolvedIssue(item)],
        action: unresolvedAction(item, index),
        questionIndexes: [index],
      }),
    );
  }

  // External services are information, never a question: Deployz never
  // creates them. Their keys are chosen under Environment variables; the
  // data does not say which variables belong to which service.
  const externalServices = (readiness.architecture?.externalServices ?? []).map(externalServiceLabel);
  const integrations = externalServices.map((name, index) =>
    emptyRow(`integration-${index}`, name, {
      configuration: 'Connected directly. Deployz does not create it.',
      cost: 'billed-separately',
      action: {
        kind: 'link',
        href: '#environment-variables',
        label: 'Environment variables',
        testId: `integration-variables-${index}`,
      },
    }),
  );

  // Whatever no service owns stays visible, priced once.
  const sharedResources = takeResources(pools, pools.resources.map((resource) => resource.componentKind));
  const leftoverCost = pools.costItems.size > 0 ? summarizeCostItems([...pools.costItems.values()]) : null;
  if (sharedResources.length > 0 || leftoverCost !== null) {
    applicationRows.push(
      emptyRow('shared', 'Shared resources', {
        resources: sharedResources,
        cost: leftoverCost,
        afterRemoval: afterRemovalFor(sharedResources),
      }),
    );
  }

  const groups: InventoryGroup[] = (
    [
      ['application', applicationRows],
      ['data', dataRows],
      ['network', networkRows],
      ['integrations', integrations],
    ] as const
  )
    .filter(([, rows]) => rows.length > 0)
    .map(([id, rows]) => ({ id, label: INVENTORY_GROUP_LABELS[id], rows }));

  for (const row of groups.flatMap((group) => group.rows)) addBlockerDispute(row, readiness);

  return { groups, externalServices, unestimatedWorkload };
}
