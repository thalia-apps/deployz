import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/analyser.js';
import { analyseRepo } from '../src/analyser.js';
import { assessPostgres, detectStartupMigrationEvidence, selectMigrationScript } from '../src/detectors.js';

const DOCKERFILE = ['FROM node:20-alpine', 'EXPOSE 3000', 'CMD ["node", "dist/index.js"]', ''].join('\n');

/** A PostgreSQL app whose package.json carries a deploy-shaped migration script. */
function app(extra: FileTree, scripts: Record<string, string> = { 'db:migrate': 'knex migrate:latest' }): FileTree {
  return {
    'Dockerfile': DOCKERFILE,
    'package.json': JSON.stringify({
      name: 'app',
      scripts: { start: 'node dist/index.js', ...scripts },
      dependencies: { express: '^4.18.0', pg: '^8.12.0', knex: '^3.0.0' },
      devDependencies: {},
    }),
    '.env.example': 'DATABASE_URL=postgresql://localhost:5432/app\n',
    ...extra,
  };
}

describe('in-process startup migrations', () => {
  const cases: [string, FileTree, string][] = [
    ['knex migrate.latest()', { 'src/boot.ts': 'await knex.migrate.latest();\n' }, 'knex migrate.latest()'],
    [
      'umzug up()',
      { 'server/db.ts': "const migrator = new Umzug({ migrations: { glob: 'm/*.js' } });\nawait migrator.up();\n" },
      'umzug up()',
    ],
    [
      'drizzle migrate()',
      { 'src/db.ts': "import { migrate } from 'drizzle-orm/node-postgres/migrator';\nawait migrate(db, { migrationsFolder: 'drizzle' });\n" },
      'drizzle migrate()',
    ],
    [
      'db-migrate getInstance().up()',
      { 'src/migrator.ts': "import dbMigrate from 'db-migrate';\nconst dbm = dbMigrate.getInstance(true);\nawait dbm.up();\n" },
      'db-migrate up()',
    ],
    [
      'a migration runner call',
      { 'src/main.ts': 'await runMigrations({ db });\n' },
      'migration runner call',
    ],
    [
      'golang-migrate Up()',
      { 'cmd/server/main.go': 'import "github.com/golang-migrate/migrate/v4"\nm, _ := migrate.New(src, url)\nm.Up()\n' },
      'golang-migrate Up()',
    ],
    ['django call_command', { 'app/boot.py': "call_command('migrate', interactive=False)\n" }, 'django call_command migrate'],
  ];

  it.each(cases)('detects %s in runtime source as startup evidence', (_name, extra, pattern) => {
    expect(detectStartupMigrationEvidence(app(extra))).toEqual(
      expect.arrayContaining([expect.objectContaining({ pattern, fromDockerCommand: true })]),
    );
  });

  it('chooses mode startup over the package.json migration script and never persists a command', () => {
    const tree = app({ 'src/boot.ts': 'await knex.migrate.latest();\n' });
    expect(selectMigrationScript(tree)).toBeDefined();
    expect(analyseRepo(tree).metadata['migrationMode']).toBe('startup');
  });

  it('follows a script that the start script and the Dockerfile chain run (node db/init.js)', () => {
    const tree = app(
      {
        'server/start.sh': 'node db/init.js\nexec node app.js\n',
        'server/db/init.js': 'await knex.migrate.latest();\nawait knex.seed.run();\n',
        'Dockerfile': 'FROM node:20\nCOPY server .\nEXPOSE 3000\nCMD ["./start.sh"]\n',
      },
      { 'db:init': 'node db/init.js' },
    );
    expect(detectStartupMigrationEvidence(tree)).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'server/db/init.js', fromDockerCommand: true })]),
    );
    const started = app({ 'db/init.js': 'await knex.migrate.latest();\n' }, { start: 'node db/init.js && node app.js' });
    expect(detectStartupMigrationEvidence(started)).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'db/init.js' })]),
    );
  });

  describe('negative controls', () => {
    it('ignores a migrator that only a scripts/ CLI file or a package.json CLI script runs', () => {
      expect(detectStartupMigrationEvidence(app({ 'scripts/migrate.ts': 'await knex.migrate.latest();\n' }))).toEqual([]);
      const cli = app(
        { 'src/db/migrate.ts': "import { migrate } from 'drizzle-orm/node-postgres/migrator';\nawait migrate(db, {});\n" },
        { 'db:migrate': 'tsx src/db/migrate.ts' },
      );
      expect(detectStartupMigrationEvidence(cli)).toEqual([]);
    });

    it('does not treat sequelize.sync() or migration definitions as a migration', () => {
      const tree = app({
        'src/db.ts': 'await sequelize.sync();\n',
        'src/migrations/001-init.ts': 'await knex.migrate.latest();\n',
        'src/db.test.ts': 'await knex.migrate.latest();\n',
      });
      expect(detectStartupMigrationEvidence(tree)).toEqual([]);
    });

    it('does not take a runner declaration or CREATE TABLE IF NOT EXISTS as a migration, and keeps the pre-deploy command', () => {
      const tree = app({
        'src/repositories/database.repository.ts': 'export class DatabaseRepository {\n  async runMigrations(): Promise<void> {}\n}\n',
        'src/db.ts': 'await pool.query("CREATE TABLE IF NOT EXISTS users (id serial primary key)");\n',
      });
      expect(detectStartupMigrationEvidence(tree)).toEqual([]);
      expect(analyseRepo(tree).metadata['migrationMode']).toBe('pre_deploy');
    });

    it('keeps the command of an app that only migrates before deploy', () => {
      const tree = app({ 'src/index.ts': 'app.listen(3000);\n' });
      expect(selectMigrationScript(tree)?.[1]).toBe('knex migrate:latest');
      expect(analyseRepo(tree).metadata['migrationMode']).toBe('pre_deploy');
    });
  });
});

