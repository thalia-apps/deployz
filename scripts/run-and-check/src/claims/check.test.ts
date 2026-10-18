import { describe, expect, it } from 'vitest';

import type { Claim, ClaimVerdict, ObservationFactName } from '../contract.js';
import { checkClaims } from './check.js';
import { PREDICTED_UNBUILDABLE } from './extract.js';
import { makeObservation, makeRun, type RunOptions } from './test-support.js';

type Values = Parameters<typeof makeRun>[0];

function check(claim: Partial<Claim> & Pick<Claim, 'type' | 'value'>, values: Values = {}, options: RunOptions = {}): ClaimVerdict {
  const full: Claim = { subject: null, from: 'test', ...claim };
  return checkClaims([full], makeObservation(makeRun(values, options)))[0]!;
}

const build = (overrides: object) => ({
  ok: true,
  exitCode: 0,
  seconds: 10,
  imageBytes: 1,
  dockerfile: 'Dockerfile',
  context: '.',
  failure: null,
  fromCache: false,
  ...overrides,
});

const DOCKERFILE = { type: 'dockerfile', subject: '.', value: 'Dockerfile' } as const;

describe('readiness', () => {
  it('is decided by the full run', () => {
    const verdict = check({ type: 'readiness', value: 'READY' });
    expect(verdict).toMatchObject({ verdict: 'NOT_CHECKABLE', reason: 'decided by the full run' });
  });
});

describe('dockerfile', () => {
  it('is CONFIRMED when the claimed Dockerfile builds', () => {
    expect(check(DOCKERFILE).verdict).toBe('CONFIRMED');
  });

  it('ignores ./ and trailing slashes when it compares paths', () => {
    const verdict = check(
      { type: 'dockerfile', subject: './apps/web/', value: './docker/Dockerfile' },
      { build: build({ dockerfile: 'docker/Dockerfile', context: 'apps/web' }) },
    );
    expect(verdict.verdict).toBe('CONFIRMED');
  });

  it('is CONTRADICTED when the build fails because of the Dockerfile', () => {
    const verdict = check(DOCKERFILE, { build: build({ ok: false, exitCode: 1, failure: 'dockerfile' }) });
    expect(verdict).toMatchObject({ verdict: 'CONTRADICTED', observed: 'build failed' });
  });

  it.each(['infrastructure', 'timeout'] as const)('is NOT_CHECKABLE for a %s failure', (failure) => {
    const verdict = check(DOCKERFILE, { build: build({ ok: false, exitCode: 1, failure }) });
    expect(verdict).toMatchObject({ verdict: 'NOT_CHECKABLE', reason: `build ${failure} failure` });
  });

  it('is NOT_CHECKABLE for an emulation failure', () => {
    const verdict = check(DOCKERFILE, { build: build({ ok: false, exitCode: 134, failure: 'emulation' }) });
    expect(verdict).toMatchObject({ verdict: 'NOT_CHECKABLE', reason: 'emulation' });
  });

  it('is NOT_CHECKABLE for an arm64 build', () => {
    const verdict = check(DOCKERFILE, {}, { arch: 'arm64-native' });
    expect(verdict).toMatchObject({ verdict: 'NOT_CHECKABLE', reason: 'arm64 build does not prove the Dockerfile', arch: 'arm64-native' });
  });

  it('is NOT_CHECKABLE when the observation built another Dockerfile', () => {
    const verdict = check({ type: 'dockerfile', subject: '.', value: 'docker/Dockerfile.prod' });
    expect(verdict).toMatchObject({ verdict: 'NOT_CHECKABLE', reason: 'the observation built another Dockerfile or context' });
  });

  it('is CONTRADICTED when the Analysis found no Dockerfile but one builds', () => {
    const verdict = check({ type: 'dockerfile', subject: '.', value: null });
    expect(verdict).toMatchObject({ verdict: 'CONTRADICTED', observed: 'Dockerfile' });
  });
});

