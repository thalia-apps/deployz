import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { recipeSchema } from '../contract.js';
import { buildImage, classifyBuildFailure, gitContextUrl } from './build.js';
import { cleanEnv } from './docker.js';
import { createImageCache } from './image-cache.js';
import { withBuildLock } from './lock.js';
import { assertSafeArgs, labelArgs } from './safety.js';

describe('assertSafeArgs', () => {
  it('allows safe calls', () => {
    const safe = [
      ['run', '-d', '--name', 'x', ...labelArgs('F1'), '--network', 'net', '--cpus', '1', '-v', 'vol:/data:ro', 'img'],
      ['run', '--network=container:app', 'img'],
      ['run', '--mount', 'type=volume,source=vol,target=/x', 'img'],
      ['run', '-e', 'A=b', '--env', 'C=d', '-eE=f', 'img'],
      ['build', '--build-arg', 'K=V', '-t', 'ref', '.'],
      ['image', 'prune', '-a', '-f', '--filter', 'label=deployz.runcheck=1'],
    ];
    for (const args of safe) expect(() => assertSafeArgs(args)).not.toThrow();
  });

  it('refuses every unsafe form', () => {
    const unsafe = [
      ['run', '--privileged', 'i'],
      ['run', '--network', 'host', 'i'],
      ['run', '--network=host', 'i'],
      ['run', '--net', 'host', 'i'],
      ['run', '--pid', 'host', 'i'],
      ['run', '--pid=host', 'i'],
      ['run', '--cap-add', 'ALL', 'i'],
      ['run', '--cap-add=NET_ADMIN', 'i'],
      ['run', '--device', '/dev/x', 'i'],
      ['run', '-p', '80:80', 'i'],
      ['run', '-p8080:80', 'i'],
      ['run', '--publish', '80:80', 'i'],
      ['run', '--publish=80:80', 'i'],
      ['run', '-P', 'i'],
      ['run', '--publish-all', 'i'],
      ['run', '--env-file', 'f', 'i'],
      ['run', '--env-file=f', 'i'],
      ['run', '-e', 'AWS_PROFILE', 'i'],
      ['run', '--env', 'GH_TOKEN', 'i'],
      ['run', '-v', '/var/run/docker.sock:/s', 'i'],
      ['run', '-v', 'C:\\Users\\me:/x', 'i'],
      ['run', '-v', './data:/x', 'i'],
      ['run', '-v', '~/x:/x', 'i'],
      ['run', '--volume=/etc:/x', 'i'],
      ['run', '-v', '\\\\host\\share:/x', 'i'],
      ['run', '--mount', 'type=bind,source=/etc,target=/x', 'i'],
      ['run', '--mount', 'source=/var/run/docker.sock,target=/s', 'i'],
      ['run', '--security-opt', 'seccomp=unconfined', 'i'],
      ['run', '--security-opt=apparmor=unconfined', 'i'],
    ];
    for (const args of unsafe) expect(() => assertSafeArgs(args), args.join(' ')).toThrow(/Unsafe/);
  });
});

describe('labelArgs', () => {
  it('returns both labels', () => {
    expect(labelArgs('repo-006')).toEqual(['--label', 'deployz.runcheck=1', '--label', 'deployz.runcheck.repo=repo-006']);
  });
});

