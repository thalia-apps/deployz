/**
 * The vendor-side control-plane client the canary drives — the same HTTP
 * routes the dashboard uses (sign-up, GitHub binding, applications,
 * releases, customers, deployments, deploy/rollback/destroy/purge, events),
 * never a database write. A cookie jar carries the better-auth session.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

interface RawResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly setCookie: string[];
  readonly text: string;
}

function rawRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<RawResponse> {
  const target = new URL(url);
  const make = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = make(
      target,
      {
        method,
        headers: {
          ...headers,
          ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const out = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') out.set(name, value);
            else if (Array.isArray(value)) out.set(name, value.join(', '));
          }
          const setCookie = res.headers['set-cookie'] ?? [];
          resolve({ status: res.statusCode ?? 0, headers: out, setCookie, text: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export interface DeploymentJob {
  id: string;
  type: string;
  state: string;
  idempotencyKey: string;
  payload: Record<string, unknown> | null;
  failureCode: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface DeploymentDetail {
  id: string;
  state: string;
  applicationId: string;
  customerId: string;
  installLinkId: string;
  installationId: string | null;
  bootstrapStackName: string | null;
  currentReleaseId: string | null;
  previousReleaseId: string | null;
  version: string | null;
  relayStatus: string;
  healthStatus: string;
  cleanupState: string | null;
  runningImageDigest: string | null;
  appUrl: string | null;
  /** The frozen size (`GET /api/deployments/:id`); null on a deployment without one. */
  size?: { id: string; label: string; profileKey: string } | null;
  /** The permanent `d-<id>.deployz.dev` address (`scripts/repository-deployment/deploy.ts`'s "Default HTTPS becomes ACTIVE" step uses the same shape). */
  defaultHttps?: { status?: string; hostname?: string; lastError?: string | null } | null;
  jobs: DeploymentJob[];
  deploymentStatus: {
    stage: string;
    currentActivity: string;
    url: string | null;
    health: { status: string };
    failure: {
      code: string | null;
      component: string | null;
      reference: string;
      message: string;
      awsStatus: string | null;
    } | null;
    job: { type: string; status: string } | null;
  };
}

export interface ReleaseSummary {
  id: string;
  version: string;
  status: 'BUILDING' | 'READY' | 'FAILED';
  failureReason: string | null;
}

export interface EventRow {
  id: string;
  eventType: string;
  occurredAt: string;
  releaseId?: string | null;
  jobId?: string | null;
  result?: string | null;
  payload?: Record<string, unknown> | null;
}

/** The GET /api/deployments/:id/infrastructure response, reduced to the
 * fields the canary asserts: the persisted relay snapshot composed into
 * components, plus the manifest-vs-inventory expectations. */
export interface InfrastructureInventory {
  readonly snapshotState: 'fresh' | 'stale' | 'none';
  readonly components: readonly { readonly kind: string; readonly status: string; readonly lifecycle: string }[];
  readonly expectations: {
    readonly components: readonly { readonly kind: string; readonly expected: boolean; readonly present: boolean }[];
    readonly missing: readonly string[];
    readonly unexpected: readonly string[];
  } | null;
}

/** The GET /api/deployments/:id/plan response, reduced to the fields Stage B
 * cross-checks against the inventory (`packages/contracts/src/plan.ts`). */
export interface DeploymentPlanView {
  readonly components: readonly { readonly kind: string; readonly name: string; readonly action: string; readonly lifecycle: string }[];
  readonly footprint?: PlanFootprint | null;
  readonly costEstimate?: unknown;
}

/** The part of the plan footprint the sizing check reads (`packages/contracts/src/footprint.ts`). */
export interface PlanFootprint {
  readonly workloads: readonly { readonly id: string; readonly compute: { readonly cpuUnits: number; readonly memoryMiB: number; readonly sizeLabel: string } }[];
  readonly resources: readonly { readonly id: string; readonly category: string; readonly configuration: Record<string, unknown> }[];
}

/** One size the public install page offers (`GET /api/public-install/:linkId`). */
export interface PublicSizeOption {
  readonly id: string;
  readonly profileKey: string;
  readonly recommended: boolean;
}

export interface PublicInstallView {
  readonly sizing: { readonly recommended: string; readonly minimum: string; readonly options: readonly PublicSizeOption[] };
}

/** `GET /api/public-install/:linkId/plan` - the plan for one Region and size, plus its fingerprint. */
export interface PublicInstallPlanView extends DeploymentPlanView {
  readonly sizeProfile: string;
  readonly planFingerprint: string | null;
}

export interface PublicInstallConfirmInput {
  readonly idempotencyKey: string;
  readonly region: string;
  readonly sizeProfile: string;
  readonly planFingerprint: string;
  readonly config: readonly { readonly key: string; readonly value: string; readonly isSecret: boolean }[];
}

