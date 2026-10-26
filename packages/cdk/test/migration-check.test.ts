import { describe, expect, it } from 'vitest';

import { MIGRATION_LOCK_KEY, migrationsUpToDate, withMigrationLock } from '../src/lambda/migration-check';

const journal = { entries: [{ when: 100 }, { when: 300 }, { when: 200 }] };
const dbReturning = (created_at: string | number | null | undefined) => ({
  query: async () => ({ rows: created_at === undefined ? [] : [{ created_at }] }),
});

describe('migrationsUpToDate', () => {
  it('is true when the last applied migration is the newest bundled one (bigint arrives as a string)', async () => {
    expect(await migrationsUpToDate(dbReturning('300'), journal)).toBe(true);
    expect(await migrationsUpToDate(dbReturning(400), journal)).toBe(true);
  });

  it('is false when a bundled migration is newer than the last applied one', async () => {
    expect(await migrationsUpToDate(dbReturning('299'), journal)).toBe(false);
  });

  it('is false for an empty migrations table or an empty journal', async () => {
    expect(await migrationsUpToDate(dbReturning(undefined), journal)).toBe(false);
    expect(await migrationsUpToDate(dbReturning(null), journal)).toBe(false);
    expect(await migrationsUpToDate(dbReturning(300), { entries: [] })).toBe(false);
  });

  it('fails safe: a query error means run the migrator', async () => {
    const broken = {
      query: async () => {
        throw new Error('relation "drizzle.__drizzle_migrations" does not exist');
      },
    };
    expect(await migrationsUpToDate(broken, journal)).toBe(false);
  });
});

describe('withMigrationLock', () => {
  function recordingClient(calls: string[]) {
    return {
      query: async (text: string, values?: unknown[]) => {
        calls.push(`${text} ${JSON.stringify(values)}`);
        return {};
      },
      release: () => {
        calls.push('release');
      },
    };
  }

  it('takes the advisory lock, runs, then unlocks and releases the connection', async () => {
    const calls: string[] = [];
    const result = await withMigrationLock(async () => recordingClient(calls), async () => {
      calls.push('run');
      return 'done';
    });
    expect(result).toBe('done');
    expect(calls).toEqual([
      `SELECT pg_advisory_lock($1) [${MIGRATION_LOCK_KEY}]`,
      'run',
      `SELECT pg_advisory_unlock($1) [${MIGRATION_LOCK_KEY}]`,
      'release',
    ]);
  });

  it('unlocks and releases when the migration fails', async () => {
    const calls: string[] = [];
    await expect(
      withMigrationLock(async () => recordingClient(calls), async () => {
        throw new Error('23505');
      }),
    ).rejects.toThrow('23505');
    expect(calls.slice(-2)).toEqual([`SELECT pg_advisory_unlock($1) [${MIGRATION_LOCK_KEY}]`, 'release']);
  });
});
