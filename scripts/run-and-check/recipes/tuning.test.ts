import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { recipeSchema } from '../src/contract.js';

const TUNING_IDS = [
  'repo-001',
  'repo-007',
  'repo-003',
  'repo-016',
  'repo-021',
  'repo-053',
  'repo-029',
  'repo-006',
  'repo-300',
  'repo-035',
  'repo-011',
  'repo-034',
  'repo-004',
  'repo-008',
  'repo-039',
  'repo-051',
  'repo-071',
  'repo-049',
  'repo-050',
  'repo-074',
  'repo-013',
  'repo-076',
] as const;

const RECIPE_KEYS = ['id', 'set', 'source', 'build', 'vendorInputs', 'databaseEngine', 'smoke', 'notes'];

const recipesDir = dirname(fileURLToPath(import.meta.url));

function readRecipe(id: string): unknown {
  return parse(readFileSync(join(recipesDir, `${id}.yaml`), 'utf8'));
}

describe('tuning recipes', () => {
  describe.each(TUNING_IDS)('%s', (id) => {
    it('parses with recipeSchema and matches its file name', () => {
      const recipe = recipeSchema.parse(readRecipe(id));
      expect(recipe.id).toBe(id);
      expect(recipe.set).toBe('tuning');
    });

    it('pins a full commit SHA', () => {
      const recipe = recipeSchema.parse(readRecipe(id));
      expect(recipe.source.kind).toBe('git');
      if (recipe.source.kind === 'git') expect(recipe.source.commit).toMatch(/^[0-9a-f]{40}$/);
    });

    it('holds only recipe inputs, never an expected answer', () => {
      const raw = readRecipe(id) as Record<string, unknown>;
      for (const key of Object.keys(raw)) expect(RECIPE_KEYS).toContain(key);
    });

    it('explains the inputs and overrides in notes', () => {
      const recipe = recipeSchema.parse(readRecipe(id));
      expect(recipe.notes.length).toBeGreaterThan(0);
    });
  });
});
