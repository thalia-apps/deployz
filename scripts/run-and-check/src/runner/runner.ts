/**
 * Application containers on the internal network. Every `docker` call goes
 * through the injected `DockerFn`; arguments are an array, never a shell.
 * Logs and evidence returned here are raw: callers redact them with
 * `redact` before they store them.
 */
import { oneShotContainerCommand, workloadContainerCommand } from '@deployz/contracts';

import type { Evidence } from '../contract.js';
import type { ContainerSpec, DockerFn, HttpCheck, ListenSocket, RunningContainer, Runner } from '../ports.js';

import { QEMU_CRASH } from '../emulation.js';
import { webHostName } from './environment.js';

const PIDS_LIMIT = '512';
const WORKER_RESTARTS = 10;
const EVIDENCE_MAX = 2000;
const PROBE_LIMITS = ['--cpus', '0.5', '--memory', '64m', '--pids-limit', '64'];

export interface RunnerDeps {
  readonly docker: DockerFn;
  readonly labelArgs: (id: string) => string[];
  /** Image with `curl` and `cat` (busybox); the orchestrator builds it. */
  readonly probeImage: string;
  /** Pause between health polls. Default 5000. */
  readonly pollIntervalMs?: number;
}

const LISTEN_STATE = '0A';
const V6_LOOPBACK = '00000000000000000000000001000000';

function bindOf(address: string): 'all' | 'loopback' {
  if (address.length === 8) return address.endsWith('7F') ? 'loopback' : 'all';
  if (address === V6_LOOPBACK) return 'loopback';
  // IPv4-mapped IPv6 address of a 127.x.x.x address.
  return /^0{16}FFFF0000[0-9A-F]{6}7F$/.test(address) ? 'loopback' : 'all';
}

/** Listening TCP sockets from the text of `/proc/net/tcp` and `/proc/net/tcp6`. A port that listens on any interface counts as `all`. */
export function parseListenSockets(procNetTcp: string): ListenSocket[] {
  const byPort = new Map<number, 'all' | 'loopback'>();
  for (const line of procNetTcp.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== LISTEN_STATE) continue;
    const [address, hexPort] = (fields[1] ?? '').split(':');
    if (address === undefined || hexPort === undefined) continue;
    const port = Number.parseInt(hexPort, 16);
    if (!Number.isInteger(port)) continue;
    const bind = bindOf(address.toUpperCase());
    if (byPort.get(port) !== 'all') byPort.set(port, bind);
  }
  return [...byPort].map(([port, bind]) => ({ port, bind })).sort((a, b) => a.port - b.port);
}

/** Replaces every value in `values` (length >= 4) in `text`; longer values first, so one that contains another is hidden whole. */
export function redact(text: string, values: Iterable<string>): string {
  let result = text;
  for (const value of [...new Set(values)].filter((entry) => entry.length >= 4).sort((a, b) => b.length - a.length)) {
    result = result.split(value).join('[redacted]');
  }
  return result;
}

function tail(text: string): string {
  return text.length > EVIDENCE_MAX ? text.slice(text.length - EVIDENCE_MAX) : text;
}

function runArguments(deps: RunnerDeps, spec: ContainerSpec): string[] {
  const memory = `${spec.size.memoryMiB}m`;
  const { services } = spec;
  const args = [
    'run',
    '-d',
    '--name',
    spec.name,
    '--platform',
    spec.platform,
    '--network',
    services.network,
    '--cpus',
    String(spec.size.cpus),
    '--memory',
    memory,
    '--memory-swap',
    memory,
    '--pids-limit',
    PIDS_LIMIT,
    ...deps.labelArgs(spec.id),
  ];
  // Every web container answers on the host name of the app's own derived URL.
  if (spec.role === 'web') args.push('--network-alias', webHostName(services));
  if (spec.role === 'worker') args.push('--restart', `on-failure:${WORKER_RESTARTS}`);
  if ('DATABASE_URL' in spec.env) args.push('-v', `${services.caVolume}:${services.caDir}:ro`);
  for (const [name, value] of Object.entries(spec.env)) args.push('-e', `${name}=${value}`);
  const command = spec.command;
  if (command !== null && spec.role === 'migration') {
    const { entryPoint, command: rest } = oneShotContainerCommand(command);
    args.push('--entrypoint', entryPoint[0]!, spec.image, ...entryPoint.slice(1), ...rest);
  } else if (command !== null) {
    args.push(spec.image, ...workloadContainerCommand(command));
  } else {
    args.push(spec.image);
  }
  return args;
}

