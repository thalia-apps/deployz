import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';
import { createReleaseRecord } from './releases.js';

describe('createReleaseRecord', () => {
  let client: PGlite | undefined;
  let db: Db;
  let organizationId: string;
  let applicationId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);

    await db.insert(schema.user).values({ id: 'user-releases', name: 'Vendor', email: 'releases@example.test' });
    const [org] = await db
      .insert(schema.organization)
      .values({ id: 'org-releases', name: 'Releases Org', slug: 'releases-org' })
      .returning();
    organizationId = org!.id;

    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App',
        repoFullName: 'acme/releases-app',
        repoUrl: 'https://github.com/acme/releases-app',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('answers 409 RELEASE_VERSION_EXISTS when a request loses the version race', async () => {
    const params = { organizationId, userId: 'user-releases', applicationId, gitSha: 'a'.repeat(40) };

    const results = await Promise.allSettled([
      createReleaseRecord(db, { ...params, version: '1.0.0' }),
      createReleaseRecord(db, { ...params, version: '1.0.0' }),
    ]);


    const rejected =results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ApiError);
    expect(rejected[0]!.reason).toMatchObject({ statusCode: 409, code: 'RELEASE_VERSION_EXISTS' });

    const rows = await db
      .select({ id: schema.releases.id })
      .from(schema.releases)
      .where(eq(schema.releases.applicationId, applicationId));
    expect(rows).toHaveLength(1);
  });
});