describe('web.port', () => {
  const WEB = { type: 'web.port', value: 8080 } as const;

  it('is CONFIRMED when the port listens on all interfaces and is reachable', () => {
    expect(check(WEB).verdict).toBe('CONFIRMED');
  });

  it('is CONTRADICTED when the app listens only on loopback', () => {
    const verdict = check(WEB, { listeningPorts: [{ port: 8080, bind: 'loopback', reachableFromProbe: false }] });
    expect(verdict).toMatchObject({ verdict: 'CONTRADICTED', observed: 'loopback' });
  });

  it('is CONTRADICTED with the real port when the app listens elsewhere', () => {
    const verdict = check(WEB, { listeningPorts: [{ port: 3000, bind: 'all', reachableFromProbe: true }] });
    expect(verdict).toMatchObject({ verdict: 'CONTRADICTED', observed: 3000 });
  });

  it('reports the reachable port, not a debug port', () => {
    const verdict = check(WEB, {
      listeningPorts: [
        { port: 9229, bind: 'loopback', reachableFromProbe: false },
        { port: 3000, bind: 'all', reachableFromProbe: true },
      ],
    });
    expect(verdict.observed).toBe(3000);
  });

  it('is NOT_CHECKABLE when the web app never started', () => {
    const verdict = check(WEB, { listeningPorts: [], webHealthy: false });
    expect(verdict).toMatchObject({ verdict: 'NOT_CHECKABLE', reason: 'the web app did not start' });
  });

  it('says so when the image did not build', () => {
    const verdict = check(WEB, { listeningPorts: [], build: build({ ok: false, failure: 'dockerfile' }) });
    expect(verdict.reason).toBe('the image did not build');
  });

  it('is NOT_CHECKABLE when the claimed port listens but the probe cannot reach it', () => {
    const verdict = check(WEB, { listeningPorts: [{ port: 8080, bind: 'all', reachableFromProbe: false }] });
    expect(verdict.verdict).toBe('NOT_CHECKABLE');
  });

  it('is NOT_CHECKABLE when the Analysis gave no port', () => {
    const verdict = check({ type: 'web.port', value: null });
    expect(verdict).toMatchObject({ verdict: 'NOT_CHECKABLE', reason: 'the Analysis made no claim' });
  });
});

describe('health.path', () => {
  const HEALTH = { type: 'health.path', value: '/healthz' } as const;

  it('is CONFIRMED when the claimed path answers 200', () => {
    expect(check(HEALTH).verdict).toBe('CONFIRMED');
  });

  it('is CONTRADICTED with the status when another path answers 200', () => {
    const verdict = check(HEALTH, {
      httpPaths: [
        { port: 8080, path: '/', status: 200 },
        { port: 8080, path: '/healthz', status: 404 },
      ],
    });
    expect(verdict).toMatchObject({ verdict: 'CONTRADICTED', observed: 404 });
  });

  it('is CONTRADICTED when the app is up and the path gives a redirect', () => {
    const verdict = check(HEALTH, { httpPaths: [{ port: 8080, path: '/healthz', status: 302 }] });
    expect(verdict).toMatchObject({ verdict: 'CONTRADICTED', observed: 302 });
  });

  it('ignores a 200 on an unreachable port', () => {
    const verdict = check(HEALTH, {
      listeningPorts: [{ port: 8080, bind: 'all', reachableFromProbe: true }],
      httpPaths: [
        { port: 8080, path: '/healthz', status: 500 },
        { port: 9000, path: '/healthz', status: 200 },
      ],
    });
    expect(verdict).toMatchObject({ verdict: 'CONTRADICTED', observed: 500 });
  });

  it('is NOT_CHECKABLE when the app is not up', () => {
    const verdict = check(HEALTH, { webHealthy: false, listeningPorts: [], httpPaths: [{ port: 8080, path: '/healthz', status: null }] });
    expect(verdict).toMatchObject({ verdict: 'NOT_CHECKABLE', reason: 'the web app did not start' });
  });

  it('is NOT_CHECKABLE when the claimed path was not probed', () => {
    const verdict = check(HEALTH, { httpPaths: [{ port: 8080, path: '/', status: 200 }] });
    expect(verdict).toMatchObject({ verdict: 'NOT_CHECKABLE', reason: 'the observation did not probe the claimed path' });
  });

  it('is NOT_CHECKABLE when the Analysis needs a vendor path', () => {
    expect(check({ type: 'health.path', value: null }).verdict).toBe('NOT_CHECKABLE');
  });
});

