import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../src/analyser.js';
import { migrationRunnerVerdict, type FileTree } from '../src/detectors.js';
import { manifestToApplicationGraph } from '../src/graph.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';
import { buildReadinessReport, reconcileReadiness } from '../src/readiness-report.js';

function tree(dockerfile: string[] | null, pkg: Record<string, unknown> = {}): FileTree {
  return {
    ...(dockerfile !== null ? { Dockerfile: dockerfile.join('\n') } : {}),
    'package.json': JSON.stringify({ name: 'app', scripts: { start: 'node index.js' }, ...pkg }),
  };
}

const FULL_INSTALL = ['FROM node:22-alpine', 'WORKDIR /app', 'COPY . .', 'RUN npm ci', 'CMD ["node", "index.js"]'];

describe('migrationRunnerVerdict', () => {
  it('adds npx to a bare CLI only when the Node image holds the CLI in node_modules', () => {
    expect(migrationRunnerVerdict(tree(FULL_INSTALL, { devDependencies: { prisma: '5' } }), 'prisma migrate deploy')).toEqual({
      runnable: true,
      needsNpx: true,
    });
  });

  it('never proves a CLI from dependencies alone', () => {
    const noInstall = ['FROM node:22-alpine', 'WORKDIR /app', 'COPY dist ./dist', 'CMD ["node", "dist/index.js"]'];
    const verdict = migrationRunnerVerdict(tree(noInstall, { dependencies: { prisma: '5' } }), 'prisma migrate deploy');
    expect(verdict).toMatchObject({ runnable: false, reason: expect.stringContaining('npx would download it') });
  });

  it('counts a production-only install for production dependencies only', () => {
    const prodOnly = ['FROM node:22-alpine', 'WORKDIR /app', 'COPY . .', 'RUN npm ci --omit=dev', 'CMD ["node", "index.js"]'];
    expect(migrationRunnerVerdict(tree(prodOnly, { dependencies: { 'drizzle-kit': '0' } }), 'npx drizzle-kit push').runnable).toBe(true);
    expect(migrationRunnerVerdict(tree(prodOnly, { devDependencies: { 'drizzle-kit': '0' } }), 'npx drizzle-kit push').runnable).toBe(false);
  });

  it('reads node_modules copied from another stage, including its whole working directory', () => {
    const copied = [
      'FROM node:22 AS deps',
      'WORKDIR /srv',
      'COPY . .',
      'RUN npm ci',
      'FROM node:22-slim',
      'COPY --from=deps /srv /srv',
      'CMD ["node", "/srv/index.js"]',
    ];
    expect(migrationRunnerVerdict(tree(copied, { devDependencies: { knex: '3' } }), 'knex migrate:latest').runnable).toBe(true);
  });

  it('follows the runtime stage ancestry to its base image', () => {
    const chained = ['FROM node:22 AS base', 'WORKDIR /app', 'COPY . .', 'RUN npm ci', 'FROM base AS runner', 'CMD ["node", "index.js"]'];
    expect(migrationRunnerVerdict(tree(chained, { dependencies: { prisma: '5' } }), 'prisma migrate deploy').runnable).toBe(true);
    const bunChain = ['FROM oven/bun:1 AS base', 'FROM base AS runner', 'CMD ["bun", "index.js"]'];
    expect(migrationRunnerVerdict(tree(bunChain, { dependencies: { prisma: '5' } }), 'prisma migrate deploy')).toMatchObject({
      runnable: false,
      reason: expect.stringContaining('oven/bun:1'),
    });
  });

  it.each([
    ['no Dockerfile', null, 'npx prisma migrate deploy'],
    ['a Bun image asked for npx', ['FROM oven/bun:1', 'RUN bun install'], 'npx prisma migrate deploy'],
    ['a Node image asked for bunx', FULL_INSTALL, 'bunx prisma migrate deploy'],
    ['pnpm without corepack', FULL_INSTALL, 'pnpm db:migrate'],
    ['a runner stage that removes npm', [...FULL_INSTALL, 'RUN rm -rf /usr/local/lib/node_modules/npm'], 'npm run db:migrate'],
    ['a distroless image', ['FROM gcr.io/distroless/nodejs22-debian12'], 'node migrate.js'],
    ['a base image from a build argument', ['ARG IMAGE', 'FROM ${IMAGE}'], 'npm run db:migrate'],
  ] as const)('needs input for %s', (_name, dockerfile, command) => {
    const verdict = migrationRunnerVerdict(tree(dockerfile === null ? null : [...dockerfile], { dependencies: { prisma: '5' } }), command);
    expect(verdict.runnable).toBe(false);
  });

  it('accepts the runner the image provides and leaves non-JavaScript commands to the vendor', () => {
    expect(migrationRunnerVerdict(tree(['FROM oven/bun:1', 'RUN bun install']), 'bunx prisma migrate deploy').runnable).toBe(true);
    const corepack = [...FULL_INSTALL, 'RUN corepack enable'];
    expect(migrationRunnerVerdict(tree(corepack), 'pnpm db:migrate').runnable).toBe(true);
    expect(migrationRunnerVerdict(tree(null), 'python manage.py migrate --noinput')).toEqual({ runnable: true, needsNpx: false });
  });
});

