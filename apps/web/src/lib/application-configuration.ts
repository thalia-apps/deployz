// Configuration-tab mapper — reduces the readiness detection facts, the
// server-computed database/cache/storage requirements, and any unresolved
// findings into one vendor-facing table: one row per setting, in a fixed
// order, with plain-English value/result/action words (never "Passed", never
// "Not required", never an em dash or an empty value).
//
// This module never re-derives detection or override logic itself — it reads
// `deriveReadinessRows`/`detectedFactRows` (the detection + override source
// of truth) and `readiness.requirements` (the database/cache/storage source
// of truth), then translates their output into the Configuration tab's own
// vocabulary and grouping.

import type { Application } from './applications';
import {
  databaseEngineName,
  detectedFactRows,
  deriveReadinessRows,
  type ApplicationReadiness,
  type DetectedFactRow,
  type EditableReadinessField,
  type ReadinessFinding,
  type ReadinessTableSetting,
} from './readiness';

export type ConfigurationResultLabel = 'Ready' | 'Not used' | 'Change required' | 'Recommended' | 'Needs review';
export type ConfigurationResultVariant = 'success' | 'secondary' | 'destructive' | 'warning';

export interface ConfigurationRowResult {
  label: ConfigurationResultLabel;
  variant: ConfigurationResultVariant;
}

export type ConfigurationRowAction =
  | { label: 'Edit' | 'Add' | 'Fix' | 'Connect'; kind: 'edit'; field: EditableReadinessField }
  | { label: 'Fix'; kind: 'fix' }
  | null;

export interface ConfigurationRow {
  id: string;
  label: string;
  value: string;
  detail: string | null;
  result: ConfigurationRowResult;
  action: ConfigurationRowAction;
  blocking: boolean;
  help: string | null;
  findingIds: string[];
}

export interface AnalysisDetail {
  id: string;
  label: string;
  lines: string[];
}

const READY: ConfigurationRowResult = { label: 'Ready', variant: 'success' };
const NOT_USED: ConfigurationRowResult = { label: 'Not used', variant: 'secondary' };
const CHANGE_REQUIRED: ConfigurationRowResult = { label: 'Change required', variant: 'destructive' };
const RECOMMENDED: ConfigurationRowResult = { label: 'Recommended', variant: 'warning' };
const NEEDS_REVIEW: ConfigurationRowResult = { label: 'Needs review', variant: 'warning' };

// Every deployment gets an S3 bucket regardless of this setting — it is
// always created and kept if the deployment is uninstalled, and the compiler
// always sets STORAGE_BUCKET, S3_BUCKET, AWS_S3_BUCKET and AWS_REGION. The
// setting only controls whether Deployz also fills the other storage
// variables the app reads (install-config.ts, compile.ts aliases), so the
// help text (and the value words) say "connected", never "used" — "Not used"
// would wrongly suggest no bucket exists.
const STORAGE_HELP =
  'Every deployment gets a storage bucket, kept after uninstall. Deployz always gives your app the bucket name in STORAGE_BUCKET, S3_BUCKET and AWS_S3_BUCKET, and the AWS Region in AWS_REGION. This setting controls whether Deployz also fills the other storage variables that your app reads.';
const STORAGE_CONNECTED_VALUE = 'Connected (storage variables filled)';
const STORAGE_NOT_CONNECTED_VALUE = 'Bucket created, not connected';

const CATEGORY_TO_ROW_ID: Record<string, string | undefined> = {
  database: 'database',
  cache: 'redis',
  storage: 'storage',
  health: 'health',
  network: 'port',
  workers: 'worker',
};

/** Every fixed row id the settings section can render, in the required order. */
const SETTING_ROW_IDS = [
  'runtime',
  'build',
  'start',
  'port',
  'health',
  'database',
  'redis',
  'storage',
  'migrations',
  'worker',
] as const;

/** Whether a row id belongs to the fixed setting rows (as opposed to a
 *  finding-only row created for an unmapped category). */
export function isSettingRowId(id: string): boolean {
  return (SETTING_ROW_IDS as readonly string[]).includes(id);
}

function byId(rows: ReadinessTableSetting[]): Map<string, ReadinessTableSetting> {
  return new Map(rows.map((row) => [row.id, row]));
}

// Runtime/build/start/port are facts Deployz needs from the repository — an
// undetected one is a gap to review, not a toggle the vendor turned off.
function coreFactRow(found: boolean): ConfigurationRowResult {
  return found ? READY : NEEDS_REVIEW;
}

// Database/cache/storage/health-check/migrations are optional capabilities —
// an unconfigured one is simply not used, never a gap.
function optionalRow(used: boolean): ConfigurationRowResult {
  return used ? READY : NOT_USED;
}

