/**
 * A full run: the application with exactly the analysed settings (the
 * analysed commands, port and health path), one service set, production
 * environment. Migration first, then the web container, then the workers.
 * Under emulation the web start has the production grace (300 s) x 3.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DeploymentManifest } from '@deployz/contracts';

import { fullRunSchema, type AnalysisResultFile, type Architecture, type Evidence, type FullRun, type Recipe } from '../contract.js';
import { runtimeLimit } from '../emulation.js';
import type { ContainerSpec, ProductionEnvironmentFn, RunningContainer, Runner, ServiceSet, SizeLimits } from '../ports.js';
import { webHostName } from './environment.js';
import { redact } from './runner.js';

const SIZE: SizeLimits = { profile: 'small-v2', memoryMiB: 512, cpus: 1 };
const MIGRATION_TIMEOUT_MS = 30 * 60_000;
const WEB_START_TIMEOUT_MS = 900_000;
const WORKER_WINDOW_MS = 5 * 60_000;
const WORKER_POLL_MS = 5000;
const LOG_LINES = 2000;
const EVIDENCE_LINES = 80;

export interface FullRunInput {
  readonly analysis: AnalysisResultFile;
  readonly image: string;
  readonly arch: Architecture;
  readonly recipe: Recipe;
  readonly runner: Runner;
  readonly services: ServiceSet;
  readonly env: ProductionEnvironmentFn;
  readonly logDir: string;
  /** Length of the worker observation window. Default 5 minutes. */
  readonly workerWindowMs?: number;
}

function workersOf(manifest: DeploymentManifest): { id: string; command: string }[] {
  if (manifest.workers !== undefined) return manifest.workers.map(({ id, command }) => ({ id, command }));
  return manifest.worker.command === null ? [] : [{ id: 'worker', command: manifest.worker.command }];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runFull(input: FullRunInput): Promise<FullRun> {
  const { analysis, image, arch, recipe, runner, services, logDir } = input;
  const manifest = analysis.manifest;
  if (manifest === null) throw new Error(`analysis ${analysis.id} has no manifest`);

  const platform = arch === 'arm64-native' ? 'linux/arm64' : 'linux/amd64';
  const startedAt = new Date().toISOString();
  const environmentNames = new Set<string>();
  const secretValues = new Set<string>([
    services.postgres.password,
    services.mysql.password,
    services.minio.accessKey,
    services.minio.secretKey,
  ]);
  const evidence: Evidence[] = [];
  const infrastructureFailures: string[] = [];
  const started: RunningContainer[] = [];
  const result = {
    migration: null as FullRun['migration'],
    webHealthy: false,
    healthPathStatus: null as number | null,
    smokeStatus: null as number | null,
    workers: [] as FullRun['workers'],
  };

  const specFor = (role: ContainerSpec['role'], name: string, command: string | null, workerId?: string): ContainerSpec => {
    const environment = input.env({ manifest, role, ...(workerId !== undefined ? { workerId } : {}), services, recipe });
    for (const key of Object.keys(environment.env)) environmentNames.add(key);
    for (const key of environment.secretNames) {
      const value = environment.env[key];
      if (value !== undefined) secretValues.add(value);
    }
    return { id: analysis.id, name, image, platform, role, command, env: environment.env, services, size: SIZE };
  };

  const record = async (source: string, container: RunningContainer): Promise<void> => {
    const text = redact(await runner.logs(container, LOG_LINES), secretValues);
    // A limit of the test (QEMU or no internet) is not an application result.
    const limit = runtimeLimit(text);
    if (limit !== null && (limit.kind === 'internet' || platform === 'linux/amd64')) {
      const note = `${limit.kind === 'internet' ? 'needs internet at run time' : 'emulation'}: ${limit.line}`;
      if (!infrastructureFailures.includes(note)) infrastructureFailures.push(note);
    }
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, `${analysis.id}-full-${source}.log`), text);
    evidence.push({ kind: 'log', source, text: redact(text.split('\n').slice(-EVIDENCE_LINES).join('\n'), secretValues).slice(-2000) });
  };

  try {
    const migrationCommand = manifest.migration.command;
    const mode = manifest.migration.mode;
    if (migrationCommand !== null && migrationCommand !== '' && (mode === undefined || mode === 'pre_deploy')) {
      const spec = specFor('migration', `${services.id}-migration`, migrationCommand);
      const run = await runner.runOnce(spec, MIGRATION_TIMEOUT_MS);
      result.migration = { command: migrationCommand, exitCode: run.exitCode };
      evidence.push(...run.evidence.map((item) => ({ ...item, text: redact(item.text, secretValues) })));
      // A failed pre-deploy migration stops the deployment: the application never starts.
      if (run.exitCode !== 0) return finish();
    }

    // Production compiles no web command (compile.ts sets Command only for workers): the image's own command runs.
    const webSpec = specFor('web', webHostName(services), null);
    const web = await runner.start(webSpec);
    started.push(web);
    const port = Number(webSpec.env['PORT']);
    const healthPath = manifest.health.path;
    const health = await runner.waitHealthy(web, { ports: [port], paths: [healthPath], timeoutMs: WEB_START_TIMEOUT_MS });
    result.webHealthy = health.healthy;
    result.healthPathStatus = health.checks.filter((check) => check.path === healthPath).at(-1)?.status ?? null;
    if (health.healthy && recipe.smoke !== undefined) {
      const [smoke] = await runner.httpProbe(web, port, [], recipe.smoke);
      result.smokeStatus = smoke?.status ?? null;
      evidence.push({ kind: 'http', source: 'smoke', text: `${recipe.smoke.method} ${recipe.smoke.path} -> ${result.smokeStatus ?? 'no response'}` });
    }
    evidence.push({ kind: 'http', source: 'health', text: `GET ${healthPath} -> ${result.healthPathStatus ?? 'no response'} after ${health.seconds ?? 'no'} s (exited: ${health.exited}, oomKilled: ${health.oomKilled})` });
    await record('web', web);

    const workers = workersOf(manifest);
    const running: { id: string; command: string; container: RunningContainer }[] = [];
    for (const worker of workers) {
      const container = await runner.start(specFor('worker', `${services.id}-worker-${worker.id}`, worker.command, worker.id));
      started.push(container);
      running.push({ id: worker.id, command: worker.command, container });
    }
    const deadline = Date.now() + (input.workerWindowMs ?? WORKER_WINDOW_MS);
    while (running.length > 0 && Date.now() < deadline) {
      await sleep(Math.min(WORKER_POLL_MS, Math.max(0, deadline - Date.now())));
      const states = await Promise.all(running.map(({ container }) => runner.isRunning(container)));
      if (states.every((state) => !state.running)) break;
    }
    for (const { id, command, container } of running) {
      const state = await runner.isRunning(container);
      result.workers.push({
        command,
        stayedRunning: state.running && state.restarts === 0,
        exitCode: state.exitCode,
        restarts: state.restarts,
        queueActivity: null,
      });
      await record(`worker-${id}`, container);
    }
  } catch (error) {
    infrastructureFailures.push(redact(error instanceof Error ? error.message : String(error), secretValues));
  } finally {
    for (const container of started) await runner.stop(container);
  }
  return finish();

  function finish(): FullRun {
    return fullRunSchema.parse({
      schemaVersion: 1,
      id: analysis.id,
      analyser: analysis.analyser,
      arch,
      startedAt,
      environmentNames: [...environmentNames].sort(),
      ...result,
      evidence,
      infrastructureFailures,
    });
  }
}
