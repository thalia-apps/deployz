import { join } from 'node:path';

import type { DeploymentManifest } from '@deployz/contracts';

import type { Architecture, Evidence, ObservationFactName, ObservationRun, Recipe } from '../contract.js';
import type {
  BuiltImage,
  ContainerSpec,
  HttpCheck,
  ListenSocket,
  RunningContainer,
  Runner,
  ServiceSet,
  ServiceSnapshot,
  SizeLimits,
} from '../ports.js';
import { runtimeLimit } from '../emulation.js';
import { OBSERVATION_PORT, type Candidates } from './candidates.js';
import { filterLocalDiskWrites, sqliteFileWritten } from './diff-filter.js';
import { failed, makeEvidence, notRun, observed, type Fact } from './facts.js';
import type { ObserveDeps } from './types.js';

const SMALL: SizeLimits = { profile: 'small-v2', memoryMiB: 512, cpus: 1 };
const MEDIUM: SizeLimits = { profile: 'medium-v1', memoryMiB: 2048, cpus: 1 };
const STARTUP_MS = 900_000;
const VARIABLE_MS = 600_000;
const LISTEN_FALLBACK_MS = 120_000;
const WORKER_WINDOW_MS = 300_000;
const MIGRATION_MS = 1_800_000;
const MAX_VARIABLES = 6;

type Health = Awaited<ReturnType<Runner['waitHealthy']>>;
type Role = ContainerSpec['role'];
type Of<N extends ObservationFactName> = NonNullable<ObservationRun[N]['value']>;

export interface RunInput {
  recipe: Recipe;
  deps: ObserveDeps;
  manifest: DeploymentManifest;
  candidates: Candidates;
  runIndex: number;
  runsDir: string;
  harnessVersion: string;
  fixtureDir?: string;
  /** `linux/arm64` only as the fallback after a QEMU crash at run time. */
  platform?: 'linux/amd64' | 'linux/arm64';
}

/** A service or container did not start: the step is retried once and then reported apart from application results. */
class InfrastructureError extends Error {}

interface Ctx extends RunInput {
  arch: Architecture;
  image: string;
  secrets: Set<string>;
  timings: Record<string, number>;
  failures: string[];
}

interface Scope {
  readonly label: string;
  readonly set: ServiceSet;
  readonly containers: RunningContainer[];
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => (promise ??= fn());
}

function ev(ctx: Ctx, kind: Evidence['kind'], source: string, text: string): Evidence {
  return makeEvidence(kind, source, text, ctx.secrets);
}

function cleanAll(ctx: Ctx, evidence: readonly Evidence[]): Evidence[] {
  return evidence.map((item) => ev(ctx, item.kind, item.source, item.text));
}

async function timed<T>(ctx: Ctx, key: string, fn: () => Promise<T>): Promise<T> {
  const start = ctx.deps.now().getTime();
  try {
    return await fn();
  } finally {
    ctx.timings[key] = (ctx.timings[key] ?? 0) + (ctx.deps.now().getTime() - start) / 1000;
  }
}

/** One failing check gives one `error` fact; the other checks continue. */
async function check<T>(
  ctx: Ctx,
  fn: () => Promise<{ value: T; evidence?: Evidence[]; note?: string }>,
): Promise<Fact<T>> {
  try {
    const result = await fn();
    return observed(result.value, ctx.arch, result.evidence ?? [], result.note);
  } catch (error) {
    return failed(ctx.arch, error);
  }
}

/** Runs a step; an infrastructure failure is retried once, then listed. Returns null when it failed twice. */
async function step<T>(ctx: Ctx, timingKey: string, label: string, fn: () => Promise<T>): Promise<T | null> {
  const prefix = `${ctx.recipe.id} run ${ctx.runIndex}`;
  let last = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await timed(ctx, timingKey, fn);
      ctx.deps.log(`${prefix}: ${label} done`);
      return result;
    } catch (error) {
      if (!(error instanceof InfrastructureError)) throw error;
      last = error.message;
      ctx.deps.log(`${prefix}: ${label} infrastructure failure (${attempt === 1 ? 'retry' : 'give up'}): ${last}`);
    }
  }
  ctx.failures.push(`${label}: ${last}`);
  return null;
}

