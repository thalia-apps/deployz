/**
 * The claim check: fixed, deterministic rules compare each Analysis claim
 * with an observation. No Docker, no agents. Each rule is a small pure
 * function of one claim and one observation run. The verdict uses run 1;
 * a used fact that is unstable across the two runs sets `unstable`.
 */
import type {
  Architecture,
  Claim,
  ClaimType,
  ClaimVerdict,
  Observation,
  ObservationFactName,
  ObservationRun,
  Verdict,
} from '../contract.js';
import { PREDICTED_UNBUILDABLE } from './extract.js';

type Observed = string | number | boolean | null;

export interface Outcome {
  verdict: Verdict;
  observed?: Observed;
  reason: string;
  facts: readonly ObservationFactName[];
}

export type Rule = (claim: Claim, run: ObservationRun) => Outcome;

type FactValue<K extends ObservationFactName> = NonNullable<ObservationRun[K]['value']>;

/** The value of a fact whose check ran; null for `not_run` and `error`. */
function observed<K extends ObservationFactName>(run: ObservationRun, name: K): FactValue<K> | null {
  const fact = run[name];
  return fact.status === 'observed' ? (fact.value as FactValue<K> | null) : null;
}

const confirmed = (reason: string, facts: readonly ObservationFactName[]): Outcome => ({ verdict: 'CONFIRMED', reason, facts });
const notCheckable = (reason: string, facts: readonly ObservationFactName[]): Outcome => ({ verdict: 'NOT_CHECKABLE', reason, facts });
const contradicted = (observedValue: Observed, reason: string, facts: readonly ObservationFactName[]): Outcome => ({
  verdict: 'CONTRADICTED',
  observed: observedValue,
  reason,
  facts,
});

/** The web app answered HTTP on some path, or its server opened a listening socket (also one on loopback only). */
function webIsUp(run: ObservationRun): boolean {
  return (
    observed(run, 'webHealthy') === true ||
    (observed(run, 'httpPaths') ?? []).some((check) => check.status !== null) ||
    (observed(run, 'listeningPorts') ?? []).some((entry) => entry.bind === 'all' || entry.port < 32768)
  );
}

const UP_FACTS = ['webHealthy', 'httpPaths', 'listeningPorts'] as const satisfies readonly ObservationFactName[];
const NOT_UP = 'the web app did not start';

function normalisePath(path: string): string {
  const normal = path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return normal === '' ? '.' : normal;
}

export const checkReadiness: Rule = () => notCheckable('decided by the full run', []);

export const checkDockerfile: Rule = (claim, run) => {
  const facts = ['build'] as const;
  const build = observed(run, 'build');
  if (build === null) return notCheckable('the build was not observed', facts);
  if (run.build.arch === 'arm64-native') return notCheckable('arm64 build does not prove the Dockerfile', facts);

  const sameDockerfile =
    claim.value !== null &&
    normalisePath(String(claim.value)) === normalisePath(build.dockerfile) &&
    normalisePath(claim.subject ?? '.') === normalisePath(build.context);

  const predictedFailure = claim.from === PREDICTED_UNBUILDABLE;
  if (build.ok) {
    if (predictedFailure) return contradicted('builds', 'the Analysis said the image cannot build, but it builds', facts);
    if (sameDockerfile) return confirmed('the image built with the claimed Dockerfile and context', facts);
    if (claim.value === null) return contradicted(build.dockerfile, 'the Analysis found no Dockerfile, but the repository builds one', facts);
    return notCheckable('the observation built another Dockerfile or context', facts);
  }
  if (predictedFailure && build.failure === 'dockerfile') {
    return confirmed('the Analysis said the image cannot build, and the build fails', facts);
  }
  if (!sameDockerfile) return notCheckable('the observation built another Dockerfile or context', facts);
  switch (build.failure) {
    case 'dockerfile':
      return contradicted('build failed', 'the claimed Dockerfile and context do not build', facts);
    case 'emulation':
      return notCheckable('emulation', facts);
    case 'infrastructure':
    case 'timeout':
      return notCheckable(`build ${build.failure} failure`, facts);
    default:
      return notCheckable('the build failed without a classified cause', facts);
  }
};

