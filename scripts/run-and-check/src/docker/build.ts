import fs from 'node:fs';
import path from 'node:path';

import type { Architecture, Evidence } from '../contract.js';
import type { BuildRequest, BuiltImage, DockerFn } from '../ports.js';
import { docker } from './docker.js';
import { createImageCache, folderSha, imageRef, type ImageCache } from './image-cache.js';
import { withBuildLock } from './lock.js';
import { labelArgs } from './safety.js';

const BUILD_TIMEOUT_MS = 90 * 60 * 1000;
const EVIDENCE_LINES = 20;
const EVIDENCE_CHARS = 2000;

type Failure = NonNullable<BuiltImage['failure']>;

const INFRASTRUCTURE =
  /TLS handshake timeout|failed to fetch|i\/o timeout|connection reset|429 Too Many Requests|toomanyrequests|Temporary failure in name resolution|unexpected EOF|failed to resolve source metadata|Could not resolve host|ETIMEDOUT|ECONNRESET|The operation was aborted due to timeout|ERR_PNPM_META_FETCH_FAIL|ERR_SOCKET_TIMEOUT|network timeout|EAI_AGAIN/i;
const EMULATION_SIGNAL = /qemu: uncaught target signal|Illegal instruction|Segmentation fault/i;

/** Classifies a failed build from the tail of its log. */
export function classifyBuildFailure(log: string, timedOut: boolean): { failure: Failure; lines: string[] } {
  if (timedOut) return { failure: 'timeout', lines: ['build timeout'] };
  const lines = log.split(/\r?\n/);
  const matching = (pattern: RegExp) => lines.filter((line) => pattern.test(line));

  const heap = matching(/JavaScript heap out of memory/);
  if (heap.length > 0) {
    // Under QEMU a V8 heap limit is followed by a qemu signal line. documenso (repo-006) failed so here and
    // built on a native x86_64 runner, so that case is emulation; a heap limit without qemu is the Dockerfile.
    const qemu = matching(/qemu: uncaught target signal/);
    return { failure: qemu.length > 0 ? 'emulation' : 'dockerfile', lines: ['heap-limit', ...heap, ...qemu] };
  }
  // The Go runtime crashes this way under QEMU user emulation (F5 failed so); a native build does not.
  const goRuntime = matching(/fatal error: lfstack\.push/);
  if (goRuntime.length > 0) return { failure: 'emulation', lines: goRuntime };
  const signals = matching(EMULATION_SIGNAL);
  if (signals.length > 0 && /qemu/i.test(log)) return { failure: 'emulation', lines: signals };
  const network = matching(INFRASTRUCTURE);
  if (network.length > 0) return { failure: 'infrastructure', lines: network };
  return { failure: 'dockerfile', lines: lines.filter((line) => line.trim() !== '').slice(-EVIDENCE_LINES) };
}

/** `https://github.com/<repository>.git#<commit>[:<context>]` */
export function gitContextUrl(repository: string, commit: string, context?: string): string {
  const subdir = context && context !== '.' ? `:${context}` : '';
  return `https://github.com/${repository}.git#${commit}${subdir}`;
}

function archOf(platform: BuildRequest['platform']): Architecture {
  return platform === 'linux/amd64' ? 'amd64-emulated' : 'arm64-native';
}

function evidenceOf(lines: readonly string[]): Evidence[] {
  const text = lines.join('\n');
  return [{ kind: 'log', source: 'build', text: text.length > EVIDENCE_CHARS ? text.slice(-EVIDENCE_CHARS) : text }];
}

export interface BuildDeps {
  readonly run?: DockerFn;
  readonly cache?: ImageCache;
  readonly lock?: typeof withBuildLock;
}