async function withScope<T>(ctx: Ctx, label: string, fn: (scope: Scope) => Promise<T>): Promise<T> {
  let set: ServiceSet;
  try {
    set = await ctx.deps.services.start(ctx.recipe.id, `r${ctx.runIndex}-${label}`);
  } catch (error) {
    throw new InfrastructureError(`service set ${label} did not start: ${message(error)}`);
  }
  for (const secret of [set.postgres.password, set.mysql.password, set.minio.accessKey, set.minio.secretKey]) {
    ctx.secrets.add(secret);
  }
  const scope: Scope = { label, set, containers: [] };
  try {
    return await fn(scope);
  } finally {
    for (const container of scope.containers) {
      await ctx.deps.runner.stop(container).catch((error: unknown) => ctx.deps.log(`stop ${container.name}: ${message(error)}`));
    }
    await ctx.deps.services.stop(set).catch((error: unknown) => ctx.deps.log(`stop services ${label}: ${message(error)}`));
  }
}

function envFor(ctx: Ctx, scope: Scope, role: Role, workerId?: string): Record<string, string> {
  const result = ctx.deps.env({
    manifest: ctx.manifest,
    role,
    ...(workerId === undefined ? {} : { workerId }),
    services: scope.set,
    recipe: ctx.recipe,
  });
  for (const name of result.secretNames) {
    const value = result.env[name];
    if (value !== undefined) ctx.secrets.add(value);
  }
  return result.env;
}

function spec(
  ctx: Ctx,
  scope: Scope,
  role: Role,
  name: string,
  command: string | null,
  env: Record<string, string>,
  size: SizeLimits,
): ContainerSpec {
  return {
    id: ctx.recipe.id,
    name: `${ctx.recipe.id}-r${ctx.runIndex}-${scope.label}-${name}`,
    image: ctx.image,
    platform: ctx.arch === 'arm64-native' ? 'linux/arm64' : 'linux/amd64',
    role,
    command,
    env,
    services: scope.set,
    size,
  };
}

async function startContainer(
  ctx: Ctx,
  scope: Scope,
  role: Role,
  name: string,
  command: string | null,
  env: Record<string, string>,
  size: SizeLimits = SMALL,
): Promise<RunningContainer> {
  try {
    const container = await ctx.deps.runner.start(spec(ctx, scope, role, name, command, env, size));
    scope.containers.push(container);
    return container;
  } catch (error) {
    throw new InfrastructureError(`${name} did not start: ${message(error)}`);
  }
}

/** Waits on the candidate ports; when that fails and the container still runs, tries the ports it really listens on. */
async function waitForWeb(ctx: Ctx, container: RunningContainer, timeoutMs: number): Promise<Health> {
  const { runner } = ctx.deps;
  const paths = ctx.candidates.healthPaths;
  const health = await runner.waitHealthy(container, { ports: ctx.candidates.ports, paths, timeoutMs });
  if (health.healthy || health.exited) return health;
  const listening = (await runner.listenSockets(container)).map((socket) => socket.port);
  const extra = listening.filter((port) => !ctx.candidates.ports.includes(port));
  if (extra.length === 0) return health;
  const second = await runner.waitHealthy(container, { ports: extra, paths, timeoutMs: LISTEN_FALLBACK_MS });
  return second.healthy ? second : health;
}

const httpLines = (checks: readonly HttpCheck[]): string => checks.map((c) => `${c.port}${c.path} ${c.status ?? 'none'}`).join('\n');
const allTables = (snapshot: ServiceSnapshot): string[] => [...snapshot.postgres.tables, ...snapshot.mysql.tables];

async function healthEvidence(ctx: Ctx, source: string, container: RunningContainer, health: Health): Promise<Evidence[]> {
  const summary = `healthy=${health.healthy} exited=${health.exited} oomKilled=${health.oomKilled} seconds=${health.seconds ?? 'none'}`;
  const logs = await ctx.deps.runner.logs(container, 40).catch((error: unknown) => `logs unavailable: ${message(error)}`);
  const evidence = [ev(ctx, 'http', source, [summary, httpLines(health.checks)].join('\n')), ev(ctx, 'log', source, logs)];
  // A crash dump puts the QEMU or Go runtime line far above the last 40 lines.
  if (!health.healthy) {
    const limit = runtimeLimit(await ctx.deps.runner.logs(container, 400).catch(() => ''));
    if (limit?.kind === 'emulation' && container.spec.platform === 'linux/amd64') {
      evidence.push(ev(ctx, 'log', source, `emulation crash: ${limit.line}`));
    }
    if (limit?.kind === 'internet') {
      const note = `needs internet at run time: ${limit.line}`;
      evidence.push(ev(ctx, 'log', source, note));
      if (!ctx.failures.includes(note)) ctx.failures.push(note);
    }
  }
  return evidence;
}

