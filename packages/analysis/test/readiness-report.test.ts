import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../src/analyser.js';
import type { AnalysisResult } from '../src/analyser.js';
import type { FileTree } from '../src/detectors.js';
import {
  buildReadinessReport,
  reconcileReadiness,
  verdictFromReadiness,
  type ReadinessReport,
} from '../src/readiness-report.js';

// ==========================================================================
// Corpus fixtures (inline file trees — no real files on disk)
// ==========================================================================

/** A fully-compatible app: Dockerfile + HEALTHCHECK + /health + PostgreSQL + migration. */
const readyTree: FileTree = {
  'Dockerfile':
    'FROM node:20-alpine\nEXPOSE 3000\nHEALTHCHECK --interval=30s CMD curl -f http://localhost:3000/health || exit 1\nCMD ["node", "dist/index.js"]\n',
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0' },
  }),
  'src/index.ts':
    "import express from 'express';\nconst app = express();\napp.get('/health', (_req, res) => res.json({ ok: true }));\napp.listen(3000);\n",
};

/** No Dockerfile. */
const noDockerfileTree: FileTree = { ...readyTree };
delete noDockerfileTree['Dockerfile'];

/** No health endpoint. */
const noHealthTree: FileTree = {
  ...readyTree,
  'Dockerfile': 'FROM node:20-alpine\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n',
  'src/index.ts':
    "import express from 'express';\nconst app = express();\napp.get('/', (_req, res) => res.send('ok'));\napp.listen(3000);\n",
};

/** PostgreSQL detected, but no migration command — a bare driver only (no
 *  independent evidence), so `postgres.required` is false → confidence
 *  'needs_confirmation'. */
const noMigrationTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0' },
  }),
};

/** PostgreSQL detected with independent evidence (a DATABASE_URL env var), no
 *  migration command → `postgres.required` true → confidence 'likely'. */
const noMigrationRequiredPostgresTree: FileTree = {
  ...readyTree,
  '.env.example': 'DATABASE_URL=postgresql://localhost:5432/mydb\n',
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0' },
  }),
};

/** No database at all — the missing-migration finding must never fire. */
const noPostgresTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js' },
    dependencies: { express: '^4.18.0' },
  }),
};

/** Worker-like code (bullmq) with a resolved "worker" start script. */
const workerWithCommandTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: {
      start: 'node dist/index.js',
      'db:migrate': 'npx drizzle-kit push',
      worker: 'node dist/worker.js',
    },
    dependencies: { express: '^4.18.0', pg: '^8.12.0', bullmq: '^5.0.0' },
  }),
};

/** Worker-like code (a Celery dependency beside bullmq) with NO resolved start command. */
const workerWithoutCommandTree: FileTree = {
  ...readyTree,
  'requirements.txt': 'celery==5.3.6\n',
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0', bullmq: '^5.0.0' },
  }),
};

/** Persistent local filesystem usage — blocking, and must be excluded from passed checks. */
const localFsTree: FileTree = {
  ...readyTree,
  'Dockerfile': 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 3000\nHEALTHCHECK CMD curl -f http://localhost:3000/health\nVOLUME /app/uploads\nCMD ["node", "dist/index.js"]\n',
  'src/uploader.ts':
    "import fs from 'fs';\nexport function save(path: string, data: string) { fs.writeFileSync(path, data); }\n",
};

/** Dockerfile copies .git from the build context (DEPLOY-031) — blocking. */
const gitCopyTree: FileTree = {
  ...readyTree,
  'Dockerfile':
    'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nCOPY .git/ .\nEXPOSE 3000\nHEALTHCHECK CMD curl -f http://localhost:3000/health\nCMD ["node", "dist/index.js"]\n',
};

/** Docker Compose defining two application services — a §11.4 rejection. */
const multiServiceComposeTree: FileTree = {
  ...readyTree,
  'docker-compose.yml': [
    'services:',
    '  web:',
    '    image: myapp/web:latest',
    '  admin:',
    '    image: myapp/admin:latest',
    '',
  ].join('\n'),
};

