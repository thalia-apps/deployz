import { describe, expect, it } from 'vitest';

import {
  detectDockerfile,
  detectFramework,
  detectPort,
  detectHealthEndpoint,
  detectEnvVars,
  detectPostgresql,
  assessPostgres,
  detectLocalFilesystem,
  detectWorker,
  detectS3,
  detectMigrationCommand,
  detectPackageManager,
  detectBuildCommand,
  detectDockerfileBuildContext,
  detectDockerfileBuildTarget,
  detectGitCopyInDockerfile,
  type FileTree,
  type DetectorFinding,
} from '../src/detectors.js';

import {
  checkRedisUnsupported,
  checkMysql,
  checkMongo,
  checkElasticsearch,
  checkOtherUnsupportedDatabases,
  type RejectionFinding,
} from '../src/rejection.js';

import { analyseRepo, type AnalysisResult } from '../src/analyser.js';

// ==========================================================================
// Corpus fixtures (inline file trees — no real files on disk)
// ==========================================================================

/** The "ideal" compatible app: Express + Dockerfile + /health + PostgreSQL + env vars + migration. */
const compatibleFixture: FileTree = {
  'Dockerfile': [
    'FROM node:20-alpine',
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN npm ci --omit=dev',
    'COPY . .',
    'EXPOSE 3000',
    'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
    'CMD ["node", "dist/index.js"]',
  ].join('\n'),
  'package.json': JSON.stringify({
    name: 'my-app',
    scripts: {
      start: 'node dist/index.js',
      'db:migrate': 'npx drizzle-kit push',
    },
    dependencies: {
      express: '^4.18.0',
      pg: '^8.12.0',
      'drizzle-orm': '^0.36.0',
    },
  }),
  '.env.example': 'PORT=3000\nDATABASE_URL=postgresql://localhost:5432/mydb\n',
  'src/index.ts': [
    "import express from 'express';",
    '',
    'const app = express();',
    'const PORT = process.env.PORT ?? 3000;',
    '',
    "app.get('/health', (_req, res) => {",
    "  res.json({ status: 'ok' });",
    '});',
    '',
    `app.listen(PORT, () => console.log(\`listening on \${PORT}\`));`,
  ].join('\n'),
};

/** Compatible fixture that uses Prisma with PostgreSQL provider. */
const compatiblePrismaFixture: FileTree = {
  'Dockerfile': 'FROM node:20-alpine\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n',
  'package.json': JSON.stringify({
    scripts: {
      start: 'node dist/index.js',
      migrate: 'npx prisma migrate deploy',
    },
    dependencies: {
      express: '^4.18.0',
      '@prisma/client': '^5.0.0',
    },
    devDependencies: {
      prisma: '^5.0.0',
    },
  }),
  'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
  '.env': 'PORT=4000\nDATABASE_URL=postgresql://localhost:5432/prisma_db\n',
  'src/index.ts': "import express from 'express';\nconst app = express();\napp.get('/health', (_req, res) => res.json({ ok: true }));\napp.listen(4000);\n",
};

/** Fastify-based compatible fixture. */
const compatibleFastifyFixture: FileTree = {
  'Dockerfile': 'FROM node:20-alpine\nEXPOSE 3000\nCMD ["node", "server.js"]\n',
  'package.json': JSON.stringify({
    scripts: { start: 'node server.js', migrate: 'npx knex migrate:latest' },
    dependencies: { fastify: '^5.0.0', pg: '^8.12.0', knex: '^3.0.0' },
  }),
  '.env.example': 'PORT=3000\nDATABASE_URL=postgresql://localhost/mydb\nAWS_S3_BUCKET=my-bucket\n',
  'server.js': [
    "const fastify = require('fastify')();",
    "fastify.get('/health', async () => ({ status: 'ok' }));",
    "fastify.listen({ port: process.env.PORT ?? 3000 });",
  ].join('\n'),
};

/** Plain Redis client dependency — SUPPORTED (medium confidence alone; does not reject). */
const incompatibleRedisFixture: FileTree = {
  ...compatibleFixture,
  'package.json': JSON.stringify({
    name: 'my-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: {
      express: '^4.18.0',
      pg: '^8.12.0',
      'drizzle-orm': '^0.36.0',
      ioredis: '^5.4.0',
    },
  }),
};

/** Unsupported Redis: Redis Stack modules (@redis/json) — this DOES reject. */
const unsupportedRedisFixture: FileTree = {
  ...compatibleFixture,
  'package.json': JSON.stringify({
    name: 'my-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: {
      express: '^4.18.0',
      pg: '^8.12.0',
      'drizzle-orm': '^0.36.0',
      ioredis: '^5.4.0',
      '@redis/json': '^1.0.0',
    },
  }),
};

/** bullmq direct dependency — high-confidence signal, Redis required. */
const bullmqFixture: FileTree = {
  ...compatibleFixture,
  'package.json': JSON.stringify({
    name: 'my-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: {
      express: '^4.18.0',
      pg: '^8.12.0',
      'drizzle-orm': '^0.36.0',
      bullmq: '^5.0.0',
    },
  }),
};

/** Incompatible: MongoDB dependency with the app's own data model on it. */
const incompatibleMongoFixture: FileTree = {
  ...compatibleFixture,
  'src/models/user.js': 'const mongoose = require("mongoose");\nmodule.exports = mongoose.model("User", new mongoose.Schema({ name: String }));\n',
  'package.json': JSON.stringify({
    name: 'my-app',
    scripts: { start: 'node dist/index.js' },
    dependencies: {
      express: '^4.18.0',
      mongoose: '^8.0.0',
    },
  }),
};

/** Incompatible: MySQL dependency. */
const incompatibleMysqlFixture: FileTree = {
  ...compatibleFixture,
  'package.json': JSON.stringify({
    name: 'my-app',
    scripts: { start: 'node dist/index.js', migrate: 'npx prisma migrate deploy' },
    dependencies: {
      express: '^4.18.0',
      mysql2: '^3.9.0',
    },
  }),
};

/** Incompatible: a declared upload volume with no object-storage alternative. */
const incompatibleLocalFsFixture: FileTree = {
  ...compatibleFixture,
  'Dockerfile': 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 3000\nHEALTHCHECK CMD curl -f http://localhost:3000/health\nVOLUME /app/uploads\nCMD ["node", "dist/index.js"]\n',
  'src/uploader.ts': [
    "import fs from 'fs';",
    '',
    'export function saveFile(buffer: Buffer, path: string) {',
    '  fs.writeFileSync(path, buffer);',
    '}',
    '',
    'export function readFile(path: string): Buffer {',
    '  return fs.readFileSync(path);',
    '}',
    '',
    'export function ensureDir(dir: string) {',
    '  fs.mkdirSync(dir, { recursive: true });',
    '}',
  ].join('\n'),
};

/** Missing Dockerfile. */
const noDockerfileFixture: FileTree = {
  ...compatibleFixture,
};
delete noDockerfileFixture['Dockerfile'];

