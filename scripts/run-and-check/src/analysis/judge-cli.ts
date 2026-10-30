/**
 * Final judge CLI: runs only the final judge (`runFinalJudge`) on stored AI
 * analyses, so a judge prompt can be scored without running the main
 * analysis again.
 *
 *   tsx src/cli.ts judge --from <analyses dir> [--from <dir> ...] --out <dir> [--repo <id> ...]
 *   tsx src/cli.ts judge --score <dir> [--score <dir> ...]
 *
 * Each id is read from the first `--from` folder that has it, so a run can
 * put new analyses of a few repositories in front of an older full set.
 * The judge reads the stored manifest, outcome and checked answers, and the
 * repository files it asks for through the snapshot fetch (the tree listing
 * and the files `judgeFileRequests` names). Writes `<out>/<id>.json` with the
 * stored outcome, the judged outcome and the judge record, then a score
 * against `ground-truth/<id>.yaml`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { JUDGE_REASON_PREFIX, judgeFileRequests, runFinalJudge, TREE_PATHS, type DeployabilityOutcome, type FileTree, type JudgeRecord } from '@deployz/analysis';
import { createAnalysisAiGateways, resolveAnalysisAiConfig } from '@deployz/api/ai-config';
import { fetchFilesForAnalysis, fetchRepositoryTreeEntries } from '@deployz/api/github';
import { parse } from 'yaml';

import { analysisResultFileSchema, recipeSchema, type AnalysisResultFile } from '../contract.js';
import { ANALYST_PRICE } from './ai-usage.js';
import { BENCHMARK_INSTALLATION_TOKEN, createSnapshotFetch, resolveGithubToken } from './snapshot.js';

const here = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(here, '..', '..');
const SNAPSHOT_CACHE_DIR = join(HARNESS_ROOT, '.runs', 'snapshot-cache');

export interface JudgeFile {
  readonly id: string;
  readonly analyser: string;
  /** The stored analysis the judge read. */
  readonly from: string;
  readonly storedOutcome: DeployabilityOutcome | null;
  readonly outcome: DeployabilityOutcome | null;
  readonly judge: JudgeRecord | null;
}

/** The outcome after the judge: a block is NOT_DEPLOYABLE, a change turns DEPLOYABLE into DEPLOYABLE_WITH_CHANGES. */
export function judgedOutcome(stored: DeployabilityOutcome | null, record: JudgeRecord | null): DeployabilityOutcome | null {
  if (stored === null || record?.status !== 'ok') return stored;
  const { decision } = record.judgement;
  if (decision === 'block') return 'NOT_DEPLOYABLE';
  if (decision === 'change' && stored === 'DEPLOYABLE') return 'DEPLOYABLE_WITH_CHANGES';
  return stored;
}

async function judgeOne(
  analysis: AnalysisResultFile,
  repository: { owner: string; repo: string; branch: string },
  fetchFn: ReturnType<typeof createSnapshotFetch>,
  gateway: Parameters<typeof runFinalJudge>[1],
): Promise<JudgeRecord | null> {
  const outcome = reviewedOutcome(analysis);
  if (analysis.status !== 'analysed' || analysis.manifest === null || outcome === null) return null;
  const manifest = { ...analysis.manifest, unsupported: analysis.manifest.unsupported.filter((reason) => !reason.startsWith(JUDGE_REASON_PREFIX)) };
  if (outcome === 'NOT_DEPLOYABLE') return runFinalJudge({ outcome, manifest, answers: [], files: {} }, gateway);
  const entries = await fetchRepositoryTreeEntries(repository, BENCHMARK_INSTALLATION_TOKEN, fetchFn);
  const listing: FileTree = {};
  Object.defineProperty(listing, TREE_PATHS, { value: entries.filter((entry) => entry.type === 'blob').map((entry) => entry.path), enumerable: false });
  const files: FileTree = await fetchFilesForAnalysis(repository, BENCHMARK_INSTALLATION_TOKEN, fetchFn, judgeFileRequests(manifest, listing));
  Object.defineProperty(files, TREE_PATHS, { value: (listing as FileTree & { [TREE_PATHS]: readonly string[] })[TREE_PATHS], enumerable: false });
  const answers = Array.isArray(analysis.ai?.['answers']) ? (analysis.ai['answers'] as { subject: string; answer: string; decision: 'ai' | 'rules' }[]) : [];
  return runFinalJudge({ outcome, manifest, answers, files }, gateway);
}

/**
 * The outcome before any judge: an analysis that ran the judge stores the
 * outcome the judge reviewed, and its manifest blocking reasons lose the
 * judge's own line.
 */
export function reviewedOutcome(analysis: AnalysisResultFile): DeployabilityOutcome | null {
  const judged = analysis.judge?.['status'] === 'ok' ? (analysis.judge['outcome'] as DeployabilityOutcome | undefined) : undefined;
  return judged ?? analysis.outcome ?? null;
}

function acceptedOutcomes(id: string): readonly string[] | null {
  const path = join(HARNESS_ROOT, 'ground-truth', `${id}.yaml`);
  if (!existsSync(path)) return null;
  const truth = parse(readFileSync(path, 'utf8')) as { outcome?: { accept?: string[] } };
  return truth.outcome?.accept ?? null;
}

export interface JudgeScore {
  readonly judged: number;
  readonly wrong: readonly string[];
  readonly notSure: readonly string[];
  readonly tooStrict: readonly string[];
  readonly fixed: readonly string[];
  readonly fallbacks: number;
  readonly costUsd: number;
  readonly latencyMs: { readonly mean: number; readonly max: number };
}

