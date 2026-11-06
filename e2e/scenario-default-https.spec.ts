/**
 * Phase 14 — comprehensive simulated-provider E2E for default HTTPS (scenarios
 * A–H). Runs the REAL API against a simulated AWS deployment (the relay
 * harness) PLUS a fixture default-HTTPS DNS provider that is assertable and
 * failure-scriptable over gated internal endpoints (server.ts
 * `/internal/fixture/default-dns-*`; only constructed under
 * `DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true`). No real Cloudflare, DNS or AWS ever
 * leaves the process.
 *
 * The default-HTTPS machine is OPT-IN in the fixture environment
 * (`DEPLOYZ_DEFAULT_HTTPS_FIXTURE`, default off in playwright.config.ts), so
 * every test here skips unless that flag is set — the CI job that runs this
 * file turns it on (ci.yml "Default-HTTPS simulated scenarios"). The ordinary
 * `--scenarios` run keeps HTTP-only behaviour and skips this file.
 */

import type { APIRequestContext } from '@playwright/test';

import { expect, expectPlanMatchesInventory, test } from './simulation/fixtures.js';
import { purgeDeployment } from './purge.js';

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;
const FIXTURE_ALB = 'e2e-alb.deployz-fixture.test';

interface DnsSnapshot {
  records: Array<{ name: string; content: string; proxied: boolean }>;
  remainingFailures: number;
  mutations: Array<{ op: string; name: string }>;
}

interface DefaultHttpsState {
  hostname: string;
  status: string;
  lastError: string | null;
  configureAttempts?: number;
}

interface Deployment {
  state: string;
  defaultHttps?: DefaultHttpsState | null;
  defaultUrl?: string | null;
  appUrl?: string | null;
  customDomain?: { hostname: string; status: string } | null;
  deploymentStatus?: { stage: string; url?: string | null };
  jobs?: Array<{ type: string }>;
  cleanupState?: string | null;
}

async function getDeployment(request: APIRequestContext, id: string): Promise<Deployment> {
  const response = await request.get(`${API_URL}/api/deployments/${id}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Deployment;
}

async function dnsSnapshot(request: APIRequestContext): Promise<DnsSnapshot> {
  const response = await request.get(`${API_URL}/internal/fixture/default-dns-records`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as DnsSnapshot;
}

async function queueDnsFailures(
  request: APIRequestContext,
  deploymentId: string,
  code: 'unavailable' | 'rate_limit',
  count: number,
): Promise<void> {
  const response = await request.post(`${API_URL}/internal/fixture/default-dns-failures`, {
    data: { code, count, deploymentId },
  });
  expect(response.ok()).toBeTruthy();
}

async function plantDnsRecord(request: APIRequestContext, name: string, content: string): Promise<void> {
  const response = await request.post(`${API_URL}/internal/fixture/default-dns-records`, {
    data: { name, content },
  });
  expect(response.ok()).toBeTruthy();
}

async function waitForDefaultHttps(
  request: APIRequestContext,
  deploymentId: string,
  status: 'ACTIVE' | 'ERROR' | 'absent',
  timeout = 40_000,
): Promise<void> {
  await expect
    .poll(
      async () => (await getDeployment(request, deploymentId)).defaultHttps?.status ?? 'absent',
      { timeout, message: `waiting for default-HTTPS to reach ${status}` },
    )
    .toBe(status);
}

/** Drives a custom domain to ACTIVE. The control plane's custom-domain
 *  auto-check rides the ~5-minute relay heartbeat (one check per 180s), which
 *  is far too slow for a simulated run — so this uses the real "check now"
 *  endpoint (POST /api/deployments/:id/domain/check), the same route the
 *  vendor UI's Check button hits, whose throttle floor is the fixture deps'
 *  zero interval. */
async function waitForCustomActive(
  request: APIRequestContext,
  deploymentId: string,
  hostname: string,
  timeoutMs = 40_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployment = await getDeployment(request, deploymentId);
    const status = deployment.customDomain?.status;
    if (status === 'active') return;
    if (status === 'error') {
      throw new Error(`custom domain ${hostname} reached error before activation`);
    }
    await request.post(`${API_URL}/api/deployments/${deploymentId}/domain/check`).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for custom domain ${hostname} to become active`);
}

