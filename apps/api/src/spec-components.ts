/**
 * Spec-derived presentation (Phase 3 dynamic infrastructure) — the API-side
 * wiring that turns a deployment's frozen DeploymentSpecV2 into component
 * identity. Everything here is additive presentation: the fixed step ladder,
 * the 5-bucket provisioning summary and the legacy component list stay
 * untouched, and a missing, invalid or uncompiled spec degrades to
 * null/undefined — never a guessed component.
 */

import {
  INFRASTRUCTURE_COMPONENT_DISPLAY,
  derivePlanComponentsFromSpec,
  type DeploymentPlan,
  type DeploymentSpecV2,
  type PlanComponentAction,
  type PlanComponentKind,
} from '@deployz/contracts';
import { PLAN_COMPONENT_KIND_DISPLAY } from '@deployz/copy-map';

import type { StackEventLike } from './customer-activity.js';
import { readStoredDeploymentSpec } from './manifest.js';
import { CANCELLED_REASONS } from './stack-event-progress.js';

/** One entry of the status payloads' additive `specComponents` field. */
export interface SpecDerivedComponent {
  componentId: string;
  label: string;
  state: 'PENDING' | 'IN_PROGRESS' | 'COMPLETE' | 'FAILED';
}

/** Component identity derived from one spec's ownership records. */
interface SpecComponentIndex {
  componentIdByLogicalId: ReadonlyMap<string, string>;
  labelByLogicalId: ReadonlyMap<string, string>;
  labelByComponentId: ReadonlyMap<string, string>;
  /** Verification check name ('compute'/'database'/'cache'/'storage'/'ingress') → componentId. */
  componentIdByCheck: ReadonlyMap<string, string>;
}

function buildIndex(spec: DeploymentSpecV2): SpecComponentIndex | null {
  // An uncompiled spec has no ownership records — no identity exists to map.
  if (spec.ownershipRecords === null) return null;
  const labelByComponentId = new Map<string, string>();
  for (const entry of derivePlanComponentsFromSpec(spec)) {
    labelByComponentId.set(entry.componentId!, entry.name);
  }
  const componentIdByLogicalId = new Map<string, string>();
  for (const record of spec.ownershipRecords) {
    componentIdByLogicalId.set(record.logicalResourceId, record.componentId);
    // Supporting components (network, config secret, log group) have no plan
    // entry — their ownership kind's display name is the honest label.
    if (!labelByComponentId.has(record.componentId)) {
      labelByComponentId.set(
        record.componentId,
        record.componentKind === 'other'
          ? 'Supporting infrastructure'
          : INFRASTRUCTURE_COMPONENT_DISPLAY[record.componentKind].name,
      );
    }
  }
  const labelByLogicalId = new Map(
    [...componentIdByLogicalId].map(([logicalId, componentId]) => [logicalId, labelByComponentId.get(componentId)!]),
  );
  const componentIdByCheck = new Map(
    (spec.verificationContract?.checks ?? []).map((check) => [check.check, check.componentId]),
  );
  return { componentIdByLogicalId, labelByLogicalId, labelByComponentId, componentIdByCheck };
}

function indexFor(specV2: Record<string, unknown> | null): SpecComponentIndex | null {
  const spec = readStoredDeploymentSpec(specV2);
  return spec ? buildIndex(spec) : null;
}

/** logicalResourceId → spec component label, for the customer-activity fallback. Null without a compiled spec. */
export function specComponentLabelByLogicalId(specV2: Record<string, unknown> | null): ReadonlyMap<string, string> | null {
  return indexFor(specV2)?.labelByLogicalId ?? null;
}

/** logicalResourceId → { componentId, label }, for the failure-context identity. Null without a compiled spec. */
export function specComponentIdentityByLogicalId(
  specV2: Record<string, unknown> | null,
): ReadonlyMap<string, { componentId: string; label: string }> | null {
  const index = indexFor(specV2);
  if (!index) return null;
  return new Map(
    [...index.componentIdByLogicalId].map(([logicalId, componentId]) => [
      logicalId,
      { componentId, label: index.labelByComponentId.get(componentId) ?? 'Deployment resource' },
    ]),
  );
}

/**
 * The five catalog kinds whose plan wording the legacy plan builders own
 * (PLAN_COMPONENT_KIND_DISPLAY mirrors INFRASTRUCTURE_COMPONENT_DISPLAY for
 * them). Wire-level kinds keep the IR's own label.
 */
const CATALOG_PLAN_KINDS: ReadonlySet<PlanComponentKind> = new Set([
  'application',
  'endpoint',
  'database',
  'cache',
  'storage',
]);

/**
 * The plan components a frozen spec presents, for GET /api/deployments/:id/plan.
 * The five catalog kinds keep the exact wording and action semantics the plan
 * builder uses, so a simple deployment's plan is today's response plus
 * componentId/group; wire-level-only kinds (worker/queue/schedule) keep the
 * IR label verbatim ("Email worker" stays "Email worker").
 */
export function planComponentsFromSpec(
  spec: DeploymentSpecV2,
  action: 'install' | 'update' | 'destroy',
  newRelease: boolean,
): DeploymentPlan['components'] {
  const actionFor = (kind: PlanComponentKind, lifecycle: 'delete' | 'retain'): PlanComponentAction => {
    if (action === 'install') return 'CREATE';
    if (action === 'destroy') return lifecycle === 'retain' ? 'RETAIN' : 'DELETE';
    return kind === 'application' && newRelease ? 'UPDATE' : 'UNCHANGED';
  };
  // Only the first entry of a catalog kind takes the catalog name: a worker is
  // also an 'application' workload, and keeps its own label ("Background
  // worker") so a plan never lists "Application" twice.
  const named = new Set<PlanComponentKind>();
  return derivePlanComponentsFromSpec(spec).map((entry) => {
    const catalogName = CATALOG_PLAN_KINDS.has(entry.kind) && !named.has(entry.kind);
    named.add(entry.kind);
    return {
      kind: entry.kind,
      name: catalogName ? (PLAN_COMPONENT_KIND_DISPLAY[entry.kind] ?? entry.name) : entry.name,
      action: actionFor(entry.kind, entry.lifecycle),
      lifecycle: entry.lifecycle,
      componentId: entry.componentId,
      group: entry.group,
    };
  });
}

