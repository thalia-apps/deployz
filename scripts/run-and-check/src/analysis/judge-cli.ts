/**
 * Final judge CLI: runs only the final judge (`runFinalJudge`) on stored AI
 * analyses, so a judge prompt can be scored without running the main
 * analysis again.
 *
 *   tsx src/cli.ts judge --from <analyses dir> [--from <dir> ...] --out <dir> [--repo <id> ...] [--transport gateway|batch]
 *   tsx src/cli.ts judge --score <dir> [--score <dir> ...]
 *   tsx src/cli.ts judge --parity <judge dir A> --parity <judge dir B>
 *
 * Each id is read from the first `--from` folder that has it, so a run can
 * put new analyses of a few repositories in front of an older full set.
 * The judge reads the stored manifest, outcome and checked answers, and the
 * repository files it asks for through the snapshot fetch (the tree listing
 * and the files `judgeFileRequests` names). Writes `<out>/<id>.json` with the
 * stored outcome, the judged outcome and the judge record, then a score
 * against `ground-truth/<id>.yaml`. `--transport batch` sends every call as
 * one Anthropic Message Batch (needs `ANTHROPIC_API_KEY`, runs every id at
 * once); `--parity` prints the ids whose verdict, decision or outcome differ.
 *
 * The soft review (`runSoftReview`) runs when every finding that makes the
 * stored outcome is soft. It reads the analysis file's `findings`; a file
 * from before them takes the findings of `--rules <dir>` (a rules analysis of
 * the same commit) only when the rules outcome is the stored outcome.
 * `--strict-from <judge dir>` (repeatable; the first folder that has the id
 * wins) reuses the stored final judge record instead of a new call, for a
 * run that changes only the soft review.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  JUDGE_REASON_PREFIX,
  judgeFileRequests,
  questionedFindings,
  runFinalJudge,
  runSoftReview,
  softReviewFileRequests,
  softReviewTargets,
  TREE_PATHS,
  type DeployabilityOutcome,
  type FileTree,
  type JudgeRecord,
  type ReadinessFinding,
  type SoftReviewRecord,
} from '@deployz/analysis';
import { createAnalysisAiGateways, resolveAnalysisAiConfig } from '@deployz/api/ai-config';
import { fetchFilesForAnalysis, fetchRepositoryTreeEntries } from '@deployz/api/github';
import { parse } from 'yaml';

import { analysisResultFileSchema, recipeSchema, type AnalysisResultFile } from '../contract.js';
import { ANALYST_PRICE } from './ai-usage.js';
import { createBatchGateway } from './batch-gateway.js';
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
  /** The soft review record when it ran; absent in files from before it. */
  readonly softReview?: SoftReviewRecord | null;
}

/** The outcome after the judge: a block is NOT_DEPLOYABLE, a change turns DEPLOYABLE into DEPLOYABLE_WITH_CHANGES. */
export function judgedOutcome(stored: DeployabilityOutcome | null, record: JudgeRecord | null): DeployabilityOutcome | null {
  if (stored === null || record?.status !== 'ok') return stored;
  const { decision } = record.judgement;
  if (decision === 'block') return 'NOT_DEPLOYABLE';
  if (decision === 'change' && stored === 'DEPLOYABLE') return 'DEPLOYABLE_WITH_CHANGES';
  return stored;
}

type StoredFinding = NonNullable<AnalysisResultFile['findings']>[number];

/** The stored required findings as the soft review reads them. */
function asReadinessFindings(findings: readonly StoredFinding[]): ReadinessFinding[] {
  return findings.map((finding): ReadinessFinding => ({
    id: finding.id,
    category: '',
    title: finding.title,
    severity: 'required',
    blocking: finding.fixClass === 'CAPABILITY_GAP',
    ...(finding.fixClass ? { fixClass: finding.fixClass as NonNullable<ReadinessFinding['fixClass']> } : {}),
    plainEnglishExplanation: '',
    whyItMatters: '',
    technicalEvidence: finding.technicalEvidence,
    suggestedOutcome: '',
    confidence: finding.confidence as ReadinessFinding['confidence'],
  }));
}

