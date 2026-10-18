import { describe, expect, it } from 'vitest';

import type { ContainerSpec } from '../ports.js';
import { fakeDocker, unsafeRunProblems } from './fake-docker.js';
import { createRunner, parseListenSockets, redact } from './runner.js';
import { fakeServices } from './test-support.js';

const labelArgs = (id: string) => ['--label', 'deployz.runcheck=1', '--label', `deployz.runcheck.repo=${id}`];
const services = fakeServices();
const IMAGE = 'deployz-runcheck/repo-001:abc';

function spec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    id: 'repo-001',
    name: 'repo-001-web',
    image: IMAGE,
    platform: 'linux/amd64',
    role: 'web',
    command: null,
    env: { PORT: '3000', DATABASE_URL: 'postgresql://u:secretpw@h:5432/d', LONG: 'x'.repeat(5000) },
    services,
    size: { profile: 'small-v2', memoryMiB: 512, cpus: 1 },
    ...overrides,
  };
}

const runner = (docker: ReturnType<typeof fakeDocker>['docker']) =>
  createRunner({ docker, labelArgs, probeImage: 'probe:1', pollIntervalMs: 1 });

describe('parseListenSockets', () => {
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';

  it('reads LISTEN entries and classifies the bind address', () => {
    const text =
      header +
      '   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 1\n' +
      '   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 2\n' +
      '   2: 0A00020F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 3\n' +
      '   3: 0100007F:2328 0100007F:9999 01 00000000:00000000 00:00000000 00000000  1000 0 4\n';
    expect(parseListenSockets(text)).toEqual([
      { port: 80, bind: 'all' },
      { port: 3000, bind: 'all' },
      { port: 8080, bind: 'loopback' },
    ]);
  });

  it('reads IPv6 entries and lets an all-interface socket win over a loopback one on the same port', () => {
    const text =
      header +
      '   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 0:0 0:0 0 0 0 1\n' +
      '   1: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 0:0 0:0 0 0 0 2\n' +
      '   2: 0000000000000000FFFF00000100007F:2328 00000000000000000000000000000000:0000 0A 0:0 0:0 0 0 0 3\n' +
      '   3: 0100007F:0BB8 00000000:0000 0A 0:0 0:0 0 0 0 4\n';
    expect(parseListenSockets(text)).toEqual([
      { port: 3000, bind: 'all' },
      { port: 8080, bind: 'loopback' },
      { port: 9000, bind: 'loopback' },
    ]);
  });
});

describe('redact', () => {
  it('hides every listed value, longest first, and ignores short ones', () => {
    expect(redact('a postgresql://u:pw123456@h b pw123456 c', ['pw123456', 'postgresql://u:pw123456@h', 'ab'])).toBe(
      'a [redacted] b [redacted] c',
    );
  });
});

describe('start', () => {
  it('runs a web container with limits, labels, internal network and the CA volume', async () => {
    const fake = fakeDocker();
    await runner(fake.docker).start(spec());
    const args = fake.calls[0]!;
    expect(args.slice(0, 4)).toEqual(['run', '-d', '--name', 'repo-001-web']);
    expect(args).toEqual(
      expect.arrayContaining(['--platform', 'linux/amd64', '--network', 'net-repo-001', '--cpus', '1', '--memory', '512m', '--memory-swap', '512m', '--pids-limit', '512']),
    );
    expect(args).toEqual(expect.arrayContaining(['-v', 'repo-001-ca:/deployz/certs:ro']));
    expect(args).not.toContain('--restart');
    expect(args).toContain(`LONG=${'x'.repeat(5000)}`);
    expect(args.at(-1)).toBe(IMAGE);
    expect(unsafeRunProblems(args, 'net-repo-001')).toEqual([]);
  });

  it('encodes a web or worker command as CMD and a migration command as ENTRYPOINT', async () => {
    const fake = fakeDocker();
    const r = runner(fake.docker);
    await r.start(spec({ command: 'node server.js --port 3000' }));
    await r.start(spec({ role: 'worker', name: 'w', command: 'node worker.js' }));
    await r.start(spec({ role: 'migration', name: 'm', command: 'npm run migrate' }));
    const [web, worker, migration] = fake.calls;
    expect(web!.slice(-4)).toEqual([IMAGE, 'sh', '-c', 'node server.js --port 3000']);
    expect(web).not.toContain('--entrypoint');
    expect(worker).toEqual(expect.arrayContaining(['--restart', 'on-failure:10']));
    expect(worker!.slice(-4)).toEqual([IMAGE, 'sh', '-c', 'node worker.js']);
    expect(migration).not.toContain('--restart');
    expect(migration!.slice(-5)).toEqual(['--entrypoint', 'sh', IMAGE, '-c', 'npm run migrate']);
    for (const args of fake.calls) expect(unsafeRunProblems(args, 'net-repo-001')).toEqual([]);
  });

  it('mounts no CA volume without a database URL', async () => {
    const fake = fakeDocker();
    await runner(fake.docker).start(spec({ env: { PORT: '3000' } }));
    expect(fake.calls[0]).not.toContain('-v');
  });

  it('fails when docker run fails', async () => {
    const failing = async () => ({ exitCode: 125, stdout: '', stderr: 'no such image', timedOut: false });
    await expect(runner(failing).start(spec())).rejects.toThrow('no such image');
  });
});

