/**
 * Repository reports and the summary (prompt 4.4). Pure functions of the
 * Analysis result, the observation, the claim verdicts and the optional
 * full run. Tuning and holdout repositories are always reported apart.
 */
import {
  REPOSITORY_SETS,
  type AnalysisResultFile,
  type ClaimVerdict,
  type DeployOutcome,
  type FullRun,
  type Observation,
  type Recipe,
  type RepositoryReport,
  type SummaryReport,
} from '../contract.js';
import { LOCAL_STATE_REASON } from '../claims/extract.js';

const MAX_PROBLEM_TEXT = 160;

type Readiness = NonNullable<RepositoryReport['readiness']>;

/**
 * The full run's health, or null when there is no full run or when it failed
 * on a limit of the test (QEMU crashed the app, or it needs the internet).
 */
export function fullRunHealth(fullRun: Pick<FullRun, 'webHealthy' | 'infrastructureFailures'> | null): boolean | null {
  if (fullRun === null) return null;
  if (fullRun.webHealthy) return true;
  const limited = fullRun.infrastructureFailures.some((note) => note.startsWith('emulation') || note.startsWith('needs internet'));
  return limited ? null : false;
}

const UNSTABLE_FULL_RUN = 'unstable full run: one full run is healthy and the other is not';

/**
 * The health of both full runs (the same rule as unstable observation facts):
 * true or false only when both runs agree. `unstable` is true when one run is
 * healthy and the other is not. A full run from before the repeat counts alone.
 */
export function fullRunsHealth(fullRun: FullRun | null): { healthy: boolean | null; unstable: boolean } {
  const first = fullRunHealth(fullRun);
  if (fullRun?.repeat === undefined) return { healthy: first, unstable: false };
  const second = fullRunHealth(fullRun.repeat);
  if (first === null || second === null) return { healthy: null, unstable: false };
  return first === second ? { healthy: first, unstable: false } : { healthy: null, unstable: true };
}

function limitOf(fullRun: FullRun): string {
  const limited = fullRunHealth(fullRun) === null ? fullRun : (fullRun.repeat ?? fullRun);
  return limited.infrastructureFailures[0] ?? '';
}

/**
 * The readiness verdict comes from the full run, not from the observation.
 * READY is right when the full run is healthy. NOT_COMPATIBLE is right when
 * it is not. NEEDS_CONFIGURATION stays open: the full run already supplies
 * the recipe inputs, so it cannot show whether configuration was needed.
 */
function decideReadiness(verdict: ClaimVerdict, state: Readiness, fullRun: FullRun | null, unbuildable: boolean): ClaimVerdict {
  if (fullRun === null && unbuildable) {
    // No image means no deployment: only NOT_COMPATIBLE is right.
    const facts = { ...verdict, facts: ['build' as const], unstable: false };
    return state === 'NOT_COMPATIBLE'
      ? { ...facts, verdict: 'CONFIRMED', reason: 'the image does not build' }
      : { ...facts, verdict: 'CONTRADICTED', observed: 'not buildable', reason: 'the image does not build' };
  }
  if (fullRun === null) return verdict;
  const { healthy, unstable } = fullRunsHealth(fullRun);
  const facts = { ...verdict, facts: [], arch: fullRun.arch, unstable };
  if (unstable) return { ...facts, verdict: 'NOT_CHECKABLE', reason: UNSTABLE_FULL_RUN };
  if (healthy === null) {
    return { ...facts, verdict: 'NOT_CHECKABLE', reason: `the full run hit a limit of the test: ${limitOf(fullRun)}` };
  }
  if (state === 'NEEDS_CONFIGURATION') {
    return { ...facts, verdict: 'NOT_CHECKABLE', reason: 'the full run supplies the recipe inputs, so it cannot show whether configuration was needed' };
  }
  const right = state === 'READY' ? healthy : !healthy;
  if (right) return { ...facts, verdict: 'CONFIRMED', reason: healthy ? 'the full run is healthy' : 'the full run is not healthy' };
  return {
    ...facts,
    verdict: 'CONTRADICTED',
    observed: healthy ? 'healthy' : 'not healthy',
    reason: healthy ? 'the full run is healthy' : 'the full run is not healthy',
  };
}

function shorten(text: string): string {
  return text.length > MAX_PROBLEM_TEXT ? `${text.slice(0, MAX_PROBLEM_TEXT - 3)}...` : text;
}

/**
 * A false problem is a fix or a vendor decision that the Analysis asked for
 * and that the application did not need:
 *  - NOT_COMPATIBLE (each `unsupported` reason) while the application is
 *    healthy: the full run, or without one the observation. A local-state
 *    reason is not one when the check confirms the local state;
 *  - a required variable that the application starts without;
 *  - a managed database or Valkey that the application never used;
 *  - gate findings that ask the vendor for something the observation shows
 *    unneeded: a database variable (the app connected), a health path (a path
 *    answers 200), a migration command (the app migrates at start), a
 *    Dockerfile (one builds).
 */