/** No health endpoint — no HEALTHCHECK instruction, no /health route. */
const noHealthFixture: FileTree = {
  ...compatibleFixture,
  'Dockerfile': [
    'FROM node:20-alpine',
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN npm ci --omit=dev',
    'COPY . .',
    'EXPOSE 3000',
    'CMD ["node", "dist/index.js"]',
  ].join('\n'),
  'src/index.ts': [
    "import express from 'express';",
    '',
    'const app = express();',
    "app.get('/', (_req, res) => res.send('Hello'));",
    'app.listen(3000);',
  ].join('\n'),
};

/** S3-using fixture (with aws-sdk). */
const s3Fixture: FileTree = {
  ...compatibleFixture,
  'package.json': JSON.stringify({
    name: 'my-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: {
      express: '^4.18.0',
      pg: '^8.12.0',
      'drizzle-orm': '^0.36.0',
      '@aws-sdk/client-s3': '^3.500.0',
    },
  }),
  '.env.example': 'PORT=3000\nAWS_S3_BUCKET=my-bucket\nAWS_REGION=us-east-1\n',
};

/** Worker fixture. */
const workerFixture: FileTree = {
  ...compatibleFixture,
  'package.json': JSON.stringify({
    name: 'my-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: {
      express: '^4.18.0',
      pg: '^8.12.0',
      'drizzle-orm': '^0.36.0',
      bull: '^4.12.0',
    },
  }),
};

/** Empty repo — just a README. */
const emptyRepoFixture: FileTree = {
  'README.md': '# My App\n\nHello world.\n',
};

/** Docker-compose fixture. */
const dockerComposeFixture: FileTree = {
  ...compatibleFixture,
  'docker-compose.yml': [
    'version: "3.8"',
    'services:',
    '  app:',
    '    build: .',
    '    ports:',
    '      - "${PORT:-3000}:3000"',
    '    environment:',
    '      - DATABASE_URL=postgresql://db:5432/app',
    '      - REDIS_URL=redis://redis:6379',
  ].join('\n'),
};

/** Prisma with MySQL provider (unsupported). */
const prismaMysqlFixture: FileTree = {
  'Dockerfile': 'FROM node:20-alpine\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n',
  'package.json': JSON.stringify({
    scripts: { start: 'node dist/index.js', migrate: 'npx prisma migrate deploy' },
    dependencies: { express: '^4.18.0', '@prisma/client': '^5.0.0' },
    devDependencies: { prisma: '^5.0.0' },
  }),
  'prisma/schema.prisma': 'datasource db {\n  provider = "mysql"\n  url = env("DATABASE_URL")\n}\n',
  'src/index.ts': "import express from 'express'; const app = express(); app.get('/health', (_req, res) => res.json({ ok: true })); app.listen(3000);\n",
};

/** NestJS fixture. */
const nestFixture: FileTree = {
  'Dockerfile': 'FROM node:20-alpine\nEXPOSE 3000\nCMD ["node", "dist/main.js"]\n',
  'package.json': JSON.stringify({
    scripts: {
      start: 'node dist/main.js',
      'typeorm:migrate': 'npx typeorm migration:run',
    },
    dependencies: {
      '@nestjs/core': '^10.0.0',
      '@nestjs/platform-express': '^10.0.0',
      pg: '^8.12.0',
      typeorm: '^0.3.0',
    },
  }),
  '.env': 'PORT=3000\nDB_URL=postgresql://localhost/app\n',
  'src/main.ts': [
    "import { NestFactory } from '@nestjs/core';",
    "import { AppModule } from './app.module';",
    '',
    'async function bootstrap() {',
    '  const app = await NestFactory.create(AppModule);',
    "  app.getHttpAdapter().get('/health', (_req, res) => res.json({ status: 'ok' }));",
    '  await app.listen(process.env.PORT ?? 3000);',
    '}',
    'bootstrap();',
  ].join('\n'),
};

// ==========================================================================
// §18 Detectors
// ==========================================================================

