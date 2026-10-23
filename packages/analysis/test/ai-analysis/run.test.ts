import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../../src/analyser.js';
import { SpendLimitExceededError, type AiGateway } from '../../src/ai-gateway.js';
import { ANALYST_PROMPT_VERSION, parseAnalysisEngine, runAiAnalysis } from '../../src/ai-analysis/index.js';
import type { FileTree } from '../../src/detectors.js';
import { databaseConnectionUnverified } from '../../src/manifest.js';
import { buildReadinessReport } from '../../src/readiness-report.js';
import { blocker, cite, ELIXIR_SOURCES, elixirPostgres, fact, fakeGateway, MONGO_OR_POSTGRES, toWire } from './helpers.js';

const resolved: FileTree = {
  Dockerfile: ['FROM node:20', 'EXPOSE 3000', 'CMD ["node", "src/index.js"]'].join('\n'),
  'package.json': JSON.stringify({ name: 'a', dependencies: { express: '^4' } }),
  'src/index.js': "app.get('/health', r);\napp.listen(process.env.PORT || 3000);",
};

const inputOf = (tree: FileTree, analyst: AiGateway) => ({ tree, rules: analyseRepo(tree), gateways: { analyst } });
const throwing = (error: Error): AiGateway => ({ generate: () => Promise.reject(error) });

const OPTIONAL = blocker('q1', 'optional_by_setting', {
  setting: 'DB_TYPE',
  settingValue: 'postgres',
  engine: 'postgres',
  evidence: [...cite('src/db.js', 1, 'process.env.DB_TYPE'), ...cite('src/db.js', 2, "type === 'postgres'")],
});