function buildRuntimeRow(facts: Map<string, DetectedFactRow>): ConfigurationRow {
  const runtime = facts.get('runtime');
  const framework = facts.get('framework');
  const found = runtime?.found === true;
  const value = found && framework?.found ? `${runtime.value} · ${framework.value}` : found ? runtime.value : 'Not detected';
  return {
    id: 'runtime',
    label: 'Runtime',
    value,
    detail: null,
    result: coreFactRow(found),
    action: null,
    blocking: false,
    help: null,
    findingIds: [],
  };
}

// A build step is optional (many apps build entirely in their Dockerfile),
// and it has no UI setting, so a missing one is never a warning.
function buildFactRow(id: 'build' | 'start', label: string, facts: Map<string, DetectedFactRow>): ConfigurationRow {
  const fact = facts.get(id);
  const found = fact?.found === true;
  return {
    id,
    label,
    value: found ? fact.value : id === 'build' ? 'None' : 'Not detected',
    detail: null,
    result: id === 'build' ? optionalRow(found) : coreFactRow(found),
    action: null,
    blocking: false,
    help: null,
    findingIds: [],
  };
}

function detailForOverride(row: ReadinessTableSetting): string | null {
  return row.overridden && row.detectedValue ? `Set by you · detected: ${row.detectedValue}` : null;
}

function buildPortRow(settings: Map<string, ReadinessTableSetting>): ConfigurationRow {
  const row = settings.get('port');
  const hasValue = row !== undefined && row.value !== '';
  return {
    id: 'port',
    label: 'Port',
    value: hasValue ? row!.value : 'Not detected',
    detail: row ? detailForOverride(row) : null,
    result: row?.overridden ? READY : coreFactRow(hasValue),
    action: { label: 'Edit', kind: 'edit', field: 'containerPort' },
    blocking: false,
    help: null,
    findingIds: [],
  };
}

/** Health check and migrations: optional editable fields that go from "Add"
 *  to "Edit" once a value exists, using the same effective/detected/override
 *  values `deriveReadinessRows` already resolved. */
function buildOptionalFieldRow(
  id: 'health' | 'migrations',
  label: string,
  field: EditableReadinessField,
  emptyValueWord: string,
  settings: Map<string, ReadinessTableSetting>,
): ConfigurationRow {
  const row = settings.get(id);
  const hasValue = row !== undefined && row.value !== '';
  return {
    id,
    label,
    value: hasValue ? row!.value : emptyValueWord,
    detail: row ? detailForOverride(row) : null,
    result: row?.overridden ? READY : optionalRow(hasValue),
    action: { label: hasValue ? 'Edit' : 'Add', kind: 'edit', field },
    blocking: false,
    help: null,
    findingIds: [],
  };
}

/** Database/cache: the server-computed requirements summary is the only
 *  source of truth for effective/detected/overridden — reading it directly
 *  here (rather than the display text `deriveReadinessRows` builds for the
 *  old readiness table) keeps the "Not used" copy correct even when a vendor
 *  override disagrees with what was detected. (Storage has its own row
 *  builder below — a bucket always exists, so its value/help words differ.) */
function buildRequirementRow(
  id: 'database' | 'redis',
  label: string,
  field: EditableReadinessField,
  usedValue: string,
  requirements: ApplicationReadiness['requirements'],
): ConfigurationRow {
  const requirement = requirements?.[id];
  if (!requirement) {
    return {
      id,
      label,
      value: 'Needs review',
      detail: null,
      result: NEEDS_REVIEW,
      action: { label: 'Add', kind: 'edit', field },
      blocking: false,
      help: null,
      findingIds: [],
    };
  }
  const used = requirement.effective;
  const detail = requirement.overridden
    ? `Set by you · detected: ${requirement.detected ? usedValue : 'Not used'}`
    : null;
  return {
    id,
    label,
    value: used ? usedValue : 'Not used',
    detail,
    result: requirement.overridden || used ? READY : NOT_USED,
    action: { label: used ? 'Edit' : 'Add', kind: 'edit', field },
    blocking: false,
    help: null,
    findingIds: [],
  };
}

/** File storage: every deployment gets an S3 bucket regardless of this
 *  setting (always created, retained on uninstall) — only whether Deployz
 *  fills the app's other storage variables is optional. The
 *  value words and help text always say so, unlike the other requirement
 *  rows where "Not used" is accurate on its own. */
