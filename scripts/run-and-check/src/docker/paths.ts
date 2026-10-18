import os from 'node:os';
import path from 'node:path';

/** `%LOCALAPPDATA%\deployz-runcheck`, the machine-wide folder of the harness. */
export function runcheckHome(): string {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'deployz-runcheck');
}
