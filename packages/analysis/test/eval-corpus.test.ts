/**
 * AI MVP Phase 9 — the permanent evaluation corpus for the MVP analysis.
 *
 * Nine representative repositories, each with the expectations a target
 * customer would recognise: what Deployz detected, which findings it raised
 * (and which it must NOT raise), how the environment variables were
 * classified, and what the deployment gate says. Everything here is
 * deterministic; the AI fallback never runs in this corpus, so the
 * assertions are exact. Add a repository here whenever a real-world
 * analysis surprise is fixed, so it stays fixed.
 */

import { describe, expect, it } from 'vitest';

import type { ManifestEnvVariable } from '@deployz/contracts';

import { analyseRepo } from '../src/analyser.js';
import { buildApplicationAnalysis } from '../src/application-analysis.js';
import type { FileTree } from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';
import { buildReadinessReport } from '../src/readiness-report.js';
import { collectUnresolvedQuestions } from '../src/repository-ai.js';

const CONTEXT = { analysisVersion: 13, aiResolved: [], resolvedMigrationCommand: null };

interface Expectation {
  readinessState: 'READY' | 'ALMOST_READY' | 'NEEDS_CHANGES';
  findings: string[];
  gate: 'READY' | 'NEEDS_CONFIGURATION' | 'NOT_COMPATIBLE';
  runtime: string;
  framework: string | null;
  port: number | null;
  database: 'postgres' | 'unsupported' | 'none';
  redisRequired: boolean;
  healthPath: string | null;
  env: Record<string, ManifestEnvVariable['classification']>;
  unresolvedQuestions: string[];
}

function nodeDockerfile(extra: string[] = []): string {
  return ['FROM node:20-alpine', 'WORKDIR /app', 'COPY . .', 'EXPOSE 3000', ...extra, 'CMD ["node", "server.js"]'].join('\n');
}