function buildStorageRow(requirements: ApplicationReadiness['requirements']): ConfigurationRow {
  const requirement = requirements?.storage;
  if (!requirement) {
    return {
      id: 'storage',
      label: 'File storage',
      value: 'Needs review',
      detail: null,
      result: NEEDS_REVIEW,
      action: { label: 'Connect', kind: 'edit', field: 'storageRequired' },
      blocking: false,
      help: STORAGE_HELP,
      findingIds: [],
    };
  }
  const used = requirement.effective;
  const valueFor = (connected: boolean): string => (connected ? STORAGE_CONNECTED_VALUE : STORAGE_NOT_CONNECTED_VALUE);
  const detail = requirement.overridden ? `Set by you · detected: ${valueFor(requirement.detected)}` : null;
  return {
    id: 'storage',
    label: 'File storage',
    value: valueFor(used),
    detail,
    result: requirement.overridden || used ? READY : NOT_USED,
    action: { label: used ? 'Edit' : 'Connect', kind: 'edit', field: 'storageRequired' },
    blocking: false,
    help: STORAGE_HELP,
    findingIds: [],
  };
}

function buildWorkerRow(workerCommand: string): ConfigurationRow {
  return {
    id: 'worker',
    label: 'Background worker',
    value: workerCommand,
    detail: null,
    result: READY,
    action: null,
    blocking: false,
    help: null,
    findingIds: [],
  };
}

/** The Fix action for a row carrying a required finding: an editable field
 *  when `requiredChangeFix` resolves to one (the port or the migration choice),
 *  otherwise the Fix-instructions dialog. */
function fixAction(required: ReadinessFinding | undefined): ConfigurationRowAction {
  if (!required) return { label: 'Fix', kind: 'fix' };
  const fix = requiredChangeFix(required);
  return fix.kind === 'edit' ? { label: 'Fix', kind: 'edit', field: fix.field } : { label: 'Fix', kind: 'fix' };
}

function buildExtraFindingRow(finding: ReadinessFinding): ConfigurationRow {
  const required = finding.severity === 'required';
  return {
    id: `finding-${finding.id}`,
    label: requiredChangeLabel(finding),
    value: finding.suggestedOutcome,
    detail: null,
    result: required ? CHANGE_REQUIRED : RECOMMENDED,
    action: fixAction(required ? finding : undefined),
    blocking: required,
    help: finding.plainEnglishExplanation,
    findingIds: [finding.id],
  };
}

/** Fold a row's mapped findings in: a required finding always wins the
 *  result and routes Fix the same way the required-changes panel does
 *  (`requiredChangeFix`) — a health row's Fix opens instructions, a port
 *  row's Fix opens the port editor, never the other way round. A
 *  recommended-only row keeps its own action, so the setting stays editable;
 *  a row with no action of its own opens the instructions dialog. */
function applyFindings(row: ConfigurationRow, findings: ReadinessFinding[]): ConfigurationRow {
  if (findings.length === 0) return row;
  const required = findings.find((finding) => finding.severity === 'required');
  const chosen = required ?? findings[0]!;
  return {
    ...row,
    result: required ? CHANGE_REQUIRED : RECOMMENDED,
    blocking: required !== undefined,
    action: required || !row.action ? fixAction(required) : row.action,
    help: chosen.plainEnglishExplanation,
    findingIds: findings.map((finding) => finding.id),
  };
}

