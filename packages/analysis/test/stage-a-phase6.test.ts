import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/analyser.js';
import { detectDeclaredWorkerCommands, detectWorker } from '../src/detectors.js';
import { checkMysql, checkOtherUnsupportedDatabases, checkPulumi, checkTerraform } from '../src/rejection.js';

// Stage A phase-6 regression fixtures — the hardening batch from the unseen
// set, COMP-015, 036, 037. The Stage A corpus and its findings registry were
// removed on 2026-10-18; see docs/testing/compatibility.md for the Docker
// run-and-check test.

describe('COMP-015 — worker code and declared worker processes outside Node', () => {
  it('detects job queues declared in Ruby, Python, Go, JVM and Elixir manifests', () => {
    expect(detectWorker({ Gemfile: "gem 'rails'\ngem 'sidekiq'\n" }).value).toEqual(['sidekiq']);
    expect(detectWorker({ 'requirements.txt': 'django==5.0\ncelery==5.4\n' }).value).toEqual(['celery']);
    expect(detectWorker({ 'go.mod': 'module x\n\nrequire github.com/hibiken/asynq v0.24.0\n' }).value).toEqual(['asynq']);
    expect(detectWorker({ 'build.gradle': 'implementation "org.quartz-scheduler:quartz:2.3.2"\n' }).value).toEqual(['quartz (JVM)']);
    expect(detectWorker({ 'mix.exs': '{:oban, "~> 2.17"}\n' }).value).toEqual(['oban (Elixir)']);
    // An in-process cron scheduler is not worker code.
    expect(detectWorker({ 'go.mod': 'module x\n\nrequire github.com/robfig/cron/v3 v3.0.1\n' })).toMatchObject({ detected: false });
    expect(detectWorker({ 'package.json': JSON.stringify({ dependencies: { croner: '^8.0.0' } }) })).toMatchObject({ detected: false });
  });

  it('detects a queue-worker command in a Procfile, Dockerfile or Compose file, not in a test helper', () => {
    expect(detectWorker({ Procfile: 'web: bundle exec puma\nworker: bundle exec sidekiq\n' }).value).toEqual([
      'queue worker command',
      'declared worker process (Procfile)',
    ]);
    expect(detectWorker({ 'docker/entrypoint.sh': 'php artisan queue:work --tries=3 &\n' }).value).toEqual(['queue worker command']);
    expect(detectWorker({ 'tests/support/run.sh': 'celery -A app worker\n' })).toMatchObject({ detected: false });
  });

  it('resolves declared worker processes from Procfile processes and Compose commands, not from package names', () => {
    expect(detectDeclaredWorkerCommands({ Procfile: 'web: node server.js\nworker: node worker.js\n' })).toEqual([
      { id: 'worker', command: 'node worker.js', source: 'Procfile' },
    ]);
    const compose: FileTree = {
      'docker-compose.yml': 'services:\n  rails:\n    image: chatwoot/chatwoot\n  sidekiq:\n    image: chatwoot/chatwoot\n    command: ["bundle", "exec", "sidekiq", "-C", "config/sidekiq.yml"]\n  postgres:\n    image: postgres:16\n',
    };
    expect(detectDeclaredWorkerCommands(compose)).toEqual([
      { id: 'sidekiq', command: 'bundle exec sidekiq -C config/sidekiq.yml', source: 'docker-compose.yml sidekiq' },
    ]);
    expect(detectWorker(compose).value).toEqual(['queue worker command', 'declared worker process (docker-compose.yml sidekiq)']);
    // linkwarden runs `apps/worker` inside its web container: a package named
    // worker with a start script declares nothing.
    const workspace: FileTree = {
      'package.json': JSON.stringify({ name: 'linkwarden', workspaces: ['apps/*'] }),
      'apps/web/package.json': JSON.stringify({ name: '@linkwarden/web', scripts: { start: 'next start' } }),
      'apps/worker/package.json': JSON.stringify({ name: '@linkwarden/worker', scripts: { start: 'node dist/index.js' } }),
    };
    expect(detectDeclaredWorkerCommands(workspace)).toEqual([]);
    // A one-shot queue CLI is not a worker command.
    expect(
      detectDeclaredWorkerCommands({ 'docker-compose.yml': 'services:\n  app:\n    image: myapp\n    command: rq info\n' }),
    ).toEqual([]);
    expect(
      detectDeclaredWorkerCommands({ 'docker-compose.yml': 'services:\n  app:\n    image: myapp\n    command: rq worker high default\n' }),
    ).toEqual([{ id: 'app', command: 'rq worker high default', source: 'docker-compose.yml app' }]);
  });
});

