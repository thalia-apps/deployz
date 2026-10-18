import { OBSERVATION_FACTS, type ObservationFactName, type ObservationRun } from '../contract.js';
import type { Fact } from './facts.js';

export function statusClass(status: number | null): string {
  if (status === null) return 'none';
  const hundreds = Math.floor(status / 100);
  return hundreds >= 2 && hundreds <= 5 ? `${hundreds}xx` : 'other';
}

type Decision = { [N in ObservationFactName]: (value: NonNullable<ObservationRun[N]['value']>) => unknown };

/** The decision-relevant part of each fact: what a claim verdict reads, not log text or timings. */
const DECISION: Decision = {
  build: (v) => v.ok,
  webHealthy: (v) => v,
  // A loopback port in the Linux ephemeral range (32768+) is an internal socket that changes on every start.
  listeningPorts: (v) =>
    v
      .filter((p) => p.bind === 'all' || p.port < 32768)
      .map((p) => `${p.port}/${p.bind}/${p.reachableFromProbe}`)
      .sort(),
  httpPaths: (v) => v.map((p) => `${p.port}${p.path} ${statusClass(p.status)}`).sort(),
  smoke: (v) => statusClass(v.status),
  database: (v) => [v.engine, v.tablesAfterStart.length > 0, v.sqliteFileWritten],
  startupMigration: (v) => [v.tablesCreatedByStart, v.secondStartHealthy],
  migrationCommands: (v) => v.map((m) => `${m.command} ${m.exitCode === 0} ${m.createdTables}`).sort(),
  redis: (v) => v.connected,
  objectStorage: (v) => v.objectsWritten > 0,
  localDiskWrites: (v) => v.length > 0,
  workers: (v) => v.map((w) => `${w.command} ${w.stayedRunning}`).sort(),
  requiredVariables: (v) => v.map((r) => `${r.name} ${r.healthyWithout} ${r.healthyWith}`).sort(),
  twoCopiesHealthy: (v) => v,
  restartHealthy: (v) => v,
  sizes: (v) => v.map((s) => `${s.profile} ${s.healthy}`).sort(),
};

function key(name: ObservationFactName, fact: Fact<unknown>): string {
  if (fact.status !== 'observed' || fact.value === null) return fact.status;
  const decide = DECISION[name] as (value: unknown) => unknown;
  return `observed:${JSON.stringify(decide(fact.value))}`;
}

/** Facts whose two runs disagree on the decision-relevant value (4.7). */
export function findUnstable(first: ObservationRun, second: ObservationRun): ObservationFactName[] {
  return OBSERVATION_FACTS.filter((name) => key(name, first[name]) !== key(name, second[name]));
}
