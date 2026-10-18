import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';

import type { DockerFn } from '../ports.js';
import { assertSafeArgs } from './safety.js';

const TAIL_CHARS = 64 * 1024;
const ENV_NAMES = new Set(['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'PROGRAMFILES']);

/**
 * The only host variables a docker call sees. `ProgramFiles` is needed: the
 * CLI cannot find the buildx plugin without it.
 */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (value !== undefined && (ENV_NAMES.has(upper) || upper.startsWith('DOCKER_'))) clean[name] = value;
  }
  return clean;
}

/** Starts `docker <args>` without a shell, with the clean environment, after the safety check. */
export function spawnDocker(args: readonly string[]): ChildProcess {
  assertSafeArgs(args);
  return spawn('docker', [...args], { env: cleanEnv(), shell: false, windowsHide: true });
}

function keepTail(current: string, chunk: string): string {
  const joined = current + chunk;
  return joined.length > TAIL_CHARS ? joined.slice(-TAIL_CHARS) : joined;
}

export const docker: DockerFn = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawnDocker(args);
    let log: ReturnType<typeof createWriteStream> | undefined;
    if (options.logFile) {
      mkdirSync(path.dirname(options.logFile), { recursive: true });
      log = createWriteStream(options.logFile);
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeoutMs)
      : undefined;

    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = keepTail(stdout, chunk);
      log?.write(chunk);
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = keepTail(stderr, chunk);
      log?.write(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      log?.end();
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const finish = () => resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
      if (log) log.end(finish);
      else finish();
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.input);
  });