// ---------------------------------------------------------------------------
// specComponents — the additive per-component status list. Entries come from
// the INSTALL job's stack events mapped through ownership records; components
// the legacy list already reports fill in where events said nothing.
// ---------------------------------------------------------------------------

/** The legacy status-component key each verification check name backs. */
const CHECK_BY_LEGACY_KEY: Record<string, string> = {
  runtime: 'compute',
  database: 'database',
  storage: 'storage',
  redis: 'cache',
  https: 'ingress',
};

const STATE_BY_COMPONENT_STATUS: Record<string, SpecDerivedComponent['state']> = {
  READY: 'COMPLETE',
  IN_PROGRESS: 'IN_PROGRESS',
  FAILED: 'FAILED',
  PENDING: 'PENDING',
};

/** Bucket for logical ids the ownership map does not know — never dropped. */
const OTHER_COMPONENT_ID = 'other';
const OTHER_COMPONENT_LABEL = 'Other resources';

function isDebris(event: StackEventLike): boolean {
  return (
    event.resourceStatus.endsWith('_FAILED') &&
    event.resourceStatusReason !== null &&
    CANCELLED_REASONS.has(event.resourceStatusReason.trim())
  );
}

function eventState(status: string): SpecDerivedComponent['state'] {
  if (status.endsWith('_FAILED')) return 'FAILED';
  if (status.endsWith('_COMPLETE')) return 'COMPLETE';
  return 'IN_PROGRESS';
}

function aggregateEvents(
  index: SpecComponentIndex,
  events: readonly StackEventLike[],
): Map<string, SpecDerivedComponent['state']> {
  const byComponent = new Map<string, StackEventLike[]>();
  for (const event of events) {
    if (isDebris(event)) continue;
    const componentId = index.componentIdByLogicalId.get(event.logicalResourceId) ?? OTHER_COMPONENT_ID;
    const list = byComponent.get(componentId);
    if (list) list.push(event);
    else byComponent.set(componentId, [event]);
  }

  const states = new Map<string, SpecDerivedComponent['state']>();
  for (const [componentId, componentEvents] of byComponent) {
    // A failure anywhere in the history wins; completion is judged on each
    // resource's latest event, because its history also holds the IN_PROGRESS
    // event that preceded the COMPLETE one.
    let failed = false;
    const latestByResource = new Map<string, StackEventLike>();
    for (const event of componentEvents) {
      if (eventState(event.resourceStatus) === 'FAILED') failed = true;
      const latest = latestByResource.get(event.logicalResourceId);
      if (!latest || event.eventAt.getTime() > latest.eventAt.getTime()) {
        latestByResource.set(event.logicalResourceId, event);
      }
    }
    const allComplete = [...latestByResource.values()].every(
      (event) => eventState(event.resourceStatus) === 'COMPLETE',
    );
    states.set(componentId, failed ? 'FAILED' : allComplete ? 'COMPLETE' : 'IN_PROGRESS');
  }
  return states;
}

/**
 * The spec-derived component list for one status payload. Undefined when the
 * deployment has no compiled spec — the field is absent, never empty-by-guess.
 */
export function specComponentsForStatus(
  specV2: Record<string, unknown> | null,
  components: readonly { key: string; status: string }[],
  events: readonly StackEventLike[],
): SpecDerivedComponent[] | undefined {
  const spec = readStoredDeploymentSpec(specV2);
  if (!spec) return undefined;
  const index = buildIndex(spec);
  if (!index) return undefined;

  const aggregates = aggregateEvents(index, events);
  // Spec (plan) order first, then supporting components in first-seen order,
  // the unknown bucket last.
  const orderedIds: string[] = [];
  for (const entry of derivePlanComponentsFromSpec(spec)) {
    if (aggregates.has(entry.componentId!)) orderedIds.push(entry.componentId!);
  }
  for (const componentId of aggregates.keys()) {
    if (componentId !== OTHER_COMPONENT_ID && !orderedIds.includes(componentId)) orderedIds.push(componentId);
  }
  if (aggregates.has(OTHER_COMPONENT_ID)) orderedIds.push(OTHER_COMPONENT_ID);

  const entries: SpecDerivedComponent[] = orderedIds.map((componentId) => ({
    componentId,
    label: componentId === OTHER_COMPONENT_ID ? OTHER_COMPONENT_LABEL : index.labelByComponentId.get(componentId) ?? 'Deployment resource',
    state: aggregates.get(componentId)!,
  }));

  // Components the legacy list already reports, where events said nothing —
  // identity via the spec's verification contract, state carried across.
  const seen = new Set(orderedIds);
  for (const component of components) {
    if (component.status === 'NOT_REQUIRED') continue;
    const state = STATE_BY_COMPONENT_STATUS[component.status];
    if (state === undefined) continue;
    const check = CHECK_BY_LEGACY_KEY[component.key];
    const componentId = check ? index.componentIdByCheck.get(check) : undefined;
    if (!componentId || seen.has(componentId)) continue;
    seen.add(componentId);
    entries.push({
      componentId,
      label: index.labelByComponentId.get(componentId) ?? 'Deployment resource',
      state,
    });
  }
  return entries;
}
