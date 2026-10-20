/**
 * The open items of a rules Analysis: what the AI is asked, and nothing else.
 *
 * - A blocker candidate: a rejection where it is not known whether the app
 *   needs the item (an unsupported datastore, durable local state, a second
 *   application service in the production Compose file).
 * - A fact that the rules did not resolve: no port, no start command, no
 *   health path, no Dockerfile or a tied choice, or an unknown migration for a
 *   required database.
 *
 * Every other rules value is final for the AI engine. A repository with no
 * open item makes no model call.
 */
import type { AnalysisResult } from '../analyser.js';
import { listDockerfileCandidates, type FileTree } from '../detectors.js';

export type BlockerCategory = 'datastore' | 'local_state' | 'compose_service';
export const OPEN_FACTS = ['dockerfile', 'port', 'startCommand', 'healthPath', 'migration'] as const;
export type OpenFact = (typeof OPEN_FACTS)[number];

/** The dependency of the local-state finding that the manifest reads from `usesLocalFilesystem`. */
export const LOCAL_FILESYSTEM_FINDING = 'local-filesystem-state';

export interface BlockerItem {
  readonly kind: 'blocker';
  readonly category: BlockerCategory;
  /** The rejection's dependency, or `LOCAL_FILESYSTEM_FINDING`. */
  readonly dependency: string;
  /** The rejection reason (the text the vendor sees). */
  readonly reason: string;
  /** Words the evidence window searches for: the dependency, the declared paths and variables, the service names. */
  readonly terms: readonly string[];
}

export interface FactItem {
  readonly kind: 'fact';
  readonly fact: OpenFact;
}

export type OpenItem = BlockerItem | FactItem;

/** Words that name a database engine choice in code or configuration. */
const ENGINE_SELECTORS = ['DB_TYPE', 'DB_CLIENT', 'DB_DRIVER', 'DB_CONNECTION', 'DB_ENGINE', 'DATABASE_TYPE', 'DATABASE_URL', 'DATABASE_ENGINE', 'DB_DIALECT', 'datasource'];
/** Words that name a storage backend choice. */
const STORAGE_SELECTORS = ['STORAGE', 'FILESYSTEM_DISK', 'S3_', 'BUCKET'];
const ENGINE_WORDS = /mongo|elastic|opensearch|clickhouse|sqlite|mariadb|\bh2\b|cassandra|neo4j|couch|dynamo/i;

function datastoreTerms(dependency: string, reason: string): string[] {
  const engine = reason.match(ENGINE_WORDS)?.[0];
  return [...new Set([dependency, ...(engine ? [engine.toLowerCase()] : []), ...ENGINE_SELECTORS])];
}

/** The paths and variable names in a local-state reason (`LIVEBOOK_HOME=/data (Dockerfile)`, `VOLUME /data (Dockerfile)`). */
function localStateTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const match of text.matchAll(/\b([A-Z][A-Z0-9_]{2,})=(\/[\w./-]+)/g)) {
    terms.add(match[1]!);
    terms.add(match[2]!);
  }
  for (const match of text.matchAll(/VOLUME\s+\[?["']?(\/[\w./-]+)/g)) terms.add(match[1]!);
  // The usual way out of local state is a database or S3 setting, so the window also shows those switches.
  return [...terms, ...STORAGE_SELECTORS, ...ENGINE_SELECTORS];
}

/** The service names in a multi-service reason: `defines 2 application services (api, rag_api)`. */
function composeTerms(reason: string): string[] {
  const list = reason.match(/application services \(([^)]+)\)/)?.[1] ?? '';
  return list.split(/,\s*/).filter((name) => name.length > 0);
}

function blockerOf(dependency: string, reason: string): BlockerItem | null {
  if (/^Unsupported (?:database|search engine)/.test(reason) && !/extension/.test(reason)) {
    return { kind: 'blocker', category: 'datastore', dependency, reason, terms: datastoreTerms(dependency, reason) };
  }
  if (dependency === 'docker-compose-multi-service') {
    return { kind: 'blocker', category: 'compose_service', dependency, reason, terms: composeTerms(reason) };
  }
  if ((dependency === 'local-filesystem' && /durable local state/.test(reason)) || (dependency === 'persistent-volume' && /named volumes/.test(reason))) {
    return { kind: 'blocker', category: 'local_state', dependency, reason, terms: localStateTerms(reason) };
  }
  return null;
}

export function collectOpenItems(tree: FileTree, rules: AnalysisResult): OpenItem[] {
  const meta = rules.metadata;
  const items: OpenItem[] = [];
  for (const rejection of rules.rejections) {
    if (!rejection.detected) continue;
    const item = blockerOf(rejection.dependency, rejection.reason);
    if (item !== null) items.push(item);
  }
  if (meta['usesLocalFilesystem'] === true) {
    const finding = rules.findings.find((entry) => entry.detector === 'local-filesystem');
    const declared = Array.isArray(finding?.value) ? (finding.value as unknown[]).filter((entry): entry is string => typeof entry === 'string') : [];
    items.push({
      kind: 'blocker',
      category: 'local_state',
      dependency: LOCAL_FILESYSTEM_FINDING,
      reason: `Durable local filesystem state declared: ${declared.join(', ') || 'unknown'}`,
      terms: localStateTerms(declared.join(' ')),
    });
  }

  const database = (meta['postgres'] as { required?: unknown } | undefined)?.required === true || (meta['mysql'] as { required?: unknown } | undefined)?.required === true;
  const open: Record<OpenFact, boolean> = {
    dockerfile: listDockerfileCandidates(tree).length > 0 && (typeof meta['dockerfilePath'] !== 'string' || meta['dockerfileSelectionTied'] === true),
    port: typeof meta['port'] !== 'string',
    startCommand: !Array.isArray(meta['startupCommands']) || meta['startupCommands'].length === 0,
    healthPath: meta['healthMode'] === 'vendor_required',
    migration: database && meta['migrationMode'] === 'unknown',
  };
  for (const fact of OPEN_FACTS) if (open[fact]) items.push({ kind: 'fact', fact });
  return items;
}