export const checkWebPort: Rule = (claim, run) => {
  const facts = ['listeningPorts', 'build'] as const;
  const listening = observed(run, 'listeningPorts');
  if (listening === null) return notCheckable('listening ports were not observed', facts);
  // A loopback port in the Linux ephemeral range (32768+) is an internal socket, not the app's port.
  const ports = listening.filter((entry) => entry.bind === 'all' || entry.port < 32768 || entry.port === claim.value);
  if (ports.length === 0) {
    return notCheckable(observed(run, 'build')?.ok === false ? 'the image did not build' : NOT_UP, facts);
  }
  const claimed = ports.find((entry) => entry.port === claim.value);
  if (claimed?.bind === 'all') {
    return claimed.reachableFromProbe
      ? confirmed('the claimed port listens on all interfaces and answers the probe', facts)
      : notCheckable('the claimed port listens but the probe could not reach it', facts);
  }
  if (claimed?.bind === 'loopback') {
    return contradicted('loopback', 'the claimed port listens on the loopback interface only', facts);
  }
  const injected = ports.find((entry) => entry.port === run.candidates.injectedPort);
  if (injected?.bind === 'loopback') {
    return contradicted('loopback', 'the app follows PORT but listens on the loopback interface only', facts);
  }
  if (injected?.bind === 'all' && injected.reachableFromProbe) {
    return confirmed('the app follows PORT, and production sets PORT to the claimed port', facts);
  }
  const actual = ports.find((entry) => entry.bind === 'all' && entry.reachableFromProbe) ?? ports[0]!;
  return contradicted(actual.port, 'the app listens on another port', facts);
};

export const checkHealthPath: Rule = (claim, run) => {
  const facts = ['httpPaths', 'listeningPorts', 'webHealthy'] as const;
  const checks = observed(run, 'httpPaths');
  if (checks === null) return notCheckable('HTTP paths were not observed', facts);
  if (!webIsUp(run)) return notCheckable(NOT_UP, facts);

  const reachable = new Set(
    (observed(run, 'listeningPorts') ?? []).filter((entry) => entry.bind === 'all' && entry.reachableFromProbe).map((entry) => entry.port),
  );
  const onReachable = reachable.size === 0 ? checks : checks.filter((check) => reachable.has(check.port));
  const answers = onReachable.filter((check) => check.path === claim.value);
  if (answers.some((check) => check.status === 200)) return confirmed('the claimed path answers 200', facts);
  if (answers.length === 0) return notCheckable('the observation did not probe the claimed path', facts);
  return contradicted(answers[0]!.status, 'the claimed path does not answer 200', facts);
};

export const checkDatabaseEngine: Rule = (claim, run) => {
  const facts = ['database', 'smoke', 'webHealthy', 'httpPaths', 'listeningPorts'] as const;
  const database = observed(run, 'database');
  if (database === null) return notCheckable('the database was not observed', facts);
  const used = database.connections > 0 || database.tablesAfterStart.length > 0;
  const engine = database.engine ?? 'unknown';

  if (claim.value === 'none') {
    if (database.sqliteFileWritten) return contradicted('sqlite', 'the app wrote a SQLite file', facts);
    if (used) return contradicted(engine, 'the app connected to a SQL database', facts);
    if (!webIsUp(run)) return notCheckable(NOT_UP, facts);
    const status = observed(run, 'smoke')?.status ?? null;
    if (status === null) {
      // A server on loopback only can get no request at all, so no request can touch a database.
      const reachable = (observed(run, 'listeningPorts') ?? []).some((entry) => entry.bind === 'all' && entry.reachableFromProbe);
      return reachable
        ? notCheckable('the database request got no response', facts)
        : confirmed('no SQL connection while the app ran, and no request can reach it', facts);
    }
    if (status >= 500) return contradicted(`http ${status}`, 'the request that uses the database failed', facts);
    return confirmed('no SQL connection, no tables, and the database request succeeded', facts);
  }
  if (used) {
    return engine === claim.value
      ? confirmed(`the app used ${engine}`, facts)
      : contradicted(engine, 'the app used another SQL engine', facts);
  }
  if (database.sqliteFileWritten) return contradicted('sqlite', 'the app wrote a SQLite file instead', facts);
  if (!webIsUp(run)) return notCheckable(NOT_UP, facts);
  return contradicted('none', 'the app made no SQL connection', facts);
};

