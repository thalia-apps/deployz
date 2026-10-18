/** Options whose next argument is a plain value that the checks must not read as a flag. */
const VALUE_FLAGS = new Set(['--build-arg', '--label', '--tag', '--file', '--filter', '--format', '--name']);

/** `run`/`create`/`exec` options that take a separate value; the first other bare argument is the image or container. */
const RUN_VALUE_FLAGS = new Set([
  '--name', '--platform', '--network', '--net', '--network-alias', '--cpus', '--memory', '-m', '--memory-swap',
  '--pids-limit', '--label', '-l', '--restart', '-e', '--env', '-v', '--volume', '--mount', '--entrypoint',
  '-u', '--user', '-w', '--workdir', '--security-opt', '--pid', '--cap-add', '--device', '--env-file',
  '--publish', '-p', '--add-host', '--hostname', '-h', '--stop-timeout', '--tmpfs', '--ulimit', '--shm-size',
]);
const RUN_COMMANDS = new Set(['run', 'create', 'exec']);

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const HOST_PATH = /^([A-Za-z]:[\\/]|[/.~\\])/;

function isHostPath(source: string): boolean {
  return HOST_PATH.test(source) || source.includes('docker.sock');
}

function mountIsHostPath(spec: string): boolean {
  const fields = new Map(
    spec.split(',').map((part) => {
      const at = part.indexOf('=');
      return at < 0 ? [part, ''] : [part.slice(0, at), part.slice(at + 1)];
    }),
  );
  const type = fields.get('type') ?? 'volume';
  if (type === 'tmpfs') return false;
  if (type !== 'volume') return true;
  return isHostPath(fields.get('source') ?? fields.get('src') ?? '');
}

function refuse(reason: string): never {
  throw new Error(`Unsafe docker argument refused: ${reason}`);
}

/** Throws when the arguments would weaken the isolation of the harness. */
export function assertSafeArgs(args: readonly string[]): void {
  const runLike = RUN_COMMANDS.has(args[0] ?? '');
  for (let i = runLike ? 1 : 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    // The image (or container) ends docker's own options; what follows is the command inside the container.
    if (runLike && !arg.startsWith('-')) break;
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    const long = arg.startsWith('--');
    const eq = long ? arg.indexOf('=') : -1;
    const flag = eq < 0 ? arg : arg.slice(0, eq);
    const next = (): string => (eq < 0 ? (args[i + 1] ?? '') : arg.slice(eq + 1));

    if (flag === '--privileged') refuse('--privileged');
    if ((flag === '--network' || flag === '--net') && next() === 'host') refuse('--network host');
    if (flag === '--pid' && next() === 'host') refuse('--pid host');
    if (flag === '--cap-add') refuse('--cap-add');
    if (flag === '--device') refuse('--device');
    if (flag === '--publish' || flag === '--publish-all' || arg === '-P' || (!long && arg.startsWith('-p'))) {
      refuse('port publishing');
    }
    if (flag === '--env-file') refuse('--env-file');
    if (flag === '--security-opt' && next().includes('unconfined')) refuse('--security-opt unconfined');

    if (flag === '-e' || flag === '--env' || (!long && arg.startsWith('-e'))) {
      const value = flag === '-e' || flag === '--env' ? next() : arg.slice(2);
      if (!value.includes('=')) refuse('environment variable without a value');
    }
    if (flag === '-v' || flag === '--volume' || (!long && arg.startsWith('-v'))) {
      const value = flag === '-v' || flag === '--volume' ? next() : arg.slice(2);
      const source = DRIVE_PATH.test(value) ? value : (value.split(':')[0] ?? '');
      if (isHostPath(source) || !value.includes(':')) refuse(`volume source ${source}`);
    }
    if (flag === '--mount' && mountIsHostPath(next())) refuse('mount of a host path');
    if (runLike && eq < 0 && RUN_VALUE_FLAGS.has(arg)) i += 1;
  }
}

/** The labels every harness image, container, network and volume carries. */
export function labelArgs(id: string): string[] {
  return ['--label', 'deployz.runcheck=1', '--label', `deployz.runcheck.repo=${id}`];
}
