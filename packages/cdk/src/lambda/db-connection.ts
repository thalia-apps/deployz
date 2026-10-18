/**
 * Shared Lambda → RDS connection for the control plane.
 *
 * Both entry points (api-handler, worker-handler) need the same three things:
 * credentials out of Secrets Manager, the drizzle migrations applied, and a
 * pooled drizzle instance. Keeping one copy means the worker can never run
 * against a schema the API has already migrated past.
 *
 * Drizzle migrations are bundled as text via esbuild's text loader, written
 * to /tmp/drizzle at cold start, and run through the drizzle migrator. The
 * connection URL uses sslmode=require with uselibpqcompat=true because RDS
 * has rds.force_ssl=1 and pg v9 treats sslmode=require as verify-full
 * (rejecting the RDS self-signed cert).
 */
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as schema from '@deployz/db/schema';

// Migration SQL files bundled via esbuild text loader (declared as strings).
// The _journal.json is bundled via esbuild's JSON loader.
import migration0000 from '../../../db/drizzle/0000_parallel_triton.sql';
import migration0001 from '../../../db/drizzle/0001_event_logs_immutable.sql';
import migration0002 from '../../../db/drizzle/0002_dizzy_red_shift.sql';
import migration0003 from '../../../db/drizzle/0003_orange_phalanx.sql';
import migration0004 from '../../../db/drizzle/0004_married_blob.sql';
import migration0005 from '../../../db/drizzle/0005_deep_gambit.sql';
import migration0006 from '../../../db/drizzle/0006_funny_pete_wisdom.sql';
import migration0007 from '../../../db/drizzle/0007_relay_enrollment.sql';
import migration0008 from '../../../db/drizzle/0008_github_installations.sql';
import migration0009 from '../../../db/drizzle/0009_ai_explanation_cache.sql';
import migration0010 from '../../../db/drizzle/0010_needy_nuke.sql';
import migration0011 from '../../../db/drizzle/0011_material_captain_cross.sql';
import migration0012 from '../../../db/drizzle/0012_tense_ultragirl.sql';
import migration0013 from '../../../db/drizzle/0013_natural_marvex.sql';
import migration0014 from '../../../db/drizzle/0014_lethal_bastion.sql';
import migration0015 from '../../../db/drizzle/0015_tan_blue_blade.sql';
import migration0016 from '../../../db/drizzle/0016_married_wolf_cub.sql';
import migration0017 from '../../../db/drizzle/0017_cooing_prowler.sql';
import migration0018 from '../../../db/drizzle/0018_stormy_harrier.sql';
import migration0019 from '../../../db/drizzle/0019_happy_retro_girl.sql';
import migration0020 from '../../../db/drizzle/0020_same_ultragirl.sql';
import migration0021 from '../../../db/drizzle/0021_youthful_excalibur.sql';
import migration0022 from '../../../db/drizzle/0022_faithful_krista_starr.sql';
import migration0023 from '../../../db/drizzle/0023_equal_ozymandias.sql';
import migration0024 from '../../../db/drizzle/0024_marvelous_nehzno.sql';
import migration0025 from '../../../db/drizzle/0025_wet_mordo.sql';
import migration0026 from '../../../db/drizzle/0026_colorful_madame_web.sql';
import migration0027 from '../../../db/drizzle/0027_fat_speed.sql';
import migration0028 from '../../../db/drizzle/0028_red_whale.sql';
import migration0029 from '../../../db/drizzle/0029_normal_patch.sql';
import migration0030 from '../../../db/drizzle/0030_material_texas_twister.sql';
import migration0031 from '../../../db/drizzle/0031_release_image_availability.sql';
import migration0032 from '../../../db/drizzle/0032_remove_stripe_billing.sql';
import migration0033 from '../../../db/drizzle/0033_deployment_billing_state.sql';
import migration0034 from '../../../db/drizzle/0034_billing_subscriptions.sql';
import migration0035 from '../../../db/drizzle/0035_billing_scheduled_change.sql';
import migration0036 from '../../../db/drizzle/0036_one_active_test_deployment.sql';
import migration0037 from '../../../db/drizzle/0037_billing_checkout_intents.sql';
import migration0038 from '../../../db/drizzle/0038_included_production_deployments.sql';
import migration0039 from '../../../db/drizzle/0039_old_iron_man.sql';
import migration0040 from '../../../db/drizzle/0040_public_install_links.sql';
import migration0043 from '../../../db/drizzle/0043_install_link_lifecycle.sql';
import migration0044 from '../../../db/drizzle/0044_installation_invitations.sql';
import migration0045 from '../../../db/drizzle/0045_pending_secrets.sql';
import migration0041 from '../../../db/drizzle/0041_jev_shadow_verifications.sql';
import migration0042 from '../../../db/drizzle/0042_jev_failure_classifications.sql';
import migration0046 from '../../../db/drizzle/0046_environment_setup.sql';
import migration0047 from '../../../db/drizzle/0047_checkout_intent_subscribe_only.sql';
import migration0048 from '../../../db/drizzle/0048_deployment_spec_v2.sql';
import migration0049 from '../../../db/drizzle/0049_async_component_kinds.sql';
import migration0050 from '../../../db/drizzle/0050_rds_az_capacity.sql';
import migration0051 from '../../../db/drizzle/0051_release_confirmation.sql';
import migration0052 from '../../../db/drizzle/0052_infrastructure_size_tiers.sql';
import journal from '../../../db/drizzle/meta/_journal.json';
import { migrationsUpToDate } from './migration-check.js';

