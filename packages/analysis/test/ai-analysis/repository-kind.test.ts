import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../../src/analyser.js';
import { runAiAnalysis } from '../../src/ai-analysis/index.js';
import { buildEvidencePack, evidenceFileRequests, isProductionFile } from '../../src/ai-analysis/evidence-pack.js';
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

// A key-value server in C with no Dockerfile (Valkey, new-229), and one with a toolchain image
// that starts nothing (Redis, new-225): the rules alone would ask for a Dockerfile.
const DATASTORE = (dockerfile?: string): FileTree =>
  withPaths({
    'README.md': '# Acme KV\n',
    ...(dockerfile === undefined ? {} : { 'docker/Dockerfile.noble': dockerfile }),
    'Makefile': 'all:\n\tcd src && $(MAKE)\n',
    'src/server.h': ['#ifndef SERVER_H', '#define CONFIG_DEFAULT_SERVER_PORT 6379 /* TCP port. */', '#endif'].join('\n'),
    'src/server.c': '#include "server.h"\nint main(int argc, char **argv) { return serve(); }\n',
  });

const DEFAULT_PORT = cite('src/server.h', 2, '#define CONFIG_DEFAULT_SERVER_PORT 6379 /* TCP port. */');

describe('AI Analysis: datastore repository kind', () => {
  it('is asked when no web port or start command is known, not only without a Dockerfile', () => {
    expect(questionId(DATASTORE())).toBeDefined();
    expect(questionId(DATASTORE(['FROM ubuntu:24.04', 'WORKDIR /workspace', 'COPY src /workspace/src', 'RUN make'].join('\n')))).toBeDefined();
  });

  it('shows the line with the default client port', async () => {
    const { prompt } = await outcomeOf(DATASTORE(), null);
    expect(prompt).toContain('2| #define CONFIG_DEFAULT_SERVER_PORT 6379');
  });

  it('a checked datastore answer is not deployable, with or without a Dockerfile', async () => {
    for (const tree of [DATASTORE(), DATASTORE(['FROM ubuntu:24.04', 'WORKDIR /workspace', 'COPY src /workspace/src', 'RUN make'].join('\n'))]) {
      const { report, failedChecks } = await outcomeOf(tree, 'datastore', { evidence: DEFAULT_PORT });
      expect(failedChecks).toBe(0);
      expect(report.outcome).toBe('NOT_DEPLOYABLE');
      const ids = report.findings.map((finding) => finding.id);
      expect(ids).toContain('unsupported-datastore-server');
      expect(ids).not.toContain('unsupported-no-dockerfile');
    }
  });

  it('keeps the rules outcome when the cited line names no datastore role or port', async () => {
    const { report, failedChecks } = await outcomeOf(DATASTORE(), 'datastore', { evidence: cite('src/server.c', 2, 'int main(int argc, char **argv) { return serve(); }') });
    expect(failedChecks).toBe(1);
    expect(report.outcome).toBe('DEPLOYABLE_WITH_CHANGES');
  });
});

// A database server whose role only the root README states (PostgreSQL new-221, MySQL new-213,
// RabbitMQ new-224): the rules tree does not hold the README, the AI evidence files do.
const README_ONLY = (): FileTree =>
  withPaths({
    'README.md': [
      'PostgreSQL Database Management System',
      '=====================================',
      '',
      'PostgreSQL is an advanced object-relational database management system',
      'that supports an extended subset of the SQL standard.',
    ].join('\n'),
    'GNUmakefile.in': 'all:\n\t$(MAKE) -C src all\n',
    'src/backend/main/main.c': 'int main(int argc, char *argv[]) { return PostmasterMain(argc, argv); }\n',
  });

describe('AI Analysis: the root README for the repository kind', () => {
  it('requests the root README only for the repository kind question', () => {
    // The rules tree holds no README; the path list of the repository has it.
    const withReadmePath = (files: Record<string, string>): FileTree =>
      Object.defineProperty(files, TREE_PATHS, { value: [...Object.keys(files), 'README.md'], enumerable: false });
    const { 'README.md': _readme, ...source } = README_ONLY();
    const rulesTree = withReadmePath({ ...source });
    expect(evidenceFileRequests(rulesTree, analyseRepo(rulesTree))).toContain('README.md');
    const app = withReadmePath({
      Dockerfile: ['FROM node:20', 'COPY . .', 'EXPOSE 3000', 'CMD ["node", "index.js"]'].join('\n'),
      'package.json': JSON.stringify({ name: 'a', dependencies: { express: '^4' } }),
      'index.js': 'require("express")().listen(process.env.PORT || 3000);',
    });
    expect(evidenceFileRequests(app, analyseRepo(app))).not.toContain('README.md');
  });

  it('a datastore answer that cites the README role line is not deployable', async () => {
    const { report, failedChecks, prompt } = await outcomeOf(README_ONLY(), 'datastore', {
      evidence: cite('README.md', 4, 'PostgreSQL is an advanced object-relational database management system'),
    });
    expect(prompt).toContain('4| PostgreSQL is an advanced object-relational database management system');
    expect(failedChecks).toBe(0);
    expect(report.outcome).toBe('NOT_DEPLOYABLE');
  });

  it('a README role sentence that wraps over two lines supports the answer (MariaDB new-209)', async () => {
    const tree = withPaths({
      ...README_ONLY(),
      'README.md': ['# MariaDB Server', '', 'MariaDB Server is one of the most widely deployed open source relational', ' databases. It is built by a global community.'].join('\n'),
    });
    const { report, failedChecks } = await outcomeOf(tree, 'datastore', {
      evidence: [cite('README.md', 1, '# MariaDB Server')[0]!, cite('README.md', 3, 'open source relational')[0]!],
    });
    expect(failedChecks).toBe(0);
    expect(report.outcome).toBe('NOT_DEPLOYABLE');
    // The title line alone names no role.
    expect((await outcomeOf(tree, 'datastore', { evidence: cite('README.md', 1, '# MariaDB Server') })).failedChecks).toBe(1);
  });

  it('is never production evidence for another answer', () => {
    expect(isProductionFile('README.md')).toBe(false);
    expect(isProductionFile('docs/README.md')).toBe(false);
    const tree = withPaths({
      ...README_ONLY(),
      Dockerfile: ['FROM debian:12', 'COPY . /src', 'RUN make -C /src'].join('\n'),
      'README.md': 'Run it with `PORT=5432 ./start.sh`; the start script listens on PORT.\n',
    });
    const pack = buildEvidencePack(tree, analyseRepo(tree));
    const other = pack.questions.filter((question) => !(question.kind === 'fact' && question.fact === 'repositoryKind'));
    expect(other.length).toBeGreaterThan(0);
    expect(other.flatMap((question) => question.windows).some((file) => file.path === 'README.md')).toBe(false);
  });
});