export async function buildImage(req: BuildRequest, deps: BuildDeps = {}): Promise<BuiltImage> {
  const run = deps.run ?? docker;
  const cache = deps.cache ?? createImageCache(run);
  const lock = deps.lock ?? withBuildLock;
  const { recipe } = req;
  const dockerfile = recipe.build?.dockerfile ?? 'Dockerfile';
  const context = recipe.build?.context ?? '.';
  const arch = archOf(req.platform);

  let sha: string;
  let contextArg: string;
  let dockerfileArg: string;
  if (recipe.source.kind === 'git') {
    sha = recipe.source.commit;
    contextArg = gitContextUrl(recipe.source.repository, recipe.source.commit, recipe.build?.context);
    dockerfileArg = dockerfile;
  } else {
    if (!req.fixtureDir) throw new Error(`Fixture ${req.id} needs fixtureDir`);
    sha = folderSha(req.fixtureDir);
    contextArg = path.resolve(req.fixtureDir, context);
    dockerfileArg = path.resolve(req.fixtureDir, dockerfile);
  }
  // An arm64 fallback image has its own cache entry and tag, so it never replaces the amd64 image.
  if (req.platform === 'linux/arm64') sha = `${sha}-arm64`;
  const ref = imageRef(req.id, sha);

  const base = { image: ref, dockerfile, context };
  const failedOnCi = req.platform === 'linux/amd64' && !req.noCache ? cache.readFailure(req.id, sha) : null;
  if (failedOnCi !== null) {
    return {
      ...base,
      arch: failedOnCi.arch,
      ok: false,
      exitCode: 1,
      seconds: 0,
      imageBytes: null,
      failure: failedOnCi.failure,
      fromCache: true,
      evidence: [{ kind: 'command', source: 'ci-build', text: failedOnCi.lines.join('\n').slice(-2000) }],
    };
  }
  if (!req.noCache && cache.has(req.id, sha)) {
    const meta = cache.readMeta(req.id, sha);
    const matches = meta && (meta.arch === arch || (arch === 'amd64-emulated' && meta.arch === 'amd64-ci-build'));
    if (meta && matches) {
      await cache.load(req.id, sha);
      return {
        ...base,
        arch: meta.arch,
        ok: true,
        exitCode: 0,
        seconds: meta.seconds,
        imageBytes: meta.imageBytes,
        dockerfile: meta.dockerfile,
        context: meta.context,
        failure: null,
        fromCache: true,
        evidence: [{ kind: 'command', source: 'image-cache', text: `loaded ${ref} from the image cache` }],
      };
    }
  }

  return lock(async () => {
    fs.mkdirSync(req.logDir, { recursive: true });
    const startedAt = Date.now();
    const args = [
      'build',
      '--progress=plain',
      '--platform',
      req.platform,
      '-f',
      dockerfileArg,
      ...Object.entries(recipe.build?.buildArgs ?? {}).flatMap(([key, value]) => ['--build-arg', `${key}=${value}`]),
      ...labelArgs(req.id),
      '-t',
      ref,
      contextArg,
    ];

    let last = { failure: 'dockerfile' as Failure, lines: [] as string[], exitCode: null as number | null };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const logFile = path.join(req.logDir, attempt === 1 ? 'build.log' : `build.retry${attempt - 1}.log`);
      const result = await run(args, { logFile, timeoutMs: BUILD_TIMEOUT_MS });
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      if (result.exitCode === 0 && !result.timedOut) {
        const size = await run(['image', 'inspect', '--format', '{{.Size}}', ref]);
        const imageBytes = size.exitCode === 0 ? Number(size.stdout.trim()) : null;
        await cache.save(req.id, sha, {
          arch,
          builtAt: new Date().toISOString(),
          seconds,
          dockerfile,
          context,
          imageBytes,
        });
        return {
          ...base,
          arch,
          ok: true,
          exitCode: 0,
          seconds,
          imageBytes,
          failure: null,
          fromCache: false,
          evidence: evidenceOf((result.stderr + result.stdout).split(/\r?\n/).filter(Boolean).slice(-EVIDENCE_LINES)),
        };
      }
      const classified = classifyBuildFailure(`${result.stdout}\n${result.stderr}`, result.timedOut);
      last = { ...classified, exitCode: result.timedOut ? null : result.exitCode };
      if (last.failure !== 'emulation' && last.failure !== 'infrastructure') break;
    }
    return {
      ...base,
      arch,
      ok: false,
      exitCode: last.exitCode,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      imageBytes: null,
      failure: last.failure,
      fromCache: false,
      evidence: evidenceOf(last.lines.slice(-EVIDENCE_LINES)),
    };
  });
}