/**
 * Migration SQL keyed by journal tag.
 *
 * esbuild cannot glob-import, so every migration has to be listed by hand. A
 * migration added under packages/db/drizzle without a line here is invisible
 * until the deployed Lambda tries to apply it and drizzle fails with a bare
 * "No file ... found in /tmp/drizzle folder". writeMigrationsToTmp checks this
 * map against the journal up front and names what is missing instead;
 * packages/cdk/test/lambda-migrations.test.ts fails the build even earlier.
 */
const MIGRATION_SQL: Record<string, string> = {
  '0000_parallel_triton': migration0000,
  '0001_event_logs_immutable': migration0001,
  '0002_dizzy_red_shift': migration0002,
  '0003_orange_phalanx': migration0003,
  '0004_married_blob': migration0004,
  '0005_deep_gambit': migration0005,
  '0006_funny_pete_wisdom': migration0006,
  '0007_relay_enrollment': migration0007,
  '0008_github_installations': migration0008,
  '0009_ai_explanation_cache': migration0009,
  '0010_needy_nuke': migration0010,
  '0011_material_captain_cross': migration0011,
  '0012_tense_ultragirl': migration0012,
  '0013_natural_marvex': migration0013,
  '0014_lethal_bastion': migration0014,
  '0015_tan_blue_blade': migration0015,
  '0016_married_wolf_cub': migration0016,
  '0017_cooing_prowler': migration0017,
  '0018_stormy_harrier': migration0018,
  '0019_happy_retro_girl': migration0019,
  '0020_same_ultragirl': migration0020,
  '0021_youthful_excalibur': migration0021,
  '0022_faithful_krista_starr': migration0022,
  '0023_equal_ozymandias': migration0023,
  '0024_marvelous_nehzno': migration0024,
  '0025_wet_mordo': migration0025,
  '0026_colorful_madame_web': migration0026,
  '0027_fat_speed': migration0027,
  '0028_red_whale': migration0028,
  '0029_normal_patch': migration0029,
  '0030_material_texas_twister': migration0030,
  '0031_release_image_availability': migration0031,
  '0032_remove_stripe_billing': migration0032,
  '0033_deployment_billing_state': migration0033,
  '0034_billing_subscriptions': migration0034,
  '0035_billing_scheduled_change': migration0035,
  '0036_one_active_test_deployment': migration0036,
  '0037_billing_checkout_intents': migration0037,
  '0038_included_production_deployments': migration0038,
  '0039_old_iron_man': migration0039,
  '0040_public_install_links': migration0040,
  '0043_install_link_lifecycle': migration0043,
  '0044_installation_invitations': migration0044,
  '0045_pending_secrets': migration0045,
  '0041_jev_shadow_verifications': migration0041,
  '0042_jev_failure_classifications': migration0042,
  '0046_environment_setup': migration0046,
  '0047_checkout_intent_subscribe_only': migration0047,
  '0048_deployment_spec_v2': migration0048,
  '0049_async_component_kinds': migration0049,
  '0050_rds_az_capacity': migration0050,
  '0051_release_confirmation': migration0051,
  '0052_infrastructure_size_tiers': migration0052,
};

