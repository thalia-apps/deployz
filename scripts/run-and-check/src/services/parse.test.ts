import { describe, expect, it } from 'vitest';

import {
  applicationSessions,
  generateMinioKeys,
  generatePassword,
  parseMysqlInspection,
  parsePostgresCounts,
  parseValkeyInspection,
  replaceSecrets,
  serviceNames,
  serviceNamesOf,
} from './parse.js';

describe('serviceNames', () => {
  it('builds the names from id and label', () => {
    const names = serviceNames('repo-006', 'obs1');
    expect(names.network).toBe('rc-repo-006-obs1-net');
    expect(names.postgres).toBe('rc-repo-006-obs1-postgres');
    expect(names.bucket).toBe('rc-repo-006');
    expect(serviceNamesOf('repo-006', names.network)).toEqual(names);
  });

  it('refuses names that are not safe in a script', () => {
    expect(() => serviceNames('Repo_1', 'a')).toThrow();
    expect(() => serviceNames('repo', 'a b')).toThrow();
    expect(() => serviceNamesOf('repo', 'other-net')).toThrow();
  });
});

describe('generated secrets', () => {
  it('makes alphanumeric passwords that differ', () => {
    const a = generatePassword();
    expect(a).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(generatePassword()).not.toBe(a);
  });

  it('makes MinIO keys of the allowed shape', () => {
    const { accessKey, secretKey } = generateMinioKeys();
    expect(accessKey).toMatch(/^[A-Z0-9]{20}$/);
    expect(secretKey).toMatch(/^[A-Za-z0-9]{40}$/);
  });
});

describe('parsers', () => {
  it('subtracts the harness sessions from the PostgreSQL log counts', () => {
    expect(parsePostgresCounts('5\n2\n')).toBe(3);
    expect(parsePostgresCounts('0\n0\n')).toBe(0);
    expect(() => parsePostgresCounts('grep: no such file')).toThrow();
  });

  it('parses the MySQL counter and the tables', () => {
    expect(parseMysqlInspection('Connections\t12\norders\nusers\n')).toEqual({ total: 12, tables: ['orders', 'users'] });
    expect(parseMysqlInspection('Connections\t3\n').tables).toEqual([]);
    expect(() => parseMysqlInspection('ERROR 1045')).toThrow();
  });

  it('parses the Valkey counter and the key count in raw and typed output', () => {
    const info = '# Stats\r\ntotal_connections_received:7\r\ntotal_commands_processed:10\r\n';
    expect(parseValkeyInspection(`${info}\n4\n`)).toEqual({ total: 7, keys: 4 });
    expect(parseValkeyInspection(`${info}(integer) 0\n`)).toEqual({ total: 7, keys: 0 });
    expect(() => parseValkeyInspection('4\n')).toThrow();
  });

  it('counts only application sessions', () => {
    expect(applicationSessions(10, 4, 3)).toBe(3);
    expect(applicationSessions(4, 4, 1)).toBe(0);
  });

  it('removes secrets from text', () => {
    expect(replaceSecrets('bad pw s3cret here', ['s3cret', ''])).toBe('bad pw *** here');
  });
});

describe('serviceNames case', () => {
  it('accepts an upper-case fixture id and names in lower case', () => {
    expect(serviceNames('F1', 'a').network).toBe('rc-f1-a-net');
    expect(serviceNamesOf('F1', 'rc-f1-a-net').network).toBe('rc-f1-a-net');
  });
});