/** MySQL as the only database driver — a §10 rejection (next to `pg` it would be a configurable engine, COMP-002). */
/** MongoDB as the app's data store — a §10 rejection; MySQL itself is a SUPPORTED engine since Phase 4B. */
const mongoTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0', mongoose: '^8.0.0' },
  }),
  'src/models/user.ts': [
    "import mongoose from 'mongoose';",
    'export const User = mongoose.model("User", new mongoose.Schema({ email: String }));',
  ].join('\n'),
};

const JARGON_REGEX = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN|RDS)\b/i;

// ==========================================================================
// State calculation
// ==========================================================================

describe('buildReadinessReport — state calculation', () => {
  it('READY: no required findings at all', () => {
    const report = buildReadinessReport(analyseRepo(readyTree));
    expect(report.state).toBe('READY');
    expect(report.requiredCount).toBe(0);
  });

  it('ALMOST_READY: a fixable-required finding (container-setup), no blocking finding', () => {
    const report = buildReadinessReport(analyseRepo(noDockerfileTree));
    expect(report.state).toBe('ALMOST_READY');
    expect(report.requiredCount).toBe(1);
    expect(report.findings.some((f) => f.id === 'container-setup')).toBe(true);
  });

  it('ALMOST_READY: a fixable-required finding (health-check), no blocking finding', () => {
    const report = buildReadinessReport(analyseRepo(noHealthTree));
    expect(report.state).toBe('ALMOST_READY');
    expect(report.findings.some((f) => f.id === 'health-check')).toBe(true);
  });

  it('NEEDS_CHANGES: any blocking required finding (§10 rejection)', () => {
    const report = buildReadinessReport(analyseRepo(mongoTree));
    expect(report.state).toBe('NEEDS_CHANGES');
  });

  it('ALMOST_READY: local filesystem persistence is a repository change, not a block', () => {
    const report = buildReadinessReport(analyseRepo(localFsTree));
    expect(report.state).toBe('ALMOST_READY');
    expect(report.outcome).toBe('DEPLOYABLE_WITH_CHANGES');
    expect(report.findings.find((f) => f.id === 'local-file-storage')?.blocking).toBe(false);
  });

  it('ALMOST_READY: Dockerfile copies .git (DEPLOY-031) is a repository change, not a block', () => {
    const report = buildReadinessReport(analyseRepo(gitCopyTree));
    expect(report.state).toBe('ALMOST_READY');
    expect(report.outcome).toBe('DEPLOYABLE_WITH_CHANGES');
    expect(report.findings.find((f) => f.id === 'build-context-git-metadata')?.blocking).toBe(false);
    expect(report.passed.some((p) => p.id === 'dockerfile-git-copy')).toBe(false);
  });

  it('NEEDS_CHANGES wins over a simultaneous fixable-required finding', () => {
    const tree: FileTree = { ...mongoTree };
    delete tree['Dockerfile'];
    const report = buildReadinessReport(analyseRepo(tree));
    expect(report.state).toBe('NEEDS_CHANGES');
    // Both findings are still present — NEEDS_CHANGES just outranks ALMOST_READY.
    expect(report.findings.some((f) => f.id === 'container-setup')).toBe(true);
  });

  it('RECOMMENDED findings never block READY', () => {
    // Postgres detected, no migration command (recommended) — still READY.
    const report = buildReadinessReport(analyseRepo(noMigrationTree));
    expect(report.state).toBe('READY');
    expect(report.recommendedCount).toBeGreaterThan(0);
  });
});

// ==========================================================================
// Required vs recommended classification, blocking vs fixable
// ==========================================================================