/** The records belonging to ONE deployment: its routing CNAME plus the
 *  validation CNAME beneath the same hostname. */
function recordsFor(
  snapshot: DnsSnapshot,
  hostname: string,
): Array<{ name: string; content: string; proxied: boolean }> {
  return snapshot.records.filter(
    (record) => record.name === hostname || record.name.endsWith(`.${hostname}`),
  );
}

const defaultHttpsEnabled = process.env.DEPLOYZ_DEFAULT_HTTPS_FIXTURE === 'true';

// ── A — default HTTPS success ───────────────────────────────────────────────
test.describe('default-https-a success', () => {
  test.use({ deployzScenario: 'happy-path' });
  test.skip(!defaultHttpsEnabled, 'DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true is required for the default-HTTPS suite');

  test('@scenario:default-https-a install → reconciliation → ACTIVE → READY with exactly the d-* records', async ({
    deployzInstall,
    request,
  }) => {
    test.setTimeout(60_000);
    const { deploymentId, api } = deployzInstall;

    await waitForDefaultHttps(request, deploymentId, 'ACTIVE');
    const deployment = await getDeployment(request, deploymentId);
    expect(deployment.deploymentStatus?.stage).toBe('READY');
    expect(deployment.defaultHttps?.lastError).toBeNull();

    const hostname = deployment.defaultHttps!.hostname;
    expect(hostname).toMatch(/^d-[0-9a-f-]{36}\.deployz-fixture\.test$/);

    // P0: the infrastructure inventory's secure endpoint reads READY from the
    // ACTIVE machine (a verified HTTPS probe), never from the load balancer's
    // CloudFormation status alone.
    const infrastructure = await request.get(`${API_URL}/api/deployments/${deploymentId}/infrastructure`);
    expect(infrastructure.ok()).toBe(true);
    const endpoint = ((await infrastructure.json()) as {
      components: Array<{ kind: string; status: string; httpsState?: string }>;
    }).components.find((component) => component.kind === 'endpoint');
    expect(endpoint).toMatchObject({ status: 'ready', httpsState: 'READY' });

    // Phase 6 expectation gate at the READY checkpoint: the inventory
    // matches the plan with the secure endpoint in place.
    await expectPlanMatchesInventory(api, deploymentId, { stage: 'default-https-ready' });

    // Assert the fixture-zone records — never the production zone hex (that
    // is Phase 15's static check; see the docs section).
    const snapshot = await dnsSnapshot(request);
    const records = recordsFor(snapshot, hostname);
    expect(records).toHaveLength(2);
    const routing = records.find((record) => record.name === hostname);
    expect(routing).toBeDefined();
    expect(routing!.content).toBe(FIXTURE_ALB);
    expect(routing!.proxied).toBe(true);
    const validation = records.find((record) => record.name !== hostname);
    expect(validation).toBeDefined();
    expect(validation!.proxied).toBe(false);
  });
});

// ── B — Cloudflare unavailable ──────────────────────────────────────────────
test.describe('default-https-b unavailable', () => {
  test.use({ deployzScenario: 'happy-path' });
  test.skip(!defaultHttpsEnabled, 'DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true is required for the default-HTTPS suite');

  test('@scenario:default-https-b unavailable DNS failures are state-only and recover to ACTIVE/READY', async ({
    deployzInstall,
    request,
  }) => {
    test.setTimeout(60_000);
    const { deploymentId } = deployzInstall;

    // Script the two failures BEFORE the machine reaches its first DNS write
    // (the WAITING_FOR_DNS reconciliation after the relay reports the ACM
    // validation record). FIFO: both are consumed there, then the write
    // succeeds.
    await queueDnsFailures(request, deploymentId, 'unavailable', 2);

    await waitForDefaultHttps(request, deploymentId, 'ACTIVE');
    const deployment = await getDeployment(request, deploymentId);
    expect(deployment.deploymentStatus?.stage).toBe('READY');
    expect(deployment.state).toBe('HEALTHY');
    // Both unavailable writes consumed the watchdog budget: PENDING mint (1)
    // + 2 failures + the post-recovery force cycle = 4.
    expect(deployment.defaultHttps?.configureAttempts).toBe(4);
    // No INSTALL/DESTROY re-trigger — AWS was never disturbed.
    const types = (deployment.jobs ?? []).map((job) => job.type);
    expect(types.filter((type) => type === 'INSTALL')).toHaveLength(1);
    expect(types.filter((type) => type === 'DESTROY')).toHaveLength(0);
  });
});