export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

const TERMINAL_JOB_STATES = new Set(['SUCCEEDED', 'SUCCESS', 'FAILED', 'CANCELLED']);

export function isTerminalJobState(state: string): boolean {
  return TERMINAL_JOB_STATES.has(state);
}

export class ControlPlane {
  private readonly cookies = new Map<string, string>();

  /** `origin` is the dashboard origin better-auth trusts — the API refuses auth calls without one. */
  constructor(
    readonly apiUrl: string,
    readonly origin: string,
  ) {}

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { headers?: Record<string, string>; allowStatus?: number[]; anonymous?: boolean } = {},
  ): Promise<{ status: number; body: T; headers: Headers }> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(this.cookies.size > 0 && !options.anonymous
        ? { cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') }
        : {}),
      ...options.headers,
    };
    // node:https rather than fetch: the fetch spec forbids setting Origin,
    // which better-auth requires on every auth call.
    const response = await rawRequest(`${this.apiUrl}${path}`, method, headers, body === undefined ? undefined : JSON.stringify(body));
    for (const cookie of options.anonymous ? [] : response.setCookie) {
      const pair = cookie.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const text = response.text;
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    const ok = response.status >= 200 && response.status < 400;
    if (!ok && !(options.allowStatus ?? []).includes(response.status)) {
      const envelope = parsed as { error?: { code?: string; message?: string } } | null;
      throw new ControlPlaneError(
        response.status,
        envelope?.error?.code ?? null,
        `${method} ${path} -> ${response.status}: ${envelope?.error?.message ?? text.slice(0, 300)}`,
        parsed,
      );
    }
    return { status: response.status, body: parsed as T, headers: response.headers };
  }

  // ── Vendor session ──────────────────────────────────────────────────────

  async signUp(input: { name: string; email: string; password: string }): Promise<void> {
    await this.request('POST', '/api/auth/sign-up/email', input);
    if (!this.cookies.size) throw new Error('sign-up returned no session cookie');
  }

  async signIn(input: { email: string; password: string }): Promise<void> {
    await this.request('POST', '/api/auth/sign-in/email', input);
    if (!this.cookies.size) throw new Error('sign-in returned no session cookie');
  }

  /** The dashboard's post-install redirect target — binds the App installation to this org. */
  async bindGithubInstallation(installationId: string): Promise<string> {
    const { status, headers } = await this.request<unknown>(
      'GET',
      `/api/github/setup?installation_id=${encodeURIComponent(installationId)}`,
      undefined,
      { allowStatus: [302, 303, 307] },
    );
    const location = headers.get('location') ?? '';
    if (status < 300 || !location.includes('github=connected')) {
      throw new Error(
        `GitHub binding did not report connected (status ${status}, location ${location}). ` +
          `If installation ${installationId} is bound to another organization, run as the vendor that holds it ` +
          `(DEPLOYZ_CANARY_VENDOR_EMAIL/DEPLOYZ_CANARY_VENDOR_PASSWORD) — see docs/testing/aws-e2e.md.`,
      );
    }
    return location;
  }

  async listGithubInstallations(): Promise<{ id: string; accountLogin?: string }[]> {
    const { body } = await this.request<{ installations: { id: string; accountLogin?: string }[] }>(
      'GET',
      '/api/github/installations',
    );
    return body.installations;
  }

  // ── Applications and releases ───────────────────────────────────────────

  async createApplication(input: {
    name: string;
    githubInstallationId: string;
    repoFullName: string;
    repoUrl: string;
    defaultBranch: string;
    containerPort?: number;
    healthPath?: string;
    databaseRequired?: boolean;
    redisRequired?: boolean;
  }): Promise<{ id: string }> {
    // A persistent vendor organization keeps the application across runs: an
    // application with deployment history cannot be removed, and the product
    // allows one application per repository per organization. Reuse it.
    const { status, body } = await this.request<{ id: string } | { error: { details?: { applicationId?: string } } }>(
      'POST',
      '/api/applications',
      input,
      { allowStatus: [409] },
    );
    if (status !== 409) return body as { id: string };
    const applicationId = 'error' in body ? body.error.details?.applicationId : undefined;
    if (!applicationId) throw new ControlPlaneError(409, null, `POST /api/applications -> 409: ${JSON.stringify(body)}`, body);
    return { id: applicationId };
  }

  async getApplication(id: string): Promise<Record<string, unknown>> {
    const { body } = await this.request<Record<string, unknown>>('GET', `/api/applications/${id}`);
    return body;
  }

  /** The dashboard triggers analysis explicitly after connecting a repository. */
  async triggerAnalysis(id: string): Promise<void> {
    await this.request('POST', `/api/applications/${id}/analyse`, {});
  }

  async patchApplication(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.request('PATCH', `/api/applications/${id}`, patch);
  }

  async getReadiness(id: string): Promise<{ state: string; analysisStatus: string; findings: unknown[] }> {
    const { body } = await this.request<{ state: string; analysisStatus: string; findings: unknown[] }>(
      'GET',
      `/api/applications/${id}/readiness`,
    );
    return body;
  }

  async createRelease(
    applicationId: string,
    input: { version: string; gitSha: string; migrationCommand?: string },
  ): Promise<{ id: string; version: string }> {
    const { body } = await this.request<{ id: string; version: string }>(
      'POST',
      `/api/applications/${applicationId}/releases`,
      input,
    );
    return body;
  }

  async listReleases(applicationId: string): Promise<ReleaseSummary[]> {
    const { body } = await this.request<{ releases: ReleaseSummary[] }>(
      'GET',
      `/api/applications/${applicationId}/releases`,
    );
    return body.releases;
  }

  /** Whatever the control plane exposes about a FAILED release's CodeBuild
   * build — build-log status and the extracted evidence, never the raw log
   * lines (apps/api/src/release-build-failure.ts). 404s (not FAILED, or the
   * build/application does not exist) surface as a thrown ControlPlaneError. */
  async buildFailure(applicationId: string, releaseId: string): Promise<Record<string, unknown>> {
    const { body } = await this.request<Record<string, unknown>>(
      'GET',
      `/api/applications/${applicationId}/releases/${releaseId}/build-failure`,
    );
    return body;
  }

  // ── Customers and deployments ───────────────────────────────────────────

  async createCustomer(input: { name: string; email: string }): Promise<{ id: string }> {
    const { body } = await this.request<{ id: string }>('POST', '/api/customers', input);
    return body;
  }

  async createDeployment(input: {
    applicationId: string;
    customerId: string;
    region: string;
    sizeProfile?: string;
  }): Promise<{ id: string; installLinkId: string; installLinkToken: string }> {
    const { body } = await this.request<{ id: string; installLinkId: string; installLinkToken: string }>('POST', '/api/deployments', {
      ...input,
      deploymentType: 'TEST',
    });
    return body;
  }

  /** A targeted invitation (`recommendedSizeProfile` is the per-link size override). */
  async createInvitation(
    customerId: string,
    input: { applicationId: string; recommendedRegion?: string; recommendedSizeProfile?: string },
  ): Promise<{ id: string; token: string; recommendedRegion: string | null; recommendedSizeProfile: string | null }> {
    const { body } = await this.request<{
      id: string;
      token: string;
      recommendedRegion: string | null;
      recommendedSizeProfile: string | null;
    }>('POST', `/api/customers/${customerId}/invitations`, input);
    return body;
  }

  // -- Customer side: the public install page. Never sends the vendor session cookie. --

  private publicOptions(token: string, allowStatus: number[] = []) {
    return { headers: { 'x-deployz-token': token }, allowStatus, anonymous: true };
  }

  async publicInstall(linkId: string, token: string): Promise<PublicInstallView> {
    const { body } = await this.request<PublicInstallView>('GET', `/api/public-install/${linkId}`, undefined, this.publicOptions(token));
    return body;
  }

  async publicInstallPlan(linkId: string, token: string, region: string, profile: string): Promise<PublicInstallPlanView> {
    const query = `region=${encodeURIComponent(region)}&profile=${encodeURIComponent(profile)}`;
    const { body } = await this.request<PublicInstallPlanView>(
      'GET',
      `/api/public-install/${linkId}/plan?${query}`,
      undefined,
      this.publicOptions(token),
    );
    return body;
  }

  /** Answers any status in `allowStatus` instead of throwing, so a caller can assert a refusal. */
  async publicInstallConfirm(
    linkId: string,
    token: string,
    input: PublicInstallConfirmInput,
    allowStatus: number[] = [],
  ): Promise<{ status: number; body: { installLinkId?: string; installLinkToken?: string; error?: { code?: string } } }> {
    const { status, body } = await this.request<{ installLinkId?: string; installLinkToken?: string; error?: { code?: string } }>(
      'POST',
      `/api/public-install/${linkId}/confirm`,
      input,
      this.publicOptions(token, allowStatus),
    );
    return { status, body };
  }

  async getDeployment(id: string): Promise<DeploymentDetail> {
    const { body } = await this.request<DeploymentDetail>('GET', `/api/deployments/${id}`);
    return body;
  }

  async getInstallInfo(installLinkId: string, installLinkToken: string): Promise<{
    quickCreateUrl: string | null;
    bootstrapStackName: string;
    deploymentId: string;
    alreadyInstalled: boolean;
  }> {
    const { body } = await this.request<{
      quickCreateUrl: string | null;
      bootstrapStackName: string;
      deploymentId: string;
      alreadyInstalled: boolean;
    }>('GET', `/api/install/${installLinkId}`, undefined, { headers: { 'x-deployz-token': installLinkToken } });
    return body;
  }

  async markInstallLaunched(installLinkId: string): Promise<{ state: string }> {
    const { body } = await this.request<{ state: string }>('POST', `/api/install/${installLinkId}/launched`, {});
    return body;
  }

  async deploy(
    deploymentId: string,
    releaseId: string,
    idempotencyKey?: string,
  ): Promise<{ status: number; jobId: string; state: string }> {
    const { status, body } = await this.request<{ jobId: string; state: string }>(
      'POST',
      `/api/deployments/${deploymentId}/deploy`,
      { releaseId },
      { ...(idempotencyKey ? { headers: { 'idempotency-key': idempotencyKey } } : {}) },
    );
    return { status, ...body };
  }

  async rollback(deploymentId: string, releaseId: string): Promise<{ status: number; jobId: string; state: string }> {
    const { status, body } = await this.request<{ jobId: string; state: string }>(
      'POST',
      `/api/deployments/${deploymentId}/rollback`,
      { releaseId },
    );
    return { status, ...body };
  }

  async restart(deploymentId: string): Promise<{ status: number; jobId: string; state: string }> {
    const { status, body } = await this.request<{ jobId: string; state: string }>(
      'POST',
      `/api/deployments/${deploymentId}/restart`,
      {},
    );
    return { status, ...body };
  }

  async destroy(deploymentId: string): Promise<{ status: number; body: unknown }> {
    return this.request('POST', `/api/deployments/${deploymentId}/destroy`, {});
  }

  async purge(deploymentId: string): Promise<{ status: number; body: unknown }> {
    return this.request('POST', `/api/deployments/${deploymentId}/purge`, {});
  }

  async events(deploymentId: string): Promise<EventRow[]> {
    const { body } = await this.request<{ events: EventRow[] }>(
      'GET',
      `/api/deployments/${deploymentId}/events?limit=200`,
    );
    return body.events;
  }

  async infrastructure(deploymentId: string): Promise<InfrastructureInventory> {
    const { body } = await this.request<InfrastructureInventory>(
      'GET',
      `/api/deployments/${deploymentId}/infrastructure`,
    );
    return body;
  }

  async plan(deploymentId: string, action: 'install' | 'update' | 'destroy'): Promise<DeploymentPlanView> {
    const { body } = await this.request<DeploymentPlanView>('GET', `/api/deployments/${deploymentId}/plan?action=${action}`);
    return body;
  }

  async diagnostics(deploymentId: string): Promise<Record<string, unknown>> {
    const { body } = await this.request<Record<string, unknown>>(
      'GET',
      `/api/deployments/${deploymentId}/diagnostics`,
    );
    return body;
  }
}