describe('buildReadinessReport — finding classification', () => {
  it('§10 rejections are required + blocking', () => {
    const report = buildReadinessReport(analyseRepo(mongoTree));
    const finding = report.findings.find((f) => f.id === 'unsupported-database-mongo');
    expect(finding?.severity).toBe('required');
    expect(finding?.blocking).toBe(true);
    expect(finding?.confidence).toBe('confirmed');
  });

  it('a Django MySQL project without a migrate step gets the standard command suggested', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM python:3.11\nWORKDIR /app\nCOPY . .\nEXPOSE 8000\nCMD ["python3", "manage.py", "runserver", "0.0.0.0:8000"]\n',
      'requirements.txt': 'Django==4.2\nmysqlclient==2.2\n',
      'manage.py': "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'app.settings')\n",
      'app/settings.py': "DATABASES = {'default': {'ENGINE': 'django.db.backends.mysql', 'NAME': os.getenv('DB_NAME')}}\n",
      'docker-compose.yml': 'services:\n  web:\n    build: .\n    ports:\n      - "8000:8000"\n  db:\n    image: mysql:8\n',
    };
    const analysis = analyseRepo(tree);
    expect(analysis.metadata['suggestedMigrationCommand']).toBe('python manage.py migrate --noinput');
    const finding = buildReadinessReport(analysis).findings.find((f) => f.id === 'database-migrations');
    expect(finding?.suggestedOutcome).toContain('python manage.py migrate --noinput');
    expect(finding?.blocking).toBe(false);
  });

  it('no migration suggestion when the image already migrates at start', () => {
    const tree: FileTree = {
      'Dockerfile': 'FROM python:3.11\nCOPY . .\nCMD sh -c "python manage.py migrate --noinput && gunicorn app.wsgi"\n',
      'requirements.txt': 'Django==4.2\nmysqlclient==2.2\n',
      'manage.py': "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'app.settings')\n",
      'app/settings.py': "DATABASES = {'default': {'ENGINE': 'django.db.backends.mysql'}}\n",
    };
    expect(analyseRepo(tree).metadata['suggestedMigrationCommand']).toBeUndefined();
  });

  it('the SQLite rejection names both supported engines', () => {
    const tree: FileTree = {
      ...readyTree,
      'package.json': JSON.stringify({
        name: 'sqlite-app',
        scripts: { start: 'node dist/index.js' },
        dependencies: { express: '^4.18.0', 'better-sqlite3': '^9.0.0' },
      }),
    };
    const finding = buildReadinessReport(analyseRepo(tree)).findings.find((f) => f.id === 'unsupported-database-sqlite');
    expect(finding?.blocking).toBe(true);
    expect(finding?.suggestedOutcome).toContain('PostgreSQL or MySQL');
    expect(finding?.whyItMatters).toContain('PostgreSQL or MySQL');
  });

  it('local filesystem persistence is required + a code change + confirmed', () => {
    const report = buildReadinessReport(analyseRepo(localFsTree));
    const finding = report.findings.find((f) => f.id === 'local-file-storage');
    expect(finding?.severity).toBe('required');
    expect(finding?.fixClass).toBe('CODE_CHANGE');
    expect(finding?.blocking).toBe(false);
    expect(finding?.confidence).toBe('confirmed');
  });

  it('a Dockerfile .git copy is required + a code change + confirmed', () => {
    const report = buildReadinessReport(analyseRepo(gitCopyTree));
    const finding = report.findings.find((f) => f.id === 'build-context-git-metadata');
    expect(finding?.severity).toBe('required');
    expect(finding?.fixClass).toBe('CODE_CHANGE');
    expect(finding?.blocking).toBe(false);
    expect(finding?.confidence).toBe('confirmed');
  });

  it('container-setup is required + fixable (not blocking) + confirmed', () => {
    const report = buildReadinessReport(analyseRepo(noDockerfileTree));
    const finding = report.findings.find((f) => f.id === 'container-setup');
    expect(finding?.severity).toBe('required');
    expect(finding?.blocking).toBe(false);
    expect(finding?.confidence).toBe('confirmed');
  });

  it('health-check is required + fixable (not blocking) + likely', () => {
    const report = buildReadinessReport(analyseRepo(noHealthTree));
    const finding = report.findings.find((f) => f.id === 'health-check');
    expect(finding?.severity).toBe('required');
    expect(finding?.blocking).toBe(false);
    expect(finding?.confidence).toBe('likely');
  });

  it('a multi-service compose file renders the multi-service copy, not the message-queue copy (CANARY-002)', () => {
    const report = buildReadinessReport(analyseRepo(multiServiceComposeTree));
    const finding = report.findings.find((f) => f.id === 'unsupported-multi-service');
    expect(finding).toBeDefined();
    expect(finding?.title).toBe('Runs as several services');
    expect(finding?.severity).toBe('required');
    // Static analysis cannot show that each service is required: the vendor verifies it.
    expect(finding?.fixClass).toBe('CODE_CHANGE');
    expect(finding?.blocking).toBe(false);
    expect(report.findings.some((f) => f.id === 'unsupported-message-queue')).toBe(false);
  });

  it('database-migrations is recommended, never blocking', () => {
    const report = buildReadinessReport(analyseRepo(noMigrationTree));
    const finding = report.findings.find((f) => f.id === 'database-migrations');
    expect(finding?.severity).toBe('recommended');
    expect(finding?.blocking).toBe(false);
  });

  it('READY stays READY: a resolved worker command is a recommended informational finding (Phase 4A)', () => {
    const report = buildReadinessReport(analyseRepo(workerWithCommandTree), {
      workerCommandResolved: true,
    });
    expect(report.state).toBe('READY');
    const finding = report.findings.find((f) => f.id === 'worker-process');
    expect(finding?.severity).toBe('recommended');
    expect(finding?.blocking).toBe(false);
    expect(finding?.confidence).toBe('confirmed');
  });

  it('READY stays READY: worker-like code without a worker start command is recommended only', () => {
    const report = buildReadinessReport(analyseRepo(workerWithoutCommandTree), {
      workerCommandResolved: false,
    });
    expect(report.state).toBe('READY');
    expect(report.findings.find((f) => f.id === 'worker-command')?.severity).toBe('recommended');
  });

  it('never tells the vendor to merge jobs into the web process, replace a queue or remove infrastructure', () => {
    const analysis = analyseRepo(workerWithoutCommandTree);
    const report = buildReadinessReport({
      ...analysis,
      rejections: [
        ...analysis.rejections,
        { detected: true, dependency: 'kafka', reason: 'Kafka consumer in src/queue.ts' },
        { detected: true, dependency: 'terraform', reason: 'main.tf at the repository root' },
      ],
    });
    const outcomes = ['worker-command', 'unsupported-message-queue', 'unsupported-architecture'].map(
      (id) => report.findings.find((f) => f.id === id)?.suggestedOutcome ?? '',
    );
    expect(outcomes.every((outcome) => outcome.length > 0)).toBe(true);
    for (const outcome of outcomes) {
      expect(outcome).not.toMatch(/inside the web process, or|remove the job-runner|Replace the queue|Remove the third-party infrastructure/);
    }
  });
});

