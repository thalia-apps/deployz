/**
 * Phase 5 — async & scheduled workload detection.
 *
 * Two independent evidence families, both fed by strong production evidence
 * only (§6.1 policy: prefer strong evidence; weak/ambiguous evidence becomes
 * a vendor question; dependencies/imports alone never create infrastructure):
 *
 *   - SQS (Standard only): a producer/consumer operation in runtime JS/TS
 *     source, attributed to a declared workload (web / a worker / a
 *     scheduled job) through bounded import reachability from that
 *     workload's own entry file. Only a queue that resolves BOTH a producer
 *     and a consumer, with no ambiguity, is provisioned; everything else
 *     becomes a non-blocking `questions` entry and is never provisioned.
 *
 *   - Scheduled jobs: an explicit production deployment declaration naming
 *     both a schedule and a command for this repository's image (a
 *     render.yaml `type: cron` service, or a Kubernetes `CronJob` manifest).
 *     In-process cron libraries, CI schedules, and a bare cron string never
 *     provision anything.
 *
 * The output feeds `normalizeDeploymentManifest` (manifest.ts) as
 * `metadata.asyncQueues` / `asyncScheduledJobs` / `asyncQuestions` — already
 * shaped as `ManifestQueue[]` / `ManifestScheduledJob[]` / `ManifestQuestion[]`
 * so the manifest layer only validates and passes them through.
 */

import { posix as posixPath } from 'node:path';

import {
  cronExpressionError,
  isValidTimezone,
  type ManifestEnvBinding,
  type ManifestQuestion,
  type ManifestQueue,
  type ManifestScheduledJob,
} from '@deployz/contracts';

import type { FileTree } from './detectors.js';
import {
  collectDependencyNames,
  collectScripts,
  detectDeclaredWorkerCommands,
  dockerfileImageCommand,
  isRuntimeSourcePath,
  listDockerfileCandidates,
} from './detectors.js';

export interface AsyncWorkloadsResult {
  queues: ManifestQueue[];
  scheduledJobs: ManifestScheduledJob[];
  questions: ManifestQuestion[];
}

const JS_TS_FILE_REGEX = /\.(?:m?[jt]sx?)$/;

// ── Ids ──────────────────────────────────────────────────────────────────

/** A stable, contract-shaped kebab id (see contracts' `componentIdSchema`). */
function kebabId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return /^[a-z]/.test(slug) ? slug : `q-${slug}`.slice(0, 40);
}

// ── SQS: queue env var name recognition (rule 2) ────────────────────────────

interface QueueEnvVarInfo {
  name: string;
  /** The queue this variable names — for a DLQ var, the PARENT queue's id. */
  queueId: string;
  kind: ManifestEnvBinding['kind'];
  role: 'queue' | 'dlq';
}

function parseQueueEnvVar(name: string): QueueEnvVarInfo | null {
  let m = /^([A-Z][A-Z0-9_]*)_QUEUE_ARN$/.exec(name);
  if (m) return { name, queueId: kebabId(`${m[1]}_QUEUE`), kind: 'arn', role: 'queue' };

  m = /^([A-Z][A-Z0-9_]*)_DLQ_URL$/.exec(name);
  if (m) return { name, queueId: kebabId(`${m[1]}_QUEUE`), kind: 'url', role: 'dlq' };
  m = /^([A-Z][A-Z0-9_]*)_DEAD_LETTER_QUEUE_URL$/.exec(name);
  if (m) return { name, queueId: kebabId(`${m[1]}_QUEUE`), kind: 'url', role: 'dlq' };

  if (name === 'QUEUE_URL') return { name, queueId: 'queue', kind: 'url', role: 'queue' };
  m = /^([A-Z][A-Z0-9_]*)_QUEUE_URL$/.exec(name);
  if (m) return { name, queueId: kebabId(`${m[1]}_QUEUE`), kind: 'url', role: 'queue' };
  m = /^([A-Z][A-Z0-9_]*)_SQS_URL$/.exec(name);
  if (m) return { name, queueId: kebabId(`${m[1]}_SQS`), kind: 'url', role: 'queue' };

  return null;
}

