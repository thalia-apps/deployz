/**
 * Ground-truth comparison: an Analysis result against a reviewed ground-truth
 * file (`ground-truth/<id>.yaml`). A ground truth is written from the
 * repository by a person or an agent that never reads a Deployz Analysis, and
 * a second reviewer checks every citation. It allows several valid answers
 * per field (`accept`).
 *
 * Fixed code gives each field one verdict. `MISMATCH` on a critical field is a
 * wrong deployment decision; `QUESTION` is a vendor question for a fact the
 * repository answers.
 */
import { z } from 'zod';

import type { AnalysisResultFile } from '../contract.js';

const accept = <T extends z.ZodTypeAny>(value: T) => z.object({ accept: z.array(value) }).passthrough();
const status = z.enum(['required', 'optional', 'conditional', 'none']);

export const groundTruthSchema = z
  .object({
    id: z.string(),
    repository: z.string(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    outcome: accept(z.enum(['DEPLOYABLE', 'DEPLOYABLE_WITH_CHANGES', 'NOT_DEPLOYABLE'])),
    dockerfile: accept(z.string()).extend({ target: z.string().nullable() }),
    port: accept(z.number().int()),
    startCommand: z.object({ source: z.enum(['image', 'explicit']), accept: z.array(z.string()) }).passthrough(),
    healthPath: accept(z.string()),
    database: z
      .object({
        status,
        deployzEngine: z.enum(['postgres', 'mysql']).nullable(),
        selectBy: z.record(z.string(), z.string()),
      })
      .passthrough(),
    migrations: z.object({ mode: z.enum(['startup', 'command', 'none', 'unknown']), accept: z.array(z.string()) }).passthrough(),
    redis: z.object({ status }).passthrough(),
    workers: z.object({ status: z.enum(['none', 'embedded', 'independent', 'optional-independent']) }).passthrough(),
    storage: z
      .object({
        local: z.enum(['required', 'conditional', 'ephemeral', 'none']),
        s3: z.enum(['native', 'none']),
        s3SelectBy: z.record(z.string(), z.string()),
      })
      .passthrough(),
    env: z
      .object({
        required: z.array(z.object({ name: z.string(), secret: z.boolean() }).passthrough()),
      })
      .passthrough(),
  })
  .passthrough();
export type GroundTruth = z.infer<typeof groundTruthSchema>;

export type TruthVerdict = 'MATCH' | 'MISMATCH' | 'QUESTION';

export interface FieldResult {
  field: string;
  critical: boolean;
  verdict: TruthVerdict;
  expected: string;
  actual: string;
}

const show = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

/** `["pnpm", "start"]` → `pnpm start`; the shell form as written. */
function execFormLine(argument: string): string {
  try {
    const parts = JSON.parse(argument) as unknown;
    return Array.isArray(parts) ? parts.join(' ') : argument;
  } catch {
    return argument;
  }
}

/** The variables the vendor never types: Deployz binds, derives or mints them. */
const SUPPLIED = new Set(['deployz_managed', 'deployz_generated']);

export function compareWithTruth(truth: GroundTruth, analysis: AnalysisResultFile): FieldResult[] {
  const manifest = analysis.manifest;
  if (manifest === null) {
    return [{ field: 'analysis', critical: true, verdict: 'MISMATCH', expected: 'an analysed manifest', actual: analysis.failure ?? 'failed' }];
  }
  const results: FieldResult[] = [];
  const add = (field: string, critical: boolean, ok: boolean | 'question', expected: unknown, actual: unknown): void => {
    results.push({ field, critical, verdict: ok === 'question' ? 'QUESTION' : ok ? 'MATCH' : 'MISMATCH', expected: show(expected), actual: show(actual) });
  };
  const variables = new Map(manifest.environment.variables.map((variable) => [variable.key, variable]));
  /** The vendor is made to decide the variable: required, or a `customer_required` decision. */
  const asked = (name: string): boolean => {
    const variable = variables.get(name);
    return variable !== undefined && (variable.required || variable.classification === 'customer_required');
  };

  if (analysis.outcome !== undefined) add('outcome', true, truth.outcome.accept.includes(analysis.outcome), truth.outcome.accept, analysis.outcome);

  const dockerfile = manifest.application.dockerfilePath;
  // No Dockerfile builds from the repository: the right answer names the missing sources or finds none.
  const unbuildable = dockerfile === null || (manifest.build.missingSources?.length ?? 0) > 0;
  add(
    'dockerfile',
    true,
    truth.dockerfile.accept.length === 0 ? unbuildable : dockerfile !== null && truth.dockerfile.accept.includes(dockerfile),
    truth.dockerfile.accept.length === 0 ? 'no buildable Dockerfile' : truth.dockerfile.accept,
    unbuildable ? `${dockerfile ?? 'none'} (unbuildable)` : dockerfile,
  );

  add('port', true, manifest.web.port !== null && truth.port.accept.includes(manifest.web.port), truth.port.accept, manifest.web.port);

  const command = manifest.web.command;
  const commandLine = command === null ? '' : execFormLine(command.replace(/^(?:CMD|ENTRYPOINT|start): /, ''));
  const startOk =
    command !== null &&
    (truth.startCommand.accept.some((accepted) => commandLine.includes(accepted)) ||
      (truth.startCommand.source === 'image' && (truth.startCommand.accept.length === 0 ? /^(?:CMD|ENTRYPOINT): /.test(command) : /^ENTRYPOINT: /.test(command))));
  add('startCommand', true, startOk, truth.startCommand.accept.length > 0 ? truth.startCommand.accept : 'the image CMD/ENTRYPOINT', command);

  const health = manifest.health;
  const healthOk =
    health.mode === 'vendor_required'
      ? 'question'
      : truth.healthPath.accept.includes(health.path) && (health.path !== '/' || health.redirectsAccepted === true || health.mode === 'root');
  add('healthPath', true, healthOk, truth.healthPath.accept, health.mode === undefined ? health.path : `${health.path} (${health.mode}${health.redirectsAccepted ? ', 3xx' : ''})`);

  const engine = manifest.database.postgres ? (manifest.database.engine ?? 'postgres') : null;
  const wantsDatabase = truth.database.status !== 'none' && truth.database.deployzEngine !== null;
  add('database', true, wantsDatabase ? engine === truth.database.deployzEngine : engine === null, wantsDatabase ? truth.database.deployzEngine : 'none', engine ?? 'none');
  for (const name of Object.keys(truth.database.selectBy)) {
    add(`database.selectBy.${name}`, true, asked(name), 'the vendor sets it', variables.get(name)?.classification ?? 'not listed');
  }

  const migration = manifest.migration;
  const migrationActual = migration.needsCommand === true ? 'question' : `${migration.mode ?? 'unknown'}${migration.command ? ` ${migration.command}` : ''}`;
  const migrationOk =
    migration.needsCommand === true
      ? 'question'
      : truth.migrations.mode === 'startup'
        ? migration.mode === 'startup' || (migration.command !== null && truth.migrations.accept.includes(migration.command))
        : truth.migrations.mode === 'command'
          ? migration.command !== null && truth.migrations.accept.includes(migration.command)
          : truth.migrations.mode === 'none'
            ? migration.command === null
            : true;
  add('migrations', true, migrationOk, truth.migrations.mode, migrationActual);

  add('redis', true, (truth.redis.status === 'required') === manifest.redis.required, truth.redis.status, manifest.redis.required ? 'required' : 'not provisioned');

  const workers = manifest.workers?.length ?? 0;
  const workerQuestion = manifest.worker.needsCommand === true;
  const workerOk =
    truth.workers.status === 'independent'
      ? workers > 0 || (workerQuestion ? 'question' : false)
      : workers === 0 && (workerQuestion ? 'question' : true);
  add('workers', true, workerOk, truth.workers.status, workerQuestion ? 'question' : `${workers} worker service(s)`);

  const localRejection = manifest.unsupported.some((reason) => /local|volume|filesystem/i.test(reason));
  if (truth.storage.s3 === 'native' && truth.storage.local === 'conditional') {
    add('storage.s3', true, manifest.storage.required, 'bucket provisioned', manifest.storage.required);
    for (const [name, value] of Object.entries(truth.storage.s3SelectBy)) {
      if (/^<.*>$|^bucket$|^region$/i.test(value)) continue;
      add(`storage.selectBy.${name}`, true, asked(name), 'the vendor sets it', variables.get(name)?.classification ?? 'not listed');
    }
  }
  if (truth.storage.local === 'ephemeral' || truth.storage.local === 'none') {
    add('storage.local', true, !localRejection, 'no durable local state', manifest.unsupported);
  }

  for (const variable of truth.env.required) {
    const listed = variables.get(variable.name);
    const ok = listed !== undefined && (listed.required || (listed.classification !== undefined && SUPPLIED.has(listed.classification)) || listed.classification === 'customer_required');
    add(`env.${variable.name}`, false, ok, 'required', listed === undefined ? 'not listed' : `${listed.classification ?? '?'}${listed.required ? ', required' : ''}`);
  }
  return results;
}
