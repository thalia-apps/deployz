import { CA_DIR } from '../services/index.js';

/** The harness mounts the CA volume at CA_DIR; Docker creates that folder and its parents. */
const MOUNT_POINTS = CA_DIR.split('/').slice(1).map((_, index, parts) => `/${parts.slice(0, index + 1).join('/')}`);

/** System folders and `/etc`, which entrypoints rewrite from the environment at every start (nginx, php.ini). */
const IGNORED_FOLDERS = ['/tmp', '/var/tmp', '/run', '/var/run', '/proc', '/dev', '/root/.cache', '/var/log', '/var/cache', '/etc'];

/**
 * Tool caches and runtime artefacts anywhere in the tree: npm and pm2 state, tmp, cache and log folders,
 * files that the app generates under node_modules (Directus extensions) and Prisma CLI config.
 */
const IGNORED_SEGMENT = /(^|\/)(node_modules|__pycache__|\.npm|\.pm2|\.cache|\.config\/prisma[^/]*|tmp|cache|logs?)(\/|$)/;

function stripKind(line: string): string {
  return line.replace(/^[ACD] /, '');
}

/**
 * A write that a start makes again and that holds no user data: a hidden file that is not a database
 * (an `.env` an entrypoint writes from the environment, a licence or version cache, a `.gitignore`
 * that the app copies), or a lock or temp file.
 */
export function isTransientWrite(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  if (/\.(?:sqlite3?|db)$/.test(name)) return false;
  return name.startsWith('.') || /\.(?:lock|tmp|temp|swp)$/.test(name);
}

function isIgnored(path: string, volumes: readonly string[]): boolean {
  if (MOUNT_POINTS.includes(path) || volumes.includes(path)) return true;
  if (IGNORED_FOLDERS.some((folder) => path === folder || path.startsWith(`${folder}/`))) return true;
  if (/\.(pid|log|sock|ctl)$/.test(path)) return true;
  if (isTransientWrite(path)) return true;
  return IGNORED_SEGMENT.test(path);
}

/**
 * `docker diff` paths that are real local state. `docker diff` also lists
 * every parent folder of a changed path; a parent counts only when some path
 * below it is real state, so a folder whose changes are all ignored drops out.
 * Docker creates the mount point of each image `VOLUME`; the files in a volume
 * are not in `docker diff`, so the mount point alone is not local state.
 */
export function filterLocalDiskWrites(lines: readonly string[], volumes: readonly string[] = []): string[] {
  const paths = [...new Set(lines.map(stripKind))];
  const isParent = (path: string): boolean => paths.some((other) => other.startsWith(`${path}/`));
  return paths.filter((path) => !isIgnored(path, volumes) && !isParent(path)).sort();
}

export function sqliteFileWritten(lines: readonly string[]): boolean {
  return lines.some((line) => /\.(sqlite3?|db)$/.test(stripKind(line)));
}