const corpus: { name: string; tree: FileTree; expected: Expectation }[] = [
  {
    name: 'simple Node app (Express, no database)',
    tree: {
      Dockerfile: nodeDockerfile(),
      'package.json': JSON.stringify({ name: 'simple', scripts: { start: 'node server.js' }, dependencies: { express: '^4' } }),
      'server.js': "const app = require('express')();\napp.get('/health', (_q, r) => r.send('ok'));\napp.listen(process.env.PORT || 3000);\n",
    },
    expected: {
      readinessState: 'READY',
      findings: [],
      gate: 'READY',
      runtime: 'node',
      framework: 'express',
      port: 3000,
      database: 'none',
      redisRequired: false,
      healthPath: '/health',
      // PORT is read with a default — Deployz sets it at installation.
      env: { PORT: 'deployz_managed' },
      unresolvedQuestions: [],
    },
  },
  {
    name: 'Next.js app with Prisma on PostgreSQL',
    tree: {
      Dockerfile: ['FROM node:20-alpine AS deps', 'FROM node:20-alpine AS runner', 'EXPOSE 3000', 'CMD ["node", "server.js"]'].join('\n'),
      'package.json': JSON.stringify({
        name: 'web',
        scripts: { build: 'next build', start: 'next start', 'db:migrate': 'prisma migrate deploy' },
        dependencies: { next: '^15', '@prisma/client': '^6', prisma: '^6' },
      }),
      'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
      'app/api/health/route.ts': "export function GET() { return Response.json({ ok: true }); }\n",
      '.env.example': 'DATABASE_URL=\nNEXTAUTH_SECRET=\n',
      'app/auth.ts': "export const secret = process.env.NEXTAUTH_SECRET;\nif (!secret) throw new Error('NEXTAUTH_SECRET is required');\n",
    },
    expected: {
      readinessState: 'READY',
      findings: [],
      gate: 'READY',
      runtime: 'node',
      framework: 'next',
      port: 3000,
      database: 'postgres',
      redisRequired: false,
      healthPath: '/api/health',
      env: { DATABASE_URL: 'deployz_managed', NEXTAUTH_SECRET: 'deployz_generated' },
      unresolvedQuestions: [],
    },
  },
  {
    name: 'PostgreSQL app without a migration command',
    tree: {
      Dockerfile: nodeDockerfile(),
      'package.json': JSON.stringify({ name: 'pgapp', scripts: { start: 'node server.js' }, dependencies: { express: '^4', pg: '^8' } }),
      'server.js': "const { Pool } = require('pg');\nconst pool = new Pool({ connectionString: process.env.DATABASE_URL });\nrequire('express')().get('/health', (_q, r) => r.send('ok')).listen(3000);\n",
      '.env.example': 'DATABASE_URL=postgresql://localhost:5432/app\n',
    },
    expected: {
      readinessState: 'READY',
      findings: ['database-migrations'],
      gate: 'READY',
      runtime: 'node',
      framework: 'express',
      port: 3000,
      database: 'postgres',
      redisRequired: false,
      healthPath: '/health',
      env: { DATABASE_URL: 'deployz_managed' },
      unresolvedQuestions: [],
    },
  },
  {
    name: 'Redis queue app (BullMQ)',
    tree: {
      Dockerfile: nodeDockerfile(),
      'package.json': JSON.stringify({ name: 'jobs', scripts: { start: 'node server.js' }, dependencies: { express: '^4', bullmq: '^5', pg: '^8' } }),
      'server.js': "require('express')().get('/health', (_q, r) => r.send('ok')).listen(3000);\n",
      'queue.js': "const { Queue } = require('bullmq');\nmodule.exports = new Queue('jobs', { connection: { url: process.env.REDIS_URL } });\n",
      '.env.example': 'DATABASE_URL=\nREDIS_URL=\n',
    },
    expected: {
      readinessState: 'READY',
      findings: ['database-migrations'],
      gate: 'READY',
      runtime: 'node',
      framework: 'express',
      port: 3000,
      database: 'postgres',
      redisRequired: true,
      healthPath: '/health',
      env: { DATABASE_URL: 'deployz_managed', REDIS_URL: 'deployz_managed' },
      unresolvedQuestions: [],
    },
  },
  {
    name: 'persistent local storage app (declared volume)',
    tree: {
      Dockerfile: nodeDockerfile(['VOLUME /app/uploads']),
      'package.json': JSON.stringify({ name: 'uploads', scripts: { start: 'node server.js' }, dependencies: { express: '^4' } }),
      'server.js': "require('express')().get('/health', (_q, r) => r.send('ok')).listen(3000);\n",
    },
    expected: {
      readinessState: 'ALMOST_READY',
      findings: ['local-file-storage'],
      gate: 'NOT_COMPATIBLE',
      runtime: 'node',
      framework: 'express',
      port: 3000,
      database: 'none',
      redisRequired: false,
      healthPath: '/health',
      env: {},
      unresolvedQuestions: [],
    },
  },
  {
    name: 'env-heavy SaaS (Stripe, SMTP, app secrets, optional flags)',
    tree: {
      Dockerfile: nodeDockerfile(),
      'package.json': JSON.stringify({
        name: 'saas',
        scripts: { start: 'node server.js', 'db:migrate': 'npx drizzle-kit push' },
        dependencies: { express: '^4', pg: '^8', stripe: '^12', nodemailer: '^6' },
      }),
      'server.js': [
        "const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);",
        "const mailer = require('nodemailer').createTransport({ host: process.env.SMTP_HOST, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });",
        'const sessionSecret = process.env.SESSION_SECRET;',
        "const level = process.env.LOG_LEVEL || 'info';",
        "require('express')().get('/health', (_q, r) => r.send(String(!!(stripe && mailer && sessionSecret && level)))).listen(3000);",
      ].join('\n'),
      '.env.example': 'DATABASE_URL=\nSTRIPE_SECRET_KEY=\nSMTP_HOST=\nSMTP_USER=\nSMTP_PASS=\nSESSION_SECRET=\nLOG_LEVEL=info\nFEATURE_BETA=\n',
    },
    expected: {
      readinessState: 'READY',
      findings: [],
      gate: 'NEEDS_CONFIGURATION',
      runtime: 'node',
      framework: 'express',
      port: 3000,
      database: 'postgres',
      redisRequired: false,
      healthPath: '/health',
      env: {
        DATABASE_URL: 'deployz_managed',
        STRIPE_SECRET_KEY: 'customer_required',
        // A bare non-secret read stored as-is proves nothing about need
        // (Stage A COMP-023): the host and user are optional; the credential
        // stays required.
        SMTP_HOST: 'optional',
        SMTP_USER: 'optional',
        SMTP_PASS: 'customer_required',
        SESSION_SECRET: 'deployz_generated',
        LOG_LEVEL: 'optional',
        FEATURE_BETA: 'unknown',
      },
      unresolvedQuestions: [],
    },
  },
  {
    name: 'deliberately broken deployment configuration (no port, no start, localhost binding)',
    tree: {
      Dockerfile: 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\n',
      'package.json': JSON.stringify({ name: 'broken', dependencies: { express: '^4' } }),
      'src/index.js': "require('express')().get('/health', (_q, r) => r.send('ok')).listen(8080, '127.0.0.1');\n",
    },
    expected: {
      readinessState: 'ALMOST_READY',
      findings: ['port-unresolved', 'start-command-missing', 'localhost-binding'],
      gate: 'NEEDS_CONFIGURATION',
      runtime: 'node',
      framework: 'express',
      port: null,
      database: 'none',
      redisRequired: false,
      healthPath: '/health',
      env: {},
      unresolvedQuestions: ['start-command-unknown'],
    },
  },
  {
    // Phase 4B: a bare mysql2 dependency with NO connection evidence is
    // weak — the app deploys without a database and raises the
    // database-requirement question, instead of being unsupported.
    name: 'weak MySQL dependency without connection evidence (needs input)',
    tree: {
      Dockerfile: nodeDockerfile(),
      'package.json': JSON.stringify({ name: 'legacy', scripts: { start: 'node server.js' }, dependencies: { express: '^4', mysql2: '^3' } }),
      'server.js': "require('express')().get('/health', (_q, r) => r.send('ok')).listen(3000);\n",
    },
    expected: {
      readinessState: 'READY',
      findings: [],
      gate: 'READY',
      runtime: 'node',
      framework: 'express',
      port: 3000,
      database: 'none',
      redisRequired: false,
      healthPath: '/health',
      env: {},
      unresolvedQuestions: ['database-requirement-unclear'],
    },
  },
  {
    name: 'ambiguous repository (no container setup, no start script)',
    tree: {
      'package.json': JSON.stringify({ name: 'mystery', dependencies: { koa: '^2' } }),
      'src/app.ts': "import Koa from 'koa';\nexport const app = new Koa();\n",
      'README.md': '# mystery\n',
    },
    expected: {
      readinessState: 'ALMOST_READY',
      findings: ['container-setup', 'health-check'],
      gate: 'NEEDS_CONFIGURATION',
      runtime: 'node',
      framework: 'koa',
      port: null,
      database: 'none',
      redisRequired: false,
      healthPath: null,
      env: {},
      unresolvedQuestions: ['start-command-unknown', 'port-unknown'],
    },
  },
];