/**
 * The findings that make the stored outcome before any judge: the analysis
 * file's own without the embedded judge's findings, else the rules analysis
 * of the same commit when it reaches the same outcome.
 */
export function storedFindings(analysis: AnalysisResultFile, rules: AnalysisResultFile | null): readonly StoredFinding[] | null {
  if (analysis.findings !== undefined) return analysis.findings.filter((finding) => !finding.id.startsWith('final-review-'));
  if (rules?.findings === undefined || rules.commit !== analysis.commit || rules.outcome !== reviewedOutcome(analysis)) return null;
  return rules.findings;
}

async function judgeOne(
  analysis: AnalysisResultFile,
  findings: readonly StoredFinding[] | null,
  strict: JudgeRecord | undefined,
  repository: { owner: string; repo: string; branch: string },
  fetchFn: ReturnType<typeof createSnapshotFetch>,
  gateway: Parameters<typeof runFinalJudge>[1],
): Promise<{ judge: JudgeRecord | null; softReview: SoftReviewRecord | null }> {
  const outcome = reviewedOutcome(analysis);
  if (analysis.status !== 'analysed' || analysis.manifest === null || outcome === null) return { judge: null, softReview: null };
  const manifest = { ...analysis.manifest, unsupported: analysis.manifest.unsupported.filter((reason) => !reason.startsWith(JUDGE_REASON_PREFIX)) };
  const softOutcome = outcome === 'DEPLOYABLE' ? null : outcome;
  const targets = softOutcome === null || findings === null ? [] : softReviewTargets(asReadinessFindings(findings));
  const answers = Array.isArray(analysis.ai?.['answers']) ? (analysis.ai['answers'] as { subject: string; answer: string; decision: 'ai' | 'rules' }[]) : [];
  if (outcome === 'NOT_DEPLOYABLE' && targets.length === 0) return { judge: strict ?? (await runFinalJudge({ outcome, manifest, answers: [], files: {} }, gateway)), softReview: null };
  const entries = await fetchRepositoryTreeEntries(repository, BENCHMARK_INSTALLATION_TOKEN, fetchFn);
  const listing: FileTree = {};
  Object.defineProperty(listing, TREE_PATHS, { value: entries.filter((entry) => entry.type === 'blob').map((entry) => entry.path), enumerable: false });
  const requests = [...new Set([...(outcome === 'NOT_DEPLOYABLE' ? [] : judgeFileRequests(manifest, listing)), ...(targets.length > 0 ? softReviewFileRequests(manifest, targets, listing) : [])])];
  const files: FileTree = await fetchFilesForAnalysis(repository, BENCHMARK_INSTALLATION_TOKEN, fetchFn, requests);
  Object.defineProperty(files, TREE_PATHS, { value: (listing as FileTree & { [TREE_PATHS]: readonly string[] })[TREE_PATHS], enumerable: false });
  const [judge, softReview] = await Promise.all([
    strict ?? runFinalJudge({ outcome, manifest, answers: outcome === 'NOT_DEPLOYABLE' ? [] : answers, files }, gateway),
    softOutcome !== null && targets.length > 0 ? runSoftReview({ outcome: softOutcome, manifest, answers, files, findings: targets }, gateway) : null,
  ]);
  return { judge, softReview };
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
  /** Soft review calls. */
  readonly softReviewed: number;
  readonly wrong: readonly string[];
  readonly notSure: readonly string[];
  /** The part of `notSure` where the soft review asks the vendor to confirm a finding. */
  readonly needsConfirmation: readonly string[];
  readonly tooStrict: readonly string[];
  readonly fixed: readonly string[];
  readonly fallbacks: number;
  readonly costUsd: number;
  readonly latencyMs: { readonly mean: number; readonly max: number };
}

/**
 * A wrong outcome is one the ground truth does not accept; a question
 * ("not sure": a judge question or a soft finding the vendor must confirm)
 * is not counted wrong. Too strict: the judge made an accepted outcome
 * unaccepted.
 */
