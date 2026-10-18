/**
 * `pnpm runcheck:fetch --run <run id>` — downloads the results of one
 * `runcheck-exam.yml` run: each observation to `observations/<id>.json`, each
 * full run to `.runs/full/<analyser>/<id>.json`. Needs `GITHUB_TOKEN`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { resolveGithubToken } from './analysis/snapshot.js';
import { HARNESS_ROOT } from './claims/cli.js';

interface Artifact {
  id: number;
  name: string;
  expired: boolean;
}

const RUN_ID = /^\d+$/;
const OBSERVE = /^runcheck-observe-([\w-]+)$/;
const FULL = /^runcheck-full-([\w.@-]+)-((?:repo-\d{3}|new-\d+|F\d{1,2}))$/;

/** Where an artifact's one JSON file belongs, or null for an artifact of another kind. */
export function artifactTarget(name: string, root: string = HARNESS_ROOT): string | null {
  const observe = OBSERVE.exec(name);
  if (observe) return join(root, 'observations');
  const full = FULL.exec(name);
  if (full) return join(root, '.runs', 'full', full[1]!);
  return null;
}

function originRepository(): string {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: HARNESS_ROOT, encoding: 'utf8' }).trim();
  const match = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url);
  if (!match) throw new Error(`origin is not a GitHub repository: ${url}`);
  return match[1]!;
}

function extract(zip: string, into: string): void {
  mkdirSync(into, { recursive: true });
  // bsdtar (Windows) reads zip files; Linux and macOS have unzip.
  if (process.platform === 'win32') execFileSync('tar', ['-xf', zip, '-C', into]);
  else execFileSync('unzip', ['-o', '-q', zip, '-d', into]);
}

export async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...argv], options: { run: { type: 'string' } }, strict: true });
  if (!values.run || !RUN_ID.test(values.run)) throw new Error('usage: runcheck fetch --run <run id>');
  const token = resolveGithubToken();
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  const api = `https://api.github.com/repos/${originRepository()}/actions`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };

  const artifacts: Artifact[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(`${api}/runs/${values.run}/artifacts?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`artifact list: HTTP ${response.status}`);
    const body = (await response.json()) as { artifacts: Artifact[] };
    artifacts.push(...body.artifacts);
    if (body.artifacts.length < 100) break;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'runcheck-fetch-'));
  let fetched = 0;
  try {
    for (const artifact of artifacts) {
      const target = artifactTarget(artifact.name);
      if (target === null || artifact.expired) continue;
      const response = await fetch(`${api}/artifacts/${artifact.id}/zip`, { headers });
      if (!response.ok) throw new Error(`${artifact.name}: HTTP ${response.status}`);
      const zip = join(scratch, `${artifact.id}.zip`);
      writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
      extract(zip, target);
      fetched += 1;
      console.log(`${artifact.name} -> ${target}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`Fetched ${fetched} of ${artifacts.length} artifact(s) from run ${values.run}`);
}