describe('database.engine', () => {
  const POSTGRES = { type: 'database.engine', value: 'postgres' } as const;
  const NONE = { type: 'database.engine', value: 'none' } as const;
  const used = (engine: 'postgres' | 'mysql') => ({
    database: { engine, connections: 2, tablesAfterStart: ['users'], sqliteFileWritten: false },
  });

  it('confirms postgres from connections and tables', () => {
    expect(check(POSTGRES, used('postgres')).verdict).toBe('CONFIRMED');
  });

  it('confirms mysql from connections alone', () => {
    const verdict = check({ type: 'database.engine', value: 'mysql' }, {
      database: { engine: 'mysql', connections: 1, tablesAfterStart: [], sqliteFileWritten: false },
    });
    expect(verdict.verdict).toBe('CONFIRMED');
  });

  it('is CONTRADICTED when the app used the other engine', () => {
    expect(check(POSTGRES, used('mysql'))).toMatchObject({ verdict: 'CONTRADICTED', observed: 'mysql' });
  });

  it('is CONTRADICTED with observed none when the app made no SQL connection', () => {
    expect(check(POSTGRES)).toMatchObject({ verdict: 'CONTRADICTED', observed: 'none' });
  });

  it('is CONTRADICTED with observed sqlite when the app wrote a SQLite file', () => {
    const verdict = check(POSTGRES, { database: { engine: null, connections: 0, tablesAfterStart: [], sqliteFileWritten: true } });
    expect(verdict).toMatchObject({ verdict: 'CONTRADICTED', observed: 'sqlite' });
  });

  it('is NOT_CHECKABLE when the app did not start and used no database', () => {
    const verdict = check(POSTGRES, { webHealthy: false, listeningPorts: [], httpPaths: [{ port: 8080, path: '/', status: null }] });
    expect(verdict).toMatchObject({ verdict: 'NOT_CHECKABLE', reason: 'the web app did not start' });
  });

  it('confirms none when there is no connection, no table and the request succeeds', () => {
    expect(check(NONE).verdict).toBe('CONFIRMED');
  });

  it('confirms none for a server on loopback only, which no request can reach', () => {
    const loopback = { webHealthy: false, listeningPorts: [{ port: 8080, bind: 'loopback' as const, reachableFromProbe: false }], smoke: { path: '/', status: null } };
    expect(check(NONE, loopback).verdict).toBe('CONFIRMED');
  });

  it('contradicts none when the app connected', () => {
    expect(check(NONE, used('postgres'))).toMatchObject({ verdict: 'CONTRADICTED', observed: 'postgres' });
  });

  it('contradicts none when the app wrote a SQLite file', () => {
    const verdict = check(NONE, { database: { engine: null, connections: 0, tablesAfterStart: [], sqliteFileWritten: true } });
    expect(verdict).toMatchObject({ verdict: 'CONTRADICTED', observed: 'sqlite' });
  });

  it('contradicts none when the request that uses the database fails with a 5xx', () => {
    const verdict = check(NONE, { smoke: { path: '/db', status: 500 } });
    expect(verdict).toMatchObject({ verdict: 'CONTRADICTED', observed: 'http 500' });
  });

  it('is NOT_CHECKABLE for none when the database request got no response', () => {
    expect(check(NONE, { smoke: { path: '/db', status: null } }).verdict).toBe('NOT_CHECKABLE');
  });
});

describe('redis.required', () => {
  const connected = { redis: { connected: true, clients: 2 } };

  it('is CONFIRMED when the claim is true and the app connected', () => {
    expect(check({ type: 'redis.required', value: true }, connected).verdict).toBe('CONFIRMED');
  });

  it('is CONFIRMED when the claim is false and the app did not connect', () => {
    expect(check({ type: 'redis.required', value: false }).verdict).toBe('CONFIRMED');
  });

  it('is CONTRADICTED when the claim is true and the app made no connection', () => {
    expect(check({ type: 'redis.required', value: true })).toMatchObject({ verdict: 'CONTRADICTED', observed: false });
  });

  it('is CONTRADICTED when the claim is false and the app connected', () => {
    expect(check({ type: 'redis.required', value: false }, connected)).toMatchObject({ verdict: 'CONTRADICTED', observed: true });
  });

  it('is NOT_CHECKABLE when the app did not start', () => {
    const down = { webHealthy: false, listeningPorts: [], httpPaths: [{ port: 8080, path: '/', status: null }] };
    expect(check({ type: 'redis.required', value: true }, down).verdict).toBe('NOT_CHECKABLE');
    expect(check({ type: 'redis.required', value: false }, down).verdict).toBe('NOT_CHECKABLE');
  });
});

