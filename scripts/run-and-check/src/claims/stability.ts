/**
 * `pnpm runcheck:stability --a <dir> --b <dir>` — the release gate's
 * stability criterion: two analyses of the same commits must make the same
 * claims. Prints every claim that differs and exits 1 when one does.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { analysisResultFileSchema, type AnalysisResultFile } from '../contract.js';
import { extractClaims } from './extract.js';

export interface ClaimChange {
  readonly id: string;
  readonly claim: string;
  readonly a: string;
  readonly b: string;
}

function claimMap(file: AnalysisResultFile): Map<string, string> {
  const map = new Map<string, string>([['status', file.status]]);
  for (const claim of extractClaims(file)) {
    map.set(claim.subject === null ? claim.type : `${claim.type}:${claim.subject}`, JSON.stringify(claim.value));
  }
  return map;
}

/** Every claim that differs between two analyses of the same repository. */
export function claimChanges(a: AnalysisResultFile, b: AnalysisResultFile): ClaimChange[] {
  if (a.commit !== b.commit) throw new Error(`${a.id}: the two analyses read different commits`);
  const left = claimMap(a);
  const right = claimMap(b);
  const changes: ClaimChange[] = [];
  for (const claim of new Set([...left.keys(), ...right.keys()])) {
    const before = left.get(claim) ?? 'absent';
    const after = right.get(claim) ?? 'absent';
    if (before !== after) changes.push({ id: a.id, claim, a: before, b: after });
  }
  return changes;
}

function load(dir: string): Map<string, AnalysisResultFile> {
  if (!existsSync(dir)) throw new Error(`no analysis folder ${dir}`);
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  return new Map(
    files.map((name) => {
      const file = analysisResultFileSchema.parse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      return [file.id, file];
    }),
  );
}

export function main(argv: readonly string[]): number {
  const { values } = parseArgs({ args: [...argv], options: { a: { type: 'string' }, b: { type: 'string' } }, strict: true });
  if (!values.a || !values.b) throw new Error('usage: runcheck stability --a <analysis dir> --b <analysis dir>');
  const left = load(resolve(values.a));
  const right = load(resolve(values.b));
  const shared = [...left.keys()].filter((id) => right.has(id)).sort();
  const changes = shared.flatMap((id) => claimChanges(left.get(id)!, right.get(id)!));
  for (const change of changes) console.log(`${change.id} ${change.claim}: ${change.a} -> ${change.b}`);
  const changed = new Set(changes.map((change) => change.id)).size;
  console.log(`${shared.length} repositories compared, ${changed} with a changed claim, ${changes.length} changed claim(s)`);
  return changes.length > 0 ? 1 : 0;
}
