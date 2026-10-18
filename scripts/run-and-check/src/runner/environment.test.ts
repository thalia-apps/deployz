import { describe, expect, it } from 'vitest';

import { productionEnvironment, productionEnvironmentDetailed, webHostName } from './environment.js';
import { fakeServices, manifest, recipe } from './test-support.js';

const FULL = { database: 'postgres', redis: true, storage: true, workerCommand: 'node worker.js', migrationCommand: 'npm run migrate' } as const;

describe('productionEnvironment', () => {
  it('gives postgres, redis and storage values to the web role', () => {
    const { env, secretNames, unresolved } = productionEnvironmentDetailed({
      manifest: manifest(FULL),
      role: 'web',
      services: fakeServices(),
      recipe: recipe(),
    });
    expect(env['DATABASE_URL']).toBe('postgresql://deployz_app:pgPASSWORD0123@repo-001-postgres:5432/deployz?sslmode=require');
    expect(env['DATABASE_HOST']).toBe('repo-001-postgres');
    expect(env['DATABASE_PASSWORD']).toBe('pgPASSWORD0123');
    expect(env['REDIS_URL']).toBe('redis://repo-001-valkey:6379');
    expect(env['S3_BUCKET']).toBe('test-bucket');
    expect(env['AWS_REGION']).toBe('us-east-1');
    expect(env['PORT']).toBe('3000');
    expect(env['PGSSLROOTCERT']).toBe('/deployz/certs/rds-ca-bundle.pem');
    expect(env['APP_API_KEY']).toMatch(/^[\w-]{43}$/);
    expect(secretNames).toEqual(expect.arrayContaining(['DATABASE_URL', 'DATABASE_PASSWORD', 'APP_API_KEY', 'APP_SIGNING_SECRET']));
    expect(secretNames).not.toContain('DATABASE_HOST');
    expect(unresolved).toEqual([]);
  });

  it('leaves no intrinsic object or template text in any value', () => {
    for (const role of ['web', 'worker', 'migration'] as const) {
      const { env } = productionEnvironment({ manifest: manifest(FULL), role, services: fakeServices(), recipe: recipe() });
      for (const value of Object.values(env)) {
        expect(typeof value).toBe('string');
        expect(value).not.toMatch(/\{\{resolve|Fn::|\[object/);
      }
    }
  });

  it('gives the worker and migration roles the same shared set as web', () => {
    const services = fakeServices();
    const web = productionEnvironment({ manifest: manifest(FULL), role: 'web', services, recipe: recipe() });
    const worker = productionEnvironment({ manifest: manifest(FULL), role: 'worker', workerId: 'worker', services, recipe: recipe() });
    const migration = productionEnvironment({ manifest: manifest(FULL), role: 'migration', services, recipe: recipe() });
    expect(worker.env).toEqual(web.env);
    expect(migration.env).toEqual(web.env);
  });

  it('binds an alias name to the managed database URL', () => {
    const { env, secretNames } = productionEnvironment({
      manifest: manifest({ database: 'postgres', aliases: { MEMOS_DSN: 'url' } }),
      role: 'web',
      services: fakeServices(),
      recipe: recipe(),
    });
    expect(env['MEMOS_DSN']).toBe(env['DATABASE_URL']);
    expect(secretNames).toContain('MEMOS_DSN');
  });

  it('uses the MySQL host and password for a mysql database', () => {
    const { env } = productionEnvironment({
      manifest: manifest({ database: 'mysql' }),
      role: 'web',
      services: fakeServices(),
      recipe: recipe(),
    });
    expect(env['DATABASE_URL']).toMatch(/^mysql:\/\/deployz_app:myPASSWORD0123@repo-001-mysql:3306\/deployz/);
    expect(env['MYSQL_HOST']).toBe('repo-001-mysql');
    expect(env['MYSQL_URL']).toBe(env['DATABASE_URL']);
    expect(env['PGSSLROOTCERT']).toBeUndefined();
  });

  it('gives no database or cache value when the application has none', () => {
    const { env, secretNames } = productionEnvironment({ manifest: manifest(), role: 'web', services: fakeServices(), recipe: recipe() });
    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['REDIS_URL']).toBeUndefined();
    expect(env['NODE_ENV']).toBe('production');
    expect(secretNames).not.toContain('DATABASE_URL');
  });

  it('adds the MinIO values as harness-only and keeps their keys secret', () => {
    const { env, harnessOnly, secretNames } = productionEnvironment({
      manifest: manifest(),
      role: 'web',
      services: fakeServices(),
      recipe: recipe(),
    });
    expect(harnessOnly).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_S3', 'AWS_S3_FORCE_PATH_STYLE']);
    expect(env['AWS_ENDPOINT_URL_S3']).toBe('http://repo-001-minio:9000');
    expect(env['AWS_S3_FORCE_PATH_STYLE']).toBe('true');
    expect(secretNames).toEqual(expect.arrayContaining(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']));
  });

  it('adds vendor inputs: fixed values as given, generated values per format and secret', () => {
    const services = fakeServices();
    const input = recipe({
      vendorInputs: [
        { name: 'ADMIN_EMAIL', source: { kind: 'fixed', value: 'admin@example.test' } },
        { name: 'K_HEX32', source: { kind: 'generated', format: 'hex32' } },
        { name: 'K_HEX64', source: { kind: 'generated', format: 'hex64' } },
        { name: 'K_B64', source: { kind: 'generated', format: 'base64-32' } },
        { name: 'K_B64URL', source: { kind: 'generated', format: 'base64url-32' } },
        { name: 'K_UUID', source: { kind: 'generated', format: 'uuid' } },
        { name: 'K_ALNUM', source: { kind: 'generated', format: 'alnum-32' } },
      ],
    });
    const web = productionEnvironment({ manifest: manifest(), role: 'web', services, recipe: input });
    expect(web.env['ADMIN_EMAIL']).toBe('admin@example.test');
    expect(web.env['K_HEX32']).toMatch(/^[0-9a-f]{32}$/);
    expect(web.env['K_HEX64']).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(web.env['K_B64']!, 'base64')).toHaveLength(32);
    expect(web.env['K_B64URL']).toMatch(/^[\w-]{43}$/);
    expect(web.env['K_UUID']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(web.env['K_ALNUM']).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(web.secretNames).toContain('K_HEX32');
    expect(web.secretNames).not.toContain('ADMIN_EMAIL');
    const again = productionEnvironment({ manifest: manifest({ workerCommand: 'node worker.js' }), role: 'worker', services, recipe: input });
    expect(again.env['K_HEX64']).toBe(web.env['K_HEX64']);
    const otherRun = productionEnvironment({ manifest: manifest(), role: 'web', services: fakeServices(), recipe: input });
    expect(otherRun.env['K_HEX64']).not.toBe(web.env['K_HEX64']);
  });

  it('names the web container after the service set', () => {
    expect(webHostName(fakeServices('F3'))).toBe('F3-web');
  });
});
