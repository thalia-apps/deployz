/**
 * The repositories Stage B can run: the git recipes of the Docker
 * run-and-check test (`scripts/run-and-check/recipes/*.yaml`). A recipe gives
 * the id, the repository and the pinned commit. Stage B copies none of it and
 * holds no expected answer.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import { recipeSchema } from '../run-and-check/src/contract.js';

export interface StageBTarget {
  id: string;
  repository: string;
  commit: string;
}

const STAGE_B_ID = /^repo-\d{3}$/;

/** The git recipes with a Stage B id, in id order. A fixture recipe has no GitHub repository. */
export function loadTargets(recipesDir: string): StageBTarget[] {
  const targets: StageBTarget[] = [];
  for (const name of readdirSync(recipesDir).filter((file) => file.endsWith('.yaml')).sort()) {
    const recipe = recipeSchema.parse(parse(readFileSync(join(recipesDir, name), 'utf8')));
    if (recipe.source.kind === 'git' && STAGE_B_ID.test(recipe.id)) {
      targets.push({ id: recipe.id, repository: recipe.source.repository, commit: recipe.source.commit });
    }
  }
  return targets;
}

/** Targets selected by id; an unknown id is an error, not silence. */
export function selectTargets(targets: readonly StageBTarget[], ids: readonly string[] = []): StageBTarget[] {
  if (ids.length === 0) return [...targets];
  const wanted = new Set(ids);
  for (const id of wanted) {
    if (!targets.some((target) => target.id === id)) throw new Error(`unknown repository id ${id}`);
  }
  return targets.filter((target) => wanted.has(target.id));
}