describe('the migration "Needs input" question', () => {
  const needsInput = { candidate: 'prisma migrate deploy', reason: 'the runtime image oven/bun:1 is not shown to provide npx' };
  const analysis = analyseRepo(tree(['FROM oven/bun:1'], { dependencies: { pg: '8' } }));

  it('is a required readiness finding that the vendor decision resolves', () => {
    const report = buildReadinessReport(analysis, { migrationNeedsInput: needsInput });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ id: 'migration-command-needs-input', severity: 'required', confidence: 'needs_confirmation' }),
    );
    const resolved = reconcileReadiness(report, { containerPort: 3000, startCommand: null, migrationCommandDecided: true });
    expect(resolved.findings.map((finding) => finding.id)).not.toContain('migration-command-needs-input');
  });

  it('says that the migration is unknown when no script was found (the AI Analysis could not tell)', () => {
    const unknown = { candidate: '', reason: 'The AI Analysis could not tell how this app migrates its database.' };
    const finding = buildReadinessReport(analysis, { migrationNeedsInput: unknown }).findings.find((entry) => entry.id === 'migration-command-needs-input');
    expect(finding).toMatchObject({ plainEnglishExplanation: 'Deployz cannot tell how this app migrates its database.', technicalEvidence: unknown.reason });
  });

  it('a migration the AI left open is a change to verify (outcome 2); a rules candidate is a setting', () => {
    const unknown = { candidate: '', reason: 'The AI Analysis could not tell how this app migrates its database.' };
    const fromAi = { ...analysis, metadata: { ...analysis.metadata, aiMigrationQuestion: unknown } };
    const classOf = (report: ReturnType<typeof buildReadinessReport>) => report.findings.find((entry) => entry.id === 'migration-command-needs-input')?.fixClass;
    expect(classOf(buildReadinessReport(fromAi, { migrationNeedsInput: unknown }))).toBe('CODE_CHANGE');
    expect(classOf(buildReadinessReport(analysis, { migrationNeedsInput: needsInput }))).toBe('SETTING');
  });

  it('blocks provisioning until the vendor owns the migration setting', () => {
    const open = normalizeDeploymentManifest({ metadata: { ...analysis.metadata, migrationNeedsInput: needsInput } }, {});
    expect(open.migration.needsCommand).toBe(true);
    const gate = evaluateManifestReadiness(open);
    expect(gate.state).toBe('NEEDS_CONFIGURATION');
    expect(gate.findings).toContainEqual(expect.objectContaining({ id: 'migration-command-needs-input', severity: 'error' }));

    const decided = normalizeDeploymentManifest(
      { metadata: { ...analysis.metadata, migrationNeedsInput: needsInput, vendorOverrides: ['migrationCommand'] } },
      {},
    );
    expect(decided.migration.needsCommand).toBeUndefined();
    expect(evaluateManifestReadiness(decided).findings.map((finding) => finding.id)).not.toContain('migration-command-needs-input');
  });
});

describe('the explicit "No separate migration" choice', () => {
  const unknown = analyseRepo(tree(['FROM golang:1.22'], { dependencies: { pg: '8' } }));
  const metadata = { ...unknown.metadata, postgres: { required: true }, migrationMode: 'unknown' };
  const questions = (manifest: ReturnType<typeof normalizeDeploymentManifest>) =>
    manifestToApplicationGraph(manifest).unresolved.map((entry) => entry.field);

  it('is frozen as mode none and closes the migration strategy question', () => {
    const open = normalizeDeploymentManifest({ metadata }, {});
    expect(open.migration.mode).toBe('unknown');
    expect(questions(open)).toContain('migration_strategy');

    const decided = normalizeDeploymentManifest({ metadata: { ...metadata, vendorOverrides: ['migrationCommand'] } }, {});
    expect(decided.migration).toMatchObject({ mode: 'none', command: null });
    expect(questions(decided)).not.toContain('migration_strategy');
  });

  it('keeps startup mode and a vendor command untouched', () => {
    const startup = normalizeDeploymentManifest(
      { metadata: { ...metadata, migrationMode: 'startup', vendorOverrides: ['migrationCommand'] } },
      {},
    );
    expect(startup.migration.mode).toBe('startup');
    const command = normalizeDeploymentManifest(
      { metadata: { ...metadata, vendorOverrides: ['migrationCommand'] } },
      { migrationCommand: 'node migrate.js' },
    );
    expect(command.migration).toMatchObject({ mode: 'unknown', command: 'node migrate.js' });
  });
});