describe('storage.required', () => {
  it('is CONFIRMED when the claim is true and objects were written', () => {
    expect(check({ type: 'storage.required', value: true }, { objectStorage: { objectsWritten: 3 } }).verdict).toBe('CONFIRMED');
  });

  it('is NOT_CHECKABLE when the claim is true and no upload was triggered', () => {
    expect(check({ type: 'storage.required', value: true })).toMatchObject({ verdict: 'NOT_CHECKABLE', reason: 'no upload was triggered' });
  });

  it('is CONTRADICTED when the claim is false and objects were written', () => {
    const verdict = check({ type: 'storage.required', value: false }, { objectStorage: { objectsWritten: 1 } });
    expect(verdict).toMatchObject({ verdict: 'CONTRADICTED', observed: true });
  });

  it('is NOT_CHECKABLE when the claim is false and nothing was written', () => {
    expect(check({ type: 'storage.required', value: false }).verdict).toBe('NOT_CHECKABLE');
  });
});

describe('storage.local', () => {
  const writes = { localDiskWrites: ['/app/data/db.bin'] };

  it('is CONFIRMED when the claim is true and the app wrote to disk', () => {
    expect(check({ type: 'storage.local', value: true }, writes).verdict).toBe('CONFIRMED');
  });

  it('is NOT_CHECKABLE when the claim is true and no write was seen', () => {
    expect(check({ type: 'storage.local', value: true })).toMatchObject({ verdict: 'NOT_CHECKABLE', reason: 'no local write was seen' });
  });

  it('is CONTRADICTED with the path when the claim is false and the app wrote to disk', () => {
    expect(check({ type: 'storage.local', value: false }, writes)).toMatchObject({ verdict: 'CONTRADICTED', observed: '/app/data/db.bin' });
  });

  it('is CONFIRMED when the claim is false and there is no write', () => {
    expect(check({ type: 'storage.local', value: false }).verdict).toBe('CONFIRMED');
  });

  it('is NOT_CHECKABLE for false when the app did not start', () => {
    const down = { webHealthy: false, listeningPorts: [], httpPaths: [{ port: 8080, path: '/', status: null }] };
    expect(check({ type: 'storage.local', value: false }, down).verdict).toBe('NOT_CHECKABLE');
  });
});