interface RdsSecret {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly dbname: string;
}

export type LambdaDb = ReturnType<typeof drizzle<typeof schema>>;

let dbPromise: Promise<LambdaDb> | null = null;

/** Fetch RDS credentials from Secrets Manager at runtime. */
async function fetchDbSecret(secretArn: string): Promise<RdsSecret> {
  const client = new SecretsManagerClient({});
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  return JSON.parse(response.SecretString ?? '{}') as RdsSecret;
}

/** Write bundled migration files to /tmp/drizzle so the migrator can read them. */
export function writeMigrationsToTmp(): string {
  const migrationsDir = '/tmp/drizzle';
  const metaDir = join(migrationsDir, 'meta');
  mkdirSync(metaDir, { recursive: true });

  const tags = (journal as { entries: readonly { tag: string }[] }).entries.map(
    (entry) => entry.tag,
  );

  const missing = tags.filter((tag) => MIGRATION_SQL[tag] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Migrations listed in the drizzle journal but not bundled into the Lambda: ${missing.join(', ')}. ` +
        'Add an import and a MIGRATION_SQL entry for each in packages/cdk/src/lambda/db-connection.ts.',
    );
  }

  for (const tag of tags) {
    writeFileSync(join(migrationsDir, `${tag}.sql`), MIGRATION_SQL[tag] as string);
  }
  writeFileSync(join(metaDir, '_journal.json'), JSON.stringify(journal));

  return migrationsDir;
}

/**
 * Connect, migrate, and cache. The promise is memoised at module level so a
 * warm invocation reuses the pool and skips the migration run.
 *
 * DATABASE_URL is set as a side effect: packages/db's runtime factory reads
 * it, and without it a second connection would fall back to local PGlite.
 */
export function connectDb(): Promise<LambdaDb> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const secretArn = process.env.DB_SECRET_ARN;
      if (!secretArn) {
        throw new Error('DB_SECRET_ARN is not set');
      }

      const secret = await fetchDbSecret(secretArn);
      const databaseUrl = `postgres://${secret.username}:${secret.password}@${secret.host}:${secret.port}/${secret.dbname}?sslmode=require&uselibpqcompat=true`;

      const pool = new Pool({ connectionString: databaseUrl });
      const db = drizzle({ client: pool, schema });
      // Most cold starts find the schema already current: one query replaces
      // writing and re-checking every bundled migration. Any doubt runs the
      // migrator exactly as before.
      if (!(await migrationsUpToDate(pool, journal))) {
        const migrationsDir = writeMigrationsToTmp();
        // One migrator run per journal prefix, so each migration commits
        // before the next one starts. drizzle applies every pending migration
        // in ONE transaction, and Postgres refuses to use an enum value until
        // the transaction that added it commits (55P04): 0023 uses values that
        // 0002, 0014 and 0017 add, so a fresh database failed at 0023.
        // Already-applied entries are skipped by drizzle's own created_at check.
        const entries = (journal as { entries: readonly unknown[] }).entries;
        for (let count = 1; count <= entries.length; count++) {
          writeFileSync(
            join(migrationsDir, 'meta', '_journal.json'),
            JSON.stringify({ ...journal, entries: entries.slice(0, count) }),
          );
          await migrate(db, { migrationsFolder: migrationsDir });
        }
      }

      process.env.DATABASE_URL = databaseUrl;
      return db;
    })();
  }
  return dbPromise;
}