export function createRunner(deps: RunnerDeps): Runner {
  const { docker, probeImage } = deps;
  const pollIntervalMs = deps.pollIntervalMs ?? 5000;

  const probeArguments = (id: string, network: string): string[] => [
    'run',
    '--rm',
    '--network',
    network,
    ...PROBE_LIMITS,
    ...deps.labelArgs(id),
  ];

  async function inspect(
    container: RunningContainer,
  ): Promise<{ running: boolean; exitCode: number | null; restarts: number; oomKilled: boolean }> {
    const result = await docker([
      'inspect',
      '-f',
      '{{.State.Running}} {{.State.ExitCode}} {{.RestartCount}} {{.State.OOMKilled}}',
      container.name,
    ]);
    const [running, exitCode, restarts, oomKilled] = result.stdout.trim().split(' ');
    if (result.exitCode !== 0 || running === undefined) {
      return { running: false, exitCode: null, restarts: 0, oomKilled: false };
    }
    return {
      running: running === 'true',
      exitCode: running === 'true' ? null : Number(exitCode),
      restarts: Number(restarts),
      oomKilled: oomKilled === 'true',
    };
  }

  async function logs(container: RunningContainer, tailLines: number): Promise<string> {
    const result = await docker(['logs', '--tail', String(tailLines), container.name]);
    return result.stdout + result.stderr;
  }

  async function stop(container: RunningContainer): Promise<void> {
    await docker(['rm', '-f', container.name]);
  }

  async function httpProbe(
    container: RunningContainer,
    port: number,
    paths: string[],
    request?: { method: 'GET' | 'POST'; path: string; body?: string; contentType?: string },
  ): Promise<HttpCheck[]> {
    const targets = request === undefined ? paths : [request.path];
    const curl = ['curl', '-s', '-w', '%{http_code}\\n', '-m', '10'];
    if (request !== undefined) {
      curl.push('-X', request.method);
      if (request.contentType !== undefined) curl.push('-H', `Content-Type: ${request.contentType}`);
      if (request.body !== undefined) curl.push('--data-raw', request.body);
    }
    // `-o` applies to one URL only: each URL needs its own, or the bodies mix with the status codes.
    for (const path of targets) curl.push('-o', '/dev/null', `http://${container.name}:${port}${path}`);
    const result = await docker(
      [...probeArguments(container.spec.id, container.spec.services.network), probeImage, ...curl],
      { timeoutMs: targets.length * 10_000 + 30_000 },
    );
    const statuses = result.stdout.trim().split(/\r?\n/);
    if (statuses.length !== targets.length) {
      throw new Error(`probe of ${container.name} returned ${statuses.length} results for ${targets.length} paths: ${tail(result.stderr)}`);
    }
    return targets.map((path, index) => {
      const status = Number(statuses[index]);
      return { port, path, status: status === 0 ? null : status };
    });
  }

  return {
    async start(spec) {
      const result = await docker(runArguments(deps, spec));
      if (result.exitCode !== 0) throw new Error(`docker run ${spec.name} failed: ${tail(result.stderr)}`);
      return { name: spec.name, spec, startedAtMs: Date.now() };
    },

    async runOnce(spec, timeoutMs) {
      const started = Date.now();
      const container = await this.start(spec);
      const waited = await docker(['wait', spec.name], { timeoutMs });
      const exitCode = waited.timedOut || waited.exitCode !== 0 ? null : Number(waited.stdout.trim());
      const output = await logs(container, 40);
      await stop(container);
      const evidence: Evidence[] = [{ kind: 'log', source: spec.name, text: tail(output) }];
      return { exitCode, seconds: (Date.now() - started) / 1000, evidence };
    },

    async waitHealthy(container, options) {
      const deadline = container.startedAtMs + options.timeoutMs;
      let checks: HttpCheck[] = [];
      for (;;) {
        const state = await inspect(container);
        if (!state.running) {
          return { healthy: false, seconds: null, checks, exited: true, oomKilled: state.oomKilled };
        }
        checks = [];
        for (const port of options.ports) checks.push(...(await httpProbe(container, port, options.paths)));
        if (checks.some((check) => check.status === 200)) {
          return { healthy: true, seconds: (Date.now() - container.startedAtMs) / 1000, checks, exited: false, oomKilled: false };
        }
        if (Date.now() >= deadline) {
          return { healthy: false, seconds: null, checks, exited: false, oomKilled: state.oomKilled };
        }
        // A program that QEMU crashed can leave the container running; waiting longer gives nothing.
        if (container.spec.platform === 'linux/amd64') {
          const recent = await docker(['logs', '--tail', '20', container.name]);
          if (QEMU_CRASH.test(`${recent.stdout}\n${recent.stderr}`)) {
            return { healthy: false, seconds: null, checks, exited: true, oomKilled: false };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    },

    async listenSockets(container) {
      const result = await docker([
        ...probeArguments(container.spec.id, `container:${container.name}`),
        probeImage,
        'cat',
        '/proc/net/tcp',
        '/proc/net/tcp6',
      ]);
      if (result.exitCode !== 0) throw new Error(`socket probe of ${container.name} failed: ${tail(result.stderr)}`);
      return parseListenSockets(result.stdout);
    },

    httpProbe,

    async isRunning(container) {
      const { running, restarts, exitCode } = await inspect(container);
      return { running, restarts, exitCode };
    },

    async diff(container) {
      const result = await docker(['diff', container.name]);
      return result.stdout
        .split('\n')
        .filter((line) => /^[AC] /.test(line))
        .map((line) => line.slice(2).trim());
    },

    logs,
    stop,
  };
}