// ── C — rate limiting ───────────────────────────────────────────────────────
test.describe('default-https-c rate limited', () => {
  test.use({ deployzScenario: 'happy-path' });
  test.skip(!defaultHttpsEnabled, 'DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true is required for the default-HTTPS suite');

  test('@scenario:default-https-c rate-limited writes never consume the watchdog budget', async ({
    deployzInstall,
    request,
  }) => {
    test.setTimeout(60_000);
    const { deploymentId } = deployzInstall;

    await queueDnsFailures(request, deploymentId, 'rate_limit', 5);

    await waitForDefaultHttps(request, deploymentId, 'ACTIVE');
    const deployment = await getDeployment(request, deploymentId);
    // 429s made no progress → the budget only ever held the two configure
    // mints (job0 + the post-reconciliation force cycle), exactly like the
    // clean success path.
    expect(deployment.defaultHttps?.configureAttempts).toBe(2);
    expect(deployment.defaultHttps?.lastError).toBeNull();
    const snapshot = await dnsSnapshot(request);
    expect(snapshot.remainingFailures).toBe(0); // all 429s were retried
    // No duplicate records: exactly the routing + validation pair.
    const records = recordsFor(snapshot, deployment.defaultHttps!.hostname);
    expect(records).toHaveLength(2);
  });
});

// ── D — custom domain promotion ─────────────────────────────────────────────
test.describe('default-https-d custom domain promotion', () => {
  test.use({ deployzScenario: 'happy-path' });
  test.skip(!defaultHttpsEnabled, 'DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true is required for the default-HTTPS suite');

  test('@scenario:default-https-d an ACTIVE custom domain becomes the preferred URL; defaultUrl stays the d-* hostname', async ({
    deployzInstall,
    request,
  }) => {
    test.setTimeout(60_000);
    const { deploymentId } = deployzInstall;

    await waitForDefaultHttps(request, deploymentId, 'ACTIVE');
    const before = await getDeployment(request, deploymentId);
    const defaultHostname = before.defaultHttps!.hostname;
    expect(before.defaultUrl).toBe(`https://${defaultHostname}`);

    const hostname = `app.${crypto.randomUUID().slice(0, 8)}.deployz-fixture.test`;
    const added = await request.post(`${API_URL}/api/deployments/${deploymentId}/domain`, {
      data: { hostname },
    });
    expect(added.status()).toBe(201);

    await waitForCustomActive(request, deploymentId, hostname);

    const after = await getDeployment(request, deploymentId);
    expect(after.customDomain?.hostname).toBe(hostname);
    // Preferred URL flips to the custom hostname; the canonical default URL
    // field keeps the d-* hostname throughout.
    expect(after.appUrl).toBe(`https://${hostname}`);
    expect(after.defaultUrl).toBe(`https://${defaultHostname}`);
    expect(after.deploymentStatus?.stage).toBe('READY');
  });
});