export const checkRedisRequired: Rule = (claim, run) => {
  const facts = ['redis', ...UP_FACTS] as const;
  const redis = observed(run, 'redis');
  if (redis === null) return notCheckable('Redis was not observed', facts);
  if (redis.connected || redis.clients > 0) {
    return claim.value === true
      ? confirmed('the app connected to Valkey', facts)
      : contradicted(true, 'the app connected to Valkey', facts);
  }
  if (!webIsUp(run)) return notCheckable(NOT_UP, facts);
  return claim.value === true
    ? contradicted(false, 'the app made no Valkey connection', facts)
    : confirmed('the app made no Valkey connection', facts);
};

export const checkStorageRequired: Rule = (claim, run) => {
  const facts = ['objectStorage'] as const;
  const storage = observed(run, 'objectStorage');
  if (storage === null) return notCheckable('object storage was not observed', facts);
  if (storage.objectsWritten === 0) return notCheckable('no upload was triggered', facts);
  return claim.value === true
    ? confirmed('the app wrote objects to S3 storage', facts)
    : contradicted(true, 'the app wrote objects to S3 storage', facts);
};

export const checkStorageLocal: Rule = (claim, run) => {
  const facts = ['localDiskWrites', 'objectStorage', 'database', ...UP_FACTS] as const;
  const writes = observed(run, 'localDiskWrites');
  if (writes === null) return notCheckable('local disk writes were not observed', facts);
  if (writes.length > 0) {
    return claim.value === true
      ? confirmed('the app wrote data to local disk', facts)
      : contradicted(writes[0]!, 'the app wrote data to local disk', facts);
  }
  if (!webIsUp(run)) return notCheckable(NOT_UP, facts);
  if (claim.value !== true) return confirmed('the app wrote nothing to local disk', facts);
  // Absence alone proves nothing; data seen in S3 or in SQL tables is positive evidence of where the app keeps state.
  const objects = observed(run, 'objectStorage')?.objectsWritten ?? 0;
  const tables = observed(run, 'database')?.tablesAfterStart.length ?? 0;
  if (objects > 0 || tables > 0) return contradicted(false, 'the app kept its data in S3 or the database, not on local disk', facts);
  return notCheckable('no local write was seen', facts);
};

export const checkMigrationMode: Rule = (claim, run) => {
  const facts = ['startupMigration', 'migrationCommands', 'database', ...UP_FACTS] as const;
  const startup = observed(run, 'startupMigration');
  const database = observed(run, 'database');
  if (startup === null || database === null) return notCheckable('the migration facts were not observed', facts);
  const commands = observed(run, 'migrationCommands') ?? [];
  const commandMigrated = commands.some((command) => command.exitCode === 0 && command.createdTables);
  const tablesExist = startup.tablesCreatedByStart || database.tablesAfterStart.length > 0;

  switch (claim.value) {
    case 'startup':
      if (startup.tablesCreatedByStart) return confirmed('the first start created the tables', facts);
      if (commandMigrated) return contradicted('pre_deploy', 'only a migration command created the tables', facts);
      if (!webIsUp(run)) return notCheckable(NOT_UP, facts);
      return contradicted(database.connections > 0 ? 'unknown' : 'none', 'the first start created no tables', facts);
    case 'pre_deploy':
      if (startup.tablesCreatedByStart) return contradicted('startup', 'the first start created the tables', facts);
      if (commandMigrated) return confirmed('a migration command created the tables and the start did not', facts);
      return notCheckable('no migration command created tables', facts);
    case 'none':
      if (tablesExist) return contradicted('startup', 'tables exist after the first start', facts);
      if (commandMigrated) return contradicted('pre_deploy', 'a migration command created tables', facts);
      if (!webIsUp(run)) return notCheckable(NOT_UP, facts);
      return confirmed('no tables appeared', facts);
    default:
      return notCheckable('the Analysis found no migration evidence', facts);
  }
};