function falseProblems(
  analysis: AnalysisResultFile,
  verdicts: readonly ClaimVerdict[],
  observation: Observation,
  fullRun: FullRun | null,
  vendorInputs: Recipe['vendorInputs'],
): string[] {
  const gate = analysis.gate;
  if (gate === null) return [];
  const run = observation.runs[0]!;
  const problems: string[] = [];
  const find = (type: ClaimVerdict['claim']['type']) => verdicts.find((entry) => entry.claim.type === type);
  const findings = (id: string) => gate.findings.filter((finding) => finding.id === id);

  const healthy = fullRun !== null ? fullRunsHealth(fullRun).healthy === true : run.webHealthy.status === 'observed' && run.webHealthy.value === true;
  if (gate.state === 'NOT_COMPATIBLE' && healthy) {
    const localState = find('storage.local')?.verdict === 'CONFIRMED';
    for (const finding of findings('unsupported')) {
      if (localState && LOCAL_STATE_REASON.test(finding.message)) continue;
      problems.push(`NOT_COMPATIBLE but the application is healthy: ${shorten(finding.message)}`);
    }
  }

  for (const entry of verdicts) {
    const { claim } = entry;
    if (entry.verdict !== 'CONTRADICTED') continue;
    if (claim.type === 'env.required') problems.push(`${claim.subject} is required, but the application starts without it`);
    if (claim.type === 'database.engine' && claim.value !== 'none' && entry.observed === 'none') {
      problems.push(`a managed ${claim.value} database is required, but the application made no SQL connection`);
    }
    if (claim.type === 'redis.required' && claim.value === true) {
      problems.push(entry.observed === false && entry.reason === 'the app starts without Redis'
        ? 'Valkey is required, but the application starts without it'
        : 'Valkey is required, but the application made no connection');
    }
  }

  const database = find('database.engine');
  // A recipe input that wires the database itself (an install string that names ${DB_HOST}) is the vendor's confirmation.
  const wiredByVendor = vendorInputs.some(
    (input) => input.source.kind === 'fixed' && /\$\{?(?:DB|DATABASE|MYSQL|POSTGRES|PG)_?[A-Z]*\}?/.test(input.source.value),
  );
  if (database?.verdict === 'CONFIRMED' && !wiredByVendor && findings('database-connection-unverified').length > 0) {
    problems.push('the database variable is unverified, but the application connected with the standard bindings');
  }
  const paths = run.httpPaths.status === 'observed' ? (run.httpPaths.value ?? []) : [];
  if (findings('health-path-required').length > 0 && paths.some((check) => check.status === 200)) {
    problems.push('a health path is required, but a probed path answers 200');
  }
  const startup = run.startupMigration.status === 'observed' ? run.startupMigration.value : null;
  if (findings('migration-command-needs-input').length > 0 && startup?.tablesCreatedByStart === true) {
    problems.push('a migration command is required, but the application migrates at start');
  }
  if (findings('dockerfile-missing').length > 0 && find('dockerfile')?.verdict === 'CONTRADICTED') {
    problems.push('no Dockerfile was found, but the repository builds one');
  }
  return problems;
}

const PREDICTED: Record<Readiness, DeployOutcome> = { READY: 1, NEEDS_CONFIGURATION: 2, NOT_COMPATIBLE: 3 };

/**
 * The actual outcome. 1: the application is healthy with the analysed
 * settings and needs no vendor input. 2: it is healthy only with vendor
 * inputs, or a reviewed recipe patch makes it deployable. 3: it is not
 * healthy and no reviewed patch exists. Null when the runs do not decide.
 */
export function actualOutcome(recipe: Partial<Pick<Recipe, 'vendorInputs' | 'outcomePatch'>>, healthy: boolean | null): DeployOutcome | null {
  if (healthy === true) return (recipe.vendorInputs ?? []).length > 0 ? 2 : 1;
  if (recipe.outcomePatch !== undefined) return 2;
  return healthy === false ? 3 : null;
}

