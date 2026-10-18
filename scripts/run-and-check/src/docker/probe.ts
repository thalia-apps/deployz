import { fileURLToPath } from 'node:url';

import type { DockerFn } from '../ports.js';
import { docker as defaultDocker } from './docker.js';
import { withBuildLock } from './lock.js';
import { labelArgs } from './safety.js';

export const PROBE_IMAGE = 'deployz-runcheck/probe:2';

const PROBE_CONTEXT = fileURLToPath(new URL('../../probe', import.meta.url));

/** Builds the native probe image (curl and openssl on alpine) when it is missing; a labelled prune removes it. */
export async function ensureProbeImage(run: DockerFn = defaultDocker): Promise<string> {
  if ((await run(['image', 'inspect', PROBE_IMAGE])).exitCode === 0) return PROBE_IMAGE;
  await withBuildLock(async () => {
    const built = await run(['build', '-q', '--platform', 'linux/arm64', ...labelArgs('probe'), '-t', PROBE_IMAGE, PROBE_CONTEXT]);
    if (built.exitCode !== 0) throw new Error(`probe image build failed: ${built.stderr.slice(-500)}`);
  });
  return PROBE_IMAGE;
}
