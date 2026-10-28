import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../../src/analyser.js';
import { runAiAnalysis } from '../../src/ai-analysis/index.js';
import { buildEvidencePack } from '../../src/ai-analysis/evidence-pack.js';
import { TREE_PATHS, type FileTree } from '../../src/detectors.js';
import { buildReadinessReport } from '../../src/readiness-report.js';
import { cite, fact, fakeGateway, toWire } from './helpers.js';

const withPaths = (files: Record<string, string>): FileTree => Object.defineProperty(files, TREE_PATHS, { value: Object.keys(files), enumerable: false });

// A Python framework and CLI with no Dockerfile (crewAI, new-166), and a website
// manifest that publishes nothing, so the rules alone cannot call it a library (Strapi).
const FRAMEWORK = (): FileTree =>
  withPaths({
    'README.md': '# Acme agents\nA Python framework for agents.\n',
    'website/package.json': JSON.stringify({ name: 'acme-website', private: true, scripts: { start: 'next start' } }),
    'pyproject.toml': [
      '[project]',
      'name = "acme-agents"',
      'version = "1.0.0"',
      '',
      '[project.scripts]',
      'acme = "acme.cli:main"',
      '',
      '[build-system]',
      'requires = ["hatchling"]',
      'build-backend = "hatchling.build"',
    ].join('\n'),
    'src/acme/__init__.py': 'from acme.agent import Agent\n',
    'src/acme/cli.py': 'def main():\n    print("acme")\n',
  });

const BUILD_BACKEND = cite('pyproject.toml', 10, 'build-backend = "hatchling.build"');

function questionId(tree: FileTree): string | undefined {
  const question = buildEvidencePack(tree, analyseRepo(tree)).questions.find((entry) => entry.kind === 'fact' && entry.fact === 'repositoryKind');
  return question?.id;
}

async function outcomeOf(tree: FileTree, value: string | null, overrides: Parameters<typeof fact>[2] = {}) {
  const id = questionId(tree)!;
  const analyst = fakeGateway(toWire([], [fact(id, value, { evidence: BUILD_BACKEND, ...overrides })]));
  const { merge, report } = await runAiAnalysis({ tree, rules: analyseRepo(tree), gateways: { analyst } });
  return { report: buildReadinessReport(merge.analysis), failedChecks: report.failedChecks, prompt: analyst.prompts[0] ?? '' };
}

describe('AI Analysis: repository kind', () => {
  it('is asked only when the rules found no Dockerfile that builds the repository', () => {
    expect(analyseRepo(FRAMEWORK()).rejections.some((rejection) => rejection.detected && rejection.dependency === 'no-buildable-dockerfile')).toBe(true);
    expect(questionId(FRAMEWORK())).toBeDefined();
    const app = withPaths({
      Dockerfile: ['FROM node:20', 'COPY . .', 'EXPOSE 3000', 'CMD ["node", "index.js"]'].join('\n'),
      'package.json': JSON.stringify({ name: 'a', dependencies: { express: '^4' } }),
      'index.js': 'require("express")().listen(process.env.PORT || 3000);',
    });
    expect(questionId(app)).toBeUndefined();
  });

  it('shows the packaging lines of the manifests', async () => {
    const { prompt } = await outcomeOf(FRAMEWORK(), null);
    expect(prompt).toContain('fact "repositoryKind"');
    expect(prompt).toContain('10| build-backend = "hatchling.build"');
  });

  it('a checked framework answer is not deployable, with no "add a Dockerfile" finding', async () => {
    expect(buildReadinessReport(analyseRepo(FRAMEWORK())).outcome).toBe('DEPLOYABLE_WITH_CHANGES');
    const { report, failedChecks } = await outcomeOf(FRAMEWORK(), 'framework');
    expect(failedChecks).toBe(0);
    expect(report.outcome).toBe('NOT_DEPLOYABLE');
    const ids = report.findings.map((finding) => finding.id);
    expect(ids).toContain('unsupported-library-repository');
    expect(ids).not.toContain('unsupported-no-dockerfile');
    expect(ids).not.toContain('container-setup');
    expect(report.findings.find((finding) => finding.id === 'unsupported-library-repository')?.technicalEvidence).toContain('pyproject.toml:10');
  });

  it('a console script entry or a "bin" entry is packaging evidence too', async () => {
    const { report } = await outcomeOf(FRAMEWORK(), 'cli', { evidence: cite('pyproject.toml', 6, 'acme = "acme.cli:main"'), confidence: 'medium' });
    expect(report.outcome).toBe('NOT_DEPLOYABLE');
    const node = withPaths({
      'package.json': ['{', '  "name": "@acme/cli",', '  "bin": {', '    "acme": "bin/acme.js"', '  }', '}'].join('\n'),
      'bin/acme.js': 'console.log("acme");\n',
      'website/package.json': JSON.stringify({ name: 'acme-website', private: true }),
    });
    const { report: nodeReport } = await outcomeOf(node, 'cli', { evidence: cite('package.json', 4, '"acme": "bin/acme.js"') });
    expect(nodeReport.outcome).toBe('NOT_DEPLOYABLE');
  });

  it('keeps outcome 2 for an application, a low-confidence answer, or a cited line that does not package the code', async () => {
    for (const [value, overrides] of [
      ['application', {}],
      ['framework', { confidence: 'low' as const }],
      ['library', { evidence: cite('pyproject.toml', 2, 'name = "acme-agents"') }],
      ['sdk', { evidence: cite('README.md', 2, 'A Python framework for agents.') }],
      ['plugin', {}],
    ] as const) {
      const { report } = await outcomeOf(FRAMEWORK(), value, overrides);
      expect(report.outcome, value).toBe('DEPLOYABLE_WITH_CHANGES');
      expect(report.findings.map((finding) => finding.id)).toContain('unsupported-no-dockerfile');
    }
  });
});
