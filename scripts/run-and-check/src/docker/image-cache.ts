import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

import type { Architecture } from '../contract.js';
import { fixtureCommit } from '../fixture-id.js';
import type { DockerFn } from '../ports.js';
import { docker, spawnDocker } from './docker.js';
import { runcheckHome } from './paths.js';

export interface ImageMeta {
  readonly arch: Architecture;
  readonly builtAt: string;
  readonly seconds: number;
  readonly dockerfile: string;
  readonly context: string;
  readonly imageBytes: number | null;
}

/** A build that failed on the x86_64 CI runner: the build fact, so the harness does not build it again under emulation. */
export interface FailedBuild {
  readonly arch: 'amd64-ci-build';
  readonly failure: 'dockerfile' | 'infrastructure';
  readonly dockerfile: string;
  readonly context: string;
  readonly lines: string[];
}

export function imageRef(id: string, sha: string): string {
  return `deployz-runcheck/${id.toLowerCase()}:${sha}`;
}

/** The fixture id of an `app/` folder (see fixture-id.ts). */
export function folderSha(dir: string): string {
  return fixtureCommit(dir);
}

function exited(child: ReturnType<typeof spawnDocker>): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

export function createImageCache(run: DockerFn = docker, dir: string = path.join(runcheckHome(), 'images')) {
  const tarPath = (id: string, sha: string) => path.join(dir, `${id}-${sha}.tar.gz`);
  const metaPath = (id: string, sha: string) => path.join(dir, `${id}-${sha}.json`);
  const failurePath = (id: string, sha: string) => path.join(dir, `${id}-${sha}.failed.json`);

  async function loadFile(file: string): Promise<void> {
    const child = spawnDocker(['load']);
    const done = exited(child);
    await pipeline(fs.createReadStream(file), createGunzip(), child.stdin!);
    const { code, stderr } = await done;
    if (code !== 0) throw new Error(`docker load failed: ${stderr.trim()}`);
  }

  const cache = {
    has(id: string, sha: string): boolean {
      return fs.existsSync(tarPath(id, sha)) && fs.existsSync(metaPath(id, sha));
    },

    readMeta(id: string, sha: string): ImageMeta | null {
      try {
        return JSON.parse(fs.readFileSync(metaPath(id, sha), 'utf8')) as ImageMeta;
      } catch {
        return null;
      }
    },

    readFailure(id: string, sha: string): FailedBuild | null {
      try {
        return JSON.parse(fs.readFileSync(failurePath(id, sha), 'utf8')) as FailedBuild;
      } catch {
        return null;
      }
    },

    recordFailure(id: string, sha: string, failed: FailedBuild): void {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(failurePath(id, sha), JSON.stringify(failed, null, 2));
    },

    /** `docker save <ref> | gzip` into the cache, written to `.partial` first. */
    async save(id: string, sha: string, meta: ImageMeta): Promise<void> {
      fs.mkdirSync(dir, { recursive: true });
      const partial = `${tarPath(id, sha)}.partial`;
      const child = spawnDocker(['save', imageRef(id, sha)]);
      const done = exited(child);
      try {
        await pipeline(child.stdout!, createGzip(), fs.createWriteStream(partial));
        const { code, stderr } = await done;
        if (code !== 0) throw new Error(`docker save failed: ${stderr.trim()}`);
      } catch (error) {
        fs.rmSync(partial, { force: true });
        throw error;
      }
      fs.renameSync(partial, tarPath(id, sha));
      fs.writeFileSync(metaPath(id, sha), JSON.stringify(meta, null, 2));
    },

    async load(id: string, sha: string): Promise<void> {
      await loadFile(tarPath(id, sha));
    },

    /** Loads `image.tar.gz` from a CI build (tag `runcheck/image:<sha>`), re-tags it and stores it in the cache. */
    async importImage(
      id: string,
      sha: string,
      tarGzPath: string,
      arch: Architecture,
      meta: Partial<Pick<ImageMeta, 'dockerfile' | 'context' | 'seconds'>> = {},
    ): Promise<void> {
      await loadFile(tarGzPath);
      const tagged = await run(['tag', `runcheck/image:${sha}`, imageRef(id, sha)]);
      if (tagged.exitCode !== 0) throw new Error(`docker tag failed: ${tagged.stderr.trim()}`);
      const size = await run(['image', 'inspect', '--format', '{{.Size}}', imageRef(id, sha)]);
      await cache.save(id, sha, {
        arch,
        builtAt: new Date().toISOString(),
        seconds: meta.seconds ?? 0,
        dockerfile: meta.dockerfile ?? 'Dockerfile',
        context: meta.context ?? '.',
        imageBytes: size.exitCode === 0 ? Number(size.stdout.trim()) : null,
      });
    },
  };
  return cache;
}

export type ImageCache = ReturnType<typeof createImageCache>;