describe('runAiAnalysis', () => {
  it('makes no call when the rules left no open item', async () => {
    const analyst = fakeGateway(toWire([]));
    const { merge, report } = await runAiAnalysis(inputOf(resolved, analyst));
    expect(analyst.prompts).toHaveLength(0);
    expect(report).toMatchObject({ promptVersion: ANALYST_PROMPT_VERSION, analyst: null, questions: 0, failedChecks: 0, answers: [] });
    expect(merge.analysis.metadata['port']).toBe('3000');
  });

  it('makes one call for the open items and reports the answers', async () => {
    const analyst = fakeGateway(toWire([OPTIONAL]), { promptTokens: 1000, completionTokens: 200 });
    const { merge, report } = await runAiAnalysis(inputOf(MONGO_OR_POSTGRES, analyst));
    expect(analyst.prompts).toHaveLength(1);
    // The instructions travel as the system message; the user message holds only the data.
    expect(analyst.systems[0]).toContain('untrusted data');
    expect(analyst.prompts[0]).not.toContain('WHAT A WRONG ANSWER COSTS');
    expect(report.analyst).toMatchObject({ model: 'fake-model', usage: { promptTokens: 1000, completionTokens: 200 } });
    expect(report).toMatchObject({ questions: 1, failedChecks: 0, settings: merge.settings, answers: merge.answers });
    expect(merge.analysis.metadata['unsupportedReasons']).toEqual([]);
  });

  it('counts a failed check in the report and keeps the rules value', async () => {
    const analyst = fakeGateway(toWire([{ ...OPTIONAL, evidence: cite('src/db.js', 2, "type === 'postgres'") }]));
    const { merge, report } = await runAiAnalysis(inputOf(MONGO_OR_POSTGRES, analyst));
    expect(report.failedChecks).toBe(1);
    expect(merge.analysis.metadata['unsupportedReasons']).toHaveLength(1);
  });

  it('reads the fetched evidence files: a startup migration and the database variable they show enter the analysis', async () => {
    const tree = elixirPostgres();
    const answers = [
      fact('q1', JSON.stringify({ mode: 'startup', command: null }), { evidence: cite('lib/app/application.ex', 5, 'App.ReleaseTasks.migrate()') }),
      fact('q2', 'DB_URL', { evidence: cite('config/runtime.exs', 3, 'System.fetch_env!("DB_URL")') }),
    ];
    const analyst = fakeGateway(toWire([], answers));
    const { merge, report } = await runAiAnalysis({ ...inputOf(tree, analyst), evidenceFiles: ELIXIR_SOURCES });
    expect(analyst.prompts[0]).toContain('config/runtime.exs');
    expect(report.failedChecks).toBe(0);
    expect(merge.analysis.metadata['migrationMode']).toBe('startup');
    // The rules' evidence shape, so the finding names the file and line (it read "undefined (undefined)").
    expect(merge.analysis.metadata['migrationStartupEvidence']).toEqual([
      { source: 'lib/app/application.ex:5', pattern: 'AI Analysis', fromDockerCommand: false },
    ]);
    const migrations = buildReadinessReport(merge.analysis).findings.find((finding) => finding.id === 'database-migrations');
    expect(migrations?.technicalEvidence).toBe('Migrations run at startup: AI Analysis (lib/app/application.ex:5).');
    expect(merge.analysis.metadata['infrastructureBindings']).toContainEqual({ resource: 'postgres', semantic: 'url', applicationVariable: 'DB_URL', source: 'ai', confidence: 'high' });
    expect(databaseConnectionUnverified(merge.analysis.metadata)).toBe(false);
    expect(databaseConnectionUnverified(analyseRepo(tree).metadata)).toBe(true);
    // Without the files the answers cite nothing the pack shows.
    const { report: without } = await runAiAnalysis(inputOf(tree, fakeGateway(toWire([], answers))));
    expect(without.failedChecks).toBe(2);
  });

  it('a variable that an evidence file reads with no default is required, also when every answer is unknown', async () => {
    const tree = elixirPostgres();
    const unknown = fakeGateway(toWire([], [fact('q1', null), fact('q2', null)]));
    const { merge } = await runAiAnalysis({ ...inputOf(tree, unknown), evidenceFiles: ELIXIR_SOURCES });
    const model = merge.analysis.metadata['envVarModel'] as Array<Record<string, unknown>>;
    expect(model).toContainEqual(expect.objectContaining({ key: 'MAILER_HOST', required: true, classification: 'customer_required', source: ['read in config/runtime.exs'] }));
    // A database URL that the app requires becomes a binding, as the rules make it for a name they read.
    expect(model).toContainEqual(expect.objectContaining({ key: 'DB_URL', classification: 'deployz_managed' }));
    expect(merge.analysis.metadata['infrastructureBindings']).toContainEqual(expect.objectContaining({ applicationVariable: 'DB_URL', semantic: 'url' }));
    // DB_HOST has a default (System.get_env), so it is not required.
    expect(model.some((entry) => entry['key'] === 'DB_HOST')).toBe(false);
  });

  it('rejects when the gateway throws, the answer fails the schema, or a call uses more tokens than its budget', async () => {
    await expect(runAiAnalysis(inputOf(MONGO_OR_POSTGRES, throwing(new Error('gateway down'))))).rejects.toThrow('gateway down');
    await expect(runAiAnalysis(inputOf(MONGO_OR_POSTGRES, fakeGateway({ port: 'three thousand' })))).rejects.toThrow();
    await expect(runAiAnalysis(inputOf(MONGO_OR_POSTGRES, fakeGateway({ ...toWire([OPTIONAL]), extra: 1 })))).rejects.toThrow();
    const expensive = fakeGateway(toWire([OPTIONAL]), { promptTokens: 500_000, completionTokens: 10 });
    await expect(runAiAnalysis(inputOf(MONGO_OR_POSTGRES, expensive))).rejects.toBeInstanceOf(SpendLimitExceededError);
  });
});

describe('parseAnalysisEngine', () => {
  it.each([
    ['ai', 'ai'],
    ['shadow', 'shadow'],
    ['rules', 'rules'],
    [undefined, 'rules'],
    ['', 'rules'],
    ['AI', 'rules'],
    ['hybrid', 'rules'],
  ])('maps %s to %s', (value, expected) => {
    expect(parseAnalysisEngine(value)).toBe(expected);
  });
});