// ==========================================================================
// Migration finding — only with postgres, confidence variants
// ==========================================================================

describe('buildReadinessReport — database-migrations finding', () => {
  it('never fires for a repository with no database', () => {
    const report = buildReadinessReport(analyseRepo(noPostgresTree));
    expect(report.findings.some((f) => f.id === 'database-migrations')).toBe(false);
  });

  it('never fires when a migration command is present', () => {
    const report = buildReadinessReport(analyseRepo(readyTree));
    expect(report.findings.some((f) => f.id === 'database-migrations')).toBe(false);
  });

  it('fires with confidence "needs_confirmation" when postgres.required is false', () => {
    const analysis = analyseRepo(noMigrationTree);
    expect((analysis.metadata['postgres'] as { required: boolean }).required).toBe(false);
    const report = buildReadinessReport(analysis);
    const finding = report.findings.find((f) => f.id === 'database-migrations');
    expect(finding).toBeDefined();
    expect(finding?.confidence).toBe('needs_confirmation');
  });

  it('fires with confidence "likely" when postgres.required is true', () => {
    const analysis = analyseRepo(noMigrationRequiredPostgresTree);
    expect((analysis.metadata['postgres'] as { required: boolean }).required).toBe(true);
    const report = buildReadinessReport(analysis);
    const finding = report.findings.find((f) => f.id === 'database-migrations');
    expect(finding).toBeDefined();
    expect(finding?.confidence).toBe('likely');
  });
});

