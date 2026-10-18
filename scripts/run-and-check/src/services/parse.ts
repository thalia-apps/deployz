import { randomInt } from 'node:crypto';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ALPHANUMERIC = `${UPPER_DIGITS}abcdefghijklmnopqrstuvwxyz`;

export interface ServiceNames {
  readonly network: string;
  readonly caVolume: string;
  readonly certVolume: string;
  readonly postgres: string;
  readonly mysql: string;
  readonly valkey: string;
  readonly minio: string;
  readonly bucket: string;
  readonly dataVolumes: Readonly<Record<'postgres' | 'mysql' | 'valkey' | 'minio', string>>;
}

/** Resource names of one service set. The container name is the host name on the network. */
export function serviceNames(rawId: string, label: string): ServiceNames {
  // Fixture ids (F1) are upper case; the names are lower case on every path.
  const id = rawId.toLowerCase();
  for (const part of [id, label]) {
    if (!NAME_PATTERN.test(part)) throw new Error(`Invalid service set name part: ${part}`);
  }
  const base = `rc-${id}-${label}`;
  return {
    network: `${base}-net`,
    caVolume: `${base}-ca`,
    certVolume: `${base}-pgcert`,
    postgres: `${base}-postgres`,
    mysql: `${base}-mysql`,
    valkey: `${base}-valkey`,
    minio: `${base}-minio`,
    bucket: `rc-${id}`,
    dataVolumes: {
      postgres: `${base}-postgres-data`,
      mysql: `${base}-mysql-data`,
      valkey: `${base}-valkey-data`,
      minio: `${base}-minio-data`,
    },
  };
}

/** Names of a set from its id and network name (`rc-<id>-<label>-net`). */
export function serviceNamesOf(id: string, network: string): ServiceNames {
  const prefix = `rc-${id.toLowerCase()}-`;
  if (!network.startsWith(prefix) || !network.endsWith('-net')) throw new Error(`Unexpected service network name: ${network}`);
  return serviceNames(id, network.slice(prefix.length, -'-net'.length));
}

function randomString(alphabet: string, length: number): string {
  return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');
}

/** Alphanumeric, like the production database passwords. */
export function generatePassword(length = 24): string {
  return randomString(ALPHANUMERIC, length);
}

export function generateMinioKeys(): { accessKey: string; secretKey: string } {
  return { accessKey: randomString(UPPER_DIGITS, 20), secretKey: randomString(ALPHANUMERIC, 40) };
}

/** Output of two `grep -c` runs: all `user=deployz_app` sessions, then the harness's own. */
export function parsePostgresCounts(stdout: string): number {
  const [all, own] = stdout.split('\n').map((line) => Number.parseInt(line.trim(), 10));
  if (all === undefined || own === undefined || Number.isNaN(all) || Number.isNaN(own)) {
    throw new Error(`Unexpected PostgreSQL log count output: ${stdout.trim().slice(0, 100)}`);
  }
  return Math.max(0, all - own);
}

/** `SHOW GLOBAL STATUS LIKE 'Connections'` first, then one table name per line (mysql -N output). */
export function parseMysqlInspection(stdout: string): { total: number; tables: string[] } {
  const [first = '', ...rest] = stdout.split('\n').map((line) => line.trim());
  const match = /^Connections\s+(\d+)$/.exec(first);
  if (!match) throw new Error(`Unexpected MySQL status output: ${first.slice(0, 100)}`);
  return { total: Number(match[1]), tables: rest.filter((line) => line !== '') };
}

/** `INFO stats` followed by `DBSIZE` from one valkey-cli session. */
export function parseValkeyInspection(stdout: string): { total: number; keys: number } {
  const lines = stdout.split('\n').map((line) => line.trim());
  const total = lines
    .map((line) => /^total_connections_received:(\d+)$/.exec(line))
    .find((match) => match !== null);
  const keys = /(\d+)$/.exec(lines.filter((line) => line !== '').at(-1) ?? '');
  if (!total || !keys) throw new Error('Unexpected Valkey inspection output');
  return { total: Number(total[1]), keys: Number(keys[1]) };
}

/** Application sessions: the counter now, minus the baseline, minus every harness session so far. */
export function applicationSessions(total: number, baseline: number, harnessSessions: number): number {
  return Math.max(0, total - baseline - harnessSessions);
}

export function replaceSecrets(text: string, secrets: readonly string[]): string {
  return secrets.reduce((result, secret) => (secret === '' ? result : result.split(secret).join('***')), text);
}