/**
 * A wrong outcome is one the ground truth does not accept; a question
 * ("not sure") on a wrong stored outcome is not counted wrong. Too strict:
 * the judge made an accepted outcome unaccepted.
 */
export function scoreJudgeFiles(files: readonly JudgeFile[], accept: (id: string) => readonly string[] | null = acceptedOutcomes): JudgeScore {
  const wrong: string[] = [];
  const notSure: string[] = [];
  const tooStrict: string[] = [];
  const fixed: string[] = [];
  const latencies: number[] = [];
  let fallbacks = 0;
  let cost = 0;
  let judged = 0;
  for (const file of files) {
    const accepted = accept(file.id);
    const record = file.judge;
    if (record?.status === 'fallback') fallbacks += 1;
    if (record?.status === 'ok') {
      judged += 1;
      latencies.push(record.latencyMs);
      cost += record.usage.costUsd ?? (record.usage.promptTokens * ANALYST_PRICE.input + record.usage.completionTokens * ANALYST_PRICE.output) / 1_000_000;
    }
    if (accepted === null || file.outcome === null) continue;
    const question = record?.status === 'ok' && record.judgement.decision === 'question';
    if (question) notSure.push(file.id);
    const right = accepted.includes(file.outcome);
    const storedRight = file.storedOutcome !== null && accepted.includes(file.storedOutcome);
    if (!right && !question) wrong.push(file.id);
    if (!right && storedRight) tooStrict.push(file.id);
    if (right && !storedRight) fixed.push(file.id);
  }
  return {
    judged,
    wrong,
    notSure,
    tooStrict,
    fixed,
    fallbacks,
    costUsd: cost,
    latencyMs: {
      mean: latencies.length === 0 ? 0 : Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
      max: latencies.length === 0 ? 0 : Math.max(...latencies),
    },
  };
}

function formatScore(name: string, score: JudgeScore): string {
  return [
    `${name}: ${score.judged} judged, ${score.fallbacks} fallback(s), $${score.costUsd.toFixed(3)} total ($${(score.judged === 0 ? 0 : score.costUsd / score.judged).toFixed(4)} per call), latency mean ${score.latencyMs.mean} ms, max ${score.latencyMs.max} ms`,
    `  wrong (${score.wrong.length}): ${score.wrong.join(' ')}`,
    `  not sure (${score.notSure.length}): ${score.notSure.join(' ')}`,
    `  too strict (${score.tooStrict.length}): ${score.tooStrict.join(' ')}`,
    `  fixed (${score.fixed.length}): ${score.fixed.join(' ')}`,
  ].join('\n');
}

function readJudgeDir(dir: string): JudgeFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as JudgeFile);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      from: { type: 'string', multiple: true },
      out: { type: 'string' },
      repo: { type: 'string', multiple: true },
      score: { type: 'string', multiple: true },
      concurrency: { type: 'string', default: '4' },
    },
    strict: true,
  });
  if (values.score !== undefined) {
    for (const dir of values.score) console.log(formatScore(basename(dir), scoreJudgeFiles(readJudgeDir(resolve(dir)))));
    return 0;
  }
  if (values.from === undefined || values.out === undefined) {
    console.error('judge needs --from <analyses dir> and --out <dir>, or --score <dir>.');
    return 1;
  }
  const gateways = createAnalysisAiGateways(resolveAnalysisAiConfig(process.env));
  if (gateways === undefined) {
    console.error('judge needs AI_GATEWAY_BASE_URL and OPENROUTER_API_KEY.');
    return 1;
  }
  const fromDirs = values.from.map((dir) => resolve(dir));
  const outDir = resolve(values.out);
  mkdirSync(outDir, { recursive: true });
  const ids = values.repo ?? [...new Set(fromDirs.flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))))].sort();
  const fetchFn = createSnapshotFetch({ cacheDir: SNAPSHOT_CACHE_DIR, token: resolveGithubToken() });
  const written: JudgeFile[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++]!;
      const fromDir = fromDirs.find((dir) => existsSync(join(dir, `${id}.json`)));
      if (fromDir === undefined) throw new Error(`no stored analysis for ${id}`);
      const analysis = analysisResultFileSchema.parse(JSON.parse(readFileSync(join(fromDir, `${id}.json`), 'utf8')));
      const recipe = recipeSchema.parse(parse(readFileSync(join(HARNESS_ROOT, 'recipes', `${id}.yaml`), 'utf8')));
      if (recipe.source.kind !== 'git') continue;
      const [owner, repo] = recipe.source.repository.split('/') as [string, string];
      const judge = await judgeOne(analysis, { owner, repo, branch: recipe.source.commit }, fetchFn, gateways.analyst).catch((error: unknown) => {
        console.warn(`${id}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      const storedOutcome = reviewedOutcome(analysis);
      const file: JudgeFile = { id, analyser: basename(outDir), from: basename(fromDir), storedOutcome, outcome: judgedOutcome(storedOutcome, judge), judge };
      writeFileSync(join(outDir, `${id}.json`), `${JSON.stringify(file, null, 2)}\n`);
      written.push(file);
      const verdict = judge?.status === 'ok' ? `${judge.judgement.verdict} -> ${judge.judgement.decision}` : (judge?.status ?? 'no record');
      console.log(`${id}: ${storedOutcome ?? 'none'} -> ${file.outcome ?? 'none'} (${verdict})`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker));
  console.log(formatScore(basename(outDir), scoreJudgeFiles(written)));
  return 0;
}