// ==========================================================================
// Worker findings — gated on workerCommandResolved (Phase 4A semantics)
// ==========================================================================

describe('buildReadinessReport — worker findings', () => {
  it('never fires when no worker-like code is detected', () => {
    const report = buildReadinessReport(analyseRepo(readyTree), { workerCommandResolved: false });
    expect(report.findings.some((f) => f.id === 'worker-command')).toBe(false);
    expect(report.findings.some((f) => f.id === 'worker-process')).toBe(false);
  });

  it('recommended when worker-like code is detected and no start command resolved', () => {
    const report = buildReadinessReport(analyseRepo(workerWithoutCommandTree), {
      workerCommandResolved: false,
    });
    expect(report.findings.some((f) => f.id === 'worker-command')).toBe(true);
    expect(report.findings.some((f) => f.id === 'worker-process')).toBe(false);
  });

  it('recommended when worker-like code is detected and context is omitted entirely', () => {
    const report = buildReadinessReport(analyseRepo(workerWithoutCommandTree));
    expect(report.findings.some((f) => f.id === 'worker-command')).toBe(true);
    expect(report.findings.some((f) => f.id === 'worker-process')).toBe(false);
  });

  it('informational (non-blocking) when worker-like code is detected AND a start command resolved', () => {
    const report = buildReadinessReport(analyseRepo(workerWithCommandTree), {
      workerCommandResolved: true,
    });
    expect(report.findings.some((f) => f.id === 'worker-process')).toBe(true);
    // A resolved worker command never appears as the configuration-gap finding.
    expect(report.findings.some((f) => f.id === 'worker-command')).toBe(false);
  });
});

// ==========================================================================
// Passed-check collection
// ==========================================================================

describe('buildReadinessReport — passed checks', () => {
  it('excludes local-filesystem even when detected (it is a negative signal)', () => {
    const report = buildReadinessReport(analyseRepo(localFsTree));
    expect(report.passed.some((p) => p.id === 'local-filesystem')).toBe(false);
  });

  it('never lists worker as a passed check — worker is a finding (blocking or recommended)', () => {
    const withCommand = buildReadinessReport(analyseRepo(workerWithCommandTree), {
      workerCommandResolved: true,
    });
    expect(withCommand.passed.some((p) => p.id === 'worker')).toBe(false);
    const withoutCommand = buildReadinessReport(analyseRepo(workerWithoutCommandTree), {
      workerCommandResolved: false,
    });
    expect(withoutCommand.passed.some((p) => p.id === 'worker')).toBe(false);
  });

  it('includes detected positive-signal checks (dockerfile, framework, health-endpoint)', () => {
    const report = buildReadinessReport(analyseRepo(readyTree));
    expect(report.passed.some((p) => p.id === 'dockerfile')).toBe(true);
    expect(report.passed.some((p) => p.id === 'framework')).toBe(true);
    expect(report.passed.some((p) => p.id === 'health-endpoint')).toBe(true);
  });
});

// ==========================================================================
// Counts and summary strings
// ==========================================================================

