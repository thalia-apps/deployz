/**
 * `pnpm runcheck:full [--repo <id>] [--analysis <dir>] [--force]` — runs each
 * analysed application twice, each time on a fresh service set, with exactly
 * the analysed settings and writes `.runs/full/<analyser>/<id>.json`.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { HARNESS_ROOT, loadAnalyses, newestAnalysisDir } from './claims/cli.js';
import { fullRunSchema } from './contract.js';
import { buildImage, createDockerResources, docker, ensureProbeImage, labelArgs } from './docker/index.js';
import { loadRecipes, pool } from './observe/cli.js';
import { createRunner, productionEnvironment, runFull } from './runner/index.js';
import { createServices } from './services/index.js';

const MAX_PARALLEL = 2;

export async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: { repo: { type: 'string', multiple: true }, analysis: { type: 'string' }, force: { type: 'boolean' } },
    strict: true,
  });
  const analyses = loadAnalyses(values.analysis ? resolve(values.analysis) : newestAnalysisDir(), values.repo ?? []).filter(
    (analysis) => analysis.manifest !== null,
  );
  const recipes = new Map((await loadRecipes()).map((loaded) => [loaded.recipe.id, loaded]));
  const probeImage = await ensureProbeImage();
  const runner = createRunner({ docker, labelArgs, probeImage });
  const services = createServices({ docker, resources: createDockerResources(docker), labelArgs, helperImage: probeImage });
  let failures = 0;

  await pool(analyses, MAX_PARALLEL, async (analysis) => {
    const loaded = recipes.get(analysis.id);
    if (loaded === undefined) throw new Error(`no recipe for ${analysis.id}`);
    const outDir = join(HARNESS_ROOT, '.runs', 'full', analysis.analyser);
    const outFile = join(outDir, `${analysis.id}.json`);
    if (!values.force && existsSync(outFile)) {
      console.log(`${analysis.id}: full run exists, skipped`);
      return;
    }
    const logDir = join(HARNESS_ROOT, '.runs', analysis.id, 'full');
    const image = await buildImage({
      id: analysis.id,
      recipe: loaded.recipe,
      platform: 'linux/amd64',
      logDir,
      ...(loaded.fixtureDir === undefined ? {} : { fixtureDir: loaded.fixtureDir }),
    });
    if (!image.ok) {
      failures += 1;
      console.log(`${analysis.id}: image did not build (${image.failure}), no full run`);
      return;
    }
    const fullRunOn = async (built: typeof image, runLogDir: string) => {
      const set = await services.start(analysis.id, built.arch === 'arm64-native' ? 'fullarm' : 'full');
      try {
        return await runFull({
          analysis,
          image: built.image,
          arch: built.arch,
          recipe: loaded.recipe,
          runner,
          services: set,
          env: productionEnvironment,
          logDir: runLogDir,
        });
      } finally {
        await services.stop(set);
      }
    };
    try {
      let built = image;
      let result = await fullRunOn(built, logDir);
      // QEMU crashed the app: repeat on a native arm64 image (behaviour evidence only).
      if (!result.webHealthy && result.infrastructureFailures.some((note) => note.startsWith('emulation'))) {
        console.log(`${analysis.id}: QEMU crashed the app, repeating the full run as native arm64`);
        const native = await buildImage({
          id: analysis.id,
          recipe: loaded.recipe,
          platform: 'linux/arm64',
          logDir,
          ...(loaded.fixtureDir === undefined ? {} : { fixtureDir: loaded.fixtureDir }),
        });
        if (native.ok) {
          built = native;
          result = await fullRunOn(built, logDir);
        }
      }
      // Repeat on a fresh service set: a single run can show or hide a problem by chance.
      const repeat = await fullRunOn(built, join(logDir, 'repeat'));
      mkdirSync(outDir, { recursive: true });
      writeFileSync(outFile, `${JSON.stringify(fullRunSchema.parse({ ...result, repeat }), null, 2)}\n`);
      const health = (run: typeof result) => (run.webHealthy ? 'healthy' : 'NOT healthy');
      console.log(`${analysis.id}: full runs ${health(result)}, ${health(repeat)}`);
    } catch (error) {
      failures += 1;
      console.log(`${analysis.id}: full run failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  if (failures > 0) process.exitCode = 1;
}
