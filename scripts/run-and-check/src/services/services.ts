import type { Evidence } from '../contract.js';
import type {
  DockerCallOptions,
  DockerFn,
  DockerResources,
  DockerResult,
  ServiceSet,
  ServiceSnapshot,
  Services,
} from '../ports.js';
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
  type ServiceNames,
} from './parse.js';

// Mirror DB_USER, DB_NAME, RDS_CA_DIR and RDS_CA_BUNDLE_PATH in
// packages/infrastructure-compiler/src/compile.ts.
export const DB_USER = 'deployz_app';
export const DB_NAME = 'deployz';
export const CA_DIR = '/deployz/certs';
export const CA_FILE = `${CA_DIR}/rds-ca-bundle.pem`;

const POSTGRES_IMAGE = 'public.ecr.aws/docker/library/postgres:16-alpine';
const MYSQL_IMAGE = 'public.ecr.aws/docker/library/mysql:8.0';
// Not on ECR Public; the Docker Hub image has an arm64 variant.
const VALKEY_IMAGE = 'docker.io/valkey/valkey:8-alpine';
// MinIO no longer publishes images. This frozen Bitnami build is a pinned MinIO server with arm64, `mc` and `curl`.
const MINIO_IMAGE = 'docker.io/bitnamilegacy/minio:2025.7.23-debian-12-r5';
const CERT_HELPER_IMAGE = 'public.ecr.aws/docker/library/alpine:3.20';

const POSTGRES_PORT = 5432;
const MYSQL_PORT = 3306;
const VALKEY_PORT = 6379;
const MINIO_PORT = 9000;
const MINIO_REGION = 'us-east-1';
const POSTGRES_UID = '70';
const POSTGRES_LOG = '/tmp/pglog/pg.log';
const INSPECT_APP_NAME = 'rc-inspect';
const MINIO_TOOLS_PATH = '/opt/bitnami/minio-client/bin:/opt/bitnami/minio/bin:/usr/local/bin:/usr/bin:/bin';

const READY_TIMEOUT_MS = { postgres: 90_000, mysql: 240_000, valkey: 60_000, minio: 90_000 } as const;
const POLL_MS = 1_000;
const CALL_TIMEOUT_MS = 60_000;
const IMAGE_PULL_TIMEOUT_MS = 600_000;

interface SetState {
  readonly names: ServiceNames;
  readonly mysqlRootPassword: string;
  readonly postgresBaseline: number;
  readonly mysqlBaseline: number;
  readonly valkeyBaseline: number;
  /** Sessions the harness opened on MySQL and Valkey since the baseline: one each per inspect. */
  inspections: number;
}