describe('PostgreSQL option next to a SQLite default', () => {
  const tree: FileTree = {
    'package.json': JSON.stringify({ name: 'multi', dependencies: { 'better-sqlite3': '^11.0.0', mysql2: '^3.0.0', pg: '^8.0.0' } }),
    'packages/db/configs/postgresql.config.ts': 'export default { dialect: "postgresql", schema: "./schema" };\n',
    'packages/db/configs/mysql.config.ts': 'export default { dialect: "mysql", schema: "./schema" };\n',
  };

  it('requires PostgreSQL when a postgresql dialect config accompanies the driver', () => {
    expect(assessPostgres(tree).required).toBe(true);
  });

  it('does not require PostgreSQL for a driver without a configured dialect', () => {
    const { 'packages/db/configs/postgresql.config.ts': _config, ...driverOnly } = tree;
    expect(assessPostgres(driverOnly).required).toBe(false);
  });
});

describe('boot script migrations', () => {
  const entrypoint = (script: string, extra: FileTree = {}): FileTree => ({
    'Dockerfile': 'FROM php:8.3-fpm\nCOPY . /app\nCOPY docker/entrypoint.sh /entrypoint.sh\nCMD ["/entrypoint.sh"]\n',
    'docker/entrypoint.sh': `#!/bin/sh\nset -e\n${script}\nexec php-fpm\n`,
    ...extra,
  });
  const DOCTRINE = { 'composer.json': JSON.stringify({ require: { 'doctrine/migrations': '^3.9' } }) };

  it('detects an interpreter that runs the app migrate script file', () => {
    expect(detectStartupMigrationEvidence(entrypoint('node ./db/migrations/$DB_DIALECT/migrate.cjs ./db/migrations/$DB_DIALECT'))).toEqual(
      expect.arrayContaining([expect.objectContaining({ pattern: 'migrate script file', fromDockerCommand: true })]),
    );
  });

  it.each([['/opt/app/bin/console -n app:install'], ['php vendor/bin/app-installer init --no-interaction']])(
    'detects the install command %s next to a migration library',
    (command) => {
      expect(detectStartupMigrationEvidence(entrypoint(command, DOCTRINE))).toEqual(
        expect.arrayContaining([expect.objectContaining({ pattern: 'install command with a migration library', fromDockerCommand: true })]),
      );
    },
  );

  it('does not count an install command without a migration library, or a package install', () => {
    expect(detectStartupMigrationEvidence(entrypoint('/opt/app/bin/console -n app:install'))).toEqual([]);
    expect(detectStartupMigrationEvidence(entrypoint('composer install --no-dev\napk add --no-cache git', DOCTRINE))).toEqual([]);
  });
});
