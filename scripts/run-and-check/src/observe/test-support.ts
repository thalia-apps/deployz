import { deploymentManifestSchema } from '@deployz/contracts';

import { recipeSchema, type AnalysisResultFile, type Recipe } from '../contract.js';
import type { BuiltImage, RunningContainer, ServiceSet, ServiceSnapshot } from '../ports.js';
import type { ObserveDeps } from './types.js';

export const SECRET = 's3cret-value-1234';
const SECRET_KEY_NAME = 'SECRET_KEY';

export function makeRecipe(overrides: Record<string, unknown> = {}): Recipe {
  return recipeSchema.parse({
    id: 'repo-001',
    set: 'tuning',
    source: { kind: 'git', repository: 'o/r', commit: 'a'.repeat(40) },
    ...overrides,
  });
}

export function makeAnalysis(overrides: Record<string, unknown> = {}): AnalysisResultFile {
  const manifest = deploymentManifestSchema.parse({
    application: { root: '.', runtime: 'node', framework: null, dockerfilePath: 'Dockerfile' },
    build: { command: null, context: '.' },
    web: { command: 'node server.js', port: 4000 },
    health: { path: '/healthz' },
    database: { postgres: true, envBindings: [{ name: 'DATABASE_URL', kind: 'url' }] },
    redis: { required: false, envBindings: [{ name: 'REDIS_URL', kind: 'url' }] },
    storage: { required: false, envBindings: [] },
    migration: { command: 'npm run migrate' },
    worker: { command: 'node worker.js' },
    environment: {
      variables: [
        { key: 'SECRET_KEY', required: true, secret: true, source: [], classification: 'customer_required' },
        { key: 'DATABASE_URL', required: true, secret: true, source: [], classification: 'deployz_managed' },
        { key: 'LOG_LEVEL', required: false, secret: false, source: [] },
      ],
    },
    externalServices: [],
    unsupported: [],
  });
  return { id: 'repo-001', commit: 'a'.repeat(40), analyser: 'rules@x', status: 'analysed', failure: null, manifest, gate: null, vendorQuestions: 0, ...overrides };
}

export interface FakeOptions {
  /** From this build on, the web container exits out of memory below 2048 MiB. */
  breakFromBuild?: number;
  buildFails?: boolean;
  /** Service starts that throw before one succeeds. */
  failServiceStarts?: number;
  /** Every start of a service set with this label part throws. */
  alwaysFailLabel?: string;
  /** The web container is healthy only after a migration ran in its set, and its start creates no table. */
  needsMigration?: boolean;
}

interface SetState {
  tables: string[];
  pgConns: number;
  valkeyClients: number;
  valkeyKeys: number;
}

export interface Fake {
  deps: ObserveDeps;
  calls: { builds: number; serviceStarts: number; webStarts: number; logs: string[] };
}

