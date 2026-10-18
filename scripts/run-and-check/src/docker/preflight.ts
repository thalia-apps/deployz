import fs from 'node:fs';
import os from 'node:os';

import { docker } from './docker.js';
import { runcheckHome } from './paths.js';
import { createDockerResources } from './resources.js';
import { labelArgs } from './safety.js';

const ALPINE = 'public.ecr.aws/docker/library/alpine:3.20';
const MIN_FREE_GB = 150;
const GB = 1024 ** 3;
const ID = 'F0';

export interface PreflightCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface PreflightReport {
  readonly ok: boolean;
  readonly checks: PreflightCheck[];
}

async function check(name: string, fn: () => Promise<string>): Promise<PreflightCheck> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function dockerOut(args: string[], timeoutMs = 120_000): Promise<string> {
  const result = await docker(args, { timeoutMs });
  if (result.exitCode !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function machineFacts(): Promise<string> {
  return (async () => {
    const info = await dockerOut(['info', '--format', '{{.NCPU}} cpus, {{.MemTotal}} bytes, docker {{.ServerVersion}}, {{.Architecture}}']);
    const buildx = await dockerOut(['buildx', 'version']);
    return `host ${os.cpus().length} cpus ${Math.round(os.totalmem() / GB)} GB; ${info}; ${buildx}`;
  })();
}

async function emulation(): Promise<string> {
  const out = await dockerOut(['run', '--rm', ...labelArgs(ID), '--platform', 'linux/amd64', ALPINE, 'uname', '-m']);
  if (out !== 'x86_64') throw new Error(`uname -m printed ${out}`);
  return 'linux/amd64 runs (x86_64)';
}

async function safety(): Promise<string> {
  const resources = createDockerResources();
  const name = 'deployz-runcheck-preflight';
  try {
    await resources.createNetwork(ID, name, { internal: true });
    await resources.createVolume(ID, name);
    await dockerOut([
      'run', '-d', '--name', name, ...labelArgs(ID), '--network', name, '--cpus', '1', '--memory', '512m',
      '--pids-limit', '256', '-v', `${name}:/data`, ALPINE, 'sleep', '120',
    ]);
    const env = await dockerOut(['exec', name, 'env']);
    const leaked = env.split(/\r?\n/).map((line) => line.split('=')[0] ?? '').filter((n) => /^(AWS_|GH_|GITHUB_)/.test(n));
    if (leaked.length > 0) throw new Error(`container environment has ${leaked.join(', ')}`);

    const inspected = JSON.parse(await dockerOut(['inspect', '--format', '{{json .}}', name])) as {
      Mounts: { Type: string; Name?: string }[];
      HostConfig: { Privileged: boolean; CapAdd: string[] | null; PortBindings: Record<string, unknown> | null };
    };
    const mounts = inspected.Mounts;
    if (mounts.length !== 1 || mounts[0]?.Type !== 'volume' || mounts[0].Name !== name) {
      throw new Error(`unexpected mounts: ${JSON.stringify(mounts)}`);
    }
    if (inspected.HostConfig.Privileged) throw new Error('container is privileged');
    if (inspected.HostConfig.CapAdd?.length) throw new Error('container has added capabilities');
    if (Object.keys(inspected.HostConfig.PortBindings ?? {}).length > 0) throw new Error('container publishes ports');

    for (const url of ['https://example.com', 'http://1.1.1.1']) {
      const probe = await docker(['exec', name, 'wget', '-q', '-T', '5', '-O', '/dev/null', url], { timeoutMs: 60_000 });
      if (probe.exitCode === 0) throw new Error(`internal network reached ${url}`);
    }
    return 'labelled, limited, one named volume, no secrets, no internet';
  } finally {
    await resources.removeContainer(name);
    await resources.removeNetwork(name);
    await resources.removeVolume(name);
  }
}

async function disk(): Promise<string> {
  const home = runcheckHome();
  fs.mkdirSync(home, { recursive: true });
  const stats = fs.statfsSync(home);
  const freeGb = Math.floor((stats.bavail * stats.bsize) / GB);
  if (freeGb < MIN_FREE_GB) throw new Error(`${freeGb} GB free, ${MIN_FREE_GB} GB needed`);
  return `${freeGb} GB free`;
}

export async function preflight(): Promise<PreflightReport> {
  const checks = [
    await check('machine', machineFacts),
    await check('emulation', emulation),
    await check('safety', safety),
    await check('disk', disk),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}