export function repositoryReport(
  recipe: Pick<Recipe, 'id' | 'set'> & Partial<Pick<Recipe, 'vendorInputs' | 'outcomePatch'>>,
  analysis: AnalysisResultFile,
  observation: Observation,
  verdicts: readonly ClaimVerdict[],
  fullRun: FullRun | null,
): RepositoryReport {
  const readiness = analysis.gate?.state ?? null;
  const build = observation.runs[0]!.build;
  const unbuildable = build.value?.ok === false && build.value.failure === 'dockerfile' && build.arch !== 'arm64-native';
  const { healthy: fullHealth, unstable: unstableFullRun } = fullRunsHealth(fullRun);
  const decided = verdicts.map((entry) => {
    if (entry.claim.type === 'readiness' && readiness !== null) return decideReadiness(entry, readiness, fullRun, unbuildable);
    // The observation gives every app Valkey, so an app that uses it only when present looks like it needs it.
    // The full run has no Valkey when the claim is false: a healthy full run confirms the claim.
    if (entry.claim.type === 'redis.required' && entry.claim.value === false && entry.verdict !== 'CONFIRMED' && fullHealth === true) {
      return { ...entry, verdict: 'CONFIRMED' as const, reason: 'the full run without Valkey is healthy', observed: undefined };
    }
    // A recipe input that switches the migration on at start (miniflux RUN_MIGRATIONS=1) is the vendor's choice:
    // the start migrates because of it, which does not show that the application has no other migration path.
    if (
      entry.claim.type === 'migration.mode' &&
      entry.verdict === 'CONTRADICTED' &&
      entry.observed === 'startup' &&
      (recipe.vendorInputs ?? []).some((input) => /MIGRAT/i.test(input.name))
    ) {
      return { ...entry, verdict: 'NOT_CHECKABLE' as const, reason: 'a recipe input switches the migration on at start', observed: undefined };
    }
    return entry;
  });
  const healthy = fullRun === null && unbuildable ? false : fullHealth;
  const failures = [
    ...observation.runs.flatMap((run) => run.infrastructureFailures),
    ...(fullRun?.infrastructureFailures ?? []),
    ...(fullRun?.repeat?.infrastructureFailures ?? []),
  ];

  return {
    id: recipe.id,
    set: recipe.set,
    repository: observation.repository,
    commit: observation.commit,
    analyser: analysis.analyser,
    arch: observation.runs[0]!.build.arch,
    readiness,
    verdicts: decided,
    healthyWithAnalysedSettings: healthy,
    hiddenProblem: readiness === 'READY' && (fullHealth === false || (fullRun === null && unbuildable)),
    unstableFullRun,
    falseProblems: falseProblems(analysis, decided, observation, fullRun, recipe.vendorInputs ?? []),
    vendorQuestions: analysis.vendorQuestions,
    unstableFacts: observation.unstable,
    infrastructureFailures: [...new Set(failures)],
    outcome: { predicted: readiness === null ? null : PREDICTED[readiness], actual: actualOutcome(recipe, healthy) },
  };
}

function count(into: Record<string, number>, key: string): void {
  into[key] = (into[key] ?? 0) + 1;
}

const OUTCOMES = ['1', '2', '3'] as const;

/** `matrix[predicted][actual]` over the repositories whose actual outcome the runs decide. */
function outcomeMatrix(reports: readonly RepositoryReport[]): Record<(typeof OUTCOMES)[number], Record<(typeof OUTCOMES)[number], number>> {
  const row = () => ({ '1': 0, '2': 0, '3': 0 });
  const matrix = { '1': row(), '2': row(), '3': row() };
  for (const { outcome } of reports) {
    if (outcome.predicted !== null && outcome.actual !== null) matrix[`${outcome.predicted}`][`${outcome.actual}`] += 1;
  }
  return matrix;
}