describe('COMP-036 — IaC in non-runtime directories is not the app deployment', () => {
  it('ignores a Pulumi program under benchmarks/ and a Terraform module under examples/', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ dependencies: { express: '^4.0.0' } }),
      'benchmarks/pulumi/package.json': JSON.stringify({ dependencies: { '@pulumi/aws': '^6.0.0' } }),
      'examples/terraform/main.tf': 'resource "aws_instance" "x" {}\n',
    };
    expect(checkPulumi(tree)).toMatchObject({ detected: false });
    expect(checkTerraform(tree)).toMatchObject({ detected: false });
    expect(checkPulumi({ 'package.json': JSON.stringify({ dependencies: { '@pulumi/aws': '^6.0.0' } }) })).toMatchObject({ detected: true });
    expect(checkTerraform({ 'main.tf': 'resource "aws_instance" "x" {}\n' })).toMatchObject({ detected: true });
  });
});

describe('COMP-037 — engines declared outside Node manifests', () => {
  it('MySQL drivers in Python, JVM or Elixir manifests and a Laravel mysql default are SUPPORTED (Phase 4B)', () => {
    expect(checkMysql({ 'requirements.txt': 'Flask==3.0\nPyMySQL==1.1\n' }).detected).toBe(false);
    expect(checkMysql({ 'pom.xml': '<artifactId>mysql-connector-j</artifactId>\n' }).detected).toBe(false);
    expect(checkMysql({ 'config/database.php': "'default' => env('DB_CONNECTION', 'mysql'),\n", 'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11' } }) }).detected).toBe(false);
    expect(checkMysql({ '.env.example': 'APP_KEY=\nDB_CONNECTION=mysql\nDB_HOST=localhost\n' }).detected).toBe(false);
  });

  it('still rejects MariaDB-specific drivers and a Laravel mariadb default (Phase 4B)', () => {
    expect(checkMysql({ 'mix.exs': '{:myxql, ">= 0.0.0"}\n' })).toMatchObject({ detected: true, dependency: 'mariadb' });
    expect(checkMysql({ 'pom.xml': '<artifactId>mariadb-java-client</artifactId>\n' })).toMatchObject({ detected: true, dependency: 'mariadb' });
    expect(
      checkMysql({ 'config/database.php': "'default' => env('DB_CONNECTION', 'mariadb'),\n", 'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11' } }) }),
    ).toMatchObject({ detected: true, dependency: 'mariadb' });
    expect(checkMysql({ '.env.example': 'APP_KEY=\nDB_CONNECTION=mariadb\nDB_HOST=localhost\n' })).toMatchObject({ detected: true, dependency: 'mariadb' });
  });

  it('keeps a configurable engine and a test-only driver', () => {
    expect(checkMysql({ 'requirements.txt': 'PyMySQL==1.1\npsycopg2-binary==2.9\n' })).toMatchObject({ detected: false });
    expect(
      checkMysql({ 'config/database.php': "'default' => env('DB_CONNECTION', 'mysql'),\n", 'composer.json': JSON.stringify({ require: { 'ext-pdo_pgsql': '*' } }) }),
    ).toMatchObject({ detected: false });
    expect(checkMysql({ 'tests/fixtures/requirements.txt': 'PyMySQL==1.1\n' })).toMatchObject({ detected: false });
    expect(checkMysql({ 'tests/fixtures/config/database.php': "'default' => env('DB_CONNECTION', 'mysql'),\n" })).toMatchObject({ detected: false });
  });

  it('rejects ClickHouse with corroboration and an embedded JVM database with no PostgreSQL driver', () => {
    const plausible: FileTree = {
      'mix.exs': '{:ecto_ch, "~> 0.3"}\n{:postgrex, ">= 0.0.0"}\n',
      'docker-compose.yml': 'services:\n  plausible:\n    build: .\n  plausible_events_db:\n    image: clickhouse/clickhouse-server:24.3\n',
    };
    expect(checkOtherUnsupportedDatabases(plausible)).toMatchObject({ detected: true, dependency: 'clickhouse' });
    expect(checkOtherUnsupportedDatabases({ 'mix.exs': '{:ecto_ch, "~> 0.3"}\n{:postgrex, ">= 0.0.0"}\n' })).toMatchObject({
      detected: true,
      dependency: 'clickhouse',
    });
    expect(checkOtherUnsupportedDatabases({ 'package.json': '{"dependencies":{"@clickhouse/client":"1.0.0"}}' })).toMatchObject({
      detected: false,
    });
    expect(checkOtherUnsupportedDatabases({ 'build.gradle': 'runtimeOnly "com.h2database:h2"\n' })).toMatchObject({ detected: true, dependency: 'h2' });
    expect(checkOtherUnsupportedDatabases({ 'build.gradle': 'runtimeOnly "com.h2database:h2"\nruntimeOnly "org.postgresql:postgresql"\n' })).toMatchObject({
      detected: false,
    });
  });
});