describe('buildReadinessReport — counts and summary', () => {
  it('requiredCount/recommendedCount match the findings actually present', () => {
    const report = buildReadinessReport(analyseRepo(noMigrationTree));
    const required = report.findings.filter((f) => f.severity === 'required').length;
    const recommended = report.findings.filter((f) => f.severity === 'recommended').length;
    expect(report.requiredCount).toBe(required);
    expect(report.recommendedCount).toBe(recommended);
  });

  it('required findings sort before recommended findings', () => {
    const tree: FileTree = { ...noMigrationTree };
    delete tree['Dockerfile'];
    const report = buildReadinessReport(analyseRepo(tree));
    const severities = report.findings.map((f) => f.severity);
    expect(severities).toContain('required');
    expect(severities).toContain('recommended');
    const firstRecommendedIndex = severities.indexOf('recommended');
    expect(severities.slice(0, firstRecommendedIndex).every((s) => s === 'required')).toBe(true);
  });

  it('summary strings are exactly the three documented state summaries', () => {
    expect(buildReadinessReport(analyseRepo(readyTree)).summary).toBe(
      'This app can be deployed through Deployz.',
    );
    expect(buildReadinessReport(analyseRepo(noDockerfileTree)).summary).toBe(
      'Deployz found a few things to address before this app can be deployed reliably.',
    );
    expect(buildReadinessReport(analyseRepo(mongoTree)).summary).toBe(
      'This app needs changes before Deployz can deploy it.',
    );
  });
});

// ==========================================================================
// Finding copy is jargon-free
// ==========================================================================

describe('buildReadinessReport — jargon-free copy', () => {
  it('no finding exposes CloudFormation/IAM/ECS/ALB/Lambda/VPC/CFN/RDS terms', () => {
    // Exercise every finding this module can produce in one pass.
    const trees = [
      mongoTree,
      localFsTree,
      gitCopyTree,
      noDockerfileTree,
      noHealthTree,
      noMigrationTree,
      noMigrationRequiredPostgresTree,
      workerWithoutCommandTree,
    ];
    const allFindings = trees.flatMap((tree) => buildReadinessReport(analyseRepo(tree)).findings);
    // A declared worker process produces its own blocking finding copy.
    allFindings.push(
      ...buildReadinessReport(analyseRepo(workerWithCommandTree), {
        workerCommandResolved: true,
      }).findings,
    );
    expect(allFindings.length).toBeGreaterThan(0);
    for (const finding of allFindings) {
      expect(finding.plainEnglishExplanation).not.toMatch(JARGON_REGEX);
      expect(finding.title).not.toMatch(JARGON_REGEX);
      expect(finding.whyItMatters).not.toMatch(JARGON_REGEX);
    }
  });
});

// ==========================================================================
// verdictFromReadiness mapping
// ==========================================================================

describe('verdictFromReadiness', () => {
  it('maps READY → READY', () => {
    expect(verdictFromReadiness('READY')).toBe('READY');
  });

  it('maps ALMOST_READY → NEEDS_ATTENTION', () => {
    expect(verdictFromReadiness('ALMOST_READY')).toBe('NEEDS_ATTENTION');
  });

  it('maps NEEDS_CHANGES → NOT_COMPATIBLE', () => {
    expect(verdictFromReadiness('NEEDS_CHANGES')).toBe('NOT_COMPATIBLE');
  });
});

// ==========================================================================
// Determinism
// ==========================================================================

describe('buildReadinessReport — determinism', () => {
  it('same input twice → deep-equal output', () => {
    const analysis = analyseRepo(mongoTree);
    const first = buildReadinessReport(analysis);
    const second = buildReadinessReport(analysis);
    expect(second).toEqual(first);
  });

  it('same input twice with context → deep-equal output', () => {
    const analysis = analyseRepo(workerWithoutCommandTree);
    const context = { workerCommandResolved: false };
    const first: ReadinessReport = buildReadinessReport(analysis, context);
    const second: ReadinessReport = buildReadinessReport(analysis, context);
    expect(second).toEqual(first);
  });
});


// ==========================================================================
// AI MVP Phase 2 — port / start-command / localhost-binding findings and
// vendor-configuration reconciliation
// ==========================================================================

const dockerfileNoPortNoCmdTree: FileTree = {
  Dockerfile: 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\n',
  'package.json': JSON.stringify({ name: 'app', dependencies: { express: '^4' } }),
  'src/index.js': "require('express')().get('/health', (_q, r) => r.send('ok'));\n",
};

const localhostTree: FileTree = {
  Dockerfile: 'FROM node:20-alpine\nEXPOSE 3000\nCMD ["node", "server.js"]\n',
  'package.json': JSON.stringify({ name: 'app', dependencies: { express: '^4' } }),
  'server.js': "const app = require('express')();\napp.get('/health', (_q, r) => r.send('ok'));\napp.listen(3000, '127.0.0.1');\n",
};

