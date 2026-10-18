import { readLocalTree } from './analysis/local-tree.js';

/** The id that stands in for the commit of a fixture: a hash of its `app/` folder. Builds, observations and analyses all use it. */
export function fixtureCommit(appDir: string): string {
  return readLocalTree(appDir).commit;
}
