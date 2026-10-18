/**
 * A fixture application as a GitHub repository. `serveLocalTree` answers the
 * head, tree and blob requests of the production tree fetch
 * (`buildFileTreeForAnalysis`) from a local folder, so a fixture goes through
 * the same analysis path as a repository on GitHub.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { FetchFn } from '@deployz/api/github';

const SKIPPED_FOLDERS = new Set(['.git', 'node_modules']);

interface LocalFile {
  path: string;
  sha: string;
  content: Buffer;
}

export interface LocalTree {
  /** A 40-character id of the folder content; it takes the place of a commit. */
  commit: string;
  files: LocalFile[];
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED_FOLDERS.has(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const sha1 = (...parts: (string | Buffer)[]): string => {
  const hash = createHash('sha1');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
};

export function readLocalTree(dir: string): LocalTree {
  const files = walk(dir)
    .map((file) => {
      const content = readFileSync(file);
      return {
        path: relative(dir, file).split(sep).join('/'),
        sha: sha1(`blob ${content.length}\0`, content),
        content,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return { commit: sha1(...files.map((file) => `${file.path}\0${file.sha}\n`)), files };
}

function respond(status: number, body: unknown): Awaited<ReturnType<FetchFn>> {
  return { status, headers: { get: () => null }, json: async () => body };
}

/** Answers `/commits/<ref>`, `/git/trees/<ref>` and `/git/blobs/<sha>` for one tree. */
export function serveLocalTree(tree: LocalTree): (url: string) => Awaited<ReturnType<FetchFn>> {
  return (url) => {
    const { pathname } = new URL(url);
    if (/\/commits\/[^/]+$/.test(pathname)) return respond(200, { sha: tree.commit });
    if (/\/git\/trees\/[^/]+$/.test(pathname)) {
      return respond(200, {
        sha: tree.commit,
        truncated: false,
        tree: tree.files.map((file) => ({
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: file.sha,
          size: file.content.length,
        })),
      });
    }
    const blob = /\/git\/blobs\/([^/]+)$/.exec(pathname);
    const file = blob ? tree.files.find((candidate) => candidate.sha === blob[1]) : undefined;
    if (!file) return respond(404, { message: 'Not Found' });
    return respond(200, { content: file.content.toString('base64'), encoding: 'base64' });
  };
}
