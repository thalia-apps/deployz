import { describe, expect, it, vi } from 'vitest';

import { compatibilityStatusEnum } from '@deployz/db';

import { analyseRepo } from '../src/analyser.js';
import type { AnalysisResult } from '../src/analyser.js';
import type { FileTree } from '../src/detectors.js';
import {
  evaluateCompatibility,
  persistVerdict,
  type CompatibilityResult,
  type CompatibilityVerdict,
  type VerdictStore,
} from '../src/rules.js';

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

/** No health endpoint (no HEALTHCHECK, no /health route). */
const noHealthTree: FileTree = {
  ...readyTree,
  'Dockerfile': 'FROM node:20-alpine\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n',
  'src/index.ts':
    "import express from 'express';\nconst app = express();\napp.get('/', (_req, res) => res.send('ok'));\napp.listen(3000);\n",
};

/** No migration command — with the readiness-report refactor this is now a
 *  RECOMMENDED finding, so the §19 verdict stays READY (see the dedicated
 *  describe block below; the recommended-finding assertions live in
 *  readiness-report.test.ts, which is what actually builds the finding). */
const noMigrationTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0' },
  }),
};

/** No PostgreSQL driver. */
const noPostgresTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0' },
  }),
};

/** Plain Redis dependency — SUPPORTED (medium confidence alone, does not reject). */
const redisTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0', ioredis: '^5.4.0' },
  }),
};

/** Unsupported Redis setup — Redis Stack modules (@redis/json). Rejects. */
const unsupportedRedisTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: {
      express: '^4.18.0',
      pg: '^8.12.0',
      ioredis: '^5.4.0',
      '@redis/json': '^1.0.0',
    },
  }),
};

/** MySQL as the only database driver — a driver next to `pg` is a configurable engine (COMP-002). */
const mysqlTree: FileTree = {
  ...readyTree,
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0', mysql2: '^3.9.0' },
  }),
};

/** MongoDB dependency. */
const mongoTree: FileTree = {
  ...readyTree,
  'src/models/user.js': 'const mongoose = require("mongoose");\nmodule.exports = mongoose.model("User", new mongoose.Schema({ name: String }));\n',
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0', mongoose: '^8.0.0' },
  }),
};

/** Elasticsearch dependency. */
const elasticsearchTree: FileTree = {
  ...readyTree,
  'docker-compose.yml': 'services:\n  elasticsearch:\n    image: elasticsearch:8.13.0\n',
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: {
      express: '^4.18.0',
      pg: '^8.12.0',
      '@elastic/elasticsearch': '^8.0.0',
    },
  }),
};

/** Other unsupported database driver. */
const otherDbTree: FileTree = {
  ...readyTree,
  'docker-compose.yml': 'services:\n  cassandra:\n    image: cassandra:4\n',
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0', 'cassandra-driver': '^4.7.0' },
  }),
};

/** Persistent local filesystem usage. */
const localFsTree: FileTree = {
  ...readyTree,
  'Dockerfile': 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 3000\nHEALTHCHECK CMD curl -f http://localhost:3000/health\nVOLUME /app/uploads\nCMD ["node", "dist/index.js"]\n',
  'src/uploader.ts':
    "import fs from 'fs';\nexport function save(path: string, data: string) { fs.writeFileSync(path, data); }\n",
};

/** Dockerfile copies .git from the build context (DEPLOY-031). */
const gitCopyTree: FileTree = {
  ...readyTree,
  'Dockerfile':
    'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nCOPY .git/ .\nEXPOSE 3000\nHEALTHCHECK CMD curl -f http://localhost:3000/health\nCMD ["node", "dist/index.js"]\n',
};

/** A rejection AND a fixable-required issue both present (blocking must win the verdict). */
const rejectPlusAttentionTree: FileTree = { ...unsupportedRedisTree };
delete rejectPlusAttentionTree['Dockerfile'];

/** Multiple §10 rejections plus no database at all — all rejections must be listed. */
const multiRejectTree: FileTree = {
  ...readyTree,
  'src/models/user.js': 'const mongoose = require("mongoose");\nmodule.exports = mongoose.model("User", new mongoose.Schema({ name: String }));\n',
  'package.json': JSON.stringify({
    name: 'ready-app',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
    dependencies: {
      express: '^4.18.0',
      ioredis: '^5.4.0',
      '@redis/json': '^1.0.0',
      mongoose: '^8.0.0',
    },
  }),
};

/** Multiple fixable-required issues — all must be listed. */
const multiAttentionTree: FileTree = {
  'package.json': JSON.stringify({
    scripts: { start: 'node dist/index.js' },
    dependencies: { express: '^4.18.0', pg: '^8.12.0' },
  }),
  'src/index.ts':
    "import express from 'express';\nconst app = express();\napp.get('/', (_req, res) => res.send('ok'));\napp.listen(3000);\n",
};