// ── Step 1: build ──────────────────────────────────────────────────────────

function buildFact(ctx: Ctx, built: BuiltImage): Fact<Of<'build'>> {
  const value = {
    ok: built.ok,
    exitCode: built.exitCode,
    seconds: built.seconds,
    imageBytes: built.imageBytes,
    dockerfile: built.dockerfile,
    context: built.context,
    failure: built.failure,
    fromCache: built.fromCache,
  };
  const evidence = cleanAll(ctx, built.evidence);
  if (built.failure === 'infrastructure' || built.failure === 'emulation') {
    ctx.failures.push(`build: ${built.failure}`);
    return { status: 'error', value, arch: ctx.arch, evidence, note: `build failure: ${built.failure}` };
  }
  return observed(value, ctx.arch, evidence);
}

// ── Step 2: service set A ──────────────────────────────────────────────────

interface SetAResult {
  health: Health | null;
  facts: Pick<
    ObservationRun,
    | 'webHealthy'
    | 'listeningPorts'
    | 'httpPaths'
    | 'smoke'
    | 'database'
    | 'startupMigration'
    | 'redis'
    | 'objectStorage'
    | 'localDiskWrites'
    | 'workers'
    | 'restartHealthy'
  >;
}

async function observeSetA(ctx: Ctx): Promise<SetAResult> {
  const { deps, candidates, recipe } = ctx;
  const { runner, services } = deps;
  return withScope(ctx, 'a', async (scope) => {
    const webEnv = envFor(ctx, scope, 'web');
    let web1 = await startContainer(ctx, scope, 'web', 'web1', null, webEnv);
    const held: { health: Health | null; ports: Of<'listeningPorts'> } = { health: null, ports: [] };

    let webHealthy = await check(ctx, async () => {
      const health = await waitForWeb(ctx, web1, STARTUP_MS);
      held.health = health;
      const names = `env names: ${Object.keys(webEnv).join(', ')}`;
      return {
        value: health.healthy,
        evidence: [ev(ctx, 'command', 'web#1', names), ...(await healthEvidence(ctx, 'web#1', web1, health))],
      };
    });

    // Production runs the migration before the web container. When the start alone is not healthy,
    // run each candidate migration command in this set and start the web again; the tables seen
    // before the migration still tell whether the start alone migrates.
    let tablesBeforeMigration: string[] | null = null;
    if (held.health?.healthy !== true && candidates.migrationCommands.length > 0) {
      tablesBeforeMigration = allTables(await services.inspect(scope.set));
      await runner.stop(web1);
      const migrated: Evidence[] = [];
      for (const [index, command] of candidates.migrationCommands.entries()) {
        const migration = spec(ctx, scope, 'migration', `premigration${index + 1}`, command, envFor(ctx, scope, 'migration'), SMALL);
        const run = await runner.runOnce(migration, MIGRATION_MS);
        migrated.push(ev(ctx, 'command', `migration#${index + 1}`, `${command} exit=${run.exitCode ?? 'none'}`));
      }
      web1 = await startContainer(ctx, scope, 'web', 'web1m', null, webEnv);
      const after = web1;
      const previous = webHealthy;
      webHealthy = await check(ctx, async () => {
        const health = await waitForWeb(ctx, after, STARTUP_MS);
        held.health = health;
        return {
          value: health.healthy,
          evidence: [...previous.evidence, ...migrated, ...(await healthEvidence(ctx, 'web#1 after migration', after, health))],
        };
      });
    }
    const alive = held.health === null || !held.health.exited;
    const exited = (): Fact<never[]> => observed([], ctx.arch, [], 'container exited');

    const listeningPorts: Fact<Of<'listeningPorts'>> = alive
      ? await check(ctx, async () => {
          let sockets: ListenSocket[] = await runner.listenSockets(web1);
          // A healthy app listens somewhere: an empty read is read once more.
          if (sockets.length === 0 && held.health?.healthy === true) sockets = await runner.listenSockets(web1);
          const ports: Of<'listeningPorts'> = [];
          for (const socket of sockets) {
            const [probe] = await runner.httpProbe(web1, socket.port, ['/']);
            ports.push({ port: socket.port, bind: socket.bind, reachableFromProbe: (probe?.status ?? null) !== null });
          }
          held.ports = ports;
          const text = ports.map((p) => `${p.port} ${p.bind} reachable=${p.reachableFromProbe}`).join('\n');
          return { value: ports, evidence: [ev(ctx, 'inspect', 'web#1', text || 'no listening socket')] };
        })
      : exited();

    const httpPaths: Fact<Of<'httpPaths'>> = alive
      ? await check(ctx, async () => {
          const value: Of<'httpPaths'> = [];
          const lines: HttpCheck[] = [];
          for (const port of held.ports.filter((p) => p.reachableFromProbe)) {
            const checks = await runner.httpProbe(web1, port.port, candidates.healthPaths);
            lines.push(...checks);
            value.push(...checks.map((c) => ({ port: c.port, path: c.path, status: c.status })));
          }
          // The app can stop after its first healthy answers (RSSHub): keep the answers the health wait saw.
          if (value.length === 0 && held.health !== null) {
            value.push(...held.health.checks.filter((c) => c.status !== null).map((c) => ({ port: c.port, path: c.path, status: c.status })));
            lines.push(...held.health.checks.filter((c) => c.status !== null));
          }
          return { value, evidence: [ev(ctx, 'http', 'web#1', httpLines(lines) || 'no reachable port')] };
        })
      : exited();

    const smokePath = recipe.smoke?.path ?? '/';
    const smoke: Fact<Of<'smoke'>> = alive
      ? await check(ctx, async () => {
          const port =
            held.ports.find((p) => p.reachableFromProbe)?.port ??
            held.health?.checks.find((c) => c.status !== null)?.port ??
            candidates.ports[0] ??
            8080;
          const [result] = await runner.httpProbe(web1, port, [smokePath], recipe.smoke);
          const status = result?.status ?? null;
          return {
            value: { path: smokePath, status },
            evidence: [ev(ctx, 'http', 'web#1', `${recipe.smoke?.method ?? 'GET'} ${port}${smokePath} ${status ?? 'none'}`)],
          };
        })
      : observed({ path: smokePath, status: null }, ctx.arch, [], 'container exited');

    const snapshot = once(() => services.inspect(scope.set));
    const diff = once(() => runner.diff(web1));

    const databaseFact = (snap: ServiceSnapshot, lines: string[]) => {
      const { postgres, mysql } = snap;
      const engine: 'postgres' | 'mysql' | null = postgres.connections === 0 && mysql.connections === 0 ? null : postgres.connections >= mysql.connections ? 'postgres' : 'mysql';
      const chosen = engine === null ? null : snap[engine];
      const sqlite = lines.filter((line) => sqliteFileWritten([line]));
      return {
        value: {
          engine,
          connections: chosen?.connections ?? 0,
          tablesAfterStart: chosen?.tables ?? allTables(snap),
          sqliteFileWritten: sqlite.length > 0,
        },
        evidence: [...cleanAll(ctx, snap.evidence), ...(sqlite.length > 0 ? [ev(ctx, 'diff', 'web#1', sqlite.join('\n'))] : [])],
      };
    };
    let database = await check(ctx, async () => databaseFact(await snapshot(), await diff()));
    const redis = await check(ctx, async () => {
      const snap = await snapshot();
      return {
        value: { connected: snap.valkey.clients > 0, clients: snap.valkey.clients },
        evidence: cleanAll(ctx, snap.evidence.filter((item) => item.source.includes('valkey'))),
      };
    });
    const objectStorage = await check(ctx, async () => {
      const snap = await snapshot();
      return {
        value: { objectsWritten: snap.minio.objects },
        evidence: cleanAll(ctx, snap.evidence.filter((item) => item.source.includes('minio'))),
      };
    });
    const localDiskWrites = await check(ctx, async () => {
      const value = filterLocalDiskWrites(await diff());
      return { value, evidence: [ev(ctx, 'diff', 'web#1', value.join('\n') || 'no local writes')] };
    });

    const workers: Fact<Of<'workers'>> =
      candidates.workerCommands.length === 0
        ? notRun(ctx.arch, 'no candidate worker command')
        : await check(ctx, async () => {
            const before = (await snapshot()).valkey;
            const started: { command: string; container: RunningContainer }[] = [];
            for (const [index, command] of candidates.workerCommands.entries()) {
              const env = envFor(ctx, scope, 'worker', candidates.workerIds[command]);
              started.push({ command, container: await startContainer(ctx, scope, 'worker', `worker${index + 1}`, command, env) });
            }
            await (deps.sleep ?? defaultSleep)(WORKER_WINDOW_MS);
            const after = (await services.inspect(scope.set)).valkey;
            // All workers share one service set, so the queue activity is the same for every worker.
            const queueActivity = before.clients === 0 && after.clients === 0 ? null : after.keys !== before.keys;
            const value: Of<'workers'> = [];
            const evidence: Evidence[] = [];
            for (const [index, item] of started.entries()) {
              const state = await runner.isRunning(item.container);
              value.push({
                command: item.command,
                stayedRunning: state.running && state.restarts === 0,
                exitCode: state.exitCode,
                restarts: state.restarts,
                queueActivity,
              });
              evidence.push(ev(ctx, 'log', `worker#${index + 1}`, await runner.logs(item.container, 40)));
            }
            return { value, evidence };
          });

    // A worker can be the only process that uses the database (the phase-5 canary): inspect again after its window.
    if (workers.status === 'observed' && database.status === 'observed' && database.value?.engine === null) {
      const after = await check(ctx, async () => databaseFact(await services.inspect(scope.set), await diff()));
      if (after.status === 'observed' && after.value?.engine !== null) database = after;
    }

    const restartHealthy: Fact<boolean> =
      held.health?.healthy !== true
        ? notRun(ctx.arch, 'web was not healthy')
        : await check(ctx, async () => {
            await runner.stop(web1);
            const web2 = await startContainer(ctx, scope, 'web', 'web2', null, webEnv);
            const health = await waitForWeb(ctx, web2, STARTUP_MS);
            return { value: health.healthy, evidence: await healthEvidence(ctx, 'web#2', web2, health) };
          });

    const startupMigration = await check(ctx, async () => ({
      value: {
        tablesCreatedByStart: (tablesBeforeMigration ?? allTables(await snapshot())).length > 0,
        secondStartHealthy: restartHealthy.status === 'observed' ? restartHealthy.value : null,
      },
    }));

    return {
      health: held.health,
      facts: { webHealthy, listeningPorts, httpPaths, smoke, database, startupMigration, redis, objectStorage, localDiskWrites, workers, restartHealthy },
    };
  });
}

