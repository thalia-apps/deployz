/**
 * Cold-start shortcut: whether drizzle's migrator has nothing left to apply.
 *
 * The migrator applies a journal entry only when its `when` timestamp is newer
 * than the `created_at` of the last row in `drizzle.__drizzle_migrations`. So
 * when that last row is at least as new as the newest journal entry, running
 * the migrator is a no-op, and one cheap query replaces re-reading every
 * bundled migration on every cold start.
 *
 * Fail-safe: any error (missing table on a fresh database, connection hiccup)
 * answers "not up to date", and the caller runs the migrator exactly as before.
 */
export interface MigrationQueryable {
  query(text: string): Promise<{ rows: { created_at: string | number | null }[] }>;
}

export async function migrationsUpToDate(
  db: MigrationQueryable,
  journal: { entries: readonly { when: number }[] },
): Promise<boolean> {
  if (journal.entries.length === 0) return false;
  try {
    const newestBundled = Math.max(...journal.entries.map((entry) => entry.when));
    const result = await db.query(
      'SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1',
    );
    const applied = result.rows[0]?.created_at;
    if (applied === undefined || applied === null) return false;
    return Number(applied) >= newestBundled;
  } catch {
    return false;
  }
}

/** Fixed key of the session advisory lock that serialises migrator runs. */
export const MIGRATION_LOCK_KEY = 7_243_150_055;

export interface MigrationLockClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
  release(): void;
}

/**
 * Runs `run` while this connection holds the migration advisory lock.
 * Containers that cold-start together otherwise run the same migration at the
 * same time, and `CREATE TABLE IF NOT EXISTS` is not safe under concurrency:
 * the loser fails with 23505 on pg_type (seen in production on 0055).
 */
export async function withMigrationLock<T>(
  connect: () => Promise<MigrationLockClient>,
  run: () => Promise<T>,
): Promise<T> {
  const client = await connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      return await run();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
