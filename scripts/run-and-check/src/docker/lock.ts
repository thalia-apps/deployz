import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { runcheckHome } from './paths.js';

interface LockInfo {
  readonly pid: number;
  readonly startedAt: string;
  readonly id: string;
}

const UNREADABLE_LOCK_MS = 10_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function isStale(lockPath: string): boolean {
  try {
    const info = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockInfo;
    return !isAlive(info.pid);
  } catch {
    // Empty or partial file: the owner may be writing it right now.
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > UNREADABLE_LOCK_MS;
    } catch {
      return false;
    }
  }
}

/** Runs `fn` while holding the machine-wide build lock (one Docker build at a time). */
export async function withBuildLock<T>(
  fn: () => Promise<T>,
  options: { pollMs?: number; lockPath?: string } = {},
): Promise<T> {
  const lockPath = options.lockPath ?? path.join(runcheckHome(), 'build.lock');
  const pollMs = options.pollMs ?? 2000;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const info: LockInfo = { pid: process.pid, startedAt: new Date().toISOString(), id: randomUUID() };

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify(info));
      fs.closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (isStale(lockPath)) fs.rmSync(lockPath, { force: true });
      else await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}