// ── Step 3: clean sets (migrations, two copies) ────────────────────────────

async function observeMigrations(ctx: Ctx): Promise<Fact<Of<'migrationCommands'>>> {
  const { candidates, deps } = ctx;
  if (candidates.migrationCommands.length === 0) return notRun(ctx.arch, 'no candidate migration command');
  const value: Of<'migrationCommands'> = [];
  const evidence: Evidence[] = [];
  const problems: string[] = [];
  for (const [index, command] of candidates.migrationCommands.entries()) {
    // A clean set per command, so one command cannot hide the tables of another.
    const result = await step(ctx, 'migrations', `migration ${command}`, () =>
      withScope(ctx, `b${index + 1}`, async (scope) => {
        try {
          const before = allTables(await deps.services.inspect(scope.set));
          const migration = spec(ctx, scope, 'migration', `migration${index + 1}`, command, envFor(ctx, scope, 'migration'), SMALL);
          const run = await deps.runner.runOnce(migration, MIGRATION_MS);
          const after = allTables(await deps.services.inspect(scope.set));
          return {
            entry: { command, exitCode: run.exitCode, createdTables: after.some((table) => !before.includes(table)), seconds: run.seconds },
            evidence: cleanAll(ctx, run.evidence),
          };
        } catch (error) {
          throw error instanceof InfrastructureError ? error : new InfrastructureError(message(error));
        }
      }),
    );
    if (result === null) problems.push(command);
    else {
      value.push(result.entry);
      evidence.push(...result.evidence);
    }
  }
  if (problems.length === 0) return observed(value, ctx.arch, evidence);
  return { status: 'error', value, arch: ctx.arch, evidence, note: `infrastructure failure for: ${problems.join('; ')}` };
}