/** A fake application: healthy on `/healthz` port 8080, needs `SECRET_KEY`, creates tables when it starts. */
export function makeFake(options: FakeOptions = {}): Fake {
  const calls = { builds: 0, serviceStarts: 0, webStarts: 0, logs: [] as string[] };
  const states = new Map<string, SetState>();
  const up = new Map<string, boolean>();
  let failuresLeft = options.failServiceStarts ?? 0;
  const broken = (): boolean => options.breakFromBuild !== undefined && calls.builds >= options.breakFromBuild;

  const endpoint = { host: 'h', port: 1, user: 'u', password: 'pgpass1234', database: 'd' };
  const makeSet = (id: string): ServiceSet => ({
    id,
    network: `net-${id}`,
    postgres: endpoint,
    mysql: { ...endpoint, password: 'mysqlpass12' },
    valkey: { host: 'v', port: 6379 },
    minio: { host: 'm', port: 9000, endpoint: 'http://m:9000', accessKey: 'minioaccess1', secretKey: 'miniosecret1', bucket: 'b', region: 'us-east-1' },
    caVolume: 'ca',
    caDir: '/ca',
  });

  const deps: ObserveDeps = {
    async buildImage(): Promise<BuiltImage> {
      calls.builds += 1;
      return {
        image: 'img:1',
        arch: 'amd64-emulated',
        ok: options.buildFails !== true,
        exitCode: options.buildFails === true ? 1 : 0,
        seconds: 1,
        imageBytes: 10,
        dockerfile: 'Dockerfile',
        context: '.',
        failure: options.buildFails === true ? 'dockerfile' : null,
        fromCache: calls.builds > 1,
        evidence: [],
      };
    },
    services: {
      async start(id, label) {
        calls.serviceStarts += 1;
        if (options.alwaysFailLabel !== undefined && label.includes(options.alwaysFailLabel)) throw new Error('docker network create failed');
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('postgres did not become ready');
        }
        const set = makeSet(`${id}-${label}`);
        states.set(set.id, { tables: [], pgConns: 0, valkeyClients: 0, valkeyKeys: 0 });
        return set;
      },
      async inspect(set): Promise<ServiceSnapshot> {
        const s = states.get(set.id) as SetState;
        return {
          postgres: { connections: s.pgConns, tables: s.tables },
          mysql: { connections: 0, tables: [] },
          valkey: { clients: s.valkeyClients, keys: s.valkeyKeys },
          minio: { objects: 0 },
          evidence: [
            { kind: 'command', source: 'postgres', text: `connections=${s.pgConns}` },
            { kind: 'command', source: 'valkey', text: `clients=${s.valkeyClients}` },
          ],
        };
      },
      async stop() {},
    },
    runner: {
      async start(spec): Promise<RunningContainer> {
        const state = states.get(spec.services.id) as SetState;
        if (spec.role === 'web') {
          calls.webStarts += 1;
          const migrated = options.needsMigration !== true || state.tables.includes('migrated');
          const healthy = SECRET_KEY_NAME in spec.env && !(broken() && spec.size.memoryMiB < 2048) && migrated;
          up.set(spec.name, healthy);
          if (healthy) {
            if (options.needsMigration !== true && !state.tables.includes('users')) state.tables.push('users');
            state.pgConns = 1;
            state.valkeyClients = 1;
          }
        } else {
          up.set(spec.name, true);
          state.valkeyKeys += 1;
        }
        return { name: spec.name, spec, startedAtMs: 0 };
      },
      async runOnce(spec) {
        (states.get(spec.services.id) as SetState).tables.push('migrated');
        return { exitCode: 0, seconds: 3, evidence: [{ kind: 'log', source: 'migration', text: `ran with ${SECRET}` }] };
      },
      async waitHealthy(container, wait) {
        const isUp = up.get(container.name) === true;
        const healthy = isUp && wait.ports.includes(8080) && wait.paths.includes('/healthz');
        return { healthy, seconds: healthy ? 5 : null, checks: [], exited: !isUp, oomKilled: !isUp && broken() };
      },
      async listenSockets(container) {
        return up.get(container.name) === true ? [{ port: 8080, bind: 'all' }] : [];
      },
      async httpProbe(_container, port, paths) {
        return paths.map((path) => ({ port, path, status: port === 8080 ? (path === '/healthz' ? 200 : path === '/' ? 302 : 404) : null }));
      },
      async isRunning() {
        return { running: true, restarts: 0, exitCode: null };
      },
      async diff() {
        return ['A /app/data.sqlite', 'C /tmp/x', 'A /var/log/app.log'];
      },
      async logs(container) {
        return `ready ${container.spec.env.SECRET_KEY ?? 'no key'}`;
      },
      async stop() {},
    },
    env: ({ services }) => ({
      env: { DATABASE_URL: `postgres://${services.postgres.host}`, SECRET_KEY: SECRET },
      harnessOnly: [],
      secretNames: ['SECRET_KEY'],
    }),
    now: () => new Date('2026-10-16T10:00:00Z'),
    log: (line) => calls.logs.push(line),
    sleep: async () => {},
  };
  return { deps, calls };
}
