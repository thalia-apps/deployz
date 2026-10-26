/**
 * Ground-truth CLI (no Docker, no network):
 *
 *   pnpm runcheck:truth --analysis <dir>              every ground truth that has an analysis in <dir>
 *   pnpm runcheck:truth --analysis <dir> --repo new-35
 *
 * Prints each field that is not a MATCH and a per-repository count. Exits 1
 * when a critical field is a MISMATCH.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { parse } from 'yaml';

import { analysisResultFileSchema } from '../contract.js';
import { compareWithTruth, groundTruthSchema, type FieldResult } from './truth.js';

const here = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(here, '..', '..');
export const GROUND_TRUTH_DIR = join(HARNESS_ROOT, 'ground-truth');

export function loadGroundTruth(id: string) {
  return groundTruthSchema.parse(parse(readFileSync(join(GROUND_TRUTH_DIR, `${id}.yaml`), 'utf8')));
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const { values } = parseArgs({
    args: [...argv],
    options: { analysis: { type: 'string' }, repo: { type: 'string', multiple: true } },
    strict: true,
  });
  if (values.analysis === undefined) {
    console.error('usage: runcheck truth --analysis <dir> [--repo <id>]');
    return 2;
  }
  const dir = resolve(values.analysis);
  const ids =
    values.repo ??
    readdirSync(GROUND_TRUTH_DIR)
      .filter((name) => name.endsWith('.yaml'))
      .map((name) => name.slice(0, -5))
      .filter((id) => existsSync(join(dir, `${id}.json`)));
  let critical = 0;
  for (const id of ids) {
    const analysis = analysisResultFileSchema.parse(JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')));
    const results: FieldResult[] = compareWithTruth(loadGroundTruth(id), analysis);
    const count = (verdict: FieldResult['verdict'], onlyCritical = false) =>
      results.filter((result) => result.verdict === verdict && (!onlyCritical || result.critical)).length;
    critical += count('MISMATCH', true);
    console.log(`${id}: ${count('MATCH')} match, ${count('MISMATCH', true)} critical mismatch, ${count('MISMATCH') - count('MISMATCH', true)} env mismatch, ${count('QUESTION')} question`);
    for (const result of results.filter((entry) => entry.verdict !== 'MATCH')) {
      console.log(`  ${result.verdict}${result.critical ? '' : ' (env)'} ${result.field}: expected ${result.expected}, got ${result.actual}`);
    }
  }
  return critical > 0 ? 1 : 0;
}
