/**
 * Produces an Analysis result file for a recipe through the production path.
 *
 * The analysis session (`session.ts`) runs
 * `runApplicationAnalysis` on an in-process PGlite with the real migrations,
 * then `normalizeDeploymentManifest` and `evaluateManifestReadiness`. A git recipe reads GitHub through the
 * snapshot cache. A fixture recipe is served from its local folder by the
 * same tree fetch.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { evaluateManifestReadiness } from '@deployz/analysis';
import type { FetchFn } from '@deployz/api/github';
import {
  evaluateEnvironmentSetup,
  keysNotNeedingValue,
  type DeploymentManifest,
  type ManifestReadinessResult,
} from '@deployz/contracts';

import { vendorRequiredVariables } from '../claims/extract.js';
import type { AnalysisResultFile, Recipe } from '../contract.js';
import { readLocalTree, serveLocalTree } from './local-tree.js';
import { openAnalysisSession, type SessionEngine } from './session.js';
import { classifyGithubUrl, createSnapshotFetch } from './snapshot.js';

/** The owner a fixture takes in its GitHub-like name, `fixture/<F#>`. */
const FIXTURE_OWNER = 'fixture';

/** Names the rules, not the harness: the git tree of `packages/analysis/src` changes only when the rules change. */
export function rulesAnalyserName(cwd: string): string {
  return `rules@${analysisTree(cwd)}`;
}

/** `ai@<tree>`: the same tree holds the prompts, the checks and the merge. */
export function aiAnalyserName(cwd: string): string {
  return `ai@${analysisTree(cwd)}`;
}

function analysisTree(cwd: string): string {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD:packages/analysis/src'], { cwd, encoding: 'utf8' }).trim();
}

/**
 * The deployment-creation gate for a new application, as production runs it
 * (`evaluatePreflight`): a variable that needs no vendor value counts as
 * provided. The analysis session passes no provided keys, so it also flags
 * Deployz-managed variables.
 */
export function freshApplicationGate(manifest: DeploymentManifest): ManifestReadinessResult {
  const evaluation = evaluateEnvironmentSetup({ variables: manifest.environment.variables, settings: null, vendorValueKeys: new Set() });
  return evaluateManifestReadiness(manifest, { providedEnvKeys: keysNotNeedingValue(evaluation) });
}

/**
 * The questions the Analysis asks the vendor: the manifest questions plus the
 * gate errors that need a vendor action. An `unsupported` error is a verdict
 * (NOT_COMPATIBLE), not a question, and a warning needs no action. The
 * missing-variables error counts one question per variable.
 */
export function vendorQuestionCount(manifest: DeploymentManifest, gate: ManifestReadinessResult): number {
  const fromGate = gate.findings
    .filter((finding) => finding.severity === 'error' && finding.id !== 'unsupported')
    .reduce(
      (sum, finding) =>
        sum + (finding.id === 'required-env-vars-missing' ? vendorRequiredVariables(manifest).length : 1),
      0,
    );
  return (manifest.questions?.length ?? 0) + fromGate;
}

export interface AnalyserOptions {
  analyser: string;
  /** The folder of the snapshot cache (GitHub tree and blob answers). */
  cacheDir: string;
  token: string | null;
  offline?: boolean;
  /** `scripts/run-and-check/fixtures`. */
  fixturesDir: string;
  engine?: SessionEngine | undefined;
}

export interface Analyser {
  analyse(recipe: Recipe): Promise<AnalysisResultFile>;
  close(): Promise<void>;
}

export async function openAnalyser(options: AnalyserOptions): Promise<Analyser> {
  const github = createSnapshotFetch({ cacheDir: options.cacheDir, token: options.token, offline: options.offline });
  const fixtures = new Map<string, ReturnType<typeof serveLocalTree>>();
  const fetchFn: FetchFn = async (url, init) => {
    const request = classifyGithubUrl(url);
    if (request.kind !== 'token' && request.kind !== 'other' && request.owner === FIXTURE_OWNER) {
      const serve = fixtures.get(request.repo);
      if (!serve) throw new Error(`unknown fixture ${request.repo}`);
      return serve(url);
    }
    return github(url, init);
  };
  const session = await openAnalysisSession(fetchFn, options.engine);

  return {
    async analyse(recipe) {
      let repository: string;
      let commit: string;
      if (recipe.source.kind === 'git') {
        ({ repository, commit } = recipe.source);
      } else {
        const tree = readLocalTree(join(options.fixturesDir, recipe.source.fixture, 'app'));
        repository = `${FIXTURE_OWNER}/${recipe.source.fixture}`;
        commit = tree.commit;
        fixtures.set(recipe.source.fixture, serveLocalTree(tree));
      }
      const raw = await session.analyse({ id: recipe.id, repository, commit });
      const gate = raw.manifest ? freshApplicationGate(raw.manifest) : null;
      const buildTarget = raw.row?.detectedMetadata?.['dockerfileBuildTarget'];
      return {
        id: recipe.id,
        commit,
        analyser: options.analyser,
        status: raw.status,
        failure: raw.failure,
        manifest: raw.manifest,
        gate,
        vendorQuestions: raw.manifest && gate ? vendorQuestionCount(raw.manifest, gate) : 0,
        ...(typeof buildTarget === 'string' ? { buildTarget } : {}),
        ...(raw.aiEngine ? { ai: raw.aiEngine } : {}),
      };
    },
    close: () => session.close(),
  };
}
