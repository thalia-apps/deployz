import type { DockerFn } from '../ports.js';
import { docker } from './docker.js';

const FILTER = ['--filter', 'label=deployz.runcheck=1'];

/** Removes only what the harness created (label filter), then trims the build cache. Never a global prune. */
export async function cleanup(run: DockerFn = docker): Promise<void> {
  await run(['container', 'prune', '-f', ...FILTER]);
  await run(['network', 'prune', '-f', ...FILTER]);
  await run(['volume', 'prune', '-a', '-f', ...FILTER]);
  await run(['image', 'prune', '-a', '-f', ...FILTER]);
  await run(['builder', 'prune', '-f', '--keep-storage', '30GB']);
}