describe('runOnce', () => {
  it('waits for the exit code, keeps the log tail and removes the container', async () => {
    const fake = fakeDocker({ waitExitCode: 3 });
    const outcome = await runner(fake.docker).runOnce(spec({ role: 'migration', name: 'm', command: 'x' }), 1000);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.evidence[0]).toMatchObject({ kind: 'log', source: 'm' });
    expect(fake.calls.map((call) => call[0])).toEqual(['run', 'wait', 'logs', 'rm']);
  });

  it('reports no exit code after a timeout and still removes the container', async () => {
    const fake = fakeDocker();
    const timeout = async (args: readonly string[]) =>
      args[0] === 'wait' ? { exitCode: 1, stdout: '', stderr: '', timedOut: true } : fake.docker(args);
    const outcome = await runner(timeout).runOnce(spec({ role: 'migration', name: 'm' }), 1000);
    expect(outcome.exitCode).toBeNull();
    expect(fake.calls.at(-1)).toEqual(['rm', '-f', 'm']);
  });
});

describe('probes', () => {
  const container = { name: 'repo-001-web', spec: spec(), startedAtMs: Date.now() };

  it('probes each path from a limited, labelled probe container on the internal network', async () => {
    const fake = fakeDocker({ status: (path) => (path === '/health' ? 200 : 0) });
    const checks = await runner(fake.docker).httpProbe(container, 3000, ['/health', '/missing']);
    expect(checks).toEqual([
      { port: 3000, path: '/health', status: 200 },
      { port: 3000, path: '/missing', status: null },
    ]);
    const args = fake.calls[0]!;
    expect(args).toEqual(expect.arrayContaining(['http://repo-001-web:3000/health', 'http://repo-001-web:3000/missing', 'probe:1', 'curl']));
    expect(unsafeRunProblems(args, 'net-repo-001')).toEqual([]);
  });

  it('sends the smoke request with method, body and content type', async () => {
    const fake = fakeDocker();
    const checks = await runner(fake.docker).httpProbe(container, 3000, [], {
      method: 'POST',
      path: '/api/items',
      body: '{"a":1}',
      contentType: 'application/json',
    });
    expect(checks).toEqual([{ port: 3000, path: '/api/items', status: 200 }]);
    expect(fake.calls[0]).toEqual(expect.arrayContaining(['-X', 'POST', 'Content-Type: application/json', '--data-raw', '{"a":1}']));
  });

  it('reads listen sockets from a probe in the container network namespace', async () => {
    const fake = fakeDocker({ procNetTcp: '   0: 0100007F:0BB8 00000000:0000 0A 0:0 0:0 0 0 0 1\n' });
    expect(await runner(fake.docker).listenSockets(container)).toEqual([{ port: 3000, bind: 'loopback' }]);
    expect(fake.calls[0]).toEqual(expect.arrayContaining(['--network', 'container:repo-001-web', 'cat', '/proc/net/tcp', '/proc/net/tcp6']));
    expect(unsafeRunProblems(fake.calls[0]!, 'net-repo-001')).toEqual([]);
  });
});

describe('waitHealthy', () => {
  const options = { ports: [3000], paths: ['/'], timeoutMs: 60_000 };

  it('is healthy when a path answers 200 and reports the seconds from start', async () => {
    const result = await runner(fakeDocker().docker).waitHealthy(
      { name: 'c', spec: spec(), startedAtMs: Date.now() - 12_000 },
      options,
    );
    expect(result.healthy).toBe(true);
    expect(result.seconds).toBeGreaterThanOrEqual(12);
    expect(result.checks).toEqual([{ port: 3000, path: '/', status: 200 }]);
  });

  it('stops when the container exited and reports an out-of-memory kill', async () => {
    const result = await runner(fakeDocker({ exitAfterInspects: 0 }).docker).waitHealthy(
      { name: 'c', spec: spec(), startedAtMs: Date.now() },
      options,
    );
    expect(result).toMatchObject({ healthy: false, exited: true, oomKilled: true, seconds: null });
  });

  it('keeps the last checks when the timeout passes', async () => {
    const result = await runner(fakeDocker({ status: () => 503 }).docker).waitHealthy(
      { name: 'c', spec: spec(), startedAtMs: Date.now() },
      { ...options, timeoutMs: 30 },
    );
    expect(result).toMatchObject({ healthy: false, exited: false });
    expect(result.checks).toEqual([{ port: 3000, path: '/', status: 503 }]);
  });
});

describe('container state', () => {
  const container = { name: 'c', spec: spec(), startedAtMs: Date.now() };

  it('reads running, restarts and exit code from docker inspect', async () => {
    expect(await runner(fakeDocker().docker).isRunning(container)).toEqual({ running: true, restarts: 2, exitCode: null });
    expect(await runner(fakeDocker({ exitAfterInspects: 0 }).docker).isRunning(container)).toEqual({
      running: false,
      restarts: 0,
      exitCode: 137,
    });
  });

  it('lists added and changed paths from docker diff', async () => {
    expect(await runner(fakeDocker().docker).diff(container)).toEqual(['/tmp', '/app/data.sqlite', '/app']);
  });

  it('joins stdout and stderr of the logs and removes with rm -f', async () => {
    const fake = fakeDocker();
    const r = runner(fake.docker);
    expect(await r.logs(container, 50)).toContain('ready');
    await r.stop(container);
    expect(fake.calls.map((call) => call.join(' '))).toEqual(['logs --tail 50 c', 'rm -f c']);
  });
});
