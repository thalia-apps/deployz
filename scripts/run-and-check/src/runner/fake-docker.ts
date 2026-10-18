import type { DockerResult } from '../ports.js';

const FORBIDDEN_FLAGS = ['--privileged', '--cap-add', '--env-file', '-p', '--publish', '--pid'];

/** The safety rules for `docker run` arguments: internal network, limits, labels, no forbidden flag, every `-e` has a value. */
export function unsafeRunProblems(args: readonly string[], network: string): string[] {
  const problems: string[] = [];
  const used = args[args.indexOf('--network') + 1];
  if (used !== network && !(used?.startsWith('container:') ?? false)) problems.push(`network ${String(used)}`);
  for (const flag of ['--cpus', '--memory', '--pids-limit']) if (!args.includes(flag)) problems.push(`missing ${flag}`);
  if (!args.includes('deployz.runcheck=1')) problems.push('missing label deployz.runcheck=1');
  if (!args.some((arg) => arg.startsWith('deployz.runcheck.repo='))) problems.push('missing repo label');
  for (const flag of FORBIDDEN_FLAGS) if (args.includes(flag)) problems.push(`forbidden ${flag}`);
  args.forEach((arg, index) => {
    if (arg === '-e' && !(args[index + 1] ?? '').includes('=')) problems.push('-e without value');
    if ((arg === '-v' || arg === '--mount') && !/^[\w-]+:\/[\w/.-]+:ro$/.test(args[index + 1] ?? '')) {
      problems.push(`mount ${String(args[index + 1])}`);
    }
  });
  return problems;
}

export interface FakeDockerOptions {
  /** HTTP status of the probe for a path. Default 200. */
  status?: (path: string) => number;
  /** The container reports exited after this many inspect calls. Default never. */
  exitAfterInspects?: number;
  waitExitCode?: number;
  procNetTcp?: string;
}

/** A DockerFn that records its calls and answers like Docker. The logs of a container echo its DATABASE_URL, as a careless application would. */
export function fakeDocker(options: FakeDockerOptions = {}) {
  const calls: string[][] = [];
  const environments = new Map<string, Map<string, string>>();
  let inspects = 0;
  const docker = async (args: readonly string[]): Promise<DockerResult> => {
    calls.push([...args]);
    const done = (stdout = '', exitCode = 0): DockerResult => ({ exitCode, stdout, stderr: '', timedOut: false });
    switch (args[0]) {
      case 'run': {
        if (args.includes('--rm')) {
          if (args.includes('cat')) return done(options.procNetTcp ?? '');
          const urls = args.filter((arg) => arg.startsWith('http://'));
          const status = options.status ?? (() => 200);
          return done(urls.map((url) => String(status(new URL(url).pathname))).join('\n'));
        }
        const env = new Map<string, string>();
        args.forEach((arg, index) => {
          if (arg !== '-e') return;
          const [name, ...rest] = (args[index + 1] ?? '').split('=');
          env.set(name!, rest.join('='));
        });
        environments.set(args[args.indexOf('--name') + 1]!, env);
        return done('container-id');
      }
      case 'inspect':
        inspects += 1;
        return options.exitAfterInspects !== undefined && inspects > options.exitAfterInspects
          ? done('false 137 0 true')
          : done('true 0 2 false');
      case 'wait':
        return done(String(options.waitExitCode ?? 0));
      case 'logs': {
        const url = environments.get(args[args.length - 1]!)?.get('DATABASE_URL');
        return done(`starting\nconnecting to ${url ?? 'nothing'}\nready`);
      }
      case 'diff':
        return done('C /tmp\nA /app/data.sqlite\nD /var/old\nC /app');
      default:
        return done();
    }
  };
  return { docker, calls, environments };
}
