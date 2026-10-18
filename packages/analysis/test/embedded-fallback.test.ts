import { describe, expect, it } from 'vitest';
import { assessPostgres, TREE_PATHS, type FileTree } from '../src/index.js';

const GO_MOD = 'module example.com/vikunja\n\nrequire (\n\tgithub.com/lib/pq v1.10.9\n\tgithub.com/mattn/go-sqlite3 v1.14.22\n)\n';

const viperConfig = (defaultLine: string): string =>
  [
    'package config',
    'import "github.com/spf13/viper"',
    'func InitDefaultConfig() {',
    '\tviper.SetEnvPrefix("vikunja")',
    '\tviper.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))',
    '\tviper.AutomaticEnv()',
    `\t${defaultLine}`,
    '}',
    '',
  ].join('\n');

const typedKeys = 'const (\n\tDatabaseType Key = `database.type`\n)\n';

describe('a Go PostgreSQL driver is corroborated by a runtime engine selector with a known default', () => {
  it('requires PostgreSQL when the app defaults its engine selector to SQLite (vikunja shape)', () => {
    const tree: FileTree = {
      'go.mod': GO_MOD,
      'pkg/config/config.go': typedKeys + viperConfig('DatabaseType.setDefault("sqlite")'),
    };
    expect(assessPostgres(tree).required).toBe(true);
  });

  it('requires PostgreSQL when the selector default is PostgreSQL', () => {
    const tree: FileTree = {
      'go.mod': GO_MOD,
      'pkg/config/config.go': typedKeys + viperConfig('DatabaseType.setDefault("postgres")'),
    };
    expect(assessPostgres(tree).required).toBe(true);
  });

  it('does not require PostgreSQL without an engine selector', () => {
    const tree: FileTree = { 'go.mod': GO_MOD, 'pkg/config/config.go': viperConfig('viper.SetDefault("service.port", "3456")') };
    expect(assessPostgres(tree).required).toBe(false);
  });

  it('does not count a test-only or vendored selector', () => {
    const tree: FileTree = {
      'go.mod': GO_MOD,
      'pkg/config/config_test.go': typedKeys + viperConfig('DatabaseType.setDefault("sqlite")'),
      'vendor/example.com/cfg/config.go': typedKeys + viperConfig('DatabaseType.setDefault("sqlite")'),
    };
    expect(assessPostgres(tree).required).toBe(false);
  });

  it('does not require PostgreSQL for a SQLite selector when no PostgreSQL driver is declared', () => {
    const node: FileTree = {
      'package.json': JSON.stringify({ dependencies: { sqlite3: '^5' } }),
      'src/config.js': "const type = process.env.DB_TYPE || 'sqlite3';\n",
    };
    const go: FileTree = {
      'go.mod': 'module example.com/app\n\nrequire github.com/mattn/go-sqlite3 v1.14.22\n',
      'pkg/config/config.go': typedKeys + viperConfig('DatabaseType.setDefault("sqlite")'),
    };
    expect(assessPostgres(node).required).toBe(false);
    expect(assessPostgres(go).required).toBe(false);
  });
});

describe('a Go PostgreSQL driver whose importer the bounded fetch did not read', () => {
  const withPaths = (tree: FileTree, paths: string[]): FileTree => Object.assign(tree, { [TREE_PATHS]: paths });
  const fetched: FileTree = {
    'go.mod': GO_MOD,
    'main.go': 'package main\n\nfunc main() { run() }\n',
  };

  it('keeps PostgreSQL required when a runtime Go file was not fetched (casdoor shape)', () => {
    const tree = withPaths({ ...fetched }, ['go.mod', 'main.go', 'object/ormer.go']);
    expect(assessPostgres(tree).required).toBe(true);
  });

  it('drops the requirement when every runtime Go file was read and none imports the driver', () => {
    const tree = withPaths({ ...fetched }, ['go.mod', 'main.go', 'object/ormer_test.go', 'vendor/x/y.go']);
    expect(assessPostgres(tree).required).toBe(false);
  });
});

describe('a Go PostgreSQL driver next to an in-memory store choice', () => {
  const storeTypes = 'package storage\n\ntype Type string\n\nconst (\n\tTypeMemory   Type = "memory"\n\tTypeSQLite   Type = "sqlite"\n\tTypePostgres Type = "postgres"\n)\n';
  const sqlStore = 'package sql\n\nimport _ "github.com/lib/pq"\n';

  it('does not require PostgreSQL when the app defaults to an in-memory store (gatus shape)', () => {
    const tree: FileTree = { 'go.mod': GO_MOD, 'storage/type.go': storeTypes, 'storage/store/sql/sql.go': sqlStore };
    expect(assessPostgres(tree).required).toBe(false);
  });

  it('keeps PostgreSQL required when the imported driver has no in-memory alternative', () => {
    const tree: FileTree = { 'go.mod': GO_MOD, 'storage/store/sql/sql.go': sqlStore };
    expect(assessPostgres(tree).required).toBe(true);
  });
});
