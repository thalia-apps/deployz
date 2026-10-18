import { fileURLToPath } from 'node:url';

import type { DockerFn } from '../ports.js';
import { docker as defaultDocker } from './docker.js';
import { withBuildLock } from './lock.js';
import { LIBRARY_REGISTRY } from './registry.js';
import { labelArgs } from './safety.js';

export const PROBE_IMAGE = 'deployz-runcheck/probe:2';

const PROBE_CONTEXT = fileURLToPath(new URL('../../probe', import.meta.url));

/** Builds the probe image (curl and openssl on alpine) for the host platform when it is missing; a labelled prune removes it. */
export async function ensureProbeImage(run: DockerFn = defaultDocker): Promise<string> {
  if ((await run(['image', 'inspect', PROBE_IMAGE])).exitCode === 0) return PROBE_IMAGE;
  await withBuildLock(async () => {
    const built = await run(['build', '-q', '--build-arg', `LIBRARY=${LIBRARY_REGISTRY}`, ...labelArgs('probe'), '-t', PROBE_IMAGE, PROBE_CONTEXT]);
    if (built.exitCode !== 0) throw new Error(`probe image build failed: ${built.stderr.slice(-500)}`);
  });
  return PROBE_IMAGE;
}