/** `runtimes` maps a repository id to `manifest.application.runtime`. */
export function summaryReport(
  reports: readonly RepositoryReport[],
  analyser: string,
  options: { runtimes?: Readonly<Record<string, string>>; generatedAt?: string } = {},
): SummaryReport {
  const sets = REPOSITORY_SETS.flatMap((set) => {
    const inSet = reports.filter((report) => report.set === set);
    if (inSet.length === 0) return [];
    const contradictedByClaimType: Record<string, number> = {};
    const contradictedByRuntime: Record<string, number> = {};
    const notCheckableReasons: Record<string, number> = {};
    for (const report of inSet) {
      for (const entry of report.verdicts) {
        if (entry.verdict === 'CONTRADICTED') {
          count(contradictedByClaimType, entry.claim.type);
          count(contradictedByRuntime, options.runtimes?.[report.id] ?? 'unknown');
        }
        if (entry.verdict === 'NOT_CHECKABLE') count(notCheckableReasons, entry.reason);
      }
    }
    return [
      {
        set,
        repositories: inSet.length,
        healthyWithAnalysedSettings: inSet.filter((report) => report.healthyWithAnalysedSettings === true).length,
        hiddenProblems: inSet.filter((report) => report.hiddenProblem).map((report) => report.id),
        unstableFullRuns: inSet.filter((report) => report.unstableFullRun).map((report) => report.id),
        falseProblems: inSet.flatMap((report) => report.falseProblems.map((problem) => ({ id: report.id, problem }))),
        outcomes: outcomeMatrix(inSet),
        falseDeployable: inSet.filter(({ outcome }) => outcome.predicted === 1 && outcome.actual !== null && outcome.actual !== 1).map((report) => report.id),
        falseNotDeployable: inSet.filter(({ outcome }) => outcome.predicted === 3 && outcome.actual !== null && outcome.actual !== 3).map((report) => report.id),
        contradictedByClaimType,
        contradictedByRuntime,
        notCheckableReasons,
        unstableFacts: inSet.flatMap((report) => report.unstableFacts.map((fact) => ({ id: report.id, fact }))),
        vendorQuestions: Object.fromEntries(inSet.map((report) => [report.id, report.vendorQuestions])),
      },
    ];
  });
  return { schemaVersion: 1, analyser, generatedAt: options.generatedAt ?? new Date().toISOString(), sets };
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function table(headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string[] {
  if (rows.length === 0) return ['None.', ''];
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map((value) => cell(String(value))).join(' | ')} |`),
    '',
  ];
}

function countRows(counts: Readonly<Record<string, number>>): [string, number][] {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function renderMarkdown(summary: SummaryReport, reports: readonly RepositoryReport[]): string {
  const lines = [`# Run-and-check summary: ${summary.analyser}`, '', `Generated ${summary.generatedAt}.`, ''];
  for (const set of summary.sets) {
    const percent = Math.round((set.healthyWithAnalysedSettings / set.repositories) * 100);
    lines.push(
      `## Set: ${set.set}`,
      '',
      `- Repositories: ${set.repositories}`,
      `- Healthy with analysed settings: ${set.healthyWithAnalysedSettings} of ${set.repositories} (${percent}%)`,
      `- Hidden problems: ${set.hiddenProblems.length > 0 ? set.hiddenProblems.join(', ') : 'none'}`,
      `- Unstable full runs: ${set.unstableFullRuns.length > 0 ? set.unstableFullRuns.join(', ') : 'none'}`,
      `- False problems: ${set.falseProblems.length}`,
      `- Predicted deployable, actually not (must be 0): ${set.falseDeployable.length > 0 ? set.falseDeployable.join(', ') : 'none'}`,
      `- Predicted not deployable, actually deployable: ${set.falseNotDeployable.length > 0 ? set.falseNotDeployable.join(', ') : 'none'}`,
      '',
      '### Outcomes (rows: predicted, columns: actual)',
      '',
      '1 = deployable with Deployz, 2 = deployable with changes, 3 = not deployable. Repositories whose runs do not decide the outcome are left out.',
      '',
      ...table(
        ['Predicted', 'Actual 1', 'Actual 2', 'Actual 3'],
        OUTCOMES.map((predicted) => [predicted, ...OUTCOMES.map((actual) => set.outcomes[predicted]?.[actual] ?? 0)]),
      ),
      '### Repositories',
      '',
      ...table(
        ['Id', 'Repository', 'Readiness', 'Healthy', 'Hidden', 'False', 'Contradicted', 'Vendor questions'],
        reports
          .filter((report) => report.set === set.set)
          .map((report) => [
            report.id,
            report.repository,
            report.readiness ?? 'failed',
            report.unstableFullRun
              ? 'unstable'
              : report.healthyWithAnalysedSettings === null
                ? 'no full run'
                : report.healthyWithAnalysedSettings
                  ? 'yes'
                  : 'no',
            report.hiddenProblem ? 'yes' : 'no',
            report.falseProblems.length,
            report.verdicts.filter((entry) => entry.verdict === 'CONTRADICTED').length,
            report.vendorQuestions,
          ]),
      ),
      '### Hidden problems',
      '',
      ...(set.hiddenProblems.length > 0 ? [...set.hiddenProblems.map((id) => `- ${id}`), ''] : ['None.', '']),
      '### False problems',
      '',
      ...table(['Id', 'Problem'], set.falseProblems.map((entry) => [entry.id, entry.problem])),
      '### CONTRADICTED claims per claim type',
      '',
      ...table(['Claim type', 'Count'], countRows(set.contradictedByClaimType)),
      '### CONTRADICTED claims per runtime',
      '',
      ...table(['Runtime', 'Count'], countRows(set.contradictedByRuntime)),
      '### NOT_CHECKABLE reasons',
      '',
      ...table(['Reason', 'Count'], countRows(set.notCheckableReasons)),
      '### Unstable facts',
      '',
      ...table(['Id', 'Fact'], set.unstableFacts.map((entry) => [entry.id, entry.fact])),
      '### Vendor questions',
      '',
      ...table(['Id', 'Questions'], Object.entries(set.vendorQuestions)),
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
