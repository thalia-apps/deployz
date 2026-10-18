import type { DockerFn, DockerResources } from '../ports.js';
import { docker } from './docker.js';
import { labelArgs } from './safety.js';

export function createDockerResources(run: DockerFn = docker): DockerResources {
  async function create(args: string[]): Promise<void> {
    const result = await run(args);
    if (result.exitCode !== 0) {
      throw new Error(`docker ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim()}`);
    }
  }

  async function remove(args: string[]): Promise<void> {
    const result = await run(args);
    if (result.exitCode !== 0 && !/No such|not found/i.test(result.stderr)) {
      throw new Error(`docker ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim()}`);
    }
  }

  return {
    async createNetwork(id, name, options) {
      await create(['network', 'create', ...(options.internal ? ['--internal'] : []), ...labelArgs(id), name]);
      return name;
    },
    async createVolume(id, name) {
      await create(['volume', 'create', ...labelArgs(id), name]);
      return name;
    },
    removeContainer: (name) => remove(['rm', '-f', name]),
    removeNetwork: (name) => remove(['network', 'rm', name]),
    removeVolume: (name) => remove(['volume', 'rm', '-f', name]),
  };
}