describe('migration.mode', () => {
  const MODE = (value: string): Pick<Claim, 'type' | 'value'> => ({ type: 'migration.mode', value });
  const startedTables = {
    startupMigration: { tablesCreatedByStart: true, secondStartHealthy: true },
    database: { engine: 'postgres' as const, connections: 2, tablesAfterStart: ['users'], sqliteFileWritten: false },
  };
  const commandTables = {
    migrationCommands: [{ command: 'npm run migrate', exitCode: 0, createdTables: true, seconds: 5 }],
    database: { engine: 'postgres' as const, connections: 2, tablesAfterStart: ['users'], sqliteFileWritten: false },
  };

  it('confirms startup when the first start created the tables', () => {
    expect(check(MODE('startup'), startedTables).verdict).toBe('CONFIRMED');
  });

  it('contradicts startup when only a command created the tables', () => {
    expect(check(MODE('startup'), commandTables)).toMatchObject({ verdict: 'CONTRADICTED', observed: 'pre_deploy' });
  });

  it('contradicts startup when no table appeared', () => {
    expect(check(MODE('startup'))).toMatchObject({ verdict: 'CONTRADICTED', observed: 'none' });
  });

  it('confirms pre_deploy when a command created the tables and the start did not', () => {
    expect(check(MODE('pre_deploy'), commandTables).verdict).toBe('CONFIRMED');
  });

  it('contradicts pre_deploy when the first start created the tables', () => {
    expect(check(MODE('pre_deploy'), { ...commandTables, ...startedTables })).toMatchObject({
      verdict: 'CONTRADICTED',
      observed: 'startup',
    });
  });

  it('is NOT_CHECKABLE for pre_deploy when no command created tables', () => {
    expect(check(MODE('pre_deploy')).verdict).toBe('NOT_CHECKABLE');
  });

  it('confirms none when no table appeared and the database had no connection', () => {
    expect(check(MODE('none')).verdict).toBe('CONFIRMED');
  });

  it('contradicts none when the start created tables', () => {
    expect(check(MODE('none'), startedTables)).toMatchObject({ verdict: 'CONTRADICTED', observed: 'startup' });
  });

  it('confirms none when the app used the database without tables', () => {
    const verdict = check(MODE('none'), {
      database: { engine: 'postgres', connections: 1, tablesAfterStart: [], sqliteFileWritten: false },
    });
    expect(verdict.verdict).toBe('CONFIRMED');
  });

  it('is NOT_CHECKABLE for unknown', () => {
    expect(check(MODE('unknown')).verdict).toBe('NOT_CHECKABLE');
  });

  it('is NOT_CHECKABLE when the Analysis gave no mode', () => {
    expect(check({ type: 'migration.mode', value: null }).reason).toBe('the Analysis made no claim');
  });
});

describe('migration.command', () => {
  const COMMAND = { type: 'migration.command', value: 'npm run migrate' } as const;
  const ran = (exitCode: number | null, createdTables: boolean) => ({
    migrationCommands: [{ command: 'npm run migrate', exitCode, createdTables, seconds: 3 }],
  });

  it('is CONFIRMED when the command exits 0 and creates tables', () => {
    expect(check(COMMAND, ran(0, true)).verdict).toBe('CONFIRMED');
  });

  it('is CONTRADICTED with the exit code when the command fails', () => {
    expect(check(COMMAND, ran(1, false))).toMatchObject({ verdict: 'CONTRADICTED', observed: 1 });
  });

  it('is NOT_CHECKABLE when the command was not run', () => {
    expect(check(COMMAND)).toMatchObject({ verdict: 'NOT_CHECKABLE', reason: 'the command was not run' });
  });

  it('is NOT_CHECKABLE when the command exits 0 without new tables', () => {
    expect(check(COMMAND, ran(0, false)).verdict).toBe('NOT_CHECKABLE');
  });

  it('is NOT_CHECKABLE when the command did not finish', () => {
    expect(check(COMMAND, ran(null, false)).verdict).toBe('NOT_CHECKABLE');
  });
});

describe('worker.command', () => {
  const WORKER = { type: 'worker.command', subject: 'worker', value: 'python worker.py' } as const;
  const worker = (overrides: object) => ({
    workers: [{ command: 'python worker.py', stayedRunning: true, exitCode: null, restarts: 0, queueActivity: null, ...overrides }],
  });

  it('is CONFIRMED when the worker stays running', () => {
    expect(check(WORKER, worker({})).verdict).toBe('CONFIRMED');
  });

  it('is CONTRADICTED with the exit code when the worker exits', () => {
    expect(check(WORKER, worker({ stayedRunning: false, exitCode: 1 }))).toMatchObject({ verdict: 'CONTRADICTED', observed: 'exit 1' });
  });

  it('is CONTRADICTED when the worker restarts', () => {
    expect(check(WORKER, worker({ stayedRunning: false, restarts: 4 }))).toMatchObject({
      verdict: 'CONTRADICTED',
      observed: 'restarted 4 times',
    });
  });

  it('is NOT_CHECKABLE when the worker was not run', () => {
    expect(check(WORKER).verdict).toBe('NOT_CHECKABLE');
  });
});