describe('buildReadinessReport — Phase 2 findings', () => {
  it('reports an unresolved port and a missing start command as required, non-blocking findings', () => {
    const report = buildReadinessReport(analyseRepo(dockerfileNoPortNoCmdTree));
    expect(report.state).toBe('ALMOST_READY');
    const ids = report.findings.map((f) => f.id);
    expect(ids).toContain('port-unresolved');
    expect(ids).toContain('start-command-missing');
    for (const id of ['port-unresolved', 'start-command-missing']) {
      const finding = report.findings.find((f) => f.id === id);
      expect(finding).toMatchObject({ severity: 'required', blocking: false, confidence: 'confirmed' });
    }
  });

  it('does not pile port/start findings on top of a missing container setup', () => {
    const report = buildReadinessReport(analyseRepo({ 'package.json': JSON.stringify({ name: 'app' }) }));
    const ids = report.findings.map((f) => f.id);
    expect(ids).toContain('container-setup');
    expect(ids).not.toContain('port-unresolved');
    expect(ids).not.toContain('start-command-missing');
  });

  it('reports a loopback-only server as a required, non-blocking, likely finding with the evidence', () => {
    const report = buildReadinessReport(analyseRepo(localhostTree));
    expect(report.state).toBe('ALMOST_READY');
    const finding = report.findings.find((f) => f.id === 'localhost-binding');
    expect(finding).toMatchObject({ severity: 'required', blocking: false, confidence: 'likely' });
    expect(finding?.technicalEvidence).toContain('server.js');
    expect(report.passed.map((p) => p.id)).not.toContain('bind-address');
  });

  it('lists the runtime as a passed check and never the bind address', () => {
    const report = buildReadinessReport(analyseRepo(readyTree));
    expect(report.passed).toContainEqual({ id: 'runtime', label: 'Runtime detected' });
    expect(report.passed.map((p) => p.id)).not.toContain('bind-address');
  });
});

describe('reconcileReadiness', () => {
  const report = buildReadinessReport(analyseRepo(dockerfileNoPortNoCmdTree));

  it('turns the findings the vendor resolved into passed checks and re-derives the state', () => {
    const reconciled = reconcileReadiness(report, { containerPort: 8080, startCommand: 'node src/index.js' });
    expect(reconciled.state).toBe('READY');
    expect(reconciled.requiredCount).toBe(0);
    expect(reconciled.findings.map((f) => f.id)).not.toContain('port-unresolved');
    expect(reconciled.passed).toContainEqual({ id: 'port-unresolved', label: 'Application port set in the application details' });
    expect(reconciled.passed).toContainEqual({ id: 'start-command-missing', label: 'Start command set in the application details' });
    expect(reconciled.summary).toBe('This app can be deployed through Deployz.');
  });

  it('resolves only what the configuration covers', () => {
    const reconciled = reconcileReadiness(report, { containerPort: 8080, startCommand: null });
    expect(reconciled.state).toBe('ALMOST_READY');
    expect(reconciled.findings.map((f) => f.id)).toEqual(['start-command-missing']);
    expect(reconciled.requiredCount).toBe(1);
  });

  it('returns the same report when nothing is resolvable, and never mutates its input', () => {
    const untouched = reconcileReadiness(report, { containerPort: null, startCommand: null });
    expect(untouched).toBe(report);
    const before = JSON.stringify(report);
    reconcileReadiness(report, { containerPort: 1, startCommand: 'x' });
    expect(JSON.stringify(report)).toBe(before);
  });

  it('never resolves a blocking finding through configuration', () => {
    const blocked = buildReadinessReport(analyseRepo(mongoTree));
    const reconciled = reconcileReadiness(blocked, { containerPort: 3000, startCommand: 'node x' });
    expect(reconciled.state).toBe('NEEDS_CHANGES');
  });
});