describe('§18 detectors', () => {
  // ------------------------------------------------------------------
  // 1. Dockerfile detector
  // ------------------------------------------------------------------
  describe('detectDockerfile', () => {
    it('detects a standard Dockerfile', () => {
      const result = detectDockerfile(compatibleFixture);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('Dockerfile');
    });

    it('detects Dockerfile.prod (case-insensitive)', () => {
      const tree: FileTree = { 'dockerfile': 'FROM node:20\n' };
      const result = detectDockerfile(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('dockerfile');
    });

    it('detects a Dockerfile outside the repository root', () => {
      const tree: FileTree = { 'docker/Dockerfile': 'FROM node:20\n' };
      const result = detectDockerfile(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('docker/Dockerfile');
    });

    it('detects a suffixed Dockerfile in a workspace package', () => {
      const tree: FileTree = { 'apps/web/Dockerfile.pnpm': 'FROM node:20\n' };
      const result = detectDockerfile(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('apps/web/Dockerfile.pnpm');
    });

    it('returns false when no Dockerfile exists', () => {
      const result = detectDockerfile(noDockerfileFixture);
      expect(result.detected).toBe(false);
    });

    it('returns false for an empty repo', () => {
      const result = detectDockerfile(emptyRepoFixture);
      expect(result.detected).toBe(false);
    });

    it('prefers the shallower root Dockerfile over a nested dev-service Dockerfile', () => {
      const tree: FileTree = {
        'docker/development/Dockerfile.gotenberg': 'FROM alpine\n',
        'docker/Dockerfile': 'FROM node:20\n',
      };
      const result = detectDockerfile(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('docker/Dockerfile');
    });

    it('detects a single Dockerfile outside the root unchanged', () => {
      const tree: FileTree = { 'backend/Dockerfile': 'FROM node:20\n' };
      const result = detectDockerfile(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('backend/Dockerfile');
    });

    it('prefers the repository root Dockerfile over a nested one', () => {
      const tree: FileTree = {
        'docker/Dockerfile': 'FROM node:20\n',
        'Dockerfile': 'FROM node:20\n',
      };
      const result = detectDockerfile(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('Dockerfile');
    });

    it('prefers an exact Dockerfile name over a suffixed variant at the same depth', () => {
      const tree: FileTree = {
        'a/Dockerfile.server': 'FROM node:20\n',
        'a/Dockerfile': 'FROM node:20\n',
      };
      const result = detectDockerfile(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('a/Dockerfile');
    });

    it('prefers a production-named Dockerfile over a plain one at the same depth', () => {
      const tree: FileTree = {
        'Dockerfile': 'FROM node:20\n',
        'Dockerfile.production': 'FROM node:20\n',
      };
      expect(detectDockerfile(tree).value).toBe('Dockerfile.production');
    });
  });

  // ------------------------------------------------------------------
  // 2. Framework detector
  // ------------------------------------------------------------------
  describe('detectFramework', () => {
    it('detects Express', () => {
      const result = detectFramework(compatibleFixture);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('express');
    });

    it('detects Fastify', () => {
      const result = detectFramework(compatibleFastifyFixture);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('fastify');
    });

    it('detects NestJS', () => {
      const result = detectFramework(nestFixture);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('@nestjs/core');
    });

    it('returns false when no framework is detected', () => {
      const tree: FileTree = { 'package.json': JSON.stringify({ dependencies: {} }) };
      const result = detectFramework(tree);
      expect(result.detected).toBe(false);
    });

    it('returns false when there is no package.json', () => {
      const result = detectFramework(emptyRepoFixture);
      expect(result.detected).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // 3. Port detector
  // ------------------------------------------------------------------
  describe('detectPort', () => {
    it('detects PORT from .env.example', () => {
      const result = detectPort(compatibleFixture);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('3000');
    });

    it('detects PORT from .env', () => {
      const result = detectPort(compatiblePrismaFixture);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('4000');
    });

    it('detects PORT from docker-compose.yml', () => {
      const result = detectPort(dockerComposeFixture);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('3000');
    });

    it('detects PORT from process.env in source code when no env file', () => {
      const tree: FileTree = {
        'src/index.ts': 'const PORT = process.env.PORT || 8080;\n',
      };
      const result = detectPort(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('8080');
    });

    it('returns false when no PORT is found', () => {
      const result = detectPort(emptyRepoFixture);
      expect(result.detected).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // 4. Health endpoint detector
  // ------------------------------------------------------------------
  describe('detectHealthEndpoint', () => {
    it('detects Dockerfile HEALTHCHECK instruction', () => {
      const result = detectHealthEndpoint(compatibleFixture);
      expect(result.detected).toBe(true);
      expect((result.value as string[]).some((v: string) => v.includes('HEALTHCHECK'))).toBe(true);
    });

    it('detects Express /health route pattern', () => {
      // compatibleFixture has HEALTHCHECK AND /health route
      const result = detectHealthEndpoint(compatibleFixture);
      expect(result.detected).toBe(true);
      // Both patterns should be found
      expect((result.value as string[]).some((v: string) => v.includes('HEALTHCHECK'))).toBe(true);
      expect((result.value as string[]).some((v: string) => v.includes('/health'))).toBe(true);
    });

    it('detects Fastify health route', () => {
      const result = detectHealthEndpoint(compatibleFastifyFixture);
      expect(result.detected).toBe(true);
      expect((result.value as string[]).some((v: string) => v.includes('/health'))).toBe(true);
    });

    it('detects NestJS health adapter', () => {
      const result = detectHealthEndpoint(nestFixture);
      expect(result.detected).toBe(true);
    });

    it('detects a file-based health route', () => {
      // documenso shape: Remix flat-routes file under a monorepo app prefix.
      const tree: FileTree = { 'apps/remix/app/routes/api+/health.ts': 'export const loader = () => null;\n' };
      const result = detectHealthEndpoint(tree);
      expect(result.detected).toBe(true);
      expect((result.value as string[]).some((v: string) => v.includes('health route file'))).toBe(true);
      expect(result.path).toBe('/api/health');
    });

    it('normalizes a Remix v2 dot route to /api/health', () => {
      const tree: FileTree = { 'app/routes/api.health.ts': 'export const loader = () => null;\n' };
      const result = detectHealthEndpoint(tree);
      expect(result.detected).toBe(true);
      expect(result.path).toBe('/api/health');
    });

    it('normalizes a SvelteKit +server health route to /api/health', () => {
      const tree: FileTree = { 'src/routes/api/health/+server.ts': 'export const GET = () => null;\n' };
      const result = detectHealthEndpoint(tree);
      expect(result.detected).toBe(true);
      expect(result.path).toBe('/api/health');
    });

    it('drops a route group from a monorepo App Router health route path', () => {
      const tree: FileTree = {
        'apps/web/src/app/(internal)/api/healthz/route.ts': 'export function GET() {}\n',
      };
      const result = detectHealthEndpoint(tree);
      expect(result.detected).toBe(true);
      expect(result.path).toBe('/api/healthz');
    });

    it('detects a bare file-based health route with no api segment', () => {
      const tree: FileTree = { 'app/routes/healthz.tsx': 'export const loader = () => null;\n' };
      const result = detectHealthEndpoint(tree);
      expect(result.detected).toBe(true);
      expect(result.path).toBe('/healthz');
    });

    it('detects an App Router health route folder and normalizes its path to /api/health', () => {
      const tree: FileTree = { 'app/api/health/route.ts': 'export function GET() {}\n' };
      const result = detectHealthEndpoint(tree);
      expect(result.detected).toBe(true);
      expect(result.path).toBe('/api/health');
    });

    it('normalizes a Pages Router health route file to /api/health', () => {
      const tree: FileTree = { 'pages/api/health.ts': 'export default function handler() {}\n' };
      const result = detectHealthEndpoint(tree);
      expect(result.detected).toBe(true);
      expect(result.path).toBe('/api/health');
    });

    it('detects a prefixed /api/health route registration and captures its literal path', () => {
      const tree: FileTree = {
        'src/server.ts': "app.get('/api/health', (_req, res) => res.json({ ok: true }));\n",
      };
      const result = detectHealthEndpoint(tree);
      expect(result.detected).toBe(true);
      expect(result.path).toBe('/api/health');
    });

    it('prefers a literal route registration over a same-repo file-based route path when both are present', () => {
      const tree: FileTree = {
        'app/api/health/route.ts': 'export function GET() {}\n',
        'src/legacy-server.ts': "app.get('/api/healthz', (_req, res) => res.json({ ok: true }));\n",
      };
      const result = detectHealthEndpoint(tree);
      expect(result.detected).toBe(true);
      expect(result.path).toBe('/api/healthz');
    });

    it('lets the selected Dockerfile HEALTHCHECK path outrank a route registration', () => {
      const tree: FileTree = {
        'Dockerfile': 'FROM node:20-alpine\nHEALTHCHECK CMD curl -f http://localhost:3000/health\n',
        'app/api/health/route.ts': 'export function GET() {}\n',
      };
      const result = detectHealthEndpoint(tree);
      expect(result.detected).toBe(true);
      expect(result.path).toBe('/health');
    });

    it('detects healthcheck script in package.json', () => {
      const tree: FileTree = {
        ...compatibleFixture,
        'package.json': JSON.stringify({
          scripts: { 'healthcheck': 'curl -f http://localhost:3000/health' },
          dependencies: { express: '^4.18.0' },
        }),
      };
      const result = detectHealthEndpoint(tree);
      expect(result.detected).toBe(true);
      expect((result.value as string[]).some((v: string) => v.includes('healthcheck'))).toBe(true);
    });

    it('returns false when no health endpoint is found', () => {
      const result = detectHealthEndpoint(noHealthFixture);
      expect(result.detected).toBe(false);
    });

    it('defaults to /health when only a Dockerfile HEALTHCHECK (no literal route) is present', () => {
      const tree: FileTree = {
        'Dockerfile': 'FROM node:20-alpine\nHEALTHCHECK CMD curl -f http://localhost:3000/health\n',
      };
      const result = detectHealthEndpoint(tree);
      expect(result.detected).toBe(true);
      expect(result.path).toBe('/health');
    });

    it('composes a router /health mounted at /api into /api/health', () => {
      const tree: FileTree = {
        'src/server.ts': "import { healthRouter } from './routes/health';\napp.use('/api', healthRouter);\n",
        'src/routes/health.ts':
          "import { Router } from 'express';\nconst healthRouter = Router();\nhealthRouter.get('/health', (_req, res) => res.json({ ok: true }));\n",
      };
      const result = detectHealthEndpoint(tree);
      expect(result.detected).toBe(true);
      expect(result.path).toBe('/api/health');
    });

    it('composes a nested mount chain into its full path', () => {
      const tree: FileTree = {
        'src/app.ts': "import { apiRouter } from './routes/api';\napp.use('/api', apiRouter);\n",
        'src/routes/api.ts': "import { v1Router } from './v1';\napiRouter.use('/v1', v1Router);\n",
        'src/routes/v1.ts': "v1Router.get('/health', (_req, res) => res.json({ ok: true }));\n",
      };
      const result = detectHealthEndpoint(tree);
      expect(result.detected).toBe(true);
      expect(result.path).toBe('/api/v1/health');
    });

    it('prefers the mounted route over a stale direct /health registration', () => {
      const tree: FileTree = {
        'src/server.ts': "app.use('/api', healthRouter);\napp.get('/health', (_req, res) => res.json({ ok: true }));\n",
        'src/routes/health.ts': "healthRouter.get('/health', (_req, res) => res.json({ ok: true }));\n",
      };
      const result = detectHealthEndpoint(tree);
      expect(result.detected).toBe(true);
      expect(result.path).toBe('/api/health');
    });

    it('keeps the raw route path when the receiver has no mount anywhere', () => {
      const tree: FileTree = {
        'src/routes/health.ts': "healthRouter.get('/health', (_req, res) => res.json({ ok: true }));\n",
      };
      const result = detectHealthEndpoint(tree);
      expect(result.detected).toBe(true);
      expect(result.path).toBe('/health');
    });
  });

  // ------------------------------------------------------------------
  // 5. Env vars detector
  // ------------------------------------------------------------------
  describe('detectEnvVars', () => {
    it('detects env vars from .env.example', () => {
      const result = detectEnvVars(compatibleFixture);
      expect(result.detected).toBe(true);
      const vars = result.value as string[];
      expect(vars).toContain('PORT');
      expect(vars).toContain('DATABASE_URL');
    });

    it('detects env vars from process.env references in source code', () => {
      const tree: FileTree = {
        'src/index.ts': 'if (process.env.NODE_ENV === "production") {\n  console.log(process.env.SECRET_KEY);\n}\n',
      };
      const result = detectEnvVars(tree);
      expect(result.detected).toBe(true);
      const vars = result.value as string[];
      expect(vars).toContain('NODE_ENV');
      expect(vars).toContain('SECRET_KEY');
    });

    it('detects env vars read through a local env object, but not import.meta.env (DEPLOY-005)', () => {
      const tree: FileTree = {
        'api/src/database/index.ts': [
          "import { useEnv } from '@directus/env';",
          'const env = useEnv();',
          "if (!env['DB_CONNECT_STRING']) required.push('DB_HOST');",
          'const schema = env.DB_DATABASE;',
          '',
        ].join('\n'),
        'app/src/main.ts': 'const api = import.meta.env.VITE_API_URL;\nconst mode = env.MODE;\n',
      };
      const result = detectEnvVars(tree);
      const vars = result.value as string[];
      expect(vars).toContain('DB_CONNECT_STRING');
      expect(vars).toContain('DB_DATABASE');
      // A module without a local env object contributes nothing from `env.X`.
      expect(vars).not.toContain('VITE_API_URL');
      expect(vars).not.toContain('MODE');
    });

    it('detects env vars from docker-compose.yml', () => {
      const result = detectEnvVars(dockerComposeFixture);
      expect(result.detected).toBe(true);
      const vars = result.value as string[];
      expect(vars).toContain('DATABASE_URL');
      expect(vars).toContain('PORT');
    });

    it('deduplicates env vars found in multiple sources', () => {
      // PORT appears in both .env.example AND src/index.ts
      const result = detectEnvVars(compatibleFixture);
      const vars = result.value as string[];
      const portCount = vars.filter((v) => v === 'PORT').length;
      expect(portCount).toBe(1);
    });

    it('returns false when no env vars found', () => {
      const result = detectEnvVars(emptyRepoFixture);
      expect(result.detected).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // 6. PostgreSQL detector
  // ------------------------------------------------------------------
  describe('detectPostgresql', () => {
    it('detects pg dependency', () => {
      const result = detectPostgresql(compatibleFixture);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('pg');
    });

    it('detects drizzle-orm with pg', () => {
      const result = detectPostgresql(compatibleFixture);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('drizzle-orm');
    });

    it('detects @prisma/client with postgresql provider', () => {
      const result = detectPostgresql(compatiblePrismaFixture);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('@prisma/client');
    });

    it('detects knex + pg combination', () => {
      const result = detectPostgresql(compatibleFastifyFixture);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('knex');
    });

    it('detects postgres dependency', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ dependencies: { postgres: '^3.4.0' } }),
      };
      const result = detectPostgresql(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('postgres');
    });

    it('returns false when no PostgreSQL driver found', () => {
      const result = detectPostgresql(emptyRepoFixture);
      expect(result.detected).toBe(false);
    });

    it('returns false for Prisma with mysql provider', () => {
      const result = detectPostgresql(prismaMysqlFixture);
      expect(result.detected).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // 6b. PostgreSQL required-vs-present evidence
  // ------------------------------------------------------------------
  describe('assessPostgres', () => {
    it('requires postgres when a driver dependency AND a DATABASE_URL reference are both present', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ dependencies: { pg: '^8.12.0' } }),
        '.env.example': 'DATABASE_URL=postgresql://localhost:5432/mydb\n',
      };
      const result = assessPostgres(tree);
      expect(result.required).toBe(true);
      expect(result.evidence).toHaveLength(2);
      expect(result.evidence.some((e) => e.includes('pg dependency'))).toBe(true);
      expect(result.evidence.some((e) => e.includes('DATABASE_URL'))).toBe(true);
    });

    it('does NOT require postgres from a bare driver dependency alone', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ dependencies: { pg: '^8.12.0' } }),
      };
      const result = assessPostgres(tree);
      expect(result.required).toBe(false);
      expect(result.evidence).toHaveLength(1);
    });

    it('requires postgres when Prisma declares a postgresql provider', () => {
      const result = assessPostgres(compatiblePrismaFixture);
      expect(result.required).toBe(true);
    });

    it('does not require postgres, with no evidence, when there is no PostgreSQL usage — and the repo stays a valid, READY-capable analysis', () => {
      const noDatabaseFixture: FileTree = {
        'Dockerfile': compatibleFixture['Dockerfile']!,
        'package.json': JSON.stringify({
          name: 'no-db-app',
          scripts: { start: 'node dist/index.js' },
          dependencies: { express: '^4.18.0' },
        }),
        'src/index.ts': compatibleFixture['src/index.ts']!,
      };

      const result = assessPostgres(noDatabaseFixture);
      expect(result.required).toBe(false);
      expect(result.evidence).toEqual([]);

      const analysis = analyseRepo(noDatabaseFixture);
      expect(analysis.metadata.postgres).toEqual({ required: false, evidence: [] });
      expect(analysis.rejections.filter((r) => r.detected)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------
  // 7. Local filesystem detector
  // ------------------------------------------------------------------
  describe('detectLocalFilesystem', () => {
    it('detects a Dockerfile VOLUME', () => {
      const result = detectLocalFilesystem(incompatibleLocalFsFixture);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('VOLUME /app/uploads (Dockerfile)');
    });

    it('ignores reads — a read is not persistent local storage', () => {
      const tree: FileTree = {
        'src/template.ts': "import fs from 'fs';\nfs.readFileSync('./banner.txt');\n",
      };
      const result = detectLocalFilesystem(tree);
      expect(result.detected).toBe(false);
    });

    it('detects a Compose volume mounted into the application service', () => {
      const tree: FileTree = {
        'docker-compose.yml': 'services:\n  app:\n    build: .\n    volumes:\n      - ./data:/app/data\n  db:\n    image: postgres:16\n',
      };
      const result = detectLocalFilesystem(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('volume ./data:/app/data (docker-compose.yml app)');
    });

    it('ignores a write call with no declared volume', () => {
      const tree: FileTree = {
        'src/writer.ts': "import fs from 'fs';\nfs.writeFile('/tmp/data', 'x', () => {});\n",
      };
      const result = detectLocalFilesystem(tree);
      expect(result.detected).toBe(false);
    });

    it('returns false when no fs usage found', () => {
      const result = detectLocalFilesystem(compatibleFixture);
      expect(result.detected).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // 8. Worker detector
  // ------------------------------------------------------------------
  describe('detectWorker', () => {
    it('detects Bull dependency', () => {
      const result = detectWorker(workerFixture);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('bull');
    });

    it('detects worker_threads usage in source code', () => {
      const tree: FileTree = {
        'src/worker.ts': "import { Worker } from 'node:worker_threads';\nconst w = new Worker('./worker.js');\n",
      };
      const result = detectWorker(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('worker_threads');
    });

    it('detects Agenda dependency', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ dependencies: { agenda: '^5.0.0' } }),
      };
      const result = detectWorker(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('agenda');
    });

    it('returns false when no worker patterns found', () => {
      const result = detectWorker(compatibleFixture);
      expect(result.detected).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // 9. S3 detector
  // ------------------------------------------------------------------
  describe('detectS3', () => {
    it('detects @aws-sdk/client-s3 in package.json', () => {
      const result = detectS3(s3Fixture);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('@aws-sdk/client-s3');
    });

    it('detects AWS_S3_BUCKET env var', () => {
      const result = detectS3(s3Fixture);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('AWS_S3_BUCKET');
    });

    it('detects S3_BUCKET env var', () => {
      const tree: FileTree = {
        '.env': 'S3_BUCKET=my-bucket\n',
      };
      const result = detectS3(tree);
      expect(result.detected).toBe(true);
    });

    it('returns false when no S3 usage found', () => {
      const result = detectS3(compatibleFixture);
      expect(result.detected).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // 10. Migration command detector
  // ------------------------------------------------------------------
  describe('detectMigrationCommand', () => {
    it('detects drizzle-kit migrate command in package.json scripts', () => {
      const result = detectMigrationCommand(compatibleFixture);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('drizzle-kit');
    });

    it('detects prisma migrate deploy', () => {
      const result = detectMigrationCommand(compatiblePrismaFixture);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('prisma migrate');
    });

    it('detects a migration command in a workspace package manifest', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({
          name: 'monorepo-root',
          scripts: { 'prisma:migrate-deploy': 'npm run -w @app/prisma prisma:migrate-deploy' },
        }),
        'packages/prisma/package.json': JSON.stringify({
          name: '@app/prisma',
          scripts: { 'prisma:migrate-deploy': 'prisma migrate deploy' },
        }),
      };
      const result = detectMigrationCommand(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('prisma migrate');
    });

    it('detects knex migrate:latest', () => {
      const result = detectMigrationCommand(compatibleFastifyFixture);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('knex migrate:latest');
    });

    it('detects typeorm migration:run', () => {
      const result = detectMigrationCommand(nestFixture);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('typeorm migration:run');
    });

    it('returns false when no migration scripts found', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ scripts: { start: 'node index.js' } }),
      };
      const result = detectMigrationCommand(tree);
      expect(result.detected).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // 11. Package manager detector
  // ------------------------------------------------------------------
  describe('detectPackageManager', () => {
    it('detects pnpm from a root pnpm-lock.yaml', () => {
      const tree: FileTree = { 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n' };
      const result = detectPackageManager(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('pnpm');
    });

    it('detects yarn from a root yarn.lock', () => {
      const tree: FileTree = { 'yarn.lock': '# yarn lockfile v1\n' };
      const result = detectPackageManager(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('yarn');
    });

    it('detects bun from a root bun.lockb', () => {
      const tree: FileTree = { 'bun.lockb': '' };
      const result = detectPackageManager(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('bun');
    });

    it('detects npm from a root package-lock.json', () => {
      const tree: FileTree = { 'package-lock.json': '{}' };
      const result = detectPackageManager(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('npm');
    });

    it('returns false when no lockfile or packageManager field is present', () => {
      const result = detectPackageManager(emptyRepoFixture);
      expect(result.detected).toBe(false);
      expect(result.value).toBeUndefined();
    });

    it('prefers the root package.json "packageManager" field over a present lockfile', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
        'package-lock.json': '{}',
      };
      const result = detectPackageManager(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('pnpm');
    });

    it('detects a lockfile nested inside a workspace package', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ name: 'monorepo-root', workspaces: ['apps/*'] }),
        'apps/api/pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
      };
      const result = detectPackageManager(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('pnpm');
    });
  });

  // ------------------------------------------------------------------
  // 12. Build command detector
  // ------------------------------------------------------------------
  describe('detectBuildCommand', () => {
    it('detects a root "build" script', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ scripts: { build: 'next build' } }),
      };
      const result = detectBuildCommand(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('next build');
    });

    it('detects a "build" script in a workspace package manifest', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ name: 'monorepo-root', scripts: {} }),
        'apps/web/package.json': JSON.stringify({ name: '@app/web', scripts: { build: 'vite build' } }),
      };
      const result = detectBuildCommand(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('vite build');
    });

    it('returns false when no "build" script is found', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ scripts: { start: 'node index.js' } }),
      };
      const result = detectBuildCommand(tree);
      expect(result.detected).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // 13. Dockerfile git-copy detector (DEPLOY-031)
  // ------------------------------------------------------------------
  describe('detectGitCopyInDockerfile', () => {
    it('detects a pgweb-shaped multi-stage Dockerfile copying .git into the build stage', () => {
      const tree: FileTree = {
        'Dockerfile': [
          'FROM golang:1.21 AS build',
          'WORKDIR /build',
          'COPY . .',
          'COPY .git/ .',
          'RUN make build',
          '',
          'FROM alpine:3.19',
          'COPY --from=build /build/pgweb /usr/bin/pgweb',
          'CMD ["pgweb"]',
        ].join('\n'),
      };
      const result = detectGitCopyInDockerfile(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('COPY .git/ .');
    });

    it('detects a copy of a file inside .git, such as .git/HEAD for a version stamp', () => {
      const tree: FileTree = {
        'Dockerfile': ['FROM golang:1.22', 'COPY ./.git/HEAD .git/refs /tmp/git/', 'RUN make build', 'CMD ["./app"]'].join('\n'),
      };
      const result = detectGitCopyInDockerfile(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toContain('COPY ./.git/HEAD .git/refs /tmp/git/');
    });

    it('ignores .gitignore and .github, which only look like .git', () => {
      const tree: FileTree = {
        'Dockerfile': ['FROM node:20-alpine', 'COPY .gitignore .', 'COPY .github .github', 'CMD ["node", "index.js"]'].join('\n'),
      };
      const result = detectGitCopyInDockerfile(tree);
      expect(result.detected).toBe(false);
    });

    it('ignores a --from= copy of another stage\'s .git', () => {
      const tree: FileTree = {
        'Dockerfile': [
          'FROM golang:1.21 AS build',
          'RUN make build',
          '',
          'FROM alpine:3.19',
          'COPY --from=build /build/.git /out/.git',
          'CMD ["true"]',
        ].join('\n'),
      };
      const result = detectGitCopyInDockerfile(tree);
      expect(result.detected).toBe(false);
    });

    it('returns false with no Dockerfile', () => {
      const result = detectGitCopyInDockerfile({ 'package.json': '{}' });
      expect(result.detected).toBe(false);
    });
  });

  describe('detectDockerfileBuildContext', () => {
    it('reports the repository root for a turbo-prune Dockerfile under apps/web (rallly)', () => {
      const tree: FileTree = {
        'apps/web/Dockerfile': [
          'FROM node:24 AS builder',
          'COPY . .',
          'RUN turbo prune --scope=@rallly/web --docker',
          'FROM node:24 AS installer',
          'COPY --from=builder /app/out/full/ .',
          'COPY turbo.json turbo.json',
          'CMD ["./docker-start.sh"]',
        ].join('\n'),
      };
      const result = detectDockerfileBuildContext(tree);
      expect(result.detected).toBe(true);
      expect(result.value).toBe('.');
    });

    it('reports the root when a nested Dockerfile copies paths that include its own directory', () => {
      const tree: FileTree = {
        'services/api/Dockerfile': ['FROM node:20', 'COPY services/api/package.json ./', 'CMD ["node", "index.js"]'].join('\n'),
      };
      expect(detectDockerfileBuildContext(tree).detected).toBe(true);
    });

    it('leaves a nested Dockerfile written for its own directory alone', () => {
      const tree: FileTree = {
        'backend/Dockerfile': ['FROM python:3.12', 'COPY requirements.txt .', 'COPY . .', 'CMD ["python", "app.py"]'].join('\n'),
      };
      expect(detectDockerfileBuildContext(tree).detected).toBe(false);
    });

    it('ignores a root Dockerfile, a --from copy and a variable source', () => {
      expect(detectDockerfileBuildContext({ 'Dockerfile': ['FROM node:20', 'COPY turbo.json .', 'CMD ["node"]'].join('\n') }).detected).toBe(false);
      const tree: FileTree = {
        'apps/web/Dockerfile': ['FROM node:20', 'COPY --from=base /turbo.json ./', 'COPY $SRC_DIR ./', 'CMD ["node"]'].join('\n'),
      };
      expect(detectDockerfileBuildContext(tree).detected).toBe(false);
    });
  });

  describe('detectDockerfileBuildTarget', () => {
    const kuma = [
      'FROM node:22 AS build',
      'RUN npm ci && npm run build',
      'FROM node:22-slim AS release',
      'COPY --from=build /app /app',
      'EXPOSE 3001',
      'CMD ["node", "server/server.js"]',
      'FROM louislam/uptime-kuma:base2 AS upload-artifact',
      'RUN chmod +x /app/extra/upload-github-release-asset.sh',
    ].join('\n');

    it('names the application stage when the last stage is a tooling stage (uptime-kuma)', () => {
      const result = detectDockerfileBuildTarget({ 'docker/dockerfile': kuma });
      expect(result.detected).toBe(true);
      expect(result.value).toBe('release');
    });

    it('builds the last stage when it is the application or has a runtime name', () => {
      expect(detectDockerfileBuildTarget({ Dockerfile: ['FROM node:22 AS build', 'RUN x', 'FROM node:22-slim AS app', 'CMD ["node"]'].join('\n') }).detected).toBe(false);
      expect(detectDockerfileBuildTarget({ Dockerfile: ['FROM node:22 AS app', 'CMD ["node"]', 'FROM nginx:alpine', 'COPY --from=app /a /usr/share/nginx/html'].join('\n') }).detected).toBe(false);
    });
  });
});

// ==========================================================================
// §10 Rejection classes
// ==========================================================================

describe('§10 rejection classes', () => {
  // ------------------------------------------------------------------
  // 1. Redis
  // ------------------------------------------------------------------
  describe('checkRedisUnsupported', () => {
    it('does NOT reject a plain ioredis dependency (supported)', () => {
      const result = checkRedisUnsupported(incompatibleRedisFixture);
      expect(result.detected).toBe(false);
    });

    it('does NOT reject a plain redis dependency declared in a workspace package', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ name: 'monorepo-root', workspaces: ['packages/*'] }),
        'packages/queue/package.json': JSON.stringify({ dependencies: { ioredis: '^5.4.0' } }),
      };
      const result = checkRedisUnsupported(tree);
      expect(result.detected).toBe(false);
    });

    it('does NOT reject a plain redis dependency', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ dependencies: { redis: '^4.6.0' } }),
      };
      const result = checkRedisUnsupported(tree);
      expect(result.detected).toBe(false);
    });

    it('does NOT reject a plain @redis/client dependency', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ dependencies: { '@redis/client': '^1.5.0' } }),
      };
      const result = checkRedisUnsupported(tree);
      expect(result.detected).toBe(false);
    });

    it('rejects Redis Stack modules (e.g. @redis/json) with dependency "redis-unsupported"', () => {
      const result = checkRedisUnsupported(unsupportedRedisFixture);
      expect(result.detected).toBe(true);
      expect(result.dependency).toBe('redis-unsupported');
      expect(result.reason).toContain('Redis Stack');
    });

    it('rejects Redis Cluster usage with dependency "redis-unsupported"', () => {
      const tree: FileTree = {
        ...compatibleFixture,
        'package.json': JSON.stringify({
          dependencies: { express: '^4.18.0', pg: '^8.12.0', ioredis: '^5.4.0' },
        }),
        'src/cluster.ts': "import Redis from 'ioredis';\nconst cluster = new Redis.Cluster([{ host: 'a' }]);\n",
      };
      const result = checkRedisUnsupported(tree);
      expect(result.detected).toBe(true);
      expect(result.dependency).toBe('redis-unsupported');
      expect(result.reason).toContain('Cluster');
    });

    it('returns not detected for compatible fixture', () => {
      const result = checkRedisUnsupported(compatibleFixture);
      expect(result.detected).toBe(false);
    });

    it('returns not detected for empty repo', () => {
      const result = checkRedisUnsupported(emptyRepoFixture);
      expect(result.detected).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // 2. MySQL
  // ------------------------------------------------------------------
  describe('checkMysql', () => {
    it('no longer rejects a MySQL dependency — MySQL is a supported engine (Phase 4B)', () => {
      expect(checkMysql(incompatibleMysqlFixture).detected).toBe(false);
      const tree: FileTree = {
        'package.json': JSON.stringify({ dependencies: { mysql: '^2.18.0' } }),
      };
      expect(checkMysql(tree).detected).toBe(false);
    });

    it('no longer rejects Prisma with mysql provider', () => {
      expect(checkMysql(prismaMysqlFixture).detected).toBe(false);
    });

    it('still rejects a MariaDB-specific driver and a Laravel mariadb default', () => {
      const driver: FileTree = {
        'pom.xml': '<project><dependencies><dependency><groupId>org.mariadb.jdbc</groupId><artifactId>mariadb-java-client</artifactId></dependency></dependencies></project>',
      };
      const laravel: FileTree = {
        'config/database.php': "<?php return ['connections' => ['mysql' => ['driver' => 'mysql']]];\n",
        '.env.example': 'DB_CONNECTION=mariadb\n',
      };
      expect(checkMysql(driver).detected).toBe(true);
      expect(checkMysql(driver).dependency).toBe('mariadb');
      expect(checkMysql(laravel).detected).toBe(true);
      expect(checkMysql(laravel).dependency).toBe('mariadb');
    });

    it('does NOT flag Prisma with postgresql provider', () => {
      const result = checkMysql(compatiblePrismaFixture);
      expect(result.detected).toBe(false);
    });

    it('returns not detected for compatible fixture', () => {
      const result = checkMysql(compatibleFixture);
      expect(result.detected).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // 3. MongoDB
  // ------------------------------------------------------------------
  describe('checkMongo', () => {
    it('detects mongoose dependency', () => {
      const result = checkMongo(incompatibleMongoFixture);
      expect(result.detected).toBe(true);
      expect(result.dependency).toBe('mongoose');
    });

    it('detects mongodb dependency', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ dependencies: { mongodb: '^6.0.0' } }),
        'docker-compose.yml': 'services:\n  mongo:\n    image: mongo:7\n',
      };
      const result = checkMongo(tree);
      expect(result.detected).toBe(true);
      expect(result.dependency).toBe('mongodb');
    });

    it('returns not detected for compatible fixture', () => {
      const result = checkMongo(compatibleFixture);
      expect(result.detected).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // 4. Elasticsearch / OpenSearch
  // ------------------------------------------------------------------
  describe('checkElasticsearch', () => {
    it('detects @elastic/elasticsearch dependency', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ dependencies: { '@elastic/elasticsearch': '^8.0.0' } }),
        'docker-compose.yml': 'services:\n  elasticsearch:\n    image: elasticsearch:8.13.0\n',
      };
      const result = checkElasticsearch(tree);
      expect(result.detected).toBe(true);
      expect(result.dependency).toBe('@elastic/elasticsearch');
    });

    it('detects @opensearch-project/opensearch dependency', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ dependencies: { '@opensearch-project/opensearch': '^2.0.0' } }),
        'src/search.js':
          'const node = process.env.OPENSEARCH_URL;\nif (!node) throw new Error("OPENSEARCH_URL is required");\nconst client = new Client({ node });\n',
      };
      const result = checkElasticsearch(tree);
      expect(result.detected).toBe(true);
      expect(result.dependency).toBe('@opensearch-project/opensearch');
    });

    it('returns not detected for compatible fixture', () => {
      const result = checkElasticsearch(compatibleFixture);
      expect(result.detected).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // 5. Other unsupported databases
  // ------------------------------------------------------------------
  describe('checkOtherUnsupportedDatabases', () => {
    it('detects cassandra-driver dependency', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ dependencies: { 'cassandra-driver': '^4.7.0' } }),
        'docker-compose.yml': 'services:\n  cassandra:\n    image: cassandra:4\n',
      };
      const result = checkOtherUnsupportedDatabases(tree);
      expect(result.detected).toBe(true);
      expect(result.dependency).toBe('cassandra-driver');
    });

    it('detects neo4j-driver dependency', () => {
      const tree: FileTree = {
        'package.json': JSON.stringify({ dependencies: { 'neo4j-driver': '^5.0.0' } }),
        'src/graph.js': 'const driver = neo4j.driver(process.env.NEO4J_URI, auth);\n',
      };
      const result = checkOtherUnsupportedDatabases(tree);
      expect(result.detected).toBe(true);
      expect(result.dependency).toBe('neo4j-driver');
    });

    it('returns not detected for compatible fixture', () => {
      const result = checkOtherUnsupportedDatabases(compatibleFixture);
      expect(result.detected).toBe(false);
    });
  });
});

// ==========================================================================
// Analyser integration
// ==========================================================================

describe('analyseRepo (orchestrator)', () => {
  it('runs all detectors on the compatible fixture', () => {
    const result = analyseRepo(compatibleFixture);
    expect(result.findings).toBeDefined();
    expect(result.findings.length).toBeGreaterThan(0);

    // Dockerfile detected
    const dockerFinding = result.findings.find((f) => f.detector === 'dockerfile');
    expect(dockerFinding?.detected).toBe(true);

    // Framework detected
    const frameworkFinding = result.findings.find((f) => f.detector === 'framework');
    expect(frameworkFinding?.detected).toBe(true);

    // Port detected
    const portFinding = result.findings.find((f) => f.detector === 'port');
    expect(portFinding?.detected).toBe(true);

    // Health endpoint detected
    const healthFinding = result.findings.find((f) => f.detector === 'health-endpoint');
    expect(healthFinding?.detected).toBe(true);

    // PostgreSQL detected
    const pgFinding = result.findings.find((f) => f.detector === 'postgresql');
    expect(pgFinding?.detected).toBe(true);

    // Migration command detected
    const migrationFinding = result.findings.find((f) => f.detector === 'migration-command');
    expect(migrationFinding?.detected).toBe(true);
  });

  it('runs all rejection checks on the compatible fixture', () => {
    const result = analyseRepo(compatibleFixture);
    expect(result.rejections).toBeDefined();
    expect(result.rejections.length).toBeGreaterThan(0);

    // No rejections for compatible fixture
    const detectedRejections = result.rejections.filter((r) => r.detected);
    expect(detectedRejections).toHaveLength(0);
  });

  it('does NOT reject a plain Redis dependency (supported)', () => {
    const result = analyseRepo(incompatibleRedisFixture);
    const redisRejection = result.rejections.find((r) => r.dependency === 'redis-unsupported');
    expect(redisRejection?.detected).toBe(false);
  });

  it('rejects an unsupported Redis setup (Redis Stack modules)', () => {
    const result = analyseRepo(unsupportedRedisFixture);
    const redisRejection = result.rejections.find((r) => r.dependency === 'redis-unsupported');
    expect(redisRejection?.detected).toBe(true);
  });

  it('detects Redis via bullmq and marks it required in metadata', () => {
    const result = analyseRepo(bullmqFixture);
    const redisFinding = result.findings.find((f) => f.detector === 'redis');
    expect(redisFinding?.detected).toBe(true);
    expect(redisFinding?.value).toContain('queue');
    expect(result.metadata.usesRedis).toBe(true);
    const redisMeta = result.metadata.redis as { required: boolean };
    expect(redisMeta.required).toBe(true);
  });

  it('detects MongoDB rejection in the incompatible fixture', () => {
    const result = analyseRepo(incompatibleMongoFixture);
    const mongoRejection = result.rejections.find((r) => r.dependency === 'mongoose');
    expect(mongoRejection?.detected).toBe(true);
  });

  it('a MySQL dependency alone is no longer a rejection — it is weak, needs-input evidence (Phase 4B)', () => {
    const result = analyseRepo(incompatibleMysqlFixture);
    expect(result.rejections.some((r) => r.dependency === 'mysql2' && r.detected)).toBe(false);
    expect(result.metadata.usesMysql).toBe(true);
    const mysqlMeta = result.metadata.mysql as { required: boolean; detected: boolean };
    expect(mysqlMeta.detected).toBe(true);
    expect(mysqlMeta.required).toBe(false);
    expect(result.metadata.databaseState).toBe('none');
  });

  it('detects local filesystem usage in the incompatible fixture', () => {
    const result = analyseRepo(incompatibleLocalFsFixture);
    const fsFinding = result.findings.find((f) => f.detector === 'local-filesystem');
    expect(fsFinding?.detected).toBe(true);
  });

  it('flags missing Dockerfile', () => {
    const result = analyseRepo(noDockerfileFixture);
    const dockerFinding = result.findings.find((f) => f.detector === 'dockerfile');
    expect(dockerFinding?.detected).toBe(false);
  });

  it('flags missing health endpoint', () => {
    const result = analyseRepo(noHealthFixture);
    const healthFinding = result.findings.find((f) => f.detector === 'health-endpoint');
    // Missing health IS a finding — the verdict engine (todo 23) decides "Needs attention"
    expect(healthFinding?.detected).toBe(false);
  });

  it('produces deterministic output (same input → same output)', () => {
    const result1 = analyseRepo(compatibleFixture);
    const result2 = analyseRepo(compatibleFixture);
    expect(result1).toEqual(result2);
  });

  it('handles empty repo gracefully', () => {
    const result = analyseRepo(emptyRepoFixture);
    expect(result.findings).toBeDefined();
    expect(result.rejections).toBeDefined();
    // No detectors should find anything in an empty repo
    const detectedFindings = result.findings.filter((f) => f.detected);
    expect(detectedFindings).toHaveLength(0);
  });

  it('detects S3 usage', () => {
    const result = analyseRepo(s3Fixture);
    const s3Finding = result.findings.find((f) => f.detector === 's3');
    expect(s3Finding?.detected).toBe(true);
  });

  it('detects worker patterns', () => {
    const result = analyseRepo(workerFixture);
    const workerFinding = result.findings.find((f) => f.detector === 'worker');
    expect(workerFinding?.detected).toBe(true);
  });

  it('handles Fastify-based app correctly', () => {
    const result = analyseRepo(compatibleFastifyFixture);
    const frameworkFinding = result.findings.find((f) => f.detector === 'framework');
    expect(frameworkFinding?.detected).toBe(true);
    expect(frameworkFinding?.value).toBe('fastify');

    const pgFinding = result.findings.find((f) => f.detector === 'postgresql');
    expect(pgFinding?.detected).toBe(true);

    const migrationFinding = result.findings.find((f) => f.detector === 'migration-command');
    expect(migrationFinding?.detected).toBe(true);
  });

  it('handles NestJS-based app correctly', () => {
    const result = analyseRepo(nestFixture);
    const frameworkFinding = result.findings.find((f) => f.detector === 'framework');
    expect(frameworkFinding?.detected).toBe(true);
    expect(frameworkFinding?.value).toBe('@nestjs/core');
  });

  it('builds metadata from all findings', () => {
    const result = analyseRepo(compatibleFixture);
    expect(result.metadata).toBeDefined();
    expect(result.metadata.framework).toBe('express');
    expect(result.metadata.hasDockerfile).toBe(true);
    expect(result.metadata.hasHealthEndpoint).toBe(true);
  });

  it('computes metadata.postgres required-vs-present evidence', () => {
    const result = analyseRepo(compatibleFixture);
    expect(result.metadata.postgres).toEqual({
      required: true,
      evidence: expect.arrayContaining([
        expect.stringContaining('pg dependency'),
        expect.stringContaining('DATABASE_URL'),
      ]),
    });
  });

  it('reports packageManager: null and hasBuildCommand: false when neither is present', () => {
    const result = analyseRepo(emptyRepoFixture);
    expect(result.metadata.packageManager).toBeNull();
    expect(result.metadata.hasBuildCommand).toBe(false);
    expect(result.metadata.buildCommands).toBeUndefined();
  });

  it('detects the package manager and build command in metadata', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ scripts: { build: 'next build' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    };
    const result = analyseRepo(tree);
    expect(result.metadata.packageManager).toBe('pnpm');
    expect(result.metadata.hasBuildCommand).toBe(true);
    expect(result.metadata.buildCommands).toContain('next build');
  });
});