export function scoreJudgeFiles(files: readonly JudgeFile[], accept: (id: string) => readonly string[] | null = acceptedOutcomes): JudgeScore {
  const wrong: string[] = [];
  const notSure: string[] = [];
  const needsConfirmation: string[] = [];
  const tooStrict: string[] = [];
  const fixed: string[] = [];
  const latencies: number[] = [];
  let fallbacks = 0;
  let cost = 0;
  let judged = 0;
  let softReviewed = 0;
  const callCost = (usage: { promptTokens: number; completionTokens: number; costUsd?: number | undefined }) =>
    usage.costUsd ?? (usage.promptTokens * ANALYST_PRICE.input + usage.completionTokens * ANALYST_PRICE.output) / 1_000_000;
  for (const file of files) {
    const accepted = accept(file.id);
    const record = file.judge;
    const soft = file.softReview ?? null;
    if (record?.status === 'fallback') fallbacks += 1;
    if (soft?.status === 'fallback') fallbacks += 1;
    if (record?.status === 'ok') {
      judged += 1;
      cost += callCost(record.usage);
    }
    if (soft?.status === 'ok') {
      softReviewed += 1;
      cost += callCost(soft.usage);
    }
    // The two calls run in parallel in production.
    const latency = Math.max(record?.status === 'ok' ? record.latencyMs : 0, soft?.status === 'ok' ? soft.latencyMs : 0);
    if (latency > 0) latencies.push(latency);
    if (accepted === null || file.outcome === null) continue;
    const blocked = record?.status === 'ok' && record.judgement.decision === 'block';
    const confirm = !blocked && questionedFindings(soft).length > 0;
    const question = (record?.status === 'ok' && record.judgement.decision === 'question') || confirm;
    if (question) notSure.push(file.id);
    if (confirm) needsConfirmation.push(file.id);
    const right = accepted.includes(file.outcome);
    const storedRight = file.storedOutcome !== null && accepted.includes(file.storedOutcome);
    if (!right && !question) wrong.push(file.id);
    if (!right && storedRight) tooStrict.push(file.id);
    if (right && !storedRight) fixed.push(file.id);
  }
  return {
    judged,
    softReviewed,
    wrong,
    notSure,
    needsConfirmation,
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
    `${name}: ${score.judged} judged, ${score.softReviewed} soft review(s), ${score.fallbacks} fallback(s), $${score.costUsd.toFixed(3)} total ($${(score.judged + score.softReviewed === 0 ? 0 : score.costUsd / (score.judged + score.softReviewed)).toFixed(4)} per call), latency mean ${score.latencyMs.mean} ms, max ${score.latencyMs.max} ms`,
    `  wrong (${score.wrong.length}): ${score.wrong.join(' ')}`,
    `  not sure (${score.notSure.length}): ${score.notSure.join(' ')}`,
    `  of which needs confirmation (${score.needsConfirmation.length}): ${score.needsConfirmation.join(' ')}`,
    `  too strict (${score.tooStrict.length}): ${score.tooStrict.join(' ')}`,
    `  fixed (${score.fixed.length}): ${score.fixed.join(' ')}`,
  ].join('\n');
}

/** The ids whose verdict, decision or outcome differ between two judge folders. */
export function compareJudgeFiles(a: readonly JudgeFile[], b: readonly JudgeFile[]): string[] {
  const soft = (file: JudgeFile) => (file.softReview?.status === 'ok' ? `, soft ${file.softReview.reviews.map((review) => review.verdict).join('+')}` : '');
  const describe = (file: JudgeFile | undefined) =>
    file === undefined ? 'missing' : `${file.judge?.status === 'ok' ? `${file.judge.judgement.verdict} -> ${file.judge.judgement.decision}` : (file.judge?.status ?? 'no record')}${soft(file)}, outcome ${file.outcome ?? 'none'}`;
  const left = new Map(a.map((file) => [file.id, file]));
  const right = new Map(b.map((file) => [file.id, file]));
  const lines: string[] = [];
  for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const [x, y] = [describe(left.get(id)), describe(right.get(id))];
    if (x !== y) lines.push(`${id}: ${x} | ${y}`);
  }
  return lines;
}

