/**
 * The interfaces between the harness modules. Each module implements its
 * own part and imports the others only through these types, so the modules
 * are built in parallel and joined without change.
 *
 *   docker/   — the only code that runs the `docker` executable
 *   services/ — PostgreSQL, MySQL, Valkey, MinIO on an internal network
 *   runner/   — application containers, the probe, the production environment
 *   observe/  — observation runs (uses docker, services, runner)
 *   claims/, report/, analysis/ — no Docker
 */
import type { DeploymentManifest } from '@deployz/contracts';

import type { Architecture, Evidence, Recipe } from './contract.js';

// ── docker/ ────────────────────────────────────────────────────────────────

export interface DockerResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface DockerCallOptions {
  /** Full output goes to this file; only the result tail is kept in memory. */
  readonly logFile?: string;
  readonly timeoutMs?: number;
  readonly input?: string;
}

/** Runs `docker <args>` with the clean environment after `assertSafeArgs(args)`. */
export type DockerFn = (args: readonly string[], options?: DockerCallOptions) => Promise<DockerResult>;

export interface BuildRequest {
  readonly id: string;
  readonly recipe: Recipe;
  /** Absolute path of the fixture folder (fixtures only). */
  readonly fixtureDir?: string;
  /** `linux/amd64` for every counted result; `linux/arm64` only as the emulation fallback. */
  readonly platform: 'linux/amd64' | 'linux/arm64';
  readonly logDir: string;
  /** Rebuild even when the image cache has the image. */
  readonly noCache?: boolean;
}

export interface BuiltImage {
  /** Local image reference, e.g. `deployz-runcheck/repo-006:<sha>`. */
  readonly image: string;
  readonly arch: Architecture;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly seconds: number;
  readonly imageBytes: number | null;
  readonly dockerfile: string;
  readonly context: string;
  readonly failure: 'dockerfile' | 'infrastructure' | 'emulation' | 'timeout' | null;
  readonly fromCache: boolean;
  readonly evidence: Evidence[];
}

/** Resource names the harness creates. All carry `deployz.runcheck=1` and `deployz.runcheck.repo=<id>`. */
export interface DockerResources {
  createNetwork(id: string, name: string, options: { internal: boolean }): Promise<string>;
  createVolume(id: string, name: string): Promise<string>;
  removeContainer(name: string): Promise<void>;
  removeNetwork(name: string): Promise<void>;
  removeVolume(name: string): Promise<void>;
}

// ── services/ ──────────────────────────────────────────────────────────────

export interface SqlEndpoint {
  /** Host name on the internal network (the container name). */
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** Generated per service set; never logged. */
  readonly password: string;
  readonly database: string;
}

export interface ServiceSet {
  readonly id: string;
  readonly network: string;
  readonly postgres: SqlEndpoint;
  readonly mysql: SqlEndpoint;
  readonly valkey: { readonly host: string; readonly port: number };
  readonly minio: {
    readonly host: string;
    readonly port: number;
    readonly endpoint: string;
    readonly accessKey: string;
    readonly secretKey: string;
    readonly bucket: string;
    readonly region: string;
  };
  /** Named volume that holds `rds-ca-bundle.pem` (the CA of the PostgreSQL TLS certificate). Mount it read-only at the compiler's CA directory. */
  readonly caVolume: string;
  readonly caDir: string;
}

export interface ServiceSnapshot {
  readonly postgres: { readonly connections: number; readonly tables: string[] };
  readonly mysql: { readonly connections: number; readonly tables: string[] };
  readonly valkey: { readonly clients: number; readonly keys: number };
  readonly minio: { readonly objects: number };
  readonly evidence: Evidence[];
}

export interface Services {
  start(id: string, label: string): Promise<ServiceSet>;
  /** Connections other than the harness's own inspection sessions. */
  inspect(set: ServiceSet): Promise<ServiceSnapshot>;
  stop(set: ServiceSet): Promise<void>;
}

// ── runner/ ────────────────────────────────────────────────────────────────

export interface SizeLimits {
  readonly profile: 'small-v2' | 'medium-v1';
  readonly memoryMiB: number;
  readonly cpus: number;
}

export interface ContainerSpec {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly platform: 'linux/amd64' | 'linux/arm64';
  readonly role: 'web' | 'worker' | 'migration';
  /**
   * The analysed command line, or null for the image's own ENTRYPOINT and
   * CMD. The runner encodes it as production does: web and worker with
   * `workloadContainerCommand` (CMD = `sh -c <command>`, the image
   * ENTRYPOINT stays), migration with `oneShotContainerCommand` (ENTRYPOINT
   * = `sh -c`).
   */
  readonly command: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly services: ServiceSet;
  readonly size: SizeLimits;
}

export interface RunningContainer {
  readonly name: string;
  readonly spec: ContainerSpec;
  readonly startedAtMs: number;
}

export interface HttpCheck {
  readonly port: number;
  readonly path: string;
  readonly status: number | null;
}

export interface ListenSocket {
  readonly port: number;
  readonly bind: 'all' | 'loopback';
}

export interface Runner {
  start(spec: ContainerSpec): Promise<RunningContainer>;
  /** Runs to completion (migration, one-off commands). */
  runOnce(spec: ContainerSpec, timeoutMs: number): Promise<{ exitCode: number | null; seconds: number; evidence: Evidence[] }>;
  /** Polls until a path on a reachable port answers 200, the container exits, or the timeout passes. */
  waitHealthy(
    container: RunningContainer,
    options: { ports: number[]; paths: string[]; timeoutMs: number },
  ): Promise<{ healthy: boolean; seconds: number | null; checks: HttpCheck[]; exited: boolean; oomKilled: boolean }>;
  /** Listen sockets inside the container's network namespace (a probe joined with `--network container:<name>`). */
  listenSockets(container: RunningContainer): Promise<ListenSocket[]>;
  /** HTTP status of each path from a probe container on the internal network. */
  httpProbe(container: RunningContainer, port: number, paths: string[], request?: Recipe['smoke']): Promise<HttpCheck[]>;
  isRunning(container: RunningContainer): Promise<{ running: boolean; restarts: number; exitCode: number | null }>;
  diff(container: RunningContainer): Promise<string[]>;
  logs(container: RunningContainer, tailLines: number): Promise<string>;
  stop(container: RunningContainer): Promise<void>;
}

/**
 * The container environment, built with the production code
 * (`compileDeploymentIntent` → task-definition Environment/Secrets →
 * local intrinsic resolution → minted, derived and vendor values).
 * `harnessOnly` lists the names the harness adds that production does not
 * (MinIO endpoint and keys); they are recorded in every observation.
 */
export type ProductionEnvironmentFn = (input: {
  readonly manifest: DeploymentManifest;
  readonly role: 'web' | 'worker' | 'migration';
  readonly workerId?: string;
  readonly services: ServiceSet;
  readonly recipe: Recipe;
}) => { env: Record<string, string>; harnessOnly: string[]; secretNames: string[] };