describe('buildReadinessReport — deployability outcome', () => {
  /** The ready app with one detected rejection and the given database flags. */
  function withRejection(dependency: string, metadata: Record<string, unknown> = {}): AnalysisResult {
    const base = analyseRepo(readyTree);
    return {
      ...base,
      metadata: { ...base.metadata, ...metadata },
      rejections: [{ detected: true, dependency, reason: `Unsupported: ${dependency}` }],
    };
  }

  it('DEPLOYABLE: no required finding', () => {
    expect(buildReadinessReport(analyseRepo(readyTree)).outcome).toBe('DEPLOYABLE');
  });

  it('DEPLOYABLE: only Deployz settings are required', () => {
    const report = buildReadinessReport(analyseRepo(dockerfileNoPortNoCmdTree));
    expect(report.state).toBe('ALMOST_READY');
    expect(report.outcome).toBe('DEPLOYABLE');
    expect(report.findings.filter((f) => f.severity === 'required').every((f) => f.fixClass === 'SETTING')).toBe(true);
  });

  it('DEPLOYABLE_WITH_CHANGES: the worst item wins over settings', () => {
    const report = buildReadinessReport(analyseRepo(noDockerfileTree));
    expect(report.outcome).toBe('DEPLOYABLE_WITH_CHANGES');
    expect(verdictFromReadiness(report.state)).toBe('NEEDS_ATTENTION');
  });

  it('NOT_DEPLOYABLE: a required capability gap blocks', () => {
    const report = buildReadinessReport(analyseRepo(mongoTree));
    expect(report.outcome).toBe('NOT_DEPLOYABLE');
    expect(report.findings.find((f) => f.id === 'unsupported-database-mongo')).toMatchObject({
      fixClass: 'CAPABILITY_GAP',
      blocking: true,
    });
    expect(verdictFromReadiness(report.state)).toBe('NOT_COMPATIBLE');
  });

  it('NOT_DEPLOYABLE: SQLite is the only database driver', () => {
    const report = buildReadinessReport(withRejection('sqlite', { usesPostgresql: false, usesMysql: false }));
    expect(report.outcome).toBe('NOT_DEPLOYABLE');
  });

  it('DEPLOYABLE_WITH_CHANGES: SQLite next to a PostgreSQL or MySQL driver', () => {
    expect(buildReadinessReport(withRejection('sqlite', { usesPostgresql: true })).outcome).toBe('DEPLOYABLE_WITH_CHANGES');
    expect(buildReadinessReport(withRejection('sqlite', { usesPostgresql: false, usesMysql: true })).outcome).toBe(
      'DEPLOYABLE_WITH_CHANGES',
    );
  });

  it('DEPLOYABLE_WITH_CHANGES: an unbuildable Dockerfile and several compose services are repository changes', () => {
    expect(buildReadinessReport(withRejection('no-buildable-dockerfile')).outcome).toBe('DEPLOYABLE_WITH_CHANGES');
    expect(buildReadinessReport(withRejection('docker-compose-multi-service')).outcome).toBe('DEPLOYABLE_WITH_CHANGES');
  });

  it('keeps the outcome when the vendor resolves a setting', () => {
    const report = buildReadinessReport(
      analyseRepo({ ...dockerfileNoPortNoCmdTree, Dockerfile: 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nCOPY .git/ .\n' }),
    );
    const reconciled = reconcileReadiness(report, { containerPort: 8080, startCommand: 'node src/index.js' });
    expect(reconciled.outcome).toBe('DEPLOYABLE_WITH_CHANGES');
  });

  it('has no outcome for a report stored before fix classes', () => {
    const stored: ReadinessReport = {
      state: 'ALMOST_READY',
      requiredCount: 2,
      recommendedCount: 0,
      summary: '',
      findings: buildReadinessReport(analyseRepo(dockerfileNoPortNoCmdTree)).findings.map(({ fixClass: _fixClass, ...f }) => f),
      passed: [],
    };
    expect(reconcileReadiness(stored, { containerPort: 8080, startCommand: null }).outcome).toBeUndefined();
  });
});