interface Limits {
  readonly cpus: string;
  readonly memory: string;
  readonly pids: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createServices(deps: {
  docker: DockerFn;
  resources: DockerResources;
  labelArgs: (id: string) => string[];
  /** An image with openssl (the probe image), so a service set start needs no package download. */
  helperImage?: string;
}): Services {
  const { docker, resources, labelArgs } = deps;
  const helperImage = deps.helperImage ?? CERT_HELPER_IMAGE;
  const states = new Map<string, SetState>();

  async function call(
    step: string,
    args: readonly string[],
    secrets: readonly string[],
    options: DockerCallOptions = { timeoutMs: CALL_TIMEOUT_MS },
  ): Promise<DockerResult> {
    const result = await docker(args, options);
    if (result.exitCode !== 0 || result.timedOut) {
      const reason = result.timedOut ? 'timed out' : `exit code ${result.exitCode}`;
      throw new Error(
        `Service step "${step}" failed (${reason}): ${replaceSecrets(result.stderr.trim().slice(-400), secrets)}`,
      );
    }
    return result;
  }

  const exec = (
    container: string,
    command: readonly string[],
    options: { env?: Readonly<Record<string, string>>; input?: string } = {},
  ): Promise<DockerResult> => {
    const env = options.env ?? {};
    const envArgs = Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
    return call(
      `exec ${container}`,
      ['exec', ...(options.input === undefined ? [] : ['-i']), ...envArgs, container, ...command],
      Object.values(env),
      options.input === undefined ? { timeoutMs: CALL_TIMEOUT_MS } : { timeoutMs: CALL_TIMEOUT_MS, input: options.input },
    );
  };

  async function waitReady(name: string, timeoutMs: number, check: () => Promise<unknown>): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'not ready';
    while (Date.now() < deadline) {
      try {
        await check();
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await sleep(POLL_MS);
    }
    throw new Error(`${name} was not ready in ${Math.round(timeoutMs / 1000)} s: ${lastError}`);
  }

  async function runDetached(
    id: string,
    network: string,
    name: string,
    image: string,
    limits: Limits,
    options: { env?: Readonly<Record<string, string>>; volumes: readonly string[]; command?: readonly string[] },
  ): Promise<void> {
    const env = options.env ?? {};
    const envArgs = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    const volumeArgs = options.volumes.flatMap((volume) => ['-v', volume]);
    await call(
      `start ${name}`,
      [
        'run', '-d', '--name', name, '--network', network, ...labelArgs(id),
        '--cpus', limits.cpus, '--memory', limits.memory, '--pids-limit', limits.pids,
        ...envArgs, ...volumeArgs, image, ...(options.command ?? []),
      ],
      Object.values(env),
      { timeoutMs: IMAGE_PULL_TIMEOUT_MS },
    );
  }

  /** The helper runs on the default network because `apk add` needs the internet. It is harness code. */
  async function createCertificates(id: string, names: ServiceNames): Promise<void> {
    const host = names.postgres;
    const script = [
      'set -e',
      'command -v openssl >/dev/null || apk add --no-cache openssl >/dev/null',
      'cd /tmp',
      'openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 30 -subj "/CN=Deployz run-and-check CA" 2>/dev/null',
      `openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=${host}" 2>/dev/null`,
      `printf "subjectAltName=DNS:${host}\\n" > ext.cnf`,
      'openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.crt -days 30 -extfile ext.cnf 2>/dev/null',
      'cp ca.pem /ca/rds-ca-bundle.pem',
      'chmod 644 /ca/rds-ca-bundle.pem',
      'cp server.key server.crt /pg/',
      `chown ${POSTGRES_UID}:${POSTGRES_UID} /pg/server.key /pg/server.crt`,
      'chmod 600 /pg/server.key',
    ].join('\n');
    await call(
      'create certificates',
      [
        'run', '--rm', ...labelArgs(id), '--cpus', '1', '--memory', '256m', '--pids-limit', '128',
        '-v', `${names.caVolume}:/ca`, '-v', `${names.certVolume}:/pg`, helperImage, 'sh', '-c', script,
      ],
      [],
      { timeoutMs: IMAGE_PULL_TIMEOUT_MS },
    );
  }

  /** Two counts: all `user=deployz_app` log lines, then the harness's own. */
  const postgresCounts = (container: string): Promise<DockerResult> =>
    exec(container, [
      'sh', '-c',
      `grep -c "connection authorized: user=${DB_USER}" ${POSTGRES_LOG}; grep -c "connection authorized: user=${DB_USER}.*application_name=${INSPECT_APP_NAME}" ${POSTGRES_LOG}; true`,
    ]);

  const mysqlQuery = (container: string, rootPassword: string, sql: string): Promise<DockerResult> =>
    exec(container, ['mysql', '-h127.0.0.1', '-uroot', '-N', '-e', sql], { env: { MYSQL_PWD: rootPassword } });

  /** One session: the connection counter, then the tables. */
  const mysqlInspection = (container: string, rootPassword: string): Promise<DockerResult> =>
    mysqlQuery(
      container,
      rootPassword,
      `SHOW GLOBAL STATUS LIKE 'Connections'; SELECT table_name FROM information_schema.tables WHERE table_schema='${DB_NAME}' ORDER BY table_name;`,
    );

  /** One session: the counters, then the key count. */
  const valkeyInspection = (container: string): Promise<DockerResult> =>
    exec(container, ['valkey-cli'], { input: 'INFO stats\nDBSIZE\n' });

  const minioClient = (set: ServiceSet, command: string): Promise<DockerResult> =>
    exec(set.minio.host, ['sh', '-c', command], {
      env: {
        MC_HOST_local: `http://${set.minio.accessKey}:${set.minio.secretKey}@localhost:${MINIO_PORT}`,
        MC_CONFIG_DIR: '/tmp/mc',
        PATH: MINIO_TOOLS_PATH,
      },
    });

  async function removeAll(names: ServiceNames): Promise<void> {
    for (const container of [names.postgres, names.mysql, names.valkey, names.minio]) {
      await resources.removeContainer(container);
    }
    await resources.removeNetwork(names.network);
    for (const volume of [names.caVolume, names.certVolume, ...Object.values(names.dataVolumes)]) {
      await resources.removeVolume(volume);
    }
  }

  return {
    async start(id, label) {
      const names = serviceNames(id, label);
      const postgresPassword = generatePassword();
      const mysqlPassword = generatePassword();
      const mysqlRootPassword = generatePassword();
      const { accessKey, secretKey } = generateMinioKeys();
      const set: ServiceSet = {
        id,
        network: names.network,
        postgres: { host: names.postgres, port: POSTGRES_PORT, user: DB_USER, password: postgresPassword, database: DB_NAME },
        mysql: { host: names.mysql, port: MYSQL_PORT, user: DB_USER, password: mysqlPassword, database: DB_NAME },
        valkey: { host: names.valkey, port: VALKEY_PORT },
        minio: {
          host: names.minio,
          port: MINIO_PORT,
          endpoint: `http://${names.minio}:${MINIO_PORT}`,
          accessKey,
          secretKey,
          bucket: names.bucket,
          region: MINIO_REGION,
        },
        caVolume: names.caVolume,
        caDir: CA_DIR,
      };

      try {
        await removeAll(names);
        await resources.createNetwork(id, names.network, { internal: true });
        for (const volume of [names.caVolume, names.certVolume, ...Object.values(names.dataVolumes)]) {
          await resources.createVolume(id, volume);
        }
        await createCertificates(id, names);

        await Promise.all([
          runDetached(id, names.network, names.postgres, POSTGRES_IMAGE, { cpus: '1', memory: '512m', pids: '256' }, {
            env: { POSTGRES_USER: DB_USER, POSTGRES_PASSWORD: postgresPassword, POSTGRES_DB: DB_NAME },
            volumes: [`${names.dataVolumes.postgres}:/var/lib/postgresql/data`, `${names.certVolume}:/certs:ro`],
            command: [
              '-c', 'ssl=on', '-c', 'ssl_cert_file=/certs/server.crt', '-c', 'ssl_key_file=/certs/server.key',
              '-c', 'log_connections=on', '-c', 'logging_collector=on', '-c', 'log_directory=/tmp/pglog',
              '-c', 'log_filename=pg.log',
            ],
          }),
          runDetached(id, names.network, names.mysql, MYSQL_IMAGE, { cpus: '1', memory: '768m', pids: '512' }, {
            env: {
              MYSQL_DATABASE: DB_NAME,
              MYSQL_USER: DB_USER,
              MYSQL_PASSWORD: mysqlPassword,
              MYSQL_ROOT_PASSWORD: mysqlRootPassword,
            },
            volumes: [`${names.dataVolumes.mysql}:/var/lib/mysql`],
          }),
          runDetached(id, names.network, names.valkey, VALKEY_IMAGE, { cpus: '1', memory: '256m', pids: '128' }, {
            volumes: [`${names.dataVolumes.valkey}:/data`],
            command: ['valkey-server', '--save', '', '--appendonly', 'no'],
          }),
          runDetached(id, names.network, names.minio, MINIO_IMAGE, { cpus: '1', memory: '512m', pids: '256' }, {
            env: { MINIO_ROOT_USER: accessKey, MINIO_ROOT_PASSWORD: secretKey },
            volumes: [`${names.dataVolumes.minio}:/bitnami/minio/data`],
          }),
        ]);

        // TCP checks: the MySQL and PostgreSQL entrypoints first run a socket-only server.
        await Promise.all([
          waitReady('PostgreSQL', READY_TIMEOUT_MS.postgres, () =>
            exec(names.postgres, ['pg_isready', '-h', '127.0.0.1', '-U', DB_USER, '-d', DB_NAME]),
          ),
          waitReady('MySQL', READY_TIMEOUT_MS.mysql, () =>
            mysqlQuery(names.mysql, mysqlRootPassword, `SELECT 1 FROM information_schema.schemata WHERE schema_name='${DB_NAME}'`),
          ),
          waitReady('Valkey', READY_TIMEOUT_MS.valkey, () => exec(names.valkey, ['valkey-cli', 'ping'])),
          waitReady('MinIO', READY_TIMEOUT_MS.minio, () =>
            exec(names.minio, ['curl', '-fsS', `http://localhost:${MINIO_PORT}/minio/health/ready`]),
          ),
        ]);
        await minioClient(set, `mc mb --ignore-existing local/${names.bucket}`);

        const [postgresBase, mysqlBase, valkeyBase] = await Promise.all([
          postgresCounts(names.postgres).then((result) => parsePostgresCounts(result.stdout)),
          mysqlInspection(names.mysql, mysqlRootPassword).then((result) => parseMysqlInspection(result.stdout)),
          valkeyInspection(names.valkey).then((result) => parseValkeyInspection(result.stdout)),
        ]);
        states.set(set.network, {
          names,
          mysqlRootPassword,
          postgresBaseline: postgresBase,
          mysqlBaseline: mysqlBase.total,
          valkeyBaseline: valkeyBase.total,
          inspections: 0,
        });
        return set;
      } catch (error) {
        await removeAll(names).catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          replaceSecrets(message, [postgresPassword, mysqlPassword, mysqlRootPassword, accessKey, secretKey]),
        );
      }
    },

    async inspect(set) {
      const state = states.get(set.network);
      if (!state) throw new Error(`Service set ${set.network} was not started by this instance`);
      const { names } = state;
      state.inspections += 1;

      const [pgCounts, pgTables, mysqlResult, valkeyResult, minioResult] = await Promise.all([
        postgresCounts(names.postgres),
        exec(
          names.postgres,
          [
            'psql', '-U', DB_USER, '-d', DB_NAME, '-At', '-c',
            "SELECT CASE WHEN schemaname = 'public' THEN tablename ELSE schemaname || '.' || tablename END FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1",
          ],
          { env: { PGAPPNAME: INSPECT_APP_NAME } },
        ),
        mysqlInspection(names.mysql, state.mysqlRootPassword),
        valkeyInspection(names.valkey),
        minioClient(set, `mc ls --recursive local/${names.bucket} | wc -l`),
      ]);

      const postgresConnections = Math.max(0, parsePostgresCounts(pgCounts.stdout) - state.postgresBaseline);
      const postgresTables = pgTables.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
      const mysql = parseMysqlInspection(mysqlResult.stdout);
      const mysqlConnections = applicationSessions(mysql.total, state.mysqlBaseline, state.inspections);
      const valkey = parseValkeyInspection(valkeyResult.stdout);
      const valkeyClients = applicationSessions(valkey.total, state.valkeyBaseline, state.inspections);
      const objects = Number.parseInt(minioResult.stdout.trim(), 10);
      if (Number.isNaN(objects)) throw new Error('Unexpected MinIO listing output');

      const evidence: Evidence[] = [
        {
          kind: 'command',
          source: 'postgres',
          text: `PostgreSQL log lines "connection authorized: user=${DB_USER}", harness sessions excluded, baseline ${state.postgresBaseline}: ${postgresConnections} application connections; tables in ${DB_NAME}: ${postgresTables.join(', ') || '(none)'}`.slice(0, 2000),
        },
        {
          kind: 'command',
          source: 'mysql',
          text: `SHOW GLOBAL STATUS LIKE 'Connections' = ${mysql.total}, baseline ${state.mysqlBaseline}, harness sessions ${state.inspections}: ${mysqlConnections} application connections; tables in ${DB_NAME}: ${mysql.tables.join(', ') || '(none)'}`.slice(0, 2000),
        },
        {
          kind: 'command',
          source: 'valkey',
          text: `INFO stats total_connections_received = ${valkey.total}, baseline ${state.valkeyBaseline}, harness sessions ${state.inspections}: ${valkeyClients} application connections; DBSIZE = ${valkey.keys}`,
        },
        {
          kind: 'command',
          source: 'minio',
          text: `mc ls --recursive ${names.bucket}: ${objects} objects`,
        },
      ];
      return {
        postgres: { connections: postgresConnections, tables: postgresTables },
        mysql: { connections: mysqlConnections, tables: mysql.tables },
        valkey: { clients: valkeyClients, keys: valkey.keys },
        minio: { objects },
        evidence,
      } satisfies ServiceSnapshot;
    },

    async stop(set) {
      states.delete(set.network);
      await removeAll(serviceNamesOf(set.id, set.network));
    },
  };
}
