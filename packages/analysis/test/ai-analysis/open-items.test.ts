import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../../src/analyser.js';
import type { BlockerAnswer } from '../../src/ai-analysis/analyst.js';
import { checkAnswers } from '../../src/ai-analysis/checks.js';
import { buildEvidencePack, renderEvidencePack } from '../../src/ai-analysis/evidence-pack.js';
import { mergeAiAnswers } from '../../src/ai-analysis/merge.js';
import { collectOpenItems } from '../../src/ai-analysis/open-items.js';
import { runAiAnalysis } from '../../src/ai-analysis/index.js';
import type { FileTree } from '../../src/detectors.js';
import { buildReadinessReport } from '../../src/readiness-report.js';
import { blocker, cite, fakeGateway, toWire } from './helpers.js';

/** A Rails app whose development stack wires Redis and Elasticsearch to the app; the rules find neither required. */
const STACK: FileTree = {
  Dockerfile: 'FROM ruby:3.4-slim\nWORKDIR /app\nCOPY . .\nRUN bundle install\nEXPOSE 3000\nCMD ["bundle", "exec", "puma"]\n',
  Gemfile: "source 'https://rubygems.org'\ngem 'rails'\ngem 'pg'\n",
  'config/puma.rb': "port ENV.fetch('PORT', 3000)\n",
  'app/models/search.rb': "class Search\n  def self.client\n    Elasticsearch::Client.new(url: ENV.fetch('ES_URL'))\n  end\nend\n",
  'config/initializers/cable.rb': "ActionCable.server.config.cable = { adapter: :redis, url: ENV['REDIS_URL'] }\n",
  '.devcontainer/compose.yaml': [
    'services:',
    '  app:',
    '    image: ghcr.io/rails/devcontainer/images/ruby:3.4',
    '    environment:',
    '      DATABASE_URL: postgres://app:app@postgresql:5432',
    '      REDIS_URL: redis://redis:6379',
    '      ES_URL: http://search:9200',
    '  postgresql:',
    '    image: postgres:17-alpine',
    '  redis:',
    '    image: redis:7.0',
    '  search:',
    '    image: elasticsearch:9.5.5',
    '',
  ].join('\n'),
};

function merge(tree: FileTree, blockers: BlockerAnswer[]) {
  const rules = analyseRepo(tree);
  const pack = buildEvidencePack(tree, rules);
  const checks = checkAnswers({ pack, tree, dockerfile: 'Dockerfile', database: 'postgres' }, blockers, []);
  return { rules, pack, checks, result: mergeAiAnswers({ tree, rules, pack, answers: { blockers, facts: [] }, checks }) };
}

const declared = (analysis: { rejections: ReadonlyArray<{ detected: boolean; dependency: string }> }) =>
  analysis.rejections.filter((rejection) => rejection.detected).map((rejection) => rejection.dependency);