// ── E — custom domain failure ───────────────────────────────────────────────
test.describe('default-https-e custom domain failure', () => {
  test.use({ deployzScenario: 'happy-path' });
  test.use({ deployzRelayOptions: { failConfigureForHostnameRegex: '^blocked-' } });
  test.skip(!defaultHttpsEnabled, 'DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true is required for the default-HTTPS suite');

  test('@scenario:default-https-e a failing custom domain never fails the app; the default URL keeps serving', async ({
    deployzInstall,
    request,
  }) => {
    test.setTimeout(60_000);
    const { deploymentId } = deployzInstall;

    await waitForDefaultHttps(request, deploymentId, 'ACTIVE');
    const before = await getDeployment(request, deploymentId);
    const defaultHostname = before.defaultHttps!.hostname;

    // The relay is scripted to refuse CONFIGURE_DOMAIN for `blocked-*`
    // hostnames (deployzRelayOptions above), driving the domain machine to
    // ERROR end to end.
    const hostname = `blocked-${crypto.randomUUID().slice(0, 8)}.deployz-fixture.test`;
    const added = await request.post(`${API_URL}/api/deployments/${deploymentId}/domain`, {
      data: { hostname },
    });
    expect(added.status()).toBe(201);

    await expect
      .poll(
        async () => (await getDeployment(request, deploymentId)).customDomain?.status ?? null,
        { timeout: 30_000, message: 'waiting for the custom domain to reach error' },
      )
      .toBe('error');

    const after = await getDeployment(request, deploymentId);
    // The failing custom domain is not preferred: the app keeps serving READY
    // behind the default HTTPS URL, and stays HEALTHY (never FAILED).
    expect(after.customDomain?.status).toBe('error');
    expect(after.appUrl).toBe(`https://${defaultHostname}`);
    expect(after.deploymentStatus?.stage).toBe('READY');
    expect(after.state).toBe('HEALTHY');
  });
});

// ── F — custom domain removal ───────────────────────────────────────────────
test.describe('default-https-f custom domain removal', () => {
  test.use({ deployzScenario: 'happy-path' });
  test.skip(!defaultHttpsEnabled, 'DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true is required for the default-HTTPS suite');

  test('@scenario:default-https-f removing the custom domain reverts the preferred URL to the default', async ({
    deployzInstall,
    request,
  }) => {
    test.setTimeout(60_000);
    const { deploymentId } = deployzInstall;

    await waitForDefaultHttps(request, deploymentId, 'ACTIVE');
    const before = await getDeployment(request, deploymentId);
    const defaultHostname = before.defaultHttps!.hostname;

    const hostname = `remove-${crypto.randomUUID().slice(0, 8)}.deployz-fixture.test`;
    const added = await request.post(`${API_URL}/api/deployments/${deploymentId}/domain`, {
      data: { hostname },
    });
    expect(added.status()).toBe(201);
    await waitForCustomActive(request, deploymentId, hostname);

    const removed = await request.delete(`${API_URL}/api/deployments/${deploymentId}/domain`);
    expect(removed.status()).toBe(200);

    await expect
      .poll(
        async () => (await getDeployment(request, deploymentId)).customDomain ?? null,
        { timeout: 30_000, message: 'waiting for the custom domain removal to complete' },
      )
      .toBeNull();

    const after = await getDeployment(request, deploymentId);
    expect(after.appUrl).toBe(`https://${defaultHostname}`);
    // The default record is untouched by custom-domain removal.
    const snapshot = await dnsSnapshot(request);
    expect(snapshot.records.some((record) => record.name === defaultHostname)).toBe(true);
  });
});

// ── G — delete/purge ────────────────────────────────────────────────────────
// These drive a full destroy → purge lifecycle (the scenario includes a
// DESTROY timeline), so they run against the lifecycle-sweep scenario.
test.describe('default-https-g delete and purge', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ deployzScenario: 'lifecycle-sweep' });
  test.skip(!defaultHttpsEnabled, 'DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true is required for the default-HTTPS suite');

  test('@scenario:default-https-g destroy deletes both default records; the purge backstop finds nothing left', async ({
    deployzInstall,
    request,
  }) => {
    test.setTimeout(120_000);
    const { deploymentId } = deployzInstall;

    await waitForDefaultHttps(request, deploymentId, 'ACTIVE');
    const hostname = (await getDeployment(request, deploymentId)).defaultHttps!.hostname;

    const destroy = await request.post(`${API_URL}/api/deployments/${deploymentId}/destroy`, { data: {} });
    expect(destroy.status()).toBe(202);

    // Teardown removes BOTH default records (routing + validation) through
    // the fixture provider, and clears the machine state.
    await expect
      .poll(
        async () => (await getDeployment(request, deploymentId)).state,
        { timeout: 30_000, message: 'waiting for destroy to complete' },
      )
      .toBe('DELETED');
    await waitForDefaultHttps(request, deploymentId, 'absent');
    await expect
      .poll(async () => recordsFor(await dnsSnapshot(request), hostname).length, { timeout: 15_000 })
      .toBe(0);

    // Purge backstop: the purge route also reconciles orphans; there are
    // none for this deployment, so it completes with the records still gone
    // (never deleted twice).
    const purge = await purgeDeployment(request, deploymentId);
    expect(purge.status()).toBe(202);
    await expect
      .poll(
        async () => (await getDeployment(request, deploymentId)).cleanupState,
        { timeout: 30_000, message: 'waiting for purge to complete' },
      )
      .toBe('COMPLETE');
    const snapshot = await dnsSnapshot(request);
    expect(recordsFor(snapshot, hostname)).toHaveLength(0);
  });
});