describe('env.required', () => {
  const ENV = { type: 'env.required', subject: 'SECRET_KEY', value: true } as const;
  const tested = (healthyWithout: boolean, healthyWith: boolean) => ({
    requiredVariables: [{ name: 'SECRET_KEY', healthyWithout, healthyWith }],
  });

  it('is CONFIRMED when the app fails without the variable and starts with it', () => {
    expect(check(ENV, tested(false, true)).verdict).toBe('CONFIRMED');
  });

  it('is CONTRADICTED when the app starts without the variable', () => {
    expect(check(ENV, tested(true, true))).toMatchObject({ verdict: 'CONTRADICTED', observed: 'not required' });
  });

  it('is NOT_CHECKABLE when the app is unhealthy with the variable too', () => {
    expect(check(ENV, tested(false, false)).verdict).toBe('NOT_CHECKABLE');
  });

  it('is NOT_CHECKABLE when the variable was not tested', () => {
    expect(check(ENV)).toMatchObject({ verdict: 'NOT_CHECKABLE', reason: 'the variable was not tested' });
  });
});

describe('facts that were not observed', () => {
  it.each<[Claim['type'], Claim['value'], ObservationFactName]>([
    ['dockerfile', 'Dockerfile', 'build'],
    ['web.port', 8080, 'listeningPorts'],
    ['health.path', '/healthz', 'httpPaths'],
    ['database.engine', 'postgres', 'database'],
    ['redis.required', true, 'redis'],
    ['storage.required', true, 'objectStorage'],
    ['storage.local', true, 'localDiskWrites'],
    ['migration.mode', 'startup', 'startupMigration'],
    ['migration.command', 'x', 'migrationCommands'],
    ['worker.command', 'x', 'workers'],
    ['env.required', true, 'requiredVariables'],
  ])('%s is NOT_CHECKABLE when %s is not run', (type, value, fact) => {
    const verdict = check({ type, value, subject: 'x' }, {}, { notRun: [fact] });
    expect(verdict.verdict).toBe('NOT_CHECKABLE');
  });
});

describe('verdict evidence', () => {
  it('lists the facts and the architecture the verdict used', () => {
    const verdict = check({ type: 'web.port', value: 8080 });
    expect(verdict.facts).toEqual(['listeningPorts', 'build']);
    expect(verdict.arch).toBe('amd64-emulated');
  });

  it('uses the weakest architecture of the used facts', () => {
    const run = makeRun();
    run.build.arch = 'amd64-ci-build';
    run.listeningPorts.arch = 'arm64-native';
    const [verdict] = checkClaims([{ type: 'web.port', subject: null, value: 8080, from: 'web.port' }], makeObservation(run));
    expect(verdict!.arch).toBe('arm64-native');
  });

  it('marks a verdict unstable when a used fact is unstable, and still uses run 1', () => {
    const claim: Claim = { type: 'web.port', subject: null, value: 8080, from: 'web.port' };
    const flaky = makeRun({ listeningPorts: [{ port: 3000, bind: 'all', reachableFromProbe: true }] });
    const observation = makeObservation(makeRun(), { runs: [makeRun(), flaky], unstable: ['listeningPorts'] });
    const [verdict] = checkClaims([claim], observation);
    expect(verdict).toMatchObject({ verdict: 'CONFIRMED', unstable: true });
  });

  it('does not mark a verdict unstable for an unused fact', () => {
    const claim: Claim = { type: 'web.port', subject: null, value: 8080, from: 'web.port' };
    const [verdict] = checkClaims([claim], makeObservation(makeRun(), { unstable: ['restartHealthy'] }));
    expect(verdict!.unstable).toBe(false);
  });

  it('gives no observed value for a CONFIRMED verdict', () => {
    expect(check({ type: 'web.port', value: 8080 })).not.toHaveProperty('observed');
  });
});

describe('dockerfile with a predicted build failure', () => {
  const PREDICTED = { type: 'dockerfile' as const, subject: '.', value: 'Dockerfile', from: PREDICTED_UNBUILDABLE };

  it('confirms the prediction when the build fails', () => {
    expect(check(PREDICTED, { build: build({ ok: false, exitCode: 1, failure: 'dockerfile' }) }).verdict).toBe('CONFIRMED');
  });

  it('contradicts the prediction when the image builds', () => {
    expect(check(PREDICTED, { build: build({}) }).verdict).toBe('CONTRADICTED');
  });
});