describe('cleanEnv', () => {
  it('keeps the allowed names and drops credentials', () => {
    const env = cleanEnv({
      PATH: 'p',
      SystemRoot: 'C:\\Windows',
      TEMP: 't',
      TMP: 't',
      USERPROFILE: 'u',
      ProgramFiles: 'C:\\Program Files',
      DOCKER_HOST: 'h',
      AWS_PROFILE: 'x',
      GH_TOKEN: 'x',
      GITHUB_TOKEN: 'x',
      HOME: 'h',
    });
    expect(Object.keys(env).sort()).toEqual(['DOCKER_HOST', 'PATH', 'ProgramFiles', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']);
  });
});

describe('classifyBuildFailure', () => {
  it('classifies a V8 heap limit followed by a qemu signal as emulation', () => {
    const log = [
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      'qemu: uncaught target signal 6 (Aborted) - core dumped',
    ].join('\n');
    const result = classifyBuildFailure(log, false);
    expect(result.failure).toBe('emulation');
    expect(result.lines).toContain('heap-limit');
    expect(classifyBuildFailure('FATAL ERROR: JavaScript heap out of memory', false).failure).toBe('dockerfile');
  });

  it('classifies the other cases', () => {
    expect(classifyBuildFailure('anything', true).failure).toBe('timeout');
    expect(classifyBuildFailure('qemu: uncaught target signal 11 (Segmentation fault)', false).failure).toBe('emulation');
    expect(classifyBuildFailure('Segmentation fault', false).failure).toBe('dockerfile');
    expect(classifyBuildFailure('#12 0.923 fatal error: lfstack.push', false).failure).toBe('emulation');
    expect(classifyBuildFailure('#13 323.3 TimeoutError: The operation was aborted due to timeout', false).failure).toBe('infrastructure');
    for (const line of ['TLS handshake timeout', 'toomanyrequests: rate limit', 'Could not resolve host: x', 'read: ECONNRESET']) {
      expect(classifyBuildFailure(`step\n${line}`, false).failure).toBe('infrastructure');
    }
    expect(classifyBuildFailure('npm ERR! missing script: build', false).failure).toBe('dockerfile');
  });
});

describe('gitContextUrl', () => {
  it('adds the sub folder only when set', () => {
    expect(gitContextUrl('o/r', 'abc')).toBe('https://github.com/o/r.git#abc');
    expect(gitContextUrl('o/r', 'abc', '.')).toBe('https://github.com/o/r.git#abc');
    expect(gitContextUrl('o/r', 'abc', 'apps/web')).toBe('https://github.com/o/r.git#abc:apps/web');
  });
});

describe('withBuildLock', () => {
  const tempLock = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runcheck-lock-')), 'build.lock');

  it('runs two concurrent calls one after the other', async () => {
    const lockPath = tempLock();
    const events: string[] = [];
    const task = (name: string) => async () => {
      events.push(`${name} start`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      events.push(`${name} end`);
    };
    await Promise.all([
      withBuildLock(task('a'), { lockPath, pollMs: 10 }),
      withBuildLock(task('b'), { lockPath, pollMs: 10 }),
    ]);
    expect(events[1]).toMatch(/end$/);
    expect(events[3]).toMatch(/end$/);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('takes over a lock of a dead process', async () => {
    const lockPath = tempLock();
    const child = spawn(process.execPath, ['-e', '0']);
    await new Promise((resolve) => child.on('close', resolve));
    fs.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, startedAt: 'x', id: 'dead' }));
    await expect(withBuildLock(async () => 'ok', { lockPath, pollMs: 10 })).resolves.toBe('ok');
  });
});

describe('assertSafeArgs scope', () => {
  it('does not read the command inside the container as docker options', () => {
    expect(() =>
      assertSafeArgs(['exec', 'rc-x-mysql', 'mysql', '-uroot', '-pSecret1', '-e', 'select 1']),
    ).not.toThrow();
    expect(() =>
      assertSafeArgs(['run', '--rm', '--network', 'rc-net', '-e', 'A=1', 'img', 'sh', '-c', 'x', '-v', '/']),
    ).not.toThrow();
  });

  it('still refuses unsafe options before the image', () => {
    expect(() => assertSafeArgs(['run', '-e', 'A=1', '-v', '/etc:/x', 'img'])).toThrow();
    expect(() => assertSafeArgs(['run', '--network', 'host', 'img'])).toThrow();
    expect(() => assertSafeArgs(['run', '-p', '80:80', 'img'])).toThrow();
    expect(() => assertSafeArgs(['run', '-e', 'NAME', 'img'])).toThrow();
  });
});

describe('buildImage with a failed CI build in the cache', () => {
  it('returns the CI failure as the build fact and runs no docker command', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-cache-'));
    const calls: string[][] = [];
    const run = async (args: readonly string[]) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };
    const cache = createImageCache(run, dir);
    const sha = 'd'.repeat(40);
    cache.recordFailure('repo-071', sha, {
      arch: 'amd64-ci-build',
      failure: 'dockerfile',
      dockerfile: 'docker/Dockerfile',
      context: '.',
      lines: ['ERROR: process "/bin/sh -c git rev-parse HEAD > /app/.git_sha" did not complete successfully: exit code: 128'],
    });
    const recipe = recipeSchema.parse({
      id: 'repo-071',
      set: 'tuning',
      source: { kind: 'git', repository: 'chatwoot/chatwoot', commit: sha },
      build: { dockerfile: 'docker/Dockerfile' },
    });
    const built = await buildImage({ id: 'repo-071', recipe, platform: 'linux/amd64', logDir: dir }, { run, cache });
    expect(built).toMatchObject({ ok: false, arch: 'amd64-ci-build', failure: 'dockerfile', fromCache: true });
    expect(calls).toEqual([]);
  });
});