/** Extract stable issue codes from a result. */
function codes(result: CompatibilityResult): string[] {
  return result.issues.map((i) => i.code);
}

const READY_REASON = 'This app can be deployed through Deployz.';
const ALMOST_READY_REASON =
  'Deployz found a few things to address before this app can be deployed reliably.';
const NEEDS_CHANGES_REASON = 'This app needs changes before Deployz can deploy it.';

// ==========================================================================
// §19 verdict engine — blocking (reject) rules → NOT_COMPATIBLE
// ==========================================================================

describe('evaluateCompatibility — blocking rules (→ NOT_COMPATIBLE)', () => {
  it('unsupported Redis setup → NOT_COMPATIBLE (unsupported-redis-setup)', () => {
    const result = evaluateCompatibility(analyseRepo(unsupportedRedisTree));
    expect(result.verdict).toBe('NOT_COMPATIBLE');
    expect(codes(result)).toEqual(['unsupported-redis-setup']);
    expect(result.issues[0]?.severity).toBe('reject');
    expect(result.reason).toBe(NEEDS_CHANGES_REASON);
  });

  it('a weak MySQL dependency no longer rejects — Deployz supports MySQL (Phase 4B)', () => {
    const result = evaluateCompatibility(analyseRepo(mysqlTree));
    expect(result.verdict).toBe('READY');
    expect(codes(result)).toEqual([]);
  });

  it('MongoDB dependency → NOT_COMPATIBLE (unsupported-database-mongo)', () => {
    const result = evaluateCompatibility(analyseRepo(mongoTree));
    expect(result.verdict).toBe('NOT_COMPATIBLE');
    expect(codes(result)).toEqual(['unsupported-database-mongo']);
  });

  it('Elasticsearch dependency → NOT_COMPATIBLE (unsupported-database-elasticsearch)', () => {
    const result = evaluateCompatibility(analyseRepo(elasticsearchTree));
    expect(result.verdict).toBe('NOT_COMPATIBLE');
    expect(codes(result)).toEqual(['unsupported-database-elasticsearch']);
  });

  it('other unsupported database → NOT_COMPATIBLE (unsupported-database-other)', () => {
    const result = evaluateCompatibility(analyseRepo(otherDbTree));
    expect(result.verdict).toBe('NOT_COMPATIBLE');
    expect(codes(result)).toEqual(['unsupported-database-other']);
  });

  it('no PostgreSQL (no database at all) → READY, not a reject', () => {
    const result = evaluateCompatibility(analyseRepo(noPostgresTree));
    expect(result.verdict).toBe('READY');
    expect(result.issues).toEqual([]);
    // A repository with no database is a neutral 'none' state — never a reject.
    expect(analyseRepo(noPostgresTree).metadata['databaseState']).toBe('none');
  });

  it('local filesystem usage is a repository change → NEEDS_ATTENTION (local-file-storage)', () => {
    const result = evaluateCompatibility(analyseRepo(localFsTree));
    expect(result.verdict).toBe('NEEDS_ATTENTION');
    expect(codes(result)).toEqual(['local-file-storage']);
    expect(result.reason).toBe(ALMOST_READY_REASON);
  });

  it('Dockerfile copies .git is a repository change → NEEDS_ATTENTION (build-context-git-metadata)', () => {
    const result = evaluateCompatibility(analyseRepo(gitCopyTree));
    expect(result.verdict).toBe('NEEDS_ATTENTION');
    expect(codes(result)).toEqual(['build-context-git-metadata']);
    expect(result.reason).toBe(ALMOST_READY_REASON);
  });

  it('lists ALL §10 rejections when multiple fire (no database at all never fires one)', () => {
    const result = evaluateCompatibility(analyseRepo(multiRejectTree));
    expect(result.verdict).toBe('NOT_COMPATIBLE');
    const cs = codes(result);
    expect(cs).toContain('unsupported-redis-setup');
    expect(cs).toContain('unsupported-database-mongo');
    expect(result.reason).toBe(NEEDS_CHANGES_REASON);
  });
});

// ==========================================================================
// §19 verdict engine — fixable-required rules → NEEDS_ATTENTION
// ==========================================================================

