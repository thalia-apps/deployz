import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureCommit, recipeHash } from './store.js';
import { makeRecipe } from './test-support.js';

describe('recipeHash', () => {
  it('does not depend on key order', () => {
    const a = makeRecipe();
    const reordered: typeof a = { source: a.source, notes: a.notes, vendorInputs: a.vendorInputs, set: a.set, id: a.id };
    expect(recipeHash(reordered)).toBe(recipeHash(a));
  });

  it('changes with the recipe', () => {
    expect(recipeHash(makeRecipe({ databaseEngine: 'mysql' }))).not.toBe(recipeHash(makeRecipe()));
  });
});

describe('fixtureCommit', () => {
  it('changes when a file changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fixture-'));
    await mkdir(join(dir, 'app'));
    await writeFile(join(dir, 'app', 'a.txt'), 'one');
    const first = await fixtureCommit(dir);
    expect(await fixtureCommit(dir)).toBe(first);
    await writeFile(join(dir, 'app', 'a.txt'), 'two');
    expect(await fixtureCommit(dir)).not.toBe(first);
  });
});