// ── Env var reads (process.env.X / process.env['X'] / destructuring) ───────

const PROCESS_ENV_DOT_REGEX = /process\.env\.([A-Z][A-Z0-9_]*)\b/g;
const PROCESS_ENV_BRACKET_REGEX = /process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g;
const PROCESS_ENV_DESTRUCTURE_REGEX = /\{\s*([^{}]+)\s*\}\s*=\s*process\.env\b/g;

function envVarReadsInContent(content: string): Set<string> {
  const names = new Set<string>();
  for (const match of content.matchAll(PROCESS_ENV_DOT_REGEX)) names.add(match[1]!);
  for (const match of content.matchAll(PROCESS_ENV_BRACKET_REGEX)) names.add(match[1]!);
  for (const match of content.matchAll(PROCESS_ENV_DESTRUCTURE_REGEX)) {
    for (const part of match[1]!.split(',')) {
      const key = part.split(':')[0]!.split('=')[0]!.trim();
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) names.add(key);
    }
  }
  return names;
}

// ── SQS operations (rule 3) ─────────────────────────────────────────────────

const SQS_PRODUCE_REGEX =
  /\bSendMessageCommand\b|\bSendMessageBatchCommand\b|\.sendMessage\s*\(|\.sendMessageBatch\s*\(|\bProducer\.create\s*\(/;
const SQS_CONSUME_REGEX = /\bReceiveMessageCommand\b|\.receiveMessage\s*\(|\bConsumer\.create\s*\(/;

type SqsOp = 'produce' | 'consume';

function sqsOpsInContent(content: string): Set<SqsOp> {
  const ops = new Set<SqsOp>();
  if (SQS_PRODUCE_REGEX.test(content)) ops.add('produce');
  if (SQS_CONSUME_REGEX.test(content)) ops.add('consume');
  return ops;
}

// ── Command → entry file resolution (rule 4) ────────────────────────────────

/** Extract the script path argument from a `node`/`tsx`/`ts-node` invocation. */
function extractScriptArg(command: string): string | null {
  const m = /\b(?:node|tsx|ts-node)(?:\s+--?[\w-]+(?:[= ]\S+)?)*\s+(\S+)/.exec(command);
  return m ? m[1]! : null;
}

/** dist|build|out|lib -> src, and both .js/.ts extensions, checked against the tree. */
function resolveEntryFile(tree: FileTree, rawPath: string): string | null {
  const normalized = rawPath.replace(/^\.\//, '');
  const mapped = normalized.replace(/^(?:dist|build|out|lib)\//, 'src/');
  const bases = new Set([normalized, mapped]);
  const candidates = new Set<string>();
  for (const base of bases) {
    candidates.add(base);
    if (/\.js$/.test(base)) candidates.add(base.replace(/\.js$/, '.ts'));
    if (/\.ts$/.test(base)) candidates.add(base.replace(/\.ts$/, '.js'));
  }
  for (const candidate of candidates) {
    if (tree[candidate] !== undefined) return candidate;
  }
  return null;
}

/** Resolve a declared start command (possibly an npm script indirection) to a source entry file. */
function resolveCommandEntry(tree: FileTree, command: string): string | null {
  const npmRunMatch = /^(?:npm run|yarn run|yarn|pnpm run|pnpm)\s+([\w:.-]+)$/.exec(command.trim());
  let target = command;
  if (npmRunMatch) {
    const script = collectScripts(tree).find(([name]) => name === npmRunMatch[1]);
    if (script) target = script[1];
  }
  const arg = extractScriptArg(target);
  if (!arg) return null;
  return resolveEntryFile(tree, arg);
}

function resolveWebEntry(tree: FileTree): string | null {
  for (const [path, content] of Object.entries(tree)) {
    if (!/(?:^|\/)Procfile$/.test(path) || !content || !isRuntimeSourcePath(path)) continue;
    const m = /^web:\s*(.+)$/m.exec(content);
    if (m) {
      const resolved = resolveCommandEntry(tree, m[1]!.trim());
      if (resolved) return resolved;
    }
  }
  const startScript = collectScripts(tree).find(([name]) => name === 'start');
  if (startScript) {
    const resolved = resolveCommandEntry(tree, startScript[1]);
    if (resolved) return resolved;
  }
  const dockerfilePath = listDockerfileCandidates(tree)[0];
  const dockerfileContent = dockerfilePath !== undefined ? tree[dockerfilePath] : undefined;
  if (dockerfileContent) {
    const { cmd: imageCmd, entrypoint } = dockerfileImageCommand(dockerfileContent);
    const cmd = imageCmd ?? entrypoint;
    if (cmd) {
      const cleaned = cmd.replace(/^\[|\]$/g, '').replace(/["',]/g, ' ').replace(/\s+/g, ' ').trim();
      const resolved = resolveCommandEntry(tree, cleaned);
      if (resolved) return resolved;
    }
  }
  return null;
}

// ── Bounded import reachability (rule 4) ────────────────────────────────────

const RELATIVE_IMPORT_REGEX =
  /(?:import\s+(?:[\w*{}\s,]+\s+from\s+)?|export\s+(?:[\w*{}\s,]+\s+from\s+)?|require\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g;

function resolveRelativeImport(tree: FileTree, fromPath: string, spec: string): string | null {
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const joined = posixPath.normalize(posixPath.join(dir, spec));
  const candidates = [
    joined,
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}.js`,
    `${joined}.jsx`,
    `${joined}.mjs`,
    `${joined}.cjs`,
    `${joined}/index.ts`,
    `${joined}/index.tsx`,
    `${joined}/index.js`,
    `${joined}/index.jsx`,
  ];
  for (const candidate of candidates) {
    if (tree[candidate] !== undefined) return candidate;
  }
  return null;
}

const MAX_REACHABILITY_DEPTH = 4;

/** Every file reachable from `entry` via relative imports/requires, up to a small fixed depth. */
function reachableFiles(tree: FileTree, entry: string): Set<string> {
  const visited = new Set<string>([entry]);
  let frontier = [entry];
  for (let depth = 0; depth < MAX_REACHABILITY_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const path of frontier) {
      const content = tree[path];
      if (!content) continue;
      for (const match of content.matchAll(RELATIVE_IMPORT_REGEX)) {
        const resolved = resolveRelativeImport(tree, path, match[1]!);
        if (resolved && !visited.has(resolved)) {
          visited.add(resolved);
          next.push(resolved);
        }
      }
    }
    frontier = next;
  }
  return visited;
}

function allRuntimeSourceFiles(tree: FileTree): Set<string> {
  return new Set(Object.keys(tree).filter((path) => JS_TS_FILE_REGEX.test(path) && isRuntimeSourcePath(path)));
}

// ── Workloads (web + declared workers + declared scheduled jobs) ───────────

interface CandidateWorkload {
  id: string;
  command: string;
}

interface WorkloadReach {
  id: string;
  reach: Set<string>;
}

function computeWorkloadReaches(
  tree: FileTree,
  workers: CandidateWorkload[],
  scheduledJobs: CandidateWorkload[],
): WorkloadReach[] {
  const reaches: WorkloadReach[] = [];
  for (const workload of [...workers, ...scheduledJobs]) {
    const entry = resolveCommandEntry(tree, workload.command);
    if (entry) reaches.push({ id: workload.id, reach: reachableFiles(tree, entry) });
  }
  const webEntry = resolveWebEntry(tree);
  if (webEntry) {
    reaches.push({ id: 'web', reach: reachableFiles(tree, webEntry) });
  } else {
    const covered = new Set<string>();
    for (const { reach } of reaches) for (const file of reach) covered.add(file);
    const remaining = new Set([...allRuntimeSourceFiles(tree)].filter((file) => !covered.has(file)));
    reaches.push({ id: 'web', reach: remaining });
  }
  return reaches;
}

// ── Attribution (rules 5-7) ─────────────────────────────────────────────────

interface Attribution {
  producers: Set<string>;
  consumers: Set<string>;
}

/** Attribute every SQS op in every workload's reach to a queue-or-DLQ env var, or mark it ambiguous. */
function attributeSqsOperations(
  tree: FileTree,
  reaches: WorkloadReach[],
): { byVar: Map<string, Attribution>; ambiguousVars: Set<string>; unnamedEvidence: string[] } {
  const byVar = new Map<string, Attribution>();
  const ambiguousVars = new Set<string>();
  const unnamedEvidence: string[] = [];

  const attribute = (varName: string, workloadId: string, ops: Set<SqsOp>): void => {
    const entry = byVar.get(varName) ?? { producers: new Set(), consumers: new Set() };
    if (ops.has('produce')) entry.producers.add(workloadId);
    if (ops.has('consume')) entry.consumers.add(workloadId);
    byVar.set(varName, entry);
  };

  for (const { id: workloadId, reach } of reaches) {
    const reachQueueVars = new Set<string>();
    const fileQueueVars = new Map<string, Set<string>>();
    for (const file of reach) {
      const content = tree[file];
      if (!content) continue;
      const vars = new Set(
        [...envVarReadsInContent(content)].filter((name) => parseQueueEnvVar(name) !== null),
      );
      fileQueueVars.set(file, vars);
      for (const v of vars) reachQueueVars.add(v);
    }

    for (const file of reach) {
      const content = tree[file];
      if (!content) continue;
      const ops = sqsOpsInContent(content);
      if (ops.size === 0) continue;
      const fileVars = fileQueueVars.get(file) ?? new Set<string>();

      let targetVar: string | null = null;
      if (fileVars.size === 1) {
        targetVar = [...fileVars][0]!;
      } else if (fileVars.size === 0 && reachQueueVars.size === 1) {
        targetVar = [...reachQueueVars][0]!;
      } else if (fileVars.size === 0 && reachQueueVars.size === 0) {
        // Rule 7: SQS usage with no recognizable queue env var anywhere in reach.
        unnamedEvidence.push(file);
        continue;
      } else {
        for (const v of fileVars.size > 0 ? fileVars : reachQueueVars) ambiguousVars.add(v);
        continue;
      }

      // Rule 6: a consumer op attributed to `web` is never trusted.
      if (workloadId === 'web' && ops.has('consume')) {
        ambiguousVars.add(targetVar);
        continue;
      }
      attribute(targetVar, workloadId, ops);
    }
  }

  return { byVar, ambiguousVars, unnamedEvidence };
}

const SQS_JS_DEPS = ['@aws-sdk/client-sqs', 'aws-sdk', 'sqs-consumer', 'sqs-producer'];

function hasSqsJsDependency(tree: FileTree): boolean {
  const deps = collectDependencyNames(tree);
  return SQS_JS_DEPS.some((dep) => deps.includes(dep));
}

/** Python boto3 SQS usage (rule 7): always a question, never provisioned, never rejected. */
function detectPythonSqsUsage(tree: FileTree): string[] {
  const hasBoto3 = Object.entries(tree).some(
    ([path, content]) => content && /(?:^|\/)requirements(?:[^/]*)\.txt$/.test(path) && /^boto3/m.test(content),
  );
  if (!hasBoto3) return [];
  const files: string[] = [];
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !/\.py$/.test(path) || !isRuntimeSourcePath(path)) continue;
    if (/sqs\.(?:receive_message|send_message)|get_queue_url/.test(content)) files.push(path);
  }
  return files;
}

function buildSqsQuestions(
  ambiguousVars: Set<string>,
  unnamedEvidence: string[],
  pythonEvidence: string[],
  varSources: Map<string, string>,
): ManifestQuestion[] {
  const questions: ManifestQuestion[] = [];
  for (const varName of ambiguousVars) {
    questions.push({
      id: `queue-${kebabId(varName)}`,
      field: 'queue_relationship',
      question: `The application reads ${varName} and uses Amazon SQS, but Deployz could not determine which process produces to and consumes from it. Confirm the producer and consumer for this queue.`,
      source: varSources.get(varName) ?? 'source',
    });
  }
  for (const file of unnamedEvidence) {
    questions.push({
      id: `queue-unnamed-${kebabId(file)}`,
      field: 'queue_relationship',
      question: `The application uses Amazon SQS in ${file}, but Deployz could not find a queue URL environment variable naming which queue it accesses.`,
      source: file,
    });
  }
  for (const file of pythonEvidence) {
    questions.push({
      id: `queue-python-${kebabId(file)}`,
      field: 'queue_relationship',
      question: `The application uses Amazon SQS (boto3) in ${file}, which Deployz cannot resolve to a queue and workload automatically. Confirm the queue relationship.`,
      source: file,
    });
  }
  return questions;
}

function detectQueues(
  tree: FileTree,
  workers: CandidateWorkload[],
  scheduledJobs: CandidateWorkload[],
): { queues: ManifestQueue[]; questions: ManifestQuestion[] } {
  const pythonEvidence = detectPythonSqsUsage(tree);
  if (!hasSqsJsDependency(tree)) {
    return { queues: [], questions: buildSqsQuestions(new Set(), [], pythonEvidence, new Map()) };
  }

  const reaches = computeWorkloadReaches(tree, workers, scheduledJobs);
  const { byVar, ambiguousVars, unnamedEvidence } = attributeSqsOperations(tree, reaches);

  // Evidence source (first file that reads the var) for question wording.
  const varSources = new Map<string, string>();
  for (const [path, content] of Object.entries(tree)) {
    if (!content) continue;
    for (const name of envVarReadsInContent(content)) {
      if (parseQueueEnvVar(name) !== null && !varSources.has(name)) varSources.set(name, path);
    }
  }

  const queueVars = [...byVar.keys()].filter((name) => parseQueueEnvVar(name)?.role === 'queue');
  const queues: ManifestQueue[] = [];
  const questionVars = new Set(ambiguousVars);

  for (const varName of queueVars) {
    if (ambiguousVars.has(varName)) continue;
    const info = parseQueueEnvVar(varName)!;
    const attribution = byVar.get(varName)!;
    if (attribution.producers.size === 0 || attribution.consumers.size === 0) {
      questionVars.add(varName);
      continue;
    }

    const envBindings: ManifestEnvBinding[] = [{ name: varName, kind: info.kind }];
    const prefix = varName.replace(/_URL$/, '');
    const arnVarName = `${prefix}_ARN`;
    if (byVar.has(arnVarName)) envBindings.push({ name: arnVarName, kind: 'arn' });

    // Attach a DLQ, when one is read for this queue and its ops resolved cleanly.
    const dlqVarNames = [...byVar.keys()].filter((name) => {
      const dlqInfo = parseQueueEnvVar(name);
      return dlqInfo?.role === 'dlq' && dlqInfo.queueId === info.queueId && !ambiguousVars.has(name);
    });
    const dlqVarName = dlqVarNames[0];
    const deadLetter =
      dlqVarName !== undefined
        ? {
            maxReceiveCount: 5,
            envBindings: [{ name: dlqVarName, kind: 'url' as const }],
            producers: [...(byVar.get(dlqVarName)?.producers ?? [])],
            consumers: [...(byVar.get(dlqVarName)?.consumers ?? [])],
          }
        : undefined;

    queues.push({
      id: info.queueId,
      envBindings,
      producers: [...attribution.producers],
      consumers: [...attribution.consumers],
      source: varSources.get(varName) ?? 'source',
      ...(deadLetter ? { deadLetter } : {}),
    });
  }

  const questions = buildSqsQuestions(questionVars, unnamedEvidence, pythonEvidence, varSources);
  return { queues, questions };
}

// ── Scheduled jobs ───────────────────────────────────────────────────────────

const CRON_MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

function normalizeCron(raw: string): string | null {
  const trimmed = raw.trim();
  const cron = CRON_MACROS[trimmed] ?? trimmed;
  return cronExpressionError(cron) === null ? cron : null;
}

interface RenderCronService {
  name: string | null;
  schedule: string | null;
  command: string | null;
}

/** A hand-rolled indentation scanner for render.yaml's `services:` list — mirrors `composeServices`. */
function parseRenderCronServices(tree: FileTree): { file: string; services: RenderCronService[] } | null {
  const path = Object.keys(tree).find((p) => /(?:^|\/)render\.ya?ml$/.test(p) && isRuntimeSourcePath(p));
  if (!path) return null;
  const content = tree[path];
  if (!content) return null;

  const services: (RenderCronService & { isCron: boolean })[] = [];
  let inServices = false;
  let current: (RenderCronService & { isCron: boolean }) | null = null;
  let itemIndent = -1;

  const applyKv = (svc: RenderCronService & { isCron: boolean }, key: string, rawValue: string): void => {
    const value = rawValue.trim().replace(/^["']|["']$/g, '');
    if (key === 'type' && value === 'cron') svc.isCron = true;
    if (key === 'name') svc.name = value;
    if (key === 'schedule') svc.schedule = value;
    if ((key === 'startCommand' || key === 'dockerCommand') && value.length > 0) svc.command = value;
  };

  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!inServices) {
      if (/^services:\s*$/.test(line)) inServices = true;
      continue;
    }
    if (/^\s*(?:#|$)/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inServices = false;
      current = null;
      continue;
    }
    const itemStart = /^(\s*)-\s*(.*)$/.exec(line);
    if (itemStart && (itemIndent === -1 || itemStart[1]!.length === itemIndent)) {
      itemIndent = itemStart[1]!.length;
      current = { name: null, schedule: null, command: null, isCron: false };
      services.push(current);
      const kv = /^([a-zA-Z0-9_]+):\s*(.*)$/.exec(itemStart[2]!);
      if (kv) applyKv(current, kv[1]!, kv[2]!);
      continue;
    }
    if (!current) continue;
    const kv = /^\s*([a-zA-Z0-9_]+):\s*(.*)$/.exec(line);
    if (kv) applyKv(current, kv[1]!, kv[2]!);
  }

  const cronServices = services.filter((s) => s.isCron);
  return cronServices.length > 0 ? { file: path, services: cronServices } : null;
}

interface K8sCronJobInfo {
  name: string | null;
  schedule: string | null;
  timeZone: string | null;
  suspend: boolean;
  command: string;
}

function extractYamlListItems(block: string | undefined): string[] {
  if (!block) return [];
  const trimmed = block.trim();
  if (trimmed.startsWith('[')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter((s) => s.length > 0);
  }
  return [...trimmed.matchAll(/-\s*["']?([^"'\n]+)["']?/g)].map((m) => m[1]!.trim());
}

/** Kubernetes `kind: CronJob` manifests outside test/example/docs paths. */
function parseK8sCronJobs(tree: FileTree): { file: string; job: K8sCronJobInfo }[] {
  const results: { file: string; job: K8sCronJobInfo }[] = [];
  for (const [path, content] of Object.entries(tree)) {
    if (!content || !/\.ya?ml$/.test(path) || !isRuntimeSourcePath(path)) continue;
    if (!/^kind:\s*CronJob\s*$/m.test(content)) continue;

    const name = /^\s*name:\s*([\w.-]+)/m.exec(content)?.[1] ?? null;
    const schedule = /^\s*schedule:\s*["']?([^"'\n]+)["']?\s*$/m.exec(content)?.[1]?.trim() ?? null;
    const timeZone = /^\s*timeZone:\s*["']?([^"'\n]+)["']?\s*$/m.exec(content)?.[1]?.trim() ?? null;
    const suspend = /^\s*suspend:\s*true\s*$/m.test(content);

    const commandBlock = /command:\s*(\[[^\]]*\]|(?:\n[ \t]*-[^\n]+)+)/.exec(content)?.[1];
    const argsBlock = /args:\s*(\[[^\]]*\]|(?:\n[ \t]*-[^\n]+)+)/.exec(content)?.[1];
    const fullCommand = [...extractYamlListItems(commandBlock), ...extractYamlListItems(argsBlock)]
      .join(' ')
      .trim();

    if (!schedule || fullCommand.length === 0) continue;
    results.push({ file: path, job: { name, schedule, timeZone, suspend, command: fullCommand } });
  }
  return results;
}

/** `vercel.json` `crons` — an HTTP path schedule with no command: always a question. */
function detectVercelCrons(tree: FileTree): string[] {
  const path = Object.keys(tree).find((p) => /(?:^|\/)vercel\.json$/.test(p) && isRuntimeSourcePath(p));
  if (!path) return [];
  const content = tree[path];
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as { crons?: unknown[] };
    return Array.isArray(parsed.crons) && parsed.crons.length > 0 ? [path] : [];
  } catch {
    return [];
  }
}

/** A crontab / *.cron file: a schedule with no deployment declaration is ambiguous. */
function detectCrontabFiles(tree: FileTree): string[] {
  return Object.keys(tree).filter(
    (path) => isRuntimeSourcePath(path) && (/(?:^|\/)crontab$/.test(path) || /\.cron$/.test(path)),
  );
}

function detectScheduledJobs(
  tree: FileTree,
  reservedIds: Set<string>,
): { jobs: { id: string; command: string }[]; scheduledJobs: ManifestScheduledJob[]; questions: ManifestQuestion[] } {
  const scheduledJobs: ManifestScheduledJob[] = [];
  const questions: ManifestQuestion[] = [];
  const usedIds = new Set(reservedIds);

  const nextId = (name: string | null, fallback: string): string => {
    const base = kebabId(name && name.length > 0 ? name : fallback);
    const id = usedIds.has(base) ? `${base}-job`.slice(0, 40) : base;
    usedIds.add(id);
    return id;
  };

  const render = parseRenderCronServices(tree);
  for (const service of render?.services ?? []) {
    if (!service.schedule || !service.command) continue;
    const id = nextId(service.name, 'scheduled-job');
    const cron = normalizeCron(service.schedule);
    if (cron === null) {
      questions.push({
        id: `schedule-${id}`,
        field: 'schedule',
        question: `The cron expression "${service.schedule}" for the scheduled service ${service.name ?? id} in ${render!.file} is not valid. Confirm and correct the schedule.`,
        source: render!.file,
      });
      continue;
    }
    scheduledJobs.push({
      id,
      command: service.command,
      schedule: { type: 'cron', cron },
      timezone: null,
      source: render!.file,
    });
  }

  for (const { file, job } of parseK8sCronJobs(tree)) {
    const id = nextId(job.name, 'scheduled-job');
    const cron = normalizeCron(job.schedule!);
    const tzValid = job.timeZone === null || isValidTimezone(job.timeZone);
    if (cron === null || !tzValid) {
      questions.push({
        id: `schedule-${id}`,
        field: 'schedule',
        question: `The CronJob "${job.name ?? id}" in ${file} declares a schedule Deployz could not validate (schedule "${job.schedule}"${job.timeZone ? `, timezone "${job.timeZone}"` : ''}). Confirm and correct it.`,
        source: file,
      });
      continue;
    }
    scheduledJobs.push({
      id,
      command: job.command,
      schedule: { type: 'cron', cron },
      timezone: job.timeZone,
      ...(job.suspend ? { enabled: false } : {}),
      source: file,
    });
  }

  for (const path of detectVercelCrons(tree)) {
    questions.push({
      id: `schedule-vercel-${kebabId(path)}`,
      field: 'schedule',
      question: `${path} declares Vercel \`crons\`, which invoke an HTTP path rather than a command. Confirm how this scheduled work should run on Deployz.`,
      source: path,
    });
  }

  for (const path of detectCrontabFiles(tree)) {
    questions.push({
      id: `schedule-crontab-${kebabId(path)}`,
      field: 'schedule',
      question: `${path} declares a cron schedule with no production deployment declaration naming a command. Confirm which command this schedule should run.`,
      source: path,
    });
  }

  const jobs = scheduledJobs.map((job) => ({ id: job.id, command: job.command }));
  return { jobs, scheduledJobs, questions };
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function detectAsyncWorkloads(tree: FileTree): AsyncWorkloadsResult {
  const workers = detectDeclaredWorkerCommands(tree).map((w) => ({ id: w.id, command: w.command }));
  const reservedIds = new Set<string>(['web', 'migration', ...workers.map((w) => w.id)]);

  const { jobs: scheduledJobWorkloads, scheduledJobs, questions: scheduleQuestions } = detectScheduledJobs(
    tree,
    reservedIds,
  );
  const { queues, questions: queueQuestions } = detectQueues(tree, workers, scheduledJobWorkloads);

  return {
    queues,
    scheduledJobs,
    questions: [...queueQuestions, ...scheduleQuestions],
  };
}
