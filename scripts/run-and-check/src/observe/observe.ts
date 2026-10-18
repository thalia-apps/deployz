import type { Observation, ObservationRun, Recipe } from '../contract.js';
import { collectCandidates } from './candidates.js';
import { emulationCrash } from './emulation.js';
import { buildObservationManifest } from './observation-manifest.js';
import { runOnce } from './run-once.js';
import { findUnstable } from './stability.js';
import { finalPath, fixtureCommit, partialPath, readMatching, recipeHash, writeObservation } from './store.js';
import type { ObserveDeps, ObserveOptions } from './types.js';

function sourceOf(recipe: Recipe, fixtureCommitId: string): { repository: string; commit: string } {
  return recipe.source.kind === 'git'
    ? { repository: recipe.source.repository, commit: recipe.source.commit }
    : { repository: `fixture/${recipe.source.fixture}`, commit: fixtureCommitId };
}

/**
 * Observes one repository twice (the second run uses the cached image) and
 * writes `<observationsDir>/<id>.json`. A complete stored observation of the
 * same commit and recipe is returned unchanged unless `force` is set; a
 * partial file resumes after the runs it already holds.
 */
export async function observe(recipe: Recipe, deps: ObserveDeps, options: ObserveOptions): Promise<Observation> {
  const fixtureId = options.fixtureDir === undefined ? 'fixture' : await fixtureCommit(options.fixtureDir);
  const { repository, commit } = sourceOf(recipe, fixtureId);
  const hash = recipeHash(recipe);
  const outPath = finalPath(options.observationsDir, recipe.id);
  const partial = partialPath(options.runsDir, recipe.id);

  if (!options.force) {
    const stored = await readMatching(outPath, commit, hash);
    if (stored?.complete) {
      deps.log(`${recipe.id}: observation is complete for this commit and recipe, skipped`);
      return stored;
    }
  }

  const runs: ObservationRun[] = options.force ? [] : ((await readMatching(partial, commit, hash))?.runs ?? []);
  if (runs.length > 0) deps.log(`${recipe.id}: resuming after ${runs.length} stored run(s)`);

  const candidates = collectCandidates(recipe, options.analyses, options.claims);
  const manifest = buildObservationManifest(recipe, options.analyses, options.claims);
  const snapshot = (complete: boolean, unstable: Observation['unstable']): Observation => ({
    schemaVersion: 1,
    id: recipe.id,
    set: recipe.set,
    repository,
    commit,
    recipeHash: hash,
    imageDigest: null,
    runs,
    unstable,
    complete,
  });

  // After a QEMU crash at run time, the runs use a native arm64 image (behaviour evidence only).
  let platform: 'linux/amd64' | 'linux/arm64' = runs.some((run) => run.webHealthy.arch === 'arm64-native') ? 'linux/arm64' : 'linux/amd64';
  // A failed build is not repeated: a second run would only build again.
  while (runs.length < 2 && !(runs.length === 1 && runs[0]?.build.value?.ok !== true)) {
    const input = {
      recipe,
      deps,
      manifest,
      candidates,
      runIndex: runs.length + 1,
      runsDir: options.runsDir,
      harnessVersion: options.harnessVersion,
      ...(options.fixtureDir === undefined ? {} : { fixtureDir: options.fixtureDir }),
    };
    let run = await runOnce({ ...input, platform });
    const crash = platform === 'linux/amd64' ? emulationCrash(run) : null;
    if (crash !== null) {
      deps.log(`${recipe.id} run ${input.runIndex}: QEMU crashed at run time, repeating the run as native arm64`);
      platform = 'linux/arm64';
      const amd64Build = run.build;
      run = await runOnce({ ...input, platform });
      // The amd64 build stays the build evidence; the arm64 image only gives behaviour.
      run = { ...run, build: amd64Build, infrastructureFailures: [...run.infrastructureFailures, `emulation: ${crash}`] };
    } else if (platform === 'linux/arm64' && runs[0] !== undefined) {
      run = { ...run, build: runs[0].build };
    }
    runs.push(run);
    await writeObservation(partial, snapshot(false, []));
  }

  const [first, second] = runs;
  const result = snapshot(true, first !== undefined && second !== undefined ? findUnstable(first, second) : []);
  await writeObservation(outPath, result);
  deps.log(`${recipe.id}: observation written, unstable facts: ${result.unstable.join(', ') || 'none'}`);
  return result;
}