describe('MVP analysis evaluation corpus', () => {
  for (const { name, tree, expected } of corpus) {
    it(name, () => {
      const analysis = analyseRepo(tree);
      const report = buildReadinessReport(analysis);
      const detected = buildApplicationAnalysis(analysis, CONTEXT);
      const manifest = normalizeDeploymentManifest(analysis, {});
      const gate = evaluateManifestReadiness(manifest, { providedEnvKeys: [] });

      // Verdict and findings: exact — no invented blockers, none missing.
      expect(report.state).toBe(expected.readinessState);
      expect(report.findings.map((finding) => finding.id).sort()).toEqual([...expected.findings].sort());
      expect(gate.state).toBe(expected.gate);

      // Detected facts.
      expect(detected.runtime.value).toBe(expected.runtime);
      expect(detected.framework.value).toBe(expected.framework);
      expect(detected.network.port.value).toBe(expected.port);
      expect(detected.database.type).toBe(expected.database);
      expect(detected.redis.required).toBe(expected.redisRequired);
      expect(detected.healthCheck.path).toBe(expected.healthPath);

      // Evidence is present for every detected fact and never dumps source.
      for (const fact of [detected.runtime, detected.framework, detected.start, detected.network.port]) {
        if (fact.value !== null && fact.value !== 'unknown') expect(fact.evidence.length).toBeGreaterThan(0);
        for (const evidence of fact.evidence) expect(evidence.reason.length).toBeLessThan(400);
      }

      // Environment classification.
      const classified = Object.fromEntries(detected.environmentVariables.map((v) => [v.key, v.classification]));
      expect(classified).toEqual(expected.env);

      // Which questions the AI fallback would be asked (none for a clear repo).
      expect(collectUnresolvedQuestions(tree, analysis)).toEqual(expected.unresolvedQuestions);
    });
  }
});