/** `<dir>/<id>.json` read through `parse`, or null when no folder is given or it has no file for the id. */
function readOptional<T>(dir: string | undefined, id: string, parse: (json: unknown) => T): T | null {
  if (dir === undefined) return null;
  const path = join(resolve(dir), `${id}.json`);
  return existsSync(path) ? parse(JSON.parse(readFileSync(path, 'utf8'))) : null;
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
      transport: { type: 'string', default: 'gateway' },
      parity: { type: 'string', multiple: true },
      rules: { type: 'string' },
      'strict-from': { type: 'string', multiple: true },
    },
    strict: true,
  });
  if (values.score !== undefined) {
    for (const dir of values.score) console.log(formatScore(basename(dir), scoreJudgeFiles(readJudgeDir(resolve(dir)))));
    return 0;
  }
  if (values.parity !== undefined) {
    if (values.parity.length !== 2) {
      console.error('judge --parity needs two judge folders.');
      return 1;
    }
    const differences = compareJudgeFiles(readJudgeDir(resolve(values.parity[0]!)), readJudgeDir(resolve(values.parity[1]!)));
    console.log([`${differences.length} difference(s) (A | B):`, ...differences].join('\n'));
    return 0;
  }
  if (values.from === undefined || values.out === undefined) {
    console.error('judge needs --from <analyses dir> and --out <dir>, or --score <dir>.');
    return 1;
  }
  if (values.transport !== 'gateway' && values.transport !== 'batch') {
    console.error('judge --transport is gateway or batch.');
    return 1;
  }
  const batch = values.transport === 'batch';
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  const analyst = batch ? (apiKey ? createBatchGateway({ apiKey }) : undefined) : createAnalysisAiGateways(resolveAnalysisAiConfig(process.env))?.analyst;
  if (analyst === undefined) {
    console.error(batch ? 'judge --transport batch needs ANTHROPIC_API_KEY.' : 'judge needs AI_GATEWAY_BASE_URL and OPENROUTER_API_KEY.');
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
      if (fromDir === undefined) {
        console.log(`${id}: no stored analysis, skipped`);
        continue;
      }
      const analysis = analysisResultFileSchema.parse(JSON.parse(readFileSync(join(fromDir, `${id}.json`), 'utf8')));
      const recipe = recipeSchema.parse(parse(readFileSync(join(HARNESS_ROOT, 'recipes', `${id}.yaml`), 'utf8')));
      if (recipe.source.kind !== 'git') continue;
      const [owner, repo] = recipe.source.repository.split('/') as [string, string];
      const rules = readOptional(values.rules, id, (json) => analysisResultFileSchema.parse(json));
      const findings = storedFindings(analysis, rules);
      if (findings === null) console.log(`${id}: no findings for the stored outcome, no soft review`);
      const strictDir = values['strict-from']?.find((dir) => existsSync(join(resolve(dir), `${id}.json`)));
      const strict = readOptional(strictDir, id, (json) => (json as JudgeFile).judge ?? undefined) ?? undefined;
      const { judge, softReview } = await judgeOne(analysis, findings, strict, { owner, repo, branch: recipe.source.commit }, fetchFn, analyst).catch((error: unknown) => {
        console.warn(`${id}: ${error instanceof Error ? error.message : String(error)}`);
        return { judge: null, softReview: null };
      });
      const storedOutcome = reviewedOutcome(analysis);
      const file: JudgeFile = { id, analyser: basename(outDir), from: basename(fromDir), storedOutcome, outcome: judgedOutcome(storedOutcome, judge), judge, softReview };
      writeFileSync(join(outDir, `${id}.json`), `${JSON.stringify(file, null, 2)}\n`);
      written.push(file);
      const verdict = judge?.status === 'ok' ? `${judge.judgement.verdict} -> ${judge.judgement.decision}` : (judge?.status ?? 'no record');
      const soft = softReview?.status === 'ok' ? `; soft ${softReview.reviews.map((review) => `${review.findingId} ${review.verdict}${review.question ? ' (ask)' : ''}`).join(', ')}` : softReview ? `; soft ${softReview.status}` : '';
      console.log(`${id}: ${storedOutcome ?? 'none'} -> ${file.outcome ?? 'none'} (${verdict}${soft})`);
    }
  };
  await Promise.all(Array.from({ length: batch ? ids.length : Math.max(1, Number(values.concurrency)) }, worker));
  console.log(formatScore(basename(outDir), scoreJudgeFiles(written)));
  return 0;
}
