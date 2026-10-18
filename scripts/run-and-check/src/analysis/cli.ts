/**
 * Analysis CLI: runs the production Analysis on recipes.
 *
 *   tsx src/analysis/cli.ts                      every recipe and fixture
 *   tsx src/analysis/cli.ts --repo repo-008      one (or several --repo) recipes
 *   tsx src/analysis/cli.ts --out <dir>          another output folder
 *   tsx src/analysis/cli.ts --offline            cached GitHub snapshots only
 *
 * Writes analyses/<analyser>/<id>.json (`analysisResultFileSchema`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { parse } from 'yaml';

import { resolveGithubToken } from '../../../repository-compatibility/snapshot.js';
import { analysisResultFileSchema, recipeSchema, type Recipe } from '../contract.js';
import { openAnalyser, rulesAnalyserName } from './analyse.js';

const here = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(here, '..', '..');
const RECIPES_DIR = join(HARNESS_ROOT, 'recipes');
const FIXTURES_DIR = join(HARNESS_ROOT, 'fixtures');
const ANALYSES_DIR = join(HARNESS_ROOT, 'analyses');
const SNAPSHOT_CACHE_DIR = join(HARNESS_ROOT, '.runs', 'snapshot-cache');

export interface AnalysisOptions {
  ids: string[];
  out: string | undefined;
  offline: boolean;
}

export function parseAnalysisArgs(argv: readonly string[]): AnalysisOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: { repo: { type: 'string', multiple: true }, out: { type: 'string' }, offline: { type: 'boolean', default: false } },
    strict: true,
  });
  return { ids: values.repo ?? [], out: values.out, offline: values.offline ?? false };
}

/** The recipe file of an id: `recipes/<id>.yaml`, or `fixtures/<F#>/recipe.yaml` for a fixture. */
export function recipePath(id: string): string {
  return /^F\d+$/.test(id) ? join(FIXTURES_DIR, id, 'recipe.yaml') : join(RECIPES_DIR, `${id}.yaml`);
}

function loadRecipe(id: string): Recipe {
  const path = recipePath(id);
  if (!existsSync(path)) throw new Error(`No recipe file for ${id}: ${path}`);
  return recipeSchema.parse(parse(readFileSync(path, 'utf8')));
}

function allRecipeIds(): string[] {
  const recipes = existsSync(RECIPES_DIR) ? readdirSync(RECIPES_DIR).filter((name) => name.endsWith('.yaml')).map((name) => name.slice(0, -5)) : [];
  const fixtures = existsSync(FIXTURES_DIR) ? readdirSync(FIXTURES_DIR).filter((name) => existsSync(recipePath(name))) : [];
  return [...recipes, ...fixtures].sort();
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseAnalysisArgs(argv);
  const ids = options.ids.length > 0 ? options.ids : allRecipeIds();
  if (ids.length === 0) {
    console.error('No recipes selected.');
    return 1;
  }
  const recipes = ids.map(loadRecipe);

  const analyser = rulesAnalyserName(HARNESS_ROOT);
  const outDir = resolve(options.out ?? join(ANALYSES_DIR, analyser));
  mkdirSync(outDir, { recursive: true });

  const token = options.offline ? null : resolveGithubToken();
  if (!options.offline && !token) console.warn('No GitHub token (GITHUB_TOKEN or gh auth): unauthenticated requests are limited to 60/hour.');
  const session = await openAnalyser({ analyser, cacheDir: SNAPSHOT_CACHE_DIR, token, offline: options.offline, fixturesDir: FIXTURES_DIR });

  let failed = 0;
  try {
    for (const recipe of recipes) {
      process.stdout.write(`${recipe.id} ... `);
      const file = analysisResultFileSchema.parse(await session.analyse(recipe));
      writeFileSync(join(outDir, `${file.id}.json`), `${JSON.stringify(file, null, 2)}\n`);
      if (file.status === 'failed') failed += 1;
      console.log(file.status === 'failed' ? `FAILED: ${file.failure ?? 'unknown'}` : `${file.gate?.state}, ${file.vendorQuestions} vendor question(s)`);
    }
  } finally {
    await session.close();
  }
  console.log(`Wrote ${recipes.length} analysis file(s) to ${outDir}`);
  return failed > 0 ? 1 : 0;
}