export const checkMigrationCommand: Rule = (claim, run) => {
  const facts = ['migrationCommands'] as const;
  const commands = observed(run, 'migrationCommands');
  if (commands === null) return notCheckable('migration commands were not observed', facts);
  const command = commands.find((candidate) => candidate.command.trim() === String(claim.value).trim());
  if (command === undefined) return notCheckable('the command was not run', facts);
  if (command.exitCode === null) return notCheckable('the command did not finish', facts);
  if (command.exitCode !== 0) return contradicted(command.exitCode, 'the command exited with an error', facts);
  if (!command.createdTables) return notCheckable('the command exited 0 but created no tables', facts);
  return confirmed('the command exited 0 and created tables', facts);
};

export const checkWorkerCommand: Rule = (claim, run) => {
  const facts = ['workers'] as const;
  const workers = observed(run, 'workers');
  if (workers === null) return notCheckable('workers were not observed', facts);
  const worker = workers.find((candidate) => candidate.command.trim() === String(claim.value).trim());
  if (worker === undefined) return notCheckable('the worker command was not run', facts);
  if (worker.stayedRunning) return confirmed('the worker ran for the full window', facts);
  return contradicted(
    worker.exitCode !== null ? `exit ${worker.exitCode}` : `restarted ${worker.restarts} times`,
    'the worker did not stay running',
    facts,
  );
};

export const checkEnvRequired: Rule = (claim, run) => {
  const facts = ['requiredVariables'] as const;
  const variables = observed(run, 'requiredVariables');
  if (variables === null) return notCheckable('required variables were not observed', facts);
  const variable = variables.find((candidate) => candidate.name === claim.subject);
  if (variable === undefined) return notCheckable('the variable was not tested', facts);
  if (variable.healthyWithout) return contradicted('not required', 'the app starts without the variable', facts);
  if (variable.healthyWith) return confirmed('the app fails without the variable and starts with it', facts);
  return notCheckable('the app was not healthy with the variable either', facts);
};

const RULES: Record<ClaimType, Rule> = {
  readiness: checkReadiness,
  dockerfile: checkDockerfile,
  'web.port': checkWebPort,
  'health.path': checkHealthPath,
  'database.engine': checkDatabaseEngine,
  'redis.required': checkRedisRequired,
  'storage.required': checkStorageRequired,
  'storage.local': checkStorageLocal,
  'migration.mode': checkMigrationMode,
  'migration.command': checkMigrationCommand,
  'worker.command': checkWorkerCommand,
  'env.required': checkEnvRequired,
};

/** The weakest architecture of the used facts decides what the verdict proves. */
const ARCH_ORDER: readonly Architecture[] = ['arm64-native', 'amd64-emulated', 'amd64-ci-build'];

function verdictArch(run: ObservationRun, facts: readonly ObservationFactName[]): Architecture {
  const archs = new Set((facts.length > 0 ? facts : (['build'] as const)).map((name) => run[name].arch));
  return ARCH_ORDER.find((arch) => archs.has(arch)) ?? run.build.arch;
}

export function checkClaims(claims: readonly Claim[], observation: Observation): ClaimVerdict[] {
  const run = observation.runs[0]!;
  return claims.map((claim) => {
    // A null value is "the Analysis does not know"; only a missing Dockerfile is itself checkable.
    const outcome =
      claim.value === null && claim.type !== 'dockerfile' && claim.type !== 'readiness'
        ? notCheckable('the Analysis made no claim', [])
        : RULES[claim.type](claim, run);
    return {
      claim,
      verdict: outcome.verdict,
      ...(outcome.verdict === 'CONTRADICTED' ? { observed: outcome.observed ?? null } : {}),
      reason: outcome.reason,
      facts: [...outcome.facts],
      arch: verdictArch(run, outcome.facts),
      unstable: outcome.facts.some((name) => observation.unstable.includes(name)),
    };
  });
}