describe('a declared service that the rules did not explain', () => {
  it('is one closed blocker question with the service names, the engine words and the connection names', () => {
    const rules = analyseRepo(STACK);
    const items = collectOpenItems(STACK, rules).filter((item) => item.kind === 'blocker');
    expect(items).toEqual([
      expect.objectContaining({
        category: 'declared_service',
        dependency: 'unexplained-declared-service',
        terms: expect.arrayContaining(['redis', 'search', 'elasticsearch', 'redis_url', 'search_url']),
      }),
    ]);
    const prompt = renderEvidencePack(buildEvidencePack(STACK, rules));
    expect(prompt).toContain('Does the production app need any of these services at runtime?');
    // The window shows the production line that uses the service.
    expect(prompt).toContain("Elasticsearch::Client.new(url: ENV.fetch('ES_URL'))");
  });

  it('makes no model call when every declared service is explained, and one question when one is not', async () => {
    const app = (environment: string): FileTree => ({
      Dockerfile: 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 3000\nCMD ["node", "src/index.js"]',
      'package.json': '{\n  "name": "app",\n  "dependencies": {\n    "express": "4.21.0"\n  }\n}\n',
      'src/index.js': "const app = require('express')();\napp.get('/health', (req, res) => res.send('ok'));\napp.listen(process.env.PORT || 3000);",
      '.devcontainer/compose.yaml': `services:\n  app:\n    build: .\n${environment}    depends_on:\n      - redis\n  redis:\n    image: redis:7\n`,
    });
    for (const [environment, questions] of [['', 0], ['    environment:\n      - CACHE=redis:6379\n', 1]] as const) {
      const tree = app(environment);
      const gateway = fakeGateway(toWire([blocker('q1', 'required')]));
      const outcome = await runAiAnalysis({ tree, rules: analyseRepo(tree), gateways: { analyst: gateway } });
      expect(gateway.prompts).toHaveLength(questions);
      expect(outcome.report.questions).toBe(questions);
    }
  });

  it('accepts "required" only with a cited production line that uses the service', () => {
    const fromCompose = blocker('q1', 'required', { evidence: cite('.devcontainer/compose.yaml', 13, 'image: elasticsearch:9.5.5') });
    expect(merge(STACK, [fromCompose]).checks[0]).toMatchObject({ ok: false, reasons: expect.arrayContaining(['no cited production source line uses the service']) });
    const low = blocker('q1', 'required', { confidence: 'low', evidence: cite('app/models/search.rb', 3, 'Elasticsearch::Client.new') });
    expect(merge(STACK, [low]).checks[0]?.ok).toBe(false);
    // A failed "required" changes nothing: the question stays a change to verify (outcome 2).
    const { result } = merge(STACK, [fromCompose]);
    expect(declared(result.analysis)).toContain('unexplained-declared-service');
    expect(buildReadinessReport(result.analysis).outcome).toBe('DEPLOYABLE_WITH_CHANGES');
  });

  it('a checked "required" that cites an engine Deployz does not provide is not deployable', () => {
    const { result } = merge(STACK, [blocker('q1', 'required', { evidence: cite('app/models/search.rb', 3, 'Elasticsearch::Client.new') })]);
    expect(declared(result.analysis)).toEqual(['@elastic/elasticsearch']);
    expect(result.analysis.rejections.find((rejection) => rejection.detected)?.reason).toBe(
      "Unsupported service: the app needs Elasticsearch/OpenSearch (app/models/search.rb:3), which the repository's own setup declares. Deployz does not provide it.",
    );
    expect(result.answers[0]).toMatchObject({ decision: 'ai' });
    expect(buildReadinessReport(result.analysis).outcome).toBe('NOT_DEPLOYABLE');
  });

  it('a checked "required" that cites an engine Deployz provides keeps the question when it also names another service', () => {
    const { result } = merge(STACK, [blocker('q1', 'required', { evidence: cite('config/initializers/cable.rb', 1, 'adapter: :redis') })]);
    expect(declared(result.analysis)).toEqual(['unexplained-declared-service']);
    expect(buildReadinessReport(result.analysis).outcome).toBe('DEPLOYABLE_WITH_CHANGES');
  });

  it('a checked "required" for one declared Redis service adds Redis instead of a change', () => {
    const redisOnly: FileTree = {
      ...STACK,
      'app/models/search.rb': 'class Item\nend\n',
      '.devcontainer/compose.yaml': STACK['.devcontainer/compose.yaml']!.replace('      ES_URL: http://search:9200\n', '').replace('  search:\n    image: elasticsearch:9.5.5\n', ''),
    };
    const { rules, result } = merge(redisOnly, [blocker('q1', 'required', { evidence: cite('config/initializers/cable.rb', 1, 'adapter: :redis') })]);
    expect(declared(rules)).toEqual(['unexplained-declared-service']);
    expect(declared(result.analysis)).toEqual([]);
    expect(result.answers[0]).toMatchObject({ decision: 'ai' });
    expect((result.analysis.metadata['redis'] as { required: boolean }).required).toBe(true);
    expect(buildReadinessReport(result.analysis).outcome).toBe('DEPLOYABLE');
  });

  it('"not used" passes only when no production line names the service, and then dismisses it', () => {
    const notUsed = blocker('q1', 'not_used', { evidence: cite('Dockerfile', 6, 'CMD ["bundle", "exec", "puma"]') });
    expect(merge(STACK, [notUsed]).checks[0]).toMatchObject({ ok: false, reasons: [expect.stringMatching(/names the service or its engine$/)] });
    const unused: FileTree = { ...STACK, 'app/models/search.rb': 'class Item\nend\n', 'config/initializers/cable.rb': 'Rails.application.config.cache_store = :memory_store\n' };
    const { result } = merge(unused, [notUsed]);
    expect(declared(result.analysis)).not.toContain('unexplained-declared-service');
    expect(buildReadinessReport(result.analysis).outcome).toBe('DEPLOYABLE');
  });
});