async function observeTwoCopies(ctx: Ctx): Promise<Fact<boolean>> {
  const result = await step(ctx, 'twoCopies', 'two copies', () =>
    withScope(ctx, 'c', async (scope) => {
      const env = envFor(ctx, scope, 'web');
      const [first, second] = await Promise.all([
        startContainer(ctx, scope, 'web', 'web1', null, env),
        startContainer(ctx, scope, 'web', 'web2', null, env),
      ]);
      const [h1, h2] = await Promise.all([waitForWeb(ctx, first, STARTUP_MS), waitForWeb(ctx, second, STARTUP_MS)]);
      const evidence = [...(await healthEvidence(ctx, 'web#1', first, h1)), ...(await healthEvidence(ctx, 'web#2', second, h2))];
      return observed(h1.healthy && h2.healthy, ctx.arch, evidence);
    }),
  );
  return result ?? failed(ctx.arch, ctx.failures.at(-1));
}

// ── Step 4: required variables ─────────────────────────────────────────────

/**
 * Starts the web without each candidate variable. A start counts as healthy without the variable only when it is
 * healthy and still uses the SQL engine that the normal start used: an app that falls back to SQLite without its
 * database switch (kutt without DB_CLIENT) does not run as Deployz deploys it.
 */
async function observeVariables(ctx: Ctx, healthyWith: boolean, engineWith: 'postgres' | 'mysql' | null): Promise<Fact<Of<'requiredVariables'>>> {
  const total = ctx.candidates.variables.length;
  if (total === 0) return notRun(ctx.arch, 'no candidate variable');
  const names = ctx.candidates.variables.slice(0, MAX_VARIABLES);
  const cap = total > MAX_VARIABLES ? `tested ${names.length} of ${total} candidate variables (cap ${MAX_VARIABLES})` : undefined;
  const value: Of<'requiredVariables'> = [];
  const evidence: Evidence[] = [];
  const problems: string[] = [];
  for (const [index, name] of names.entries()) {
    const result = await step(ctx, 'requiredVariables', `variable ${name}`, () =>
      withScope(ctx, `v${index + 1}`, async (scope) => {
        const env = { ...envFor(ctx, scope, 'web') };
        delete env[name];
        const container = await startContainer(ctx, scope, 'web', 'web1', null, env);
        const health = await waitForWeb(ctx, container, VARIABLE_MS);
        const evidence = await healthEvidence(ctx, `web without ${name}`, container, health);
        let sameDatabase = true;
        if (health.healthy && engineWith !== null) {
          sameDatabase = (await ctx.deps.services.inspect(scope.set))[engineWith].connections > 0;
          if (!sameDatabase) evidence.push(ev(ctx, 'command', `web without ${name}`, `healthy, but no ${engineWith} connection`));
        }
        return { entry: { name, healthyWithout: health.healthy && sameDatabase, healthyWith }, evidence };
      }),
    );
    if (result === null) problems.push(name);
    else {
      value.push(result.entry);
      evidence.push(...result.evidence);
    }
  }
  if (problems.length === 0) return observed(value, ctx.arch, evidence, cap);
  const note = [cap, `infrastructure failure for: ${problems.join(', ')}`].filter((part) => part !== undefined).join('; ');
  return { status: 'error', value, arch: ctx.arch, evidence, note };
}

