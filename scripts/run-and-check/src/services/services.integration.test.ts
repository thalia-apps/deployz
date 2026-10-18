import { spawn } from 'node:child_process';

import { afterAll, describe, expect, it } from 'vitest';

import type { DockerFn, DockerResources, DockerResult } from '../ports.js';
import { createServices } from './services.js';

const ALLOWED_ENV = new Set(['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'PROGRAMFILES']);
const RUN_ID = 'it-services';
const RUN_FILTER = `label=deployz.runcheck.repo=${RUN_ID}`;
const PSQL_IMAGE = 'public.ecr.aws/docker/library/postgres:16-alpine';
const VALKEY_IMAGE = 'docker.io/valkey/valkey:8-alpine';
const ALPINE_IMAGE = 'public.ecr.aws/docker/library/alpine:3.20';
const MINIO_IMAGE = 'docker.io/bitnamilegacy/minio:2025.7.23-debian-12-r5';

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && (ALLOWED_ENV.has(entry[0].toUpperCase()) || entry[0].toUpperCase().startsWith('DOCKER_')),
  ),
);

/** Test helper only: `docker <args>` with the clean environment, never a shell. */
const docker: DockerFn = (args, options) =>
  new Promise<DockerResult>((resolve) => {
    const child = spawn('docker', [...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = options?.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeoutMs)
      : undefined;
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });
    child.stdin.end(options?.input ?? '');
  });

const labelArgs = (id: string): string[] => ['--label', 'deployz.runcheck=1', '--label', `deployz.runcheck.repo=${id}`];

const resources: DockerResources = {
  async createNetwork(id, name, options) {
    await docker(['network', 'create', ...(options.internal ? ['--internal'] : []), ...labelArgs(id), name]);
    return name;
  },
  async createVolume(id, name) {
    await docker(['volume', 'create', ...labelArgs(id), name]);
    return name;
  },
  async removeContainer(name) {
    await docker(['rm', '-f', '-v', name]);
  },
  async removeNetwork(name) {
    await docker(['network', 'rm', name]);
  },
  async removeVolume(name) {
    await docker(['volume', 'rm', '-f', name]);
  },
};

async function listLeftovers(): Promise<string> {
  const results = await Promise.all([
    docker(['ps', '-aq', '--filter', RUN_FILTER]),
    docker(['network', 'ls', '-q', '--filter', RUN_FILTER]),
    docker(['volume', 'ls', '-q', '--filter', RUN_FILTER]),
  ]);
  return results.map((result) => result.stdout.trim()).join('');
}

describe.skipIf(!process.env.RUNCHECK_DOCKER_TESTS)('services on an internal network', () => {
  const services = createServices({ docker, resources, labelArgs });

  afterAll(async () => {
    const containers = (await docker(['ps', '-aq', '--filter', RUN_FILTER])).stdout.split('\n');
    for (const container of containers.filter((line) => line.trim() !== '')) {
      await docker(['rm', '-f', '-v', container.trim()]);
    }
    const networks = (await docker(['network', 'ls', '-q', '--filter', RUN_FILTER])).stdout.split('\n');
    for (const network of networks.filter((line) => line.trim() !== '')) await docker(['network', 'rm', network.trim()]);
    const volumes = (await docker(['volume', 'ls', '-q', '--filter', RUN_FILTER])).stdout.split('\n');
    for (const volume of volumes.filter((line) => line.trim() !== '')) await docker(['volume', 'rm', '-f', volume.trim()]);
  });

  it('starts, reports application activity, refuses the internet and stops', async () => {
    const set = await services.start(RUN_ID, 'a');
    const client = (image: string, ...command: string[]) =>
      docker(['run', '--rm', ...labelArgs(RUN_ID), '--network', set.network, '--memory', '128m', '--pids-limit', '64', image, ...command]);
    const postgresUrl = (query: string) =>
      `postgresql://${set.postgres.user}:${set.postgres.password}@${set.postgres.host}:5432/${set.postgres.database}?${query}`;

    const idle = await services.inspect(set);
    expect(idle.postgres).toEqual({ connections: 0, tables: [] });
    expect(idle.mysql).toEqual({ connections: 0, tables: [] });
    expect(idle.valkey).toEqual({ clients: 0, keys: 0 });
    expect(idle.minio.objects).toBe(0);

    const create = await client(PSQL_IMAGE, 'psql', postgresUrl('sslmode=require'), '-c', 'create table t(x int)');
    expect(create.exitCode, create.stderr.replace(set.postgres.password, '***')).toBe(0);
    const verified = await client(PSQL_IMAGE, 'psql', postgresUrl('sslmode=verify-full&sslrootcert=system'), '-c', 'select 1');
    expect(verified.exitCode).not.toBe(0);

    const valkey = await client(VALKEY_IMAGE, 'valkey-cli', '-h', set.valkey.host, 'set', 'k', 'v');
    expect(valkey.stdout.trim()).toBe('OK');

    const put = await docker([
      'run', '--rm', ...labelArgs(RUN_ID), '--network', set.network, '--memory', '256m', '--pids-limit', '128',
      '-e', `MC_HOST_s=http://${set.minio.accessKey}:${set.minio.secretKey}@${set.minio.host}:9000`,
      '-e', 'MC_CONFIG_DIR=/tmp/mc', '--entrypoint', 'sh', MINIO_IMAGE,
      '-c', `echo hello > /tmp/o.txt && mc cp /tmp/o.txt s/${set.minio.bucket}/o.txt`,
    ]);
    expect(put.exitCode, put.stderr.replace(set.minio.secretKey, '***')).toBe(0);

    const active = await services.inspect(set);
    expect(active.postgres.connections).toBeGreaterThanOrEqual(1);
    expect(active.postgres.tables).toEqual(['t']);
    expect(active.valkey.clients).toBeGreaterThanOrEqual(1);
    expect(active.valkey.keys).toBe(1);
    expect(active.minio.objects).toBe(1);
    expect(active.evidence.map((item) => item.source)).toEqual(['postgres', 'mysql', 'valkey', 'minio']);
    const evidenceText = JSON.stringify(active.evidence);
    for (const secret of [set.postgres.password, set.mysql.password, set.minio.secretKey]) {
      expect(evidenceText).not.toContain(secret);
    }

    const ca = await docker([
      'run', '--rm', ...labelArgs(RUN_ID), '-v', `${set.caVolume}:/deployz/certs:ro`, ALPINE_IMAGE,
      'head', '-1', '/deployz/certs/rds-ca-bundle.pem',
    ]);
    expect(ca.stdout).toContain('BEGIN CERTIFICATE');

    const internet = await client(ALPINE_IMAGE, 'wget', '-T', '3', '-q', '-O', '-', 'http://1.1.1.1');
    expect(internet.exitCode).not.toBe(0);

    await services.stop(set);
    await services.stop(set);
    expect(await listLeftovers()).toBe('');
  });
});
