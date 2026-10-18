import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { fixtureAnswersSchema, recipeSchema } from '../src/contract.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const ids = Array.from({ length: 10 }, (_, index) => `F${index + 1}`);

function filesOf(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesOf(path.join(directory, entry.name)) : [path.join(directory, entry.name)],
  );
}

describe.each(ids)('fixture %s', (id) => {
  const directory = path.join(root, id);

  it('has answers that match the contract', () => {
    const answers = fixtureAnswersSchema.parse(JSON.parse(readFileSync(path.join(directory, 'answers.json'), 'utf8')));
    expect(answers.fixture).toBe(id);
  });

  it('has a recipe that matches the contract', () => {
    const recipe = recipeSchema.parse(parse(readFileSync(path.join(directory, 'recipe.yaml'), 'utf8')));
    expect(recipe).toMatchObject({ id, set: 'fixture', source: { kind: 'fixture', fixture: id } });
  });

  it('has a Dockerfile in the app folder', () => {
    expect(statSync(path.join(directory, 'app', 'Dockerfile')).isFile()).toBe(true);
  });

  it('has only LF line endings and stays small', () => {
    const files = filesOf(directory);
    for (const file of files) expect(readFileSync(file, 'utf8')).not.toContain('\r');
    expect(files.reduce((total, file) => total + statSync(file).size, 0)).toBeLessThan(100 * 1024);
  });
});