describe('evaluateCompatibility — fixable-required rules (→ NEEDS_ATTENTION)', () => {
  it('missing Dockerfile → NEEDS_ATTENTION (container-setup)', () => {
    const result = evaluateCompatibility(analyseRepo(noDockerfileTree));
    expect(result.verdict).toBe('NEEDS_ATTENTION');
    expect(codes(result)).toEqual(['container-setup']);
    expect(result.issues[0]?.severity).toBe('attention');
    expect(result.reason).toBe(ALMOST_READY_REASON);
  });

  it('missing health endpoint → NEEDS_ATTENTION (health-check)', () => {
    const result = evaluateCompatibility(analyseRepo(noHealthTree));
    expect(result.verdict).toBe('NEEDS_ATTENTION');
    expect(codes(result)).toEqual(['health-check']);
    expect(result.reason).toBe(ALMOST_READY_REASON);
  });

  it('missing migration command is now a RECOMMENDED finding — verdict stays READY', () => {
    // With the readiness-report refactor, a missing migration command for a
    // detected-PostgreSQL repo is RECOMMENDED, never REQUIRED — so it never
    // appears in `issues` and never affects the §19 verdict. The report-level
    // recommended finding itself is asserted in readiness-report.test.ts.
    const result = evaluateCompatibility(analyseRepo(noMigrationTree));
    expect(result.verdict).toBe('READY');
    expect(result.issues).toEqual([]);
    expect(result.reason).toBe(READY_REASON);
  });

  it('lists ALL fixable-required issues when multiple are missing (migration is not one of them)', () => {
    const result = evaluateCompatibility(analyseRepo(multiAttentionTree));
    expect(result.verdict).toBe('NEEDS_ATTENTION');
    expect(codes(result).sort()).toEqual(['container-setup', 'health-check']);
    expect(result.reason).toBe(ALMOST_READY_REASON);
  });
});

// ==========================================================================
// §19 verdict engine — READY + verdict precedence
// ==========================================================================

describe('evaluateCompatibility — READY + verdict precedence', () => {
  it('compatible repo → READY with no issues', () => {
    const result = evaluateCompatibility(analyseRepo(readyTree));
    expect(result.verdict).toBe('READY');
    expect(result.issues).toEqual([]);
    expect(result.reason).toBe(READY_REASON);
  });

  it('plain Redis dependency → READY (supported, not a rejection)', () => {
    const result = evaluateCompatibility(analyseRepo(redisTree));
    expect(result.verdict).toBe('READY');
    expect(codes(result)).toEqual([]);
  });

  it('a blocking rejection outranks a fixable-required issue for the VERDICT, but both are listed', () => {
    const result = evaluateCompatibility(analyseRepo(rejectPlusAttentionTree));
    expect(result.verdict).toBe('NOT_COMPATIBLE');
    // Both required findings are still reported — `issues` is not filtered to
    // the winning severity — but only the blocking one drives the verdict.
    expect(codes(result)).toContain('unsupported-redis-setup');
    expect(codes(result)).toContain('container-setup');
    expect(result.issues.find((i) => i.code === 'unsupported-redis-setup')?.severity).toBe('reject');
    expect(result.issues.find((i) => i.code === 'container-setup')?.severity).toBe('attention');
  });
});

// ==========================================================================
// databaseState metadata — none | postgres | unsupported
// ==========================================================================

describe('databaseState metadata', () => {
  it('postgres app → databaseState "postgres"', () => {
    expect(analyseRepo(readyTree).metadata['databaseState']).toBe('postgres');
  });

  it('no-database app → databaseState "none"', () => {
    expect(analyseRepo(noPostgresTree).metadata['databaseState']).toBe('none');
  });

  it('weak MySQL (no connection evidence) → databaseState "none" and a needs-input ambiguity', () => {
    // A MySQL-only tree (no pg): with both drivers the engine is a
    // configuration choice and databaseState is "postgres".
    const mysqlOnlyTree: FileTree = {
      'Dockerfile': readyTree['Dockerfile']!,
      'package.json': JSON.stringify({
        name: 'mysql-app',
        scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
        dependencies: { express: '^4.18.0', mysql2: '^3.9.0' },
      }),
      'src/index.ts': readyTree['src/index.ts']!,
    };
    const result = analyseRepo(mysqlOnlyTree);
    expect(result.metadata['databaseState']).toBe('none');
    const mysqlMeta = result.metadata['mysql'] as { required: boolean; detected: boolean };
    expect(mysqlMeta.detected).toBe(true);
    expect(mysqlMeta.required).toBe(false);
  });

  it('strong MySQL (a mysql:// URL) → databaseState "mysql" (Phase 4B)', () => {
    const mysqlRequiredTree: FileTree = {
      'Dockerfile': readyTree['Dockerfile']!,
      'package.json': JSON.stringify({
        name: 'mysql-app',
        scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit push' },
        dependencies: { express: '^4.18.0', mysql2: '^3.9.0' },
      }),
      'src/index.ts': readyTree['src/index.ts']!,
      '.env.example': 'DATABASE_URL=mysql://localhost:3306/app\n',
    };
    expect(analyseRepo(mysqlRequiredTree).metadata['databaseState']).toBe('mysql');
  });

  it('unsupported Redis (cache, not a DB) does not flip databaseState to unsupported', () => {
    // A Postgres app that also has an unsupported Redis config stays "postgres"
    // for DB purposes — the Redis rejection still drives the NOT_COMPATIBLE
    // verdict, but databaseState reflects the database, not the cache.
    expect(analyseRepo(unsupportedRedisTree).metadata['databaseState']).toBe('postgres');
  });
});