// ── H — namespace protection ────────────────────────────────────────────────
test.describe('default-https-h namespace protection', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ deployzScenario: 'lifecycle-sweep' });
  test.skip(!defaultHttpsEnabled, 'DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true is required for the default-HTTPS suite');

  test('@scenario:default-https-h reserved and non-uuid names are never mutated by purge reconciliation', async ({
    deployzInstall,
    request,
  }) => {
    test.setTimeout(120_000);
    const { deploymentId } = deployzInstall;

    // Get to a purge-eligible DELETED deployment with its own zone records
    // torn down.
    await waitForDefaultHttps(request, deploymentId, 'ACTIVE');
    const deploymentHostname = (await getDeployment(request, deploymentId)).defaultHttps!.hostname;
    const destroy = await request.post(`${API_URL}/api/deployments/${deploymentId}/destroy`, { data: {} });
    expect(destroy.status()).toBe(202);
    await expect
      .poll(
        async () => (await getDeployment(request, deploymentId)).state,
        { timeout: 30_000, message: 'waiting for destroy to complete' },
      )
      .toBe('DELETED');
    await waitForDefaultHttps(request, deploymentId, 'absent');
    await expect
      .poll(async () => recordsFor(await dnsSnapshot(request), deploymentHostname).length, { timeout: 15_000 })
      .toBe(0);

    // Plant leftovers a real zone might hold: a true orphan (uuid id, no
    // live deployment), d-* names whose ids are not uuids, and reserved
    // hostnames that must never be touched by the purge reconciliation.
    const orphanId = crypto.randomUUID();
    await plantDnsRecord(request, `d-${orphanId}.deployz-fixture.test`, FIXTURE_ALB);
    await plantDnsRecord(request, 'd-www.deployz-fixture.test', FIXTURE_ALB);
    await plantDnsRecord(request, 'd-app.deployz-fixture.test', FIXTURE_ALB);
    await plantDnsRecord(request, 'app.deployz-fixture.test', FIXTURE_ALB);
    await plantDnsRecord(request, 'www.deployz-fixture.test', FIXTURE_ALB);
    await plantDnsRecord(request, 'deployz-fixture.test', FIXTURE_ALB);

    const purge = await purgeDeployment(request, deploymentId);
    expect(purge.status()).toBe(202);
    await expect
      .poll(
        async () => (await getDeployment(request, deploymentId)).cleanupState,
        { timeout: 30_000, message: 'waiting for purge to complete' },
      )
      .toBe('COMPLETE');

    const snapshot = await dnsSnapshot(request);
    const names = snapshot.records.map((record) => record.name);
    // Only the true orphan (no live deployment row) is reconciled away.
    expect(names).not.toContain(`d-${orphanId}.deployz-fixture.test`);
    // Reserved / non-uuid d-* names survive untouched.
    expect(names).toContain('d-www.deployz-fixture.test');
    expect(names).toContain('d-app.deployz-fixture.test');
    expect(names).toContain('app.deployz-fixture.test');
    expect(names).toContain('www.deployz-fixture.test');
    expect(names).toContain('deployz-fixture.test');
    // No mutation ever reached those protected names.
    for (const mutation of snapshot.mutations) {
      expect(['app.deployz-fixture.test', 'www.deployz-fixture.test', 'deployz-fixture.test']).not.toContain(
        mutation.name,
      );
    }
  });
});