// ── Step 5: sizes ──────────────────────────────────────────────────────────

async function observeSizes(ctx: Ctx, health: Health | null): Promise<Fact<Of<'sizes'>>> {
  if (health === null) return failed(ctx.arch, 'the first web start gave no result');
  const row = (limits: SizeLimits, result: Health): Of<'sizes'>[number] => ({
    profile: limits.profile,
    memoryMiB: limits.memoryMiB,
    cpus: limits.cpus,
    healthy: result.healthy,
    startSeconds: result.seconds,
    oomKilled: result.oomKilled,
  });
  const value = [row(SMALL, health)];
  const evidence = [ev(ctx, 'command', 'small-v2', `healthy=${health.healthy} oomKilled=${health.oomKilled} exited=${health.exited}`)];
  if (health.healthy || !(health.oomKilled || health.exited)) return observed(value, ctx.arch, evidence);
  const medium = await step(ctx, 'sizes', 'medium-v1 size', () =>
    withScope(ctx, 'm', async (scope) => {
      const container = await startContainer(ctx, scope, 'web', 'web1', null, envFor(ctx, scope, 'web'), MEDIUM);
      const result = await waitForWeb(ctx, container, STARTUP_MS);
      return { result, evidence: await healthEvidence(ctx, 'medium-v1', container, result) };
    }),
  );
  if (medium === null) return { status: 'error', value, arch: ctx.arch, evidence, note: ctx.failures.at(-1) ?? 'medium-v1 run failed' };
  return observed([...value, row(MEDIUM, medium.result)], ctx.arch, [...evidence, ...medium.evidence]);
}