function sortRows(rows: ConfigurationRow[]): ConfigurationRow[] {
  const rank = (row: ConfigurationRow): number => {
    if (row.blocking) return 0;
    if (row.result.label === 'Recommended' || row.result.label === 'Needs review') return 1;
    return 2;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

/**
 * Build the Configuration tab's setting rows. Returns an empty list while
 * analysis has not completed (or completed without any detected facts, which
 * only a legacy analysis result could leave null) — there is nothing real to
 * show yet, never a fabricated row.
 */
export function deriveConfigurationRows(application: Application, readiness: ApplicationReadiness): ConfigurationRow[] {
  if (readiness.analysisStatus !== 'COMPLETE' || !readiness.detected) return [];

  const settings = byId(
    deriveReadinessRows(application, readiness).filter(
      (row): row is ReadinessTableSetting => row.kind === 'setting',
    ),
  );

  const facts = new Map(detectedFactRows(readiness.detected).map((fact) => [fact.id, fact]));

  const rows: ConfigurationRow[] = [
    buildRuntimeRow(facts),
    buildFactRow('build', 'Build command', facts),
    buildFactRow('start', 'Start command', facts),
    buildPortRow(settings),
    buildOptionalFieldRow('health', 'Health check', 'healthPath', 'Not set', settings),
    buildRequirementRow(
      'database',
      'Database',
      'databaseRequired',
      `${databaseEngineName(readiness.detected.database.type)} database`,
      readiness.requirements,
    ),
    buildRequirementRow('redis', 'Cache / queue', 'redisRequired', 'Redis cache', readiness.requirements),
    buildStorageRow(readiness.requirements),
    buildOptionalFieldRow('migrations', 'Database migrations', 'migrationCommand', 'None', settings),
  ];
  if (application.workerCommand) rows.push(buildWorkerRow(application.workerCommand));

  const rowIds = new Set(rows.map((row) => row.id));
  const findingsByRow = new Map<string, ReadinessFinding[]>();
  const extraRows: ConfigurationRow[] = [];

  const databaseUsed = readiness.requirements?.database.effective !== false;
  for (const finding of readiness.findings) {
    if (finding.id === 'database-migrations' && !databaseUsed) continue;
    const targetId = CATEGORY_TO_ROW_ID[finding.category];
    if (targetId && rowIds.has(targetId)) {
      const existing = findingsByRow.get(targetId) ?? [];
      existing.push(finding);
      findingsByRow.set(targetId, existing);
    } else {
      extraRows.push(buildExtraFindingRow(finding));
    }
  }

  const settingRows = rows.map((row) => applyFindings(row, findingsByRow.get(row.id) ?? []));
  return sortRows([...settingRows, ...extraRows]);
}

/** How a required finding is resolved: an application setting the API
 *  reconciles on save, or a repository change followed by a new analysis. */
export type RequiredChangeFix = { kind: 'edit'; field: EditableReadinessField } | { kind: 'instructions' };

const REQUIRED_CHANGE_LABELS: Record<string, string> = {
  'container-setup': 'Add container build instructions (Dockerfile)',
  'health-check': 'Add a health check route',
  'port-unresolved': 'Set the port your app listens on',
  'start-command-missing': 'Add a start command to the Dockerfile',
  'localhost-binding': 'Listen on all network interfaces, not only localhost',
  'local-file-storage': 'Store files in object storage, not on the local disk',
  'build-context-git-metadata': 'Stop copying .git into the container build',
  'migration-command-needs-input': 'Choose how database migrations run',
};

/** A plain-language label for a finding. Unknown findings keep their own title. */
export function requiredChangeLabel(finding: Pick<ReadinessFinding, 'id' | 'title'>): string {
  return REQUIRED_CHANGE_LABELS[finding.id] ?? finding.title;
}

/** Only the findings in the API's RESOLVABLE_FINDINGS clear when a setting is
 *  saved. Every other finding needs a repository change and a new analysis.
 *  Only the port and migration findings have an editor on this tab. */
export function requiredChangeFix(finding: Pick<ReadinessFinding, 'id'>): RequiredChangeFix {
  if (finding.id === 'port-unresolved') return { kind: 'edit', field: 'containerPort' };
  if (finding.id === 'migration-command-needs-input') return { kind: 'edit', field: 'migrationCommand' };
  return { kind: 'instructions' };
}

/** One entry in the "Required changes" panel at the top of the Configuration
 *  tab — every finding that blocks deployment, independent of the settings
 *  table row layout below it. */
export interface RequiredChange {
  finding: ReadinessFinding;
  label: string;
  explanation: string;
  fix: RequiredChangeFix;
}

/** Every required (blocking) finding, in the order the API returned them.
 *  Empty before analysis has completed — there is nothing to require yet. */
export function deriveRequiredChanges(readiness: ApplicationReadiness): RequiredChange[] {
  if (readiness.analysisStatus !== 'COMPLETE') return [];
  return readiness.findings
    .filter((finding) => finding.severity === 'required')
    .map((finding) => ({
      finding,
      label: requiredChangeLabel(finding),
      explanation: finding.plainEnglishExplanation || finding.suggestedOutcome,
      fix: requiredChangeFix(finding),
    }));
}

/**
 * The collapsed "Analysis details" section: the raw detection evidence
 * (file + reason) behind each detected fact, plus the list of checks the
 * server reported as passed. Neither belongs in the settings table itself —
 * that table shows the vendor's configuration, not the analyser's audit
 * trail.
 */
export function deriveAnalysisDetails(readiness: ApplicationReadiness): AnalysisDetail[] {
  const details: AnalysisDetail[] = [];

  if (readiness.detected) {
    for (const fact of detectedFactRows(readiness.detected)) {
      if (fact.evidence.length === 0) continue;
      details.push({
        id: fact.id,
        label: fact.label,
        lines: fact.evidence.map((item) => (item.file ? `${item.file} — ${item.reason}` : item.reason)),
      });
    }
  }

  if (readiness.passed.length > 0) {
    details.push({
      id: 'checks-completed',
      label: 'Checks completed',
      lines: readiness.passed.map((check) => check.label),
    });
  }

  return details;
}