// ── Waiting ───────────────────────────────────────────────────────────────

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `read` until `done` returns a value, logging a heartbeat line so a
 * long wait is visibly alive. Throws with the last observation on timeout.
 */
export async function waitFor<T, R>(
  label: string,
  read: () => Promise<T>,
  done: (value: T) => R | null | undefined,
  options: {
    timeoutMs: number;
    intervalMs?: number;
    describe?: (value: T) => string;
    /** Runs between polls — used to nudge the relay so a teardown that is
     *  merely waiting for its next scheduled tick does not idle. */
    onTick?: () => Promise<void>;
  },
): Promise<R> {
  const started = Date.now();
  const interval = options.intervalMs ?? 20_000;
  let last: T | undefined;
  let lastLine = '';
  for (;;) {
    last = await read();
    const result = done(last);
    if (result !== null && result !== undefined) return result;
    const elapsed = Math.round((Date.now() - started) / 1000);
    const line = options.describe ? options.describe(last) : '';
    if (line !== lastLine) {
      console.log(`  … ${label}: ${line} (${elapsed}s)`);
      lastLine = line;
    }
    if (Date.now() - started > options.timeoutMs) {
      throw new Error(
        `Timed out after ${Math.round(options.timeoutMs / 1000)}s waiting for ${label}; last: ${
          options.describe ? options.describe(last) : JSON.stringify(last).slice(0, 500)
        }`,
      );
    }
    await sleep(interval);
    if (options.onTick) await options.onTick();
  }
}

export function findJob(detail: DeploymentDetail, jobId: string): DeploymentJob | undefined {
  return detail.jobs.find((job) => job.id === jobId);
}

export function describeDeployment(detail: DeploymentDetail): string {
  const job = detail.jobs.at(-1);
  return `state=${detail.state} stage=${detail.deploymentStatus.stage} health=${detail.healthStatus} relay=${detail.relayStatus} current=${detail.version ?? detail.currentReleaseId ?? '-'} lastJob=${job ? `${job.type}:${job.state}` : '-'}`;
}