// ── I — permanent failure (budget exhausted → ERROR → stays ERROR → retry) ──
test.describe('default-https-i permanent failure and retry', () => {
  test.use({ deployzScenario: 'happy-path' });
  test.skip(!defaultHttpsEnabled, 'DEPLOYZ_DEFAULT_HTTPS_FIXTURE=true is required for the default-HTTPS suite');

  test('@scenario:default-https-i budget exhaustion reaches ERROR, stays ERROR across heartbeats, vendor retry re-arms', async ({
    deployzInstall,
    request,
  }) => {
    test.setTimeout(120_000);
    const { deploymentId } = deployzInstall;

    // The machine's budget is elapsed time (30 minutes). Keep every write
    // failing, wait until the budget has started, then age it past the limit.
    await queueDnsFailures(request, deploymentId, 'unavailable', 100_000);
    await expect
      .poll(async () => (await getDeployment(request, deploymentId)).defaultHttps?.configureAttempts ?? 0, {
        timeout: 40_000,
        message: 'waiting for the configure budget to start',
      })
      .toBeGreaterThan(1);

    // The machine tries to configure, fails each time, and hits ERROR. The
    // aging repeats because a heartbeat pass can overwrite it.
    await expect
      .poll(
        async () => {
          await request.post(`${API_URL}/internal/fixture/default-https-budget`, {
            data: { deploymentId, ageMs: 31 * 60_000 },
          });
          return (await getDeployment(request, deploymentId)).defaultHttps?.status ?? 'absent';
        },
        { timeout: 40_000, message: 'waiting for default-HTTPS to reach ERROR after budget exhaustion' },
      )
      .toBe('ERROR');

    const errored = await getDeployment(request, deploymentId);
    expect(errored.defaultHttps?.lastError).toBeTruthy();

    // Wait a brief period (~2 seconds of real time, enough for several
    // heartbeat cycles) — the machine stays ERROR, never self-recovers
    // (DZ-AUDIT-008).
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const stillErrored = await getDeployment(request, deploymentId);
    expect(stillErrored.defaultHttps?.status).toBe('ERROR');

    // No INSTALL/DESTROY was re-triggered — ERROR is a DNS-only state.
    const types = (stillErrored.jobs ?? []).map((j: { type: string }) => j.type);
    expect(types.filter((t: string) => t === 'INSTALL')).toHaveLength(1);

    // Stop the scripted failures so the retry can succeed.
    const cleared = await request.post(`${API_URL}/internal/fixture/default-https-budget`, {
      data: { deploymentId, clear: true },
    });
    expect(cleared.ok()).toBeTruthy();

    // Vendor retry route resets the machine to PENDING + fresh budget.
    const retryResp = await request.post(
      `${API_URL}/api/deployments/${deploymentId}/default-https/retry`,
      { data: {} },
    );
    expect(retryResp.ok()).toBeTruthy();
    expect(((await retryResp.json()) as { status: string }).status).toBe('retrying');

    // The fixture DNS has no more queued failures, so the machine recovers.
    await expect
      .poll(
        async () => (await getDeployment(request, deploymentId)).defaultHttps?.status ?? 'absent',
        { timeout: 40_000, message: 'waiting for default-HTTPS to recover to ACTIVE after retry' },
      )
      .toBe('ACTIVE');

    const recovered = await getDeployment(request, deploymentId);
    expect(recovered.defaultHttps?.configureAttempts).toBeDefined();
    // After the retry reset, configureAttempts starts at 0 and climbs again.
    // The recovery attempt plus the successful configure = at least 1, but
    // the important thing is the machine is ACTIVE without errors.
    expect(recovered.defaultHttps?.lastError).toBeNull();
    expect(recovered.deploymentStatus?.stage).toBe('READY');
  });
});