// ── One observation run ────────────────────────────────────────────────────

function candidatesOf(c: Candidates): ObservationRun['candidates'] {
  return {
    injectedPort: OBSERVATION_PORT,
    healthPaths: c.healthPaths,
    migrationCommands: c.migrationCommands,
    workerCommands: c.workerCommands,
    variables: c.variables,
    from: c.from,
  };
}

function skippedRun(ctx: Ctx, startedAt: string, build: Fact<Of<'build'>>, reason: string): ObservationRun {
  const skip = <T>(): Fact<T> => notRun<T>(ctx.arch, reason);
  return {
    startedAt,
    harnessVersion: ctx.harnessVersion,
    build,
    webHealthy: skip(),
    listeningPorts: skip(),
    httpPaths: skip(),
    smoke: skip(),
    database: skip(),
    startupMigration: skip(),
    migrationCommands: skip(),
    redis: skip(),
    objectStorage: skip(),
    localDiskWrites: skip(),
    workers: skip(),
    requiredVariables: skip(),
    twoCopiesHealthy: skip(),
    restartHealthy: skip(),
    sizes: skip(),
    candidates: candidatesOf(ctx.candidates),
    infrastructureFailures: ctx.failures,
    timings: ctx.timings,
  };
}

export async function runOnce(input: RunInput): Promise<ObservationRun> {
  const { recipe, deps, runIndex } = input;
  const startedAt = deps.now().toISOString();
  const ctx: Ctx = { ...input, arch: 'amd64-emulated', image: '', secrets: new Set(), timings: {}, failures: [] };

  let built: BuiltImage;
  try {
    built = await timed(ctx, 'build', () =>
      deps.buildImage({
        id: recipe.id,
        recipe,
        ...(input.fixtureDir === undefined ? {} : { fixtureDir: input.fixtureDir }),
        platform: input.platform ?? 'linux/amd64',
        logDir: join(input.runsDir, recipe.id, 'logs'),
      }),
    );
  } catch (error) {
    ctx.failures.push(`build: ${message(error)}`);
    return skippedRun(ctx, startedAt, failed(ctx.arch, error), 'build failed');
  }
  ctx.arch = built.arch;
  ctx.image = built.image;
  const build = buildFact(ctx, built);
  deps.log(`${recipe.id} run ${runIndex}: build ${built.ok ? 'ok' : 'failed'}${built.fromCache ? ' (cached)' : ''}`);
  if (!built.ok) return skippedRun(ctx, startedAt, build, 'build failed');

  const a = await step(ctx, 'setA', 'service set A', () => observeSetA(ctx));
  const lost = (): Fact<never> => failed(ctx.arch, ctx.failures.at(-1));
  const facts = a?.facts ?? {
    webHealthy: lost(),
    listeningPorts: lost(),
    httpPaths: lost(),
    smoke: lost(),
    database: lost(),
    startupMigration: lost(),
    redis: lost(),
    objectStorage: lost(),
    localDiskWrites: lost(),
    workers: lost(),
    restartHealthy: lost(),
  };
  const healthy = facts.webHealthy.value === true;
  const unhealthy = <T>(): Fact<T> => notRun<T>(ctx.arch, 'web was not healthy');

  const migrationCommands = await observeMigrations(ctx);
  const twoCopiesHealthy = healthy ? await observeTwoCopies(ctx) : unhealthy<boolean>();
  const requiredVariables = healthy ? await observeVariables(ctx, healthy, facts.database.value?.engine ?? null) : unhealthy<Of<'requiredVariables'>>();
  const sizes = await observeSizes(ctx, a?.health ?? null);

  return {
    startedAt,
    harnessVersion: input.harnessVersion,
    build,
    ...facts,
    migrationCommands,
    requiredVariables,
    twoCopiesHealthy,
    sizes,
    candidates: candidatesOf(input.candidates),
    infrastructureFailures: ctx.failures,
    timings: ctx.timings,
  };
}
