import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { recipeSchema } from '../src/contract.js';

const HOLDOUT_IDS = ['repo-201', 'repo-203', 'repo-204', 'repo-205', 'repo-209', 'new-1', 'new-2', 'new-3'];
const recipesDirectory = dirname(fileURLToPath(import.meta.url));

describe('holdout recipes', () => {
  it.each(HOLDOUT_IDS)('%s is a valid holdout recipe pinned to a full commit', (id) => {
    const recipe = recipeSchema.parse(parse(readFileSync(join(recipesDirectory, `${id}.yaml`), 'utf8')));
    expect(recipe.id).toBe(id);
    expect(recipe.set).toBe('holdout');
    expect(recipe.source.kind).toBe('git');
    if (recipe.source.kind === 'git') expect(recipe.source.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});
