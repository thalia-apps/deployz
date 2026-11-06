import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from './test-utils.js';

// Better Auth's Drizzle adapter expects exact table/column shapes — todo 3
// wires Better Auth against these tables, so drift here breaks auth at
// runtime, not at compile time. Assert the contract at the catalog level.
// Shape source: better-auth.com docs (core schema + organization plugin).
describe('Better Auth table shape', () => {
  let client: PGlite | undefined;

  beforeAll(async () => {
    ({ client } = await createTestDb());
  });

  afterAll(async () => {
    await client?.close();
  });

  async function columnsOf(table: string): Promise<string[]> {
    // beforeAll ran by the time any test reaches this — non-null is safe.
    const { rows } = await client!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY column_name`,
      [table],
    );
    return rows.map((r) => r.column_name);
  }

  it('user has the Better Auth core columns + the Deployz last-active tenant pointer + platform role + two-factor flag', async () => {
    expect(await columnsOf('user')).toEqual([
      'created_at',
      'email',
      'email_verified',
      'id',
      'image',
      'last_active_organization_id',
      'name',
      'platform_role',
      'two_factor_enabled',
      'updated_at',
    ]);
  });

  it('session has the Better Auth core columns + organization plugin augmentation + support session pointer', async () => {
    expect(await columnsOf('session')).toEqual([
      'active_organization_id',
      'created_at',
      'expires_at',
      'id',
      'ip_address',
      'support_organization_id',
      'token',
      'updated_at',
      'user_agent',
      'user_id',
    ]);
  });

  it('account has the Better Auth core columns', async () => {
    expect(await columnsOf('account')).toEqual([
      'access_token',
      'access_token_expires_at',
      'account_id',
      'created_at',
      'id',
      'id_token',
      'password',
      'provider_id',
      'refresh_token',
      'refresh_token_expires_at',
      'scope',
      'updated_at',
      'user_id',
    ]);
  });

  it('verification has the Better Auth core columns', async () => {
    expect(await columnsOf('verification')).toEqual([
      'created_at',
      'expires_at',
      'id',
      'identifier',
      'updated_at',
      'value',
    ]);
  });

  it('organization has the plugin columns', async () => {
    expect(await columnsOf('organization')).toEqual([
      'created_at',
      'id',
      'included_production_deployments',
      'logo',
      'metadata',
      'name',
      'slug',
      'updated_at',
    ]);
  });

  it('member has the plugin columns', async () => {
    expect(await columnsOf('member')).toEqual([
      'created_at',
      'id',
      'organization_id',
      'role',
      'user_id',
    ]);
  });

  it('invitation has the plugin columns + Deployz expiry/status fields', async () => {
    expect(await columnsOf('invitation')).toEqual([
      'created_at',
      'email',
      'expires_at',
      'id',
      'inviter_id',
      'organization_id',
      'role',
      'status',
      'updated_at',
    ]);
  });

  it('auth tables use text primary keys (Better Auth generates ids)', async () => {
    const { rows } = await client!.query<{ table_name: string; data_type: string }>(
      `SELECT table_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'id'
         AND table_name IN ('user', 'session', 'account', 'verification', 'organization', 'member', 'invitation')
       ORDER BY table_name`,
    );
    expect(rows.map((r) => `${r.table_name}:${r.data_type}`)).toEqual([
      'account:text',
      'invitation:text',
      'member:text',
      'organization:text',
      'session:text',
      'user:text',
      'verification:text',
    ]);
  });
});