// ==========================================================================
// §20 guard — purity invariant (AI can NEVER flip a deterministic verdict)
// ==========================================================================

describe('evaluateCompatibility — purity invariant (§20)', () => {
  it('same input → same verdict, synchronously (no AI, no randomness)', () => {
    const analysis = analyseRepo(multiRejectTree);
    const first = evaluateCompatibility(analysis);
    const second = evaluateCompatibility(analysis);
    // Deep-equal: verdict, reason, and issues are identical across calls.
    expect(second).toEqual(first);
    // The verdict is a plain value, not a Promise — nothing async (no AI call).
    expect(first).not.toBeInstanceOf(Promise);
  });

  it('deterministic across every verdict class', () => {
    for (const tree of [readyTree, noMigrationTree, unsupportedRedisTree]) {
      const a = evaluateCompatibility(analyseRepo(tree));
      const b = evaluateCompatibility(analyseRepo(tree));
      expect(b).toEqual(a);
    }
  });

  it('falls back to unsupported-database-other for unknown rejection dependencies', () => {
    const result: AnalysisResult = {
      findings: [
        { detector: 'dockerfile', detected: true },
        { detector: 'health-endpoint', detected: true },
        { detector: 'migration-command', detected: true },
        { detector: 'postgresql', detected: true },
        { detector: 'local-filesystem', detected: false },
      ],
      rejections: [
        {
          detected: true,
          dependency: 'some-unknown-db',
          reason:
            'Unsupported database driver: some-unknown-db. Deployz does not support this database.',
        },
      ],
      metadata: {},
    };
    const out = evaluateCompatibility(result);
    expect(out.verdict).toBe('NOT_COMPATIBLE');
    expect(codes(out)).toContain('unsupported-database-other');
  });
});

// ==========================================================================
// Verdict persistence → applications columns
// ==========================================================================

describe('persistVerdict — DB persistence', () => {
  it('writes analysisStatus=COMPLETE + READY verdict + reason + metadata', async () => {
    const update = vi.fn<VerdictStore['update']>();
    const analysis = analyseRepo(readyTree);

    await persistVerdict('app-123', analysis, { update });

    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith('app-123', {
      analysisStatus: 'COMPLETE',
      compatibilityStatus: 'READY',
      compatibilityReason: READY_REASON,
      detectedMetadata: analysis.metadata,
    });
  });

  it('writes NOT_COMPATIBLE verdict with the blocking-state reason', async () => {
    const update = vi.fn<VerdictStore['update']>();
    const analysis = analyseRepo(unsupportedRedisTree);

    await persistVerdict('app-456', analysis, { update });

    const [applicationId, values] = update.mock.calls[0] ?? [];
    expect(applicationId).toBe('app-456');
    expect(values?.analysisStatus).toBe('COMPLETE');
    expect(values?.compatibilityStatus).toBe('NOT_COMPATIBLE');
    expect(values?.compatibilityReason).toBe(NEEDS_CHANGES_REASON);
    expect(values?.detectedMetadata).toEqual(analysis.metadata);
  });

  it('writes NEEDS_ATTENTION verdict with the almost-ready reason', async () => {
    const update = vi.fn<VerdictStore['update']>();
    const analysis = analyseRepo(noDockerfileTree);

    await persistVerdict('app-789', analysis, { update });

    const [, values] = update.mock.calls[0] ?? [];
    expect(values?.compatibilityStatus).toBe('NEEDS_ATTENTION');
    expect(values?.compatibilityReason).toBe(ALMOST_READY_REASON);
  });
});

// ==========================================================================
// Enum parity with @deployz/db
// ==========================================================================

describe('CompatibilityVerdict parity with @deployz/db', () => {
  it('verdict vocabulary === compatibilityStatusEnum (no drift)', () => {
    const verdicts: CompatibilityVerdict[] = ['READY', 'NEEDS_ATTENTION', 'NOT_COMPATIBLE'];
    expect([...verdicts].sort()).toEqual([...compatibilityStatusEnum.enumValues].sort());
  });
});
