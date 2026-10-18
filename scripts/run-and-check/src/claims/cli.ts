/**
 * Claim check CLI (no Docker):
 *
 *   pnpm runcheck:claims                        every analysis of the newest analyses/rules@* folder
 *   pnpm runcheck:claims --repo repo-008        one (or several --repo) repositories
 *   pnpm runcheck:claims --analysis <dir|file>  another analysis folder or one analysis file
 *
 * Reads the analyses, observations/<id>.json and, when present,
 * .runs/full/<analyser>/<id>.json. Writes .runs/reports/<analyser>/<id>.json,
 * summary.json and summary.md.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  analysisResultFileSchema,
  fullRunSchema,
  observationSchema,
  type AnalysisResultFile,
  type FullRun,
  type Observation,
  type RepositoryReport,
} from '../contract.js';
import { renderMarkdown, repositoryReport, summaryReport } from '../report/report.js';
import { checkClaims } from './check.js';
import { extractClaims } from './extract.js';

const here = dirname(fileURLToPath(import.meta.url));
export const HARNESS_ROOT = resolve(here, '..', '..');
const ANALYSES_DIR = join(HARNESS_ROOT, 'analyses');
const OBSERVATIONS_DIR = join(HARNESS_ROOT, 'observations');
const FULL_RUNS_DIR = join(HARNESS_ROOT, '.runs', 'full');
const REPORTS_DIR = join(HARNESS_ROOT, '.runs', 'reports');

export interface ClaimsOptions {
  ids: string[];
  analysis: string | undefined;
}

export function parseClaimsArgs(argv: readonly string[]): ClaimsOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: { repo: { type: 'string', multiple: true }, analysis: { type: 'string' } },
    strict: true,
  });
  return { ids: values.repo ?? [], analysis: values.analysis };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function newestAnalysisDir(): string {
  const dirs = existsSync(ANALYSES_DIR)
    ? readdirSync(ANALYSES_DIR)
        .filter((name) => name.startsWith('rules@'))
        .map((name) => join(ANALYSES_DIR, name))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];
  if (dirs.length === 0) throw new Error(`No analysis folder analyses/rules@* in ${HARNESS_ROOT}. Run the analysis first.`);
  return dirs[0]!;
}

export function loadAnalyses(path: string, ids: readonly string[]): AnalysisResultFile[] {
  const files = statSync(path).isDirectory()
    ? readdirSync(path)
        .filter((name) => name.endsWith('.json'))
        .map((name) => join(path, name))
    : [path];
  const analyses = files.map((file) => analysisResultFileSchema.parse(readJson(file)));
  for (const id of ids) {
    if (!analyses.some((analysis) => analysis.id === id)) throw new Error(`No analysis for ${id} in ${path}`);
  }
  return analyses.filter((analysis) => ids.length === 0 || ids.includes(analysis.id)).sort((a, b) => a.id.localeCompare(b.id));
}

function loadOptional<T>(path: string, parse: (value: unknown) => T): T | null {
  return existsSync(path) ? parse(readJson(path)) : null;
}

/** One report per analysis that has an observation; the ids without an observation are returned apart. */
export function buildReports(
  analyses: readonly AnalysisResultFile[],
  loadObservation: (id: string) => Observation | null,
  loadFullRun: (analyser: string, id: string) => FullRun | null,
): { reports: RepositoryReport[]; withoutObservation: string[] } {
  const reports: RepositoryReport[] = [];
  const withoutObservation: string[] = [];
  for (const analysis of analyses) {
    const observation = loadObservation(analysis.id);
    if (observation === null) {
      withoutObservation.push(analysis.id);
      continue;
    }
    const verdicts = checkClaims(extractClaims(analysis), observation);
    const fullRun = loadFullRun(analysis.analyser, analysis.id);
    reports.push(repositoryReport({ id: analysis.id, set: observation.set }, analysis, observation, verdicts, fullRun));
  }
  return { reports, withoutObservation };
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const options = parseClaimsArgs(argv);
  const analyses = loadAnalyses(options.analysis ? resolve(options.analysis) : newestAnalysisDir(), options.ids);
  if (analyses.length === 0) {
    console.error('No analyses selected.');
    return 1;
  }
  const analyser = analyses[0]!.analyser;
  const { reports, withoutObservation } = buildReports(
    analyses,
    (id) => loadOptional(join(OBSERVATIONS_DIR, `${id}.json`), (value) => observationSchema.parse(value)),
    (name, id) => loadOptional(join(FULL_RUNS_DIR, name, `${id}.json`), (value) => fullRunSchema.parse(value)),
  );
  for (const id of withoutObservation) console.warn(`${id}: no observation, skipped`);

  const runtimes = Object.fromEntries(analyses.flatMap((analysis) => (analysis.manifest ? [[analysis.id, analysis.manifest.application.runtime]] : [])));
  const summary = summaryReport(reports, analyser, { runtimes });
  const outDir = join(REPORTS_DIR, analyser);
  mkdirSync(outDir, { recursive: true });
  for (const report of reports) writeFileSync(join(outDir, `${report.id}.json`), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(outDir, 'summary.md'), renderMarkdown(summary, reports));

  for (const set of summary.sets) {
    const contradicted = Object.values(set.contradictedByClaimType).reduce((sum, value) => sum + value, 0);
    console.log(
      `${set.set}: ${set.repositories} repositories, healthy ${set.healthyWithAnalysedSettings}, hidden problems ${set.hiddenProblems.length}, ` +
        `false problems ${set.falseProblems.length}, CONTRADICTED ${contradicted}`,
    );
  }
  console.log(`Wrote ${reports.length} report(s) and the summary to ${outDir}`);
  return 0;
}
