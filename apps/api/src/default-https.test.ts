import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import {
  applyDefaultHttpsJobResult,
  assertMutableDefaultHostname,
  beginDefaultHttpsRemoval,
  DEFAULT_HTTPS_APEX,
  DEFAULT_HTTPS_FIXTURE_APEX,
  defaultHttpsHostname,
  ensureDefaultHttpsConfigureJob,
  getDefaultDeploymentHostname,
  getDefaultDeploymentUrl,
  isDefaultDeploymentHostname,
  isDefaultHttpsJob,
  DEFAULT_HTTPS_CONFIGURE_BUDGET_MS,
  DEFAULT_HTTPS_MIN_ATTEMPT_INTERVAL_MS,
  parseDefaultDeploymentId,
  parseDefaultHttps,
  reconcileOrphanedDefaultRecords,
  RESERVED_DEFAULT_HOSTNAMES,
  resolvePreferredPublicUrl,
  runDefaultHttpsCheck,
  type DefaultHttpsDeps,
  type DefaultHostnameConfig,
} from './default-https.js';
import {
  CloudflareDnsError,
  createFakeCloudflareDnsClient,
  type CloudflareDnsClient,
  type CloudflareDnsRecord,
} from './cloudflare-records.js';
import type { HttpsProbeReason } from './domain-check.js';
import { createCustomDomain } from './domains.js';
// Phase 11 — the default-HTTPS state machine over a fresh in-memory PGlite
// (real Postgres semantics, full migrations, including the jsonb column this
// machine lives in). All DNS interaction is behind the injected
// deployment-keyed seam (CloudflareDnsClient) — no real Cloudflare, Route53,
// ACM or DNS ever runs.

describe('default-https service', () => {
  let client: PGlite | undefined;
  let db: Db;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  async function insertOrg(overrides: Partial<typeof schema.organization.$inferInsert> = {}) {
    const id = `org-${crypto.randomUUID()}`;
    const [row] = await db
      .insert(schema.organization)
      .values({ id, name: 'Test Org', slug: `test-org-${crypto.randomUUID().slice(0, 8)}`, ...overrides })
      .returning();
    return row!;
  }

  async function insertApplication(organizationId: string) {
    const [row] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Test App',
        repoFullName: `acme/https-app-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/https-app',
        defaultBranch: 'main',
      })
      .returning();
    return row!;
  }

  async function insertCustomer(organizationId: string) {
    const [row] = await db
      .insert(schema.customers)
      .values({
        organizationId,
        name: 'Test Customer',
        email: `customer-${crypto.randomUUID()}@example.com`,
      })
      .returning();
    return row!;
  }

  async function seedDeployment(
    overrides: Partial<typeof schema.deployments.$inferInsert> = {},
  ): Promise<typeof schema.deployments.$inferSelect> {
    const org = await insertOrg();
    const application = await insertApplication(org.id);
    const customer = await insertCustomer(org.id);
    const [row] = await db
      .insert(schema.deployments)
      .values({
        organizationId: org.id,
        applicationId: application.id,
        customerId: customer.id,
        region: 'us-east-1',
        state: 'HEALTHY',
        installationId: `inst-${crypto.randomUUID()}`,
        enrollmentCode: crypto.randomUUID(),
        ...overrides,
      })
      .returning();
    return row!;
  }

  async function stateOf(deploymentId: string) {
    const rows = await db
      .select({ defaultHttps: schema.deployments.defaultHttps })
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId))
      .limit(1);
    return parseDefaultHttps(rows[0]?.defaultHttps ?? null);
  }

  async function jobsFor(deploymentId: string) {
    return db.select().from(schema.deploymentJobs).where(eq(schema.deploymentJobs.deploymentId, deploymentId));
  }

  const apex = 'deployz.test';
  const prefix = 'd-';

  class FakeDnsClient implements CloudflareDnsClient {
    upserts: Array<{ name: string; value: string }> = [];
    deletes: string[] = [];
    failUpserts = false;
    getRecord = async (_deploymentId: string) => null;
    async upsertDefaultValidationRecord(deploymentId: string, validationName: string, validationValue: string) {
      if (this.failUpserts) throw new Error('boom');
      this.upserts.push({ name: validationName, value: validationValue });
      return { op: 'noop' as const, record: null };
    }
    async upsertDefaultDeploymentRecord(deploymentId: string, target: string) {
      if (this.failUpserts) throw new Error('boom');
      this.upserts.push({ name: defaultHttpsHostname(deploymentId, apex, prefix), value: target });
      return { op: 'noop' as const, record: null };
    }
    async deleteDefaultDeploymentRecord(deploymentId: string) {
      this.deletes.push(defaultHttpsHostname(deploymentId, apex, prefix));
      return { op: 'deleted' as const };
    }
    async deleteDefaultValidationRecord(deploymentId: string, validationName: string) {
      this.deletes.push(validationName);
      return { op: 'deleted' as const };
    }
    listDefaultRecords = async () => [];
  }

  /** A clock `n` attempt intervals ahead of now, for a later driver pass. */
  const laterBy = (n: number) => () => Date.now() + n * 2 * DEFAULT_HTTPS_MIN_ATTEMPT_INTERVAL_MS;

  function deps(overrides: Partial<DefaultHttpsDeps> = {}): DefaultHttpsDeps {
    return {
      enabled: true,
      apex,
      prefix,
      dns: new FakeDnsClient(),
      probeHttps: async () => ({ ok: true }),
      ...overrides,
    };
  }

  describe('runDefaultHttpsCheck — start', () => {
    it('is a no-op while the feature is disabled', async () => {
      const deployment = await seedDeployment();
      await runDefaultHttpsCheck(db, deployment, deps({ enabled: false }));
      expect(await stateOf(deployment.id)).toBeNull();
      expect(await jobsFor(deployment.id)).toHaveLength(0);
    });

    it('creates a PENDING state + cycle-0 CONFIGURE_DOMAIN job for an installed deployment', async () => {
      const deployment = await seedDeployment();
      await runDefaultHttpsCheck(db, deployment, deps());

      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('PENDING');
      expect(state?.hostname).toBe(defaultHttpsHostname(deployment.id, apex, prefix));
      expect(state?.lastError).toBeNull();

      const jobs = await jobsFor(deployment.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.type).toBe('CONFIGURE_DOMAIN');
      expect(jobs[0]!.idempotencyKey).toBe(`${deployment.id}:CONFIGURE_DOMAIN:default-https:0`);
      expect(jobs[0]!.payload).toMatchObject({
        hostname: defaultHttpsHostname(deployment.id, apex, prefix),
        domainId: deployment.id,
      });
    });

    it('mints the hostname with the control plane prefix', async () => {
      const deployment = await seedDeployment();
      await runDefaultHttpsCheck(db, deployment, deps({ prefix: 's-' }));

      const state = await stateOf(deployment.id);
      expect(state?.hostname).toBe(`s-${deployment.id}.${apex}`);
      const jobs = await jobsFor(deployment.id);
      expect(jobs[0]!.payload).toMatchObject({ hostname: `s-${deployment.id}.${apex}` });
    });

    it('starts even while an ACTIVE custom domain serves (the default URL is the permanent fallback)', async () => {
      const deployment = await seedDeployment();
      await createCustomDomain(db, deployment, `app.${crypto.randomUUID().slice(0, 8)}.customer.com`, 'user-1');
      await db
        .update(schema.customDomains)
        .set({ status: 'ACTIVE' })
        .where(eq(schema.customDomains.deploymentId, deployment.id));
      // Phase 7: the default must keep reconciling while a custom domain is
      // active — a custom domain can fail or be removed later, and the default
      // is the always-present fallback, so it is never disabled.
      await runDefaultHttpsCheck(db, deployment, deps());
      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('PENDING');
      const jobs = (await jobsFor(deployment.id)).filter(
        (job) => job.type === 'CONFIGURE_DOMAIN' && job.idempotencyKey.includes(':default-https:'),
      );
      expect(jobs).toHaveLength(1);
    });

    it('does nothing for deployments that are not installed', async () => {
      const deployment = await seedDeployment({ state: 'INSTALLING' });
      await runDefaultHttpsCheck(db, deployment, deps());
      expect(await stateOf(deployment.id)).toBeNull();
    });
  });

  describe('runDefaultHttpsCheck — certificate during the install', () => {
    async function installing(installState: 'REQUESTED' | 'RUNNING' = 'RUNNING') {
      const deployment = await seedDeployment({ state: 'INSTALLING' });
      await db.insert(schema.deploymentJobs).values({
        deploymentId: deployment.id,
        type: 'INSTALL',
        state: installState,
        idempotencyKey: `${deployment.id}:INSTALL`,
        payload: {},
        requestedBy: null,
      });
      return deployment;
    }

    async function settleNewestConfigureJob(deploymentId: string, output: Record<string, unknown>) {
      const jobs = (await jobsFor(deploymentId)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      const job = jobs[jobs.length - 1]!;
      await db
        .update(schema.deploymentJobs)
        .set({ state: 'SUCCEEDED', finishedAt: new Date() })
        .where(eq(schema.deploymentJobs.id, job.id));
      await applyDefaultHttpsJobResult(db, deploymentId, job, { success: true, output });
    }

    it('waits until the relay has claimed the INSTALL', async () => {
      const deployment = await installing('REQUESTED');
      await runDefaultHttpsCheck(db, deployment, deps());
      expect(await stateOf(deployment.id)).toBeNull();
      expect(await jobsFor(deployment.id)).toHaveLength(1);
    });

    it('requests the certificate while the INSTALL runs, asking the relay to defer the listener', async () => {
      const deployment = await installing();
      await runDefaultHttpsCheck(db, deployment, deps());

      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('PENDING');
      expect(state?.configureAttempts).toBe(0);
      const configure = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      expect(configure).toHaveLength(1);
      expect(configure[0]!.payload).toMatchObject({ deferListener: true });
    });

    function makeInstallClock() {
      let current = Date.now();
      return {
        now: () => current,
        advance: (ms: number) => {
          current += ms;
        },
      };
    }

    const MINUTE = 60_000;

    it('writes the validation CNAME at once, the routing CNAME only once the load balancer is known, and spends no budget', async () => {
      const deployment = await installing();
      const dns = new FakeDnsClient();
      const clock = makeInstallClock();
      await runDefaultHttpsCheck(db, deployment, deps({ dns, now: clock.now }));
      const validationName = `_x1.${defaultHttpsHostname(deployment.id, apex)}`;
      await settleNewestConfigureJob(deployment.id, {
        certificateArn: 'arn:aws:acm:us-east-1:1:certificate/early',
        validationName,
        validationValue: '_y1.acm-validations.aws.',
      });
      expect((await stateOf(deployment.id))?.status).toBe('WAITING_FOR_DNS');

      // Several heartbeats while the stack is still being created.
      for (let pass = 0; pass < 5; pass += 1) {
        clock.advance(2 * DEFAULT_HTTPS_MIN_ATTEMPT_INTERVAL_MS);
        await runDefaultHttpsCheck(db, deployment, deps({ dns, now: clock.now }));
        await settleNewestConfigureJob(deployment.id, {
          certificateArn: 'arn:aws:acm:us-east-1:1:certificate/early',
          certificateStatus: 'PENDING_VALIDATION',
          httpsConfigured: false,
        });
      }
      expect(dns.upserts.every((upsert) => upsert.name === validationName)).toBe(true);
      expect(dns.upserts.length).toBeGreaterThan(0);
      const waiting = await stateOf(deployment.id);
      expect(waiting).toMatchObject({ status: 'WAITING_FOR_DNS', lastError: null, configureAttempts: 0 });

      // The load balancer appears: the routing CNAME follows on the next pass.
      await settleNewestConfigureJob(deployment.id, { routingTarget: 'alb.us-east-1.elb.amazonaws.com' });
      clock.advance(2 * DEFAULT_HTTPS_MIN_ATTEMPT_INTERVAL_MS);
      await runDefaultHttpsCheck(db, deployment, deps({ dns, now: clock.now }));
      expect(dns.upserts.at(-1)).toEqual({
        name: defaultHttpsHostname(deployment.id, apex),
        value: 'alb.us-east-1.elb.amazonaws.com',
      });
    });

    it('after the install settles the same certificate is wired normally and the budget counts again', async () => {
      const deployment = await installing();
      const dns = new FakeDnsClient();
      await runDefaultHttpsCheck(db, deployment, deps({ dns }));
      await settleNewestConfigureJob(deployment.id, {
        certificateArn: 'arn:aws:acm:us-east-1:1:certificate/early',
        validationName: `_x1.${defaultHttpsHostname(deployment.id, apex)}`,
        validationValue: '_y1.acm-validations.aws.',
        routingTarget: 'alb.us-east-1.elb.amazonaws.com',
      });

      await db
        .update(schema.deployments)
        .set({ state: 'HEALTHY' })
        .where(eq(schema.deployments.id, deployment.id));
      await runDefaultHttpsCheck(db, { ...deployment, state: 'HEALTHY' }, deps({ dns }));

      const latest = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN').at(-1)!;
      expect(latest.payload).not.toHaveProperty('deferListener');
      expect(latest.payload).toMatchObject({ certificateArn: 'arn:aws:acm:us-east-1:1:certificate/early' });
      expect((await stateOf(deployment.id))?.configureAttempts).toBe(1);
    });

    async function settleInstall(deployment: Awaited<ReturnType<typeof installing>>) {
      await db
        .update(schema.deployments)
        .set({ state: 'HEALTHY' })
        .where(eq(schema.deployments.id, deployment.id));
      await db
        .update(schema.deploymentJobs)
        .set({ state: 'SUCCEEDED', finishedAt: new Date() })
        .where(eq(schema.deploymentJobs.deploymentId, deployment.id));
      return { ...deployment, state: 'HEALTHY' as const };
    }

    async function waitForInstall(deployment: Awaited<ReturnType<typeof installing>>, clock: ReturnType<typeof makeInstallClock>, dns: CloudflareDnsClient) {
      await runDefaultHttpsCheck(db, deployment, deps({ dns, now: clock.now }));
      await settleNewestConfigureJob(deployment.id, {
        certificateArn: 'arn:aws:acm:us-east-1:1:certificate/early',
        validationName: `_x1.${defaultHttpsHostname(deployment.id, apex)}`,
        validationValue: '_y1.acm-validations.aws.',
      });
      for (let elapsed = 0; elapsed < 40 * MINUTE; elapsed += 2 * MINUTE) {
        clock.advance(2 * MINUTE);
        await runDefaultHttpsCheck(db, deployment, deps({ dns, now: clock.now }));
      }
    }

    it('an install lasting 40 minutes does not use up the budget, and a certificate issued meanwhile still reaches ACTIVE', async () => {
      const deployment = await installing();
      const dns = new FakeDnsClient();
      const clock = makeInstallClock();
      await waitForInstall(deployment, clock, dns);
      expect(await stateOf(deployment.id)).toMatchObject({ status: 'WAITING_FOR_DNS', configureAttempts: 0 });

      const installed = await settleInstall(deployment);
      await settleNewestConfigureJob(deployment.id, { routingTarget: 'alb.us-east-1.elb.amazonaws.com' });
      clock.advance(2 * MINUTE);
      await runDefaultHttpsCheck(db, installed, deps({ dns, now: clock.now }));
      const started = await stateOf(deployment.id);
      expect(started?.status).toBe('WAITING_FOR_DNS');
      expect(started?.configureStartedAt).toBe(new Date(clock.now()).toISOString());

      await settleNewestConfigureJob(deployment.id, {
        certificateStatus: 'ISSUED',
        httpsConfigured: true,
      });
      expect((await stateOf(deployment.id))?.status).toBe('CONFIGURING');
      await runDefaultHttpsCheck(db, installed, deps({ dns, now: clock.now }));
      expect((await stateOf(deployment.id))?.status).toBe('ACTIVE');
    });

    it('times out only after the budget has elapsed since the install settled', async () => {
      const deployment = await installing();
      const dns = new FakeDnsClient();
      const clock = makeInstallClock();
      await waitForInstall(deployment, clock, dns);
      const installed = await settleInstall(deployment);
      dns.failUpserts = true;

      clock.advance(MINUTE);
      await runDefaultHttpsCheck(db, installed, deps({ dns, now: clock.now }));
      clock.advance(DEFAULT_HTTPS_CONFIGURE_BUDGET_MS - MINUTE);
      await runDefaultHttpsCheck(db, installed, deps({ dns, now: clock.now }));
      expect((await stateOf(deployment.id))?.status).toBe('WAITING_FOR_DNS');

      clock.advance(MINUTE);
      await runDefaultHttpsCheck(db, installed, deps({ dns, now: clock.now }));
      expect(await stateOf(deployment.id)).toMatchObject({ status: 'ERROR', lastError: 'DEFAULT_DNS_TIMEOUT' });
    });
  });

  describe('runDefaultHttpsCheck — progression', () => {
    async function install() {
      const deployment = await seedDeployment();
      await runDefaultHttpsCheck(db, deployment, deps());
      return deployment;
    }

    async function settleNewestConfigureJob(
      deploymentId: string,
      output: Record<string, unknown>,
      success = true,
    ) {
      const jobs = (await jobsFor(deploymentId)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      const job = jobs[jobs.length - 1]!;
      await db
        .update(schema.deploymentJobs)
        .set({ state: success ? 'SUCCEEDED' : 'FAILED', finishedAt: new Date() })
        .where(eq(schema.deploymentJobs.id, job.id));
      await applyDefaultHttpsJobResult(db, deploymentId, job, { success, output });
      return job;
    }

    it('an in-flight configure job blocks a duplicate on the next driver pass', async () => {
      const deployment = await install();
      await runDefaultHttpsCheck(db, deployment, deps());
      const jobs = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      expect(jobs).toHaveLength(1);
    });

    it('WAITING_FOR_DNS writes the validation + routing CNAMEs and mints a fresh cycle', async () => {
      const deployment = await install();
      const dns = new FakeDnsClient();
      await settleNewestConfigureJob(deployment.id, {
        certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
        validationName: `_x1.${defaultHttpsHostname(deployment.id, apex, prefix)}`,
        validationValue: '_y1.acm-validations.aws.',
        routingTarget: 'alb.us-east-1.elb.amazonaws.com',
      });
      expect((await stateOf(deployment.id))?.status).toBe('WAITING_FOR_DNS');

      await runDefaultHttpsCheck(db, deployment, deps({ dns }));
      expect(dns.upserts).toEqual([
        {
          name: `_x1.${defaultHttpsHostname(deployment.id, apex, prefix)}`,
          value: '_y1.acm-validations.aws.',
        },
        { name: defaultHttpsHostname(deployment.id, apex, prefix), value: 'alb.us-east-1.elb.amazonaws.com' },
      ]);
      const jobs = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      expect(jobs).toHaveLength(2);
      expect(jobs.some((job) => job.idempotencyKey.endsWith(':1'))).toBe(true);
    });

    it('a DNS write failure records DNS_WRITE_FAILED and mints no new job', async () => {
      const deployment = await install();
      const dns = new FakeDnsClient();
      dns.failUpserts = true;
      await settleNewestConfigureJob(deployment.id, {
        certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
        validationName: `_x1.${defaultHttpsHostname(deployment.id, apex, prefix)}`,
        validationValue: '_y1.acm-validations.aws.',
        routingTarget: 'alb.us-east-1.elb.amazonaws.com',
      });

      await runDefaultHttpsCheck(db, deployment, deps({ dns }));
      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('WAITING_FOR_DNS');
      expect(state?.lastError).toBe('DNS_WRITE_FAILED');
      const jobs = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      expect(jobs).toHaveLength(1);
    });

    it('CONFIGURING activates once the HTTPS probe passes', async () => {
      const deployment = await install();
      await settleNewestConfigureJob(deployment.id, {
        certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
        validationName: `_x1.${defaultHttpsHostname(deployment.id, apex, prefix)}`,
        validationValue: '_y1.acm-validations.aws.',
      });
      const stateBefore = await stateOf(deployment.id);
      await db
        .update(schema.deployments)
        .set({ defaultHttps: { ...stateBefore, status: 'CONFIGURING' } })
        .where(eq(schema.deployments.id, deployment.id));

      await runDefaultHttpsCheck(db, deployment, deps({ probeHttps: async () => ({ ok: true }) }));
      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('ACTIVE');
      expect(state?.lastError).toBeNull();
    });

    it('CONFIGURING holds with HTTPS_NOT_REACHABLE while the probe fails', async () => {
      const deployment = await install();
      await settleNewestConfigureJob(deployment.id, {});
      const stateBefore = await stateOf(deployment.id);
      await db
        .update(schema.deployments)
        .set({ defaultHttps: { ...stateBefore, status: 'CONFIGURING' } })
        .where(eq(schema.deployments.id, deployment.id));

      await runDefaultHttpsCheck(
        db,
        deployment,
        deps({ probeHttps: async () => ({ ok: false, reason: 'HTTPS_NOT_REACHABLE' }) }),
      );
      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('CONFIGURING');
      expect(state?.lastError).toBe('HTTPS_NOT_REACHABLE');
    });

    // Phase 5 — the CONFIGURING verifier outcome matrix. The probe is always
    // a FAKE (never real HTTP): each distinguishable failure must persist its
    // reason as lastError and hold CONFIGURING; only a healthy probe may
    // promote to ACTIVE.
    describe('CONFIGURING verifier outcome matrix (Phase 5)', () => {
      async function configuringDeployment() {
        const deployment = await install();
        await settleNewestConfigureJob(deployment.id, {
          certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
          validationName: `_x1.${defaultHttpsHostname(deployment.id, apex, prefix)}`,
          validationValue: '_y1.acm-validations.aws.',
          routingTarget: 'alb.us-east-1.elb.amazonaws.com',
        });
        const stateBefore = await stateOf(deployment.id);
        await db
          .update(schema.deployments)
          .set({ defaultHttps: { ...stateBefore, status: 'CONFIGURING' } })
          .where(eq(schema.deployments.id, deployment.id));
        return deployment;
      }

      it.each<[string, HttpsProbeReason]>([
        ['DNS still pending (hostname not resolvable)', 'DNS_UNRESOLVED'],
        ['TLS unavailable on the origin', 'TLS_UNAVAILABLE'],
        ['an invalid TLS certificate', 'CERT_INVALID'],
        ['the probe times out', 'PROBE_TIMEOUT'],
        ['the origin answers HTTP 404', 'HTTP_404'],
        ['the origin answers HTTP 500', 'HTTP_500'],
        ['an unclassified transport failure', 'HTTPS_NOT_REACHABLE'],
      ])('stays CONFIGURING with a distinguishing lastError when %s', async (_label, reason) => {
        const deployment = await configuringDeployment();
        await runDefaultHttpsCheck(db, deployment, deps({ probeHttps: async () => ({ ok: false, reason }) }));
        const state = await stateOf(deployment.id);
        expect(state?.status).toBe('CONFIGURING');
        expect(state?.lastError).toBe(reason);
        // A failed probe never mints a new configure job — the driver retries
        // on its own cadence.
        const jobs = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
        expect(jobs).toHaveLength(1);
      });

      it('reaches ACTIVE only on a healthy probe', async () => {
        const deployment = await configuringDeployment();
        await runDefaultHttpsCheck(db, deployment, deps({ probeHttps: async () => ({ ok: true }) }));
        const state = await stateOf(deployment.id);
        expect(state?.status).toBe('ACTIVE');
        expect(state?.lastError).toBeNull();
      });
    });

    it('ERROR is terminal: runDefaultHttpsCheck leaves ERROR untouched (DZ-AUDIT-008)', async () => {
      const deployment = await install();
      await settleNewestConfigureJob(deployment.id, {
        certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
        validationName: `_x1.${defaultHttpsHostname(deployment.id, apex, prefix)}`,
        validationValue: '_y1.acm-validations.aws.',
        routingTarget: 'alb.us-east-1.elb.amazonaws.com',
      });
      await db
        .update(schema.deployments)
        .set({ defaultHttps: { ...(await stateOf(deployment.id))!, status: 'ERROR', lastError: 'CONFIGURE_FAILED' } })
        .where(eq(schema.deployments.id, deployment.id));

      await runDefaultHttpsCheck(db, deployment, deps());
      const state = await stateOf(deployment.id);
      // ERROR is terminal — no automatic retry, no new jobs.
      expect(state?.status).toBe('ERROR');
      expect(state?.lastError).toBe('CONFIGURE_FAILED');
      const jobs = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      expect(jobs).toHaveLength(1);
    });
  });

  describe('applyDefaultHttpsJobResult', () => {
    async function seedWithState(extra: Record<string, unknown> = {}) {
      const deployment = await seedDeployment();
      const state = {
        hostname: defaultHttpsHostname(deployment.id, apex, prefix),
        status: 'PENDING',
        checkCycle: 0,
        lastError: null,
        ...extra,
      };
      await db
        .update(schema.deployments)
        .set({ defaultHttps: state })
        .where(eq(schema.deployments.id, deployment.id));
      const fakeJob = {
        id: crypto.randomUUID(),
        deploymentId: deployment.id,
        type: 'CONFIGURE_DOMAIN',
      } as typeof schema.deploymentJobs.$inferSelect;
      return { deployment, fakeJob };
    }

    it('applies cert/validation output and moves PENDING -> WAITING_FOR_DNS', async () => {
      const { deployment, fakeJob } = await seedWithState();
      await applyDefaultHttpsJobResult(db, deployment.id, fakeJob, {
        success: true,
        output: {
          certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
          validationName: '_x.deployz.test',
          validationValue: '_y.acm-validations.aws.',
        },
      });
      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('WAITING_FOR_DNS');
      expect(state?.certificateArn).toBe('arn:aws:acm:us-east-1:1:certificate/abc');
      expect(state?.validationName).toBe('_x.deployz.test');
    });

    it('moves WAITING_FOR_DNS -> CONFIGURING when the cert is ISSUED and HTTPS is wired', async () => {
      const { deployment, fakeJob } = await seedWithState({ status: 'WAITING_FOR_DNS' });
      await applyDefaultHttpsJobResult(db, deployment.id, fakeJob, {
        success: true,
        output: { certificateStatus: 'ISSUED', httpsConfigured: true, routingTarget: 'alb.example.com' },
      });
      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('CONFIGURING');
      expect(state?.routingTarget).toBe('alb.example.com');
    });

    it('a configure failure sets ERROR with the classified lastError', async () => {
      const { deployment, fakeJob } = await seedWithState();
      await applyDefaultHttpsJobResult(db, deployment.id, fakeJob, {
        success: false,
        failureCode: 'AWS_PERMISSION_DENIED',
      });
      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('ERROR');
      expect(state?.lastError).toBe('AWS_PERMISSION_DENIED');
    });

    it('a REMOVE_DOMAIN success clears the state', async () => {
      const { deployment } = await seedWithState();
      const fakeRemove = {
        id: crypto.randomUUID(),
        deploymentId: deployment.id,
        type: 'REMOVE_DOMAIN',
      } as typeof schema.deploymentJobs.$inferSelect;
      await applyDefaultHttpsJobResult(db, deployment.id, fakeRemove, { success: true });
      expect(await stateOf(deployment.id)).toBeNull();
    });

    it('a REMOVE_DOMAIN failure keeps REMOVING with REMOVE_FAILED', async () => {
      const { deployment } = await seedWithState({ status: 'REMOVING' });
      const fakeRemove = {
        id: crypto.randomUUID(),
        deploymentId: deployment.id,
        type: 'REMOVE_DOMAIN',
      } as typeof schema.deploymentJobs.$inferSelect;
      await applyDefaultHttpsJobResult(db, deployment.id, fakeRemove, { success: false });
      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('REMOVING');
      expect(state?.lastError).toBe('REMOVE_FAILED');
    });
  });

  describe('beginDefaultHttpsRemoval', () => {
    it('marks REMOVING and mints one REMOVE_DOMAIN job carrying the certificate arn', async () => {
      const deployment = await seedDeployment();
      const state = {
        hostname: defaultHttpsHostname(deployment.id, apex, prefix),
        status: 'ACTIVE',
        certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
        checkCycle: 2,
        lastError: null,
      };
      await db
        .update(schema.deployments)
        .set({ defaultHttps: state })
        .where(eq(schema.deployments.id, deployment.id));

      await beginDefaultHttpsRemoval(db, deployment, state);
      expect((await stateOf(deployment.id))?.status).toBe('REMOVING');

      const removeJobs = (await jobsFor(deployment.id)).filter((job) => job.type === 'REMOVE_DOMAIN');
      expect(removeJobs).toHaveLength(1);
      expect(removeJobs[0]!.payload).toMatchObject({
        hostname: defaultHttpsHostname(deployment.id, apex, prefix),
        domainId: deployment.id,
        certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
      });
      expect(removeJobs[0]!.idempotencyKey).toBe(`${deployment.id}:REMOVE_DOMAIN:default-https:3`);

      // A repeat call reuses the in-flight job — no retry storm.
      await beginDefaultHttpsRemoval(db, deployment, { ...state, status: 'REMOVING', checkCycle: 3 });
      expect((await jobsFor(deployment.id)).filter((job) => job.type === 'REMOVE_DOMAIN')).toHaveLength(1);
    });
  });

  describe('helpers', () => {
    it('isDefaultHttpsJob recognises the machine namespace and nothing else', () => {
      expect(isDefaultHttpsJob({ idempotencyKey: 'dep-1:CONFIGURE_DOMAIN:default-https:1' })).toBe(true);
      expect(
        isDefaultHttpsJob({ idempotencyKey: 'dep-1:CONFIGURE_DOMAIN:11111111-2222-3333-4444-555555555555:0' }),
      ).toBe(false);
    });

    it('parseDefaultHttps accepts a full state and rejects garbage', () => {
      const hostname = defaultHttpsHostname('dep-1', DEFAULT_HTTPS_APEX, prefix);
      const parsed = parseDefaultHttps({ hostname, status: 'ACTIVE', checkCycle: 1, lastError: null });
      expect(parsed?.status).toBe('ACTIVE');
      expect(parseDefaultHttps(null)).toBeNull();
      expect(parseDefaultHttps({ status: 'BOGUS' })).toBeNull();
      expect(parseDefaultHttps({ hostname, status: 'ACTIVE' })).not.toBeNull();
    });

    it('ensureDefaultHttpsConfigureJob with a finished job at the current cycle bumps the cycle', async () => {
      const deployment = await seedDeployment();
      const state = {
        hostname: defaultHttpsHostname(deployment.id, apex, prefix),
        status: 'PENDING',
        checkCycle: 0,
        lastError: null,
      };
      await ensureDefaultHttpsConfigureJob(db, deployment, state);
      const jobs = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      expect(jobs).toHaveLength(1);
      await db
        .update(schema.deploymentJobs)
        .set({ state: 'SUCCEEDED', finishedAt: new Date() })
        .where(eq(schema.deploymentJobs.id, jobs[0]!.id));
      // A fresh pass with the same current cycle bumps it to 1 and mints a
      // fresh idempotency key instead of replaying the finished job's.
      await ensureDefaultHttpsConfigureJob(db, deployment, state);
      const after = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      expect(after).toHaveLength(2);
      expect(after.some((job) => job.idempotencyKey.endsWith(':1'))).toBe(true);
      expect((await stateOf(deployment.id))?.checkCycle).toBe(1);
    });

    it('ensureDefaultHttpsConfigureJob after a state reset creates a job above every earlier cycle', async () => {
      const deployment = await seedDeployment();
      const hostname = defaultHttpsHostname(deployment.id, apex);
      const prefix = `${deployment.id}:CONFIGURE_DOMAIN:default-https:`;
      // History of the failed first attempt: cycle 0 cancelled, cycle 1 succeeded.
      for (const [cycle, state] of [[0, 'CANCELLED'], [1, 'SUCCEEDED']] as const) {
        await db.insert(schema.deploymentJobs).values({
          deploymentId: deployment.id,
          type: 'CONFIGURE_DOMAIN',
          state,
          idempotencyKey: `${prefix}${cycle}`,
          payload: {},
          requestedBy: null,
          finishedAt: new Date(),
        });
      }
      // The retry dropped the state; the next pass starts again at cycle 0.
      const state = { hostname, status: 'PENDING', checkCycle: 0, lastError: null };
      expect(await ensureDefaultHttpsConfigureJob(db, deployment, state)).toBe(true);
      const jobs = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      expect(jobs).toHaveLength(3);
      expect(jobs.some((job) => job.idempotencyKey === `${prefix}2` && job.state === 'REQUESTED')).toBe(true);
      expect((await stateOf(deployment.id))?.checkCycle).toBe(2);
    });

    it('uses the production apex by default', () => {
      expect(defaultHttpsHostname('dep-1', DEFAULT_HTTPS_APEX, prefix)).toBe('d-dep-1.deployz.dev');
    });
  });

  describe('default hostname model (Phase 2)', () => {
    it('mints a deterministic d-<id>.deployz.dev hostname and URL', () => {
      expect(getDefaultDeploymentHostname('dep-1')).toBe('d-dep-1.deployz.dev');
      // Deterministic: same id → same hostname, every time.
      expect(getDefaultDeploymentHostname('dep-1')).toBe(getDefaultDeploymentHostname('dep-1'));
      expect(getDefaultDeploymentUrl('dep-1')).toBe('https://d-dep-1.deployz.dev');
      // A real deployment id (Postgres uuid, lowercase hex + hyphens) round-trips.
      const uuid = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
      expect(getDefaultDeploymentHostname(uuid)).toBe(`d-${uuid}.deployz.dev`);
    });

    it('lower-cases the deployment id before minting', () => {
      expect(getDefaultDeploymentHostname('DEP-1')).toBe('d-dep-1.deployz.dev');
      expect(getDefaultDeploymentHostname('Deployment-A')).toBe('d-deployment-a.deployz.dev');
    });

    it('rejects deployment ids that are not DNS-safe after lower-casing', () => {
      expect(() => getDefaultDeploymentHostname('')).toThrow();
      expect(() => getDefaultDeploymentHostname('../etc/passwd')).toThrow();
      expect(() => getDefaultDeploymentHostname('has space')).toThrow();
      expect(() => getDefaultDeploymentHostname('under_score')).toThrow();
      // Mixed case is fine (lower-cased); a dot or slash is not.
      expect(() => getDefaultDeploymentHostname('DEP.1')).toThrow();
    });

    it('honours prefix/zone overrides and stays in the fixture namespace', () => {
      const fixtureConfig: DefaultHostnameConfig = { zone: DEFAULT_HTTPS_FIXTURE_APEX };
      expect(getDefaultDeploymentHostname('dep-1', fixtureConfig)).toBe(
        `d-dep-1.${DEFAULT_HTTPS_FIXTURE_APEX}`,
      );
      expect(getDefaultDeploymentHostname('dep-1', fixtureConfig)).toMatch(/\.deployz-fixture\.test$/);
      expect(defaultHttpsHostname('dep-1', DEFAULT_HTTPS_FIXTURE_APEX, prefix)).toBe(
        getDefaultDeploymentHostname('dep-1', fixtureConfig),
      );
      // prefix + zone together.
      expect(getDefaultDeploymentHostname('dep-1', { prefix: 'app-', zone: 'example.test' })).toBe(
        'app-dep-1.example.test',
      );
    });

    it('isDefaultDeploymentHostname exact-matches the minted scheme, case-insensitively', () => {
      expect(isDefaultDeploymentHostname('d-dep-1.deployz.dev')).toBe(true);
      expect(isDefaultDeploymentHostname('D-DEP-1.DEPLOYZ.DEV')).toBe(true);
      expect(isDefaultDeploymentHostname('d-dep-1.deployz-fixture.test')).toBe(false);
      expect(isDefaultDeploymentHostname('dep-1.deployz.dev')).toBe(false); // missing prefix
      expect(isDefaultDeploymentHostname('d-dep-1.evil.com')).toBe(false); // wrong zone
      expect(isDefaultDeploymentHostname('d-../x.deployz.dev')).toBe(false); // unsafe id
      expect(isDefaultDeploymentHostname('app.deployz.dev')).toBe(false); // not a d- id
    });

    it('assertMutableDefaultHostname refuses reserved hostnames and non-default zones', () => {
      for (const reserved of RESERVED_DEFAULT_HOSTNAMES) {
        expect(() => assertMutableDefaultHostname(reserved)).toThrow();
      }
      expect(() => assertMutableDefaultHostname('www.deployz.dev')).toThrow();
      expect(() => assertMutableDefaultHostname('evil.com')).toThrow();
      expect(() => assertMutableDefaultHostname('d-dep-1.deployz.dev')).not.toThrow();
    });

    it('resolvePreferredPublicUrl falls back to the default URL unless the custom domain is ACTIVE and healthy', () => {
      const base = { defaultUrl: getDefaultDeploymentUrl('dep-1') };
      // no custom → default; pending → default; ACTIVE+healthy → custom;
      // failed → default; removed → default.
      expect(resolvePreferredPublicUrl(base)).toBe('https://d-dep-1.deployz.dev');
      expect(resolvePreferredPublicUrl({ ...base, customUrl: 'https://app.customer.com' })).toBe(
        'https://d-dep-1.deployz.dev',
      );
      expect(
        resolvePreferredPublicUrl({
          ...base,
          customUrl: 'https://app.customer.com',
          customHealthy: true,
        }),
      ).toBe('https://app.customer.com');
      expect(
        resolvePreferredPublicUrl({ ...base, customUrl: 'https://app.customer.com', customHealthy: false }),
      ).toBe('https://d-dep-1.deployz.dev');
      expect(
        resolvePreferredPublicUrl({ ...base, customUrl: null, customHealthy: true }),
      ).toBe('https://d-dep-1.deployz.dev');
    });
  });

  describe('runDefaultHttpsCheck via the Cloudflare DNS client (Phase 4)', () => {
    const ALB_TARGET = 'alb.us-east-1.elb.amazonaws.com';

    /** A CloudflareDnsClient over the in-memory fake that records every upsert
     *  result and can fail the validation write once (a simulated outage). */
    function trackedClient() {
      const fake = createFakeCloudflareDnsClient({ zoneId: 'zone-1', zoneName: apex });
      const ops: Array<{ record: 'validation' | 'routing'; op: string }> = [];
      let failValidationOnce = false;
      const client: CloudflareDnsClient = {
        getRecord: async (deploymentId) => fake.getRecord(deploymentId),
        upsertDefaultDeploymentRecord: async (deploymentId, target) => {
          const result = await fake.upsertDefaultDeploymentRecord(deploymentId, target);
          ops.push({ record: 'routing', op: result.op });
          return result;
        },
        upsertDefaultValidationRecord: async (deploymentId, validationName, validationValue) => {
          if (failValidationOnce) {
            failValidationOnce = false;
            throw new CloudflareDnsError('simulated Cloudflare outage', 'CLOUDFLARE_UNAVAILABLE');
          }
          const result = await fake.upsertDefaultValidationRecord(deploymentId, validationName, validationValue);
          ops.push({ record: 'validation', op: result.op });
          return result;
        },
        deleteDefaultDeploymentRecord: async (deploymentId) => fake.deleteDefaultDeploymentRecord(deploymentId),
        deleteDefaultValidationRecord: async (deploymentId, validationName) =>
          fake.deleteDefaultValidationRecord(deploymentId, validationName),
        listDefaultRecords: async (options) => fake.listDefaultRecords(options),
      };
      return {
        client,
        fake,
        ops,
        failValidationNext: () => {
          failValidationOnce = true;
        },
      };
    }

    async function settleConfigure(
      deploymentId: string,
      output: Record<string, unknown>,
      success = true,
    ) {
      const jobs = (await jobsFor(deploymentId)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      const job = jobs[jobs.length - 1]!;
      await db
        .update(schema.deploymentJobs)
        .set({ state: success ? 'SUCCEEDED' : 'FAILED', finishedAt: new Date() })
        .where(eq(schema.deploymentJobs.id, job.id));
      await applyDefaultHttpsJobResult(db, deploymentId, job, { success, output });
    }

    /** install → PENDING job → relay reports validation fields + the ALB →
     *  WAITING_FOR_DNS, exactly like the custom-domain machine. */
    async function installWithAlbTarget(client: CloudflareDnsClient) {
      const deployment = await seedDeployment();
      await runDefaultHttpsCheck(db, deployment, deps({ dns: client }));
      const validationName = `_x1.${defaultHttpsHostname(deployment.id, apex, prefix)}`;
      await settleConfigure(deployment.id, {
        certificateArn: 'arn:aws:acm:us-east-1:1:certificate/abc',
        validationName,
        validationValue: '_y1.acm-validations.aws.',
        routingTarget: ALB_TARGET,
      });
      return { deployment, validationName };
    }

    function configureJobCount(deploymentId: string) {
      return jobsFor(deploymentId).then((rows) => rows.filter((job) => job.type === 'CONFIGURE_DOMAIN').length);
    }

    it('reconciles the proxied routing + unproxied validation records, stamps lastDnsCheckAt, and lets WAITING_FOR_DNS → CONFIGURING ride the relay outcome', async () => {
      const { client, fake } = trackedClient();
      const { deployment, validationName } = await installWithAlbTarget(client);
      expect((await stateOf(deployment.id))?.status).toBe('WAITING_FOR_DNS');

      await runDefaultHttpsCheck(db, deployment, deps({ dns: client }));

      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('WAITING_FOR_DNS');
      expect(state?.lastError).toBeNull();
      expect(state?.lastDnsCheckAt).toBeTruthy();

      const hostname = defaultHttpsHostname(deployment.id, apex, prefix);
      const records = fake.listRecords();
      expect(records.some((record) => record.name === hostname && record.content === ALB_TARGET && record.proxied === true)).toBe(
        true,
      );
      expect(
        records.some(
          (record) =>
            record.name === validationName &&
            record.content === '_y1.acm-validations.aws.' &&
            record.proxied === false,
        ),
      ).toBe(true);

      // DNS is in place → a fresh configure cycle is minted; once the relay
      // reports the cert ISSUED + listener wired the machine reaches CONFIGURING.
      expect(await configureJobCount(deployment.id)).toBe(2);
      await settleConfigure(deployment.id, { certificateStatus: 'ISSUED', httpsConfigured: true });
      const progressed = await stateOf(deployment.id);
      expect(progressed?.status).toBe('CONFIGURING');
      expect(progressed?.lastDnsCheckAt).toBe(state?.lastDnsCheckAt);
    });

    it('a repeat reconciliation is a noop — one routing + one validation record, never duplicates', async () => {
      const { client, fake, ops } = trackedClient();
      const { deployment } = await installWithAlbTarget(client);

      await runDefaultHttpsCheck(db, deployment, deps({ dns: client }));
      expect(ops.map((entry) => [entry.record, entry.op])).toEqual([
        ['validation', 'created'],
        ['routing', 'created'],
      ]);
      expect(fake.listRecords()).toHaveLength(2);

      ops.length = 0;
      await runDefaultHttpsCheck(db, deployment, deps({ dns: client, now: laterBy(1) }));
      expect(ops.map((entry) => [entry.record, entry.op])).toEqual([
        ['validation', 'noop'],
        ['routing', 'noop'],
      ]);
      expect(fake.listRecords()).toHaveLength(2);
    });

    it('a Cloudflare outage corrupts nothing and enqueues no AWS job; the next pass retries', async () => {
      const { client, fake, ops, failValidationNext } = trackedClient();
      const { deployment } = await installWithAlbTarget(client);
      expect(await configureJobCount(deployment.id)).toBe(1);

      failValidationNext();
      await runDefaultHttpsCheck(db, deployment, deps({ dns: client }));

      const failed = await stateOf(deployment.id);
      expect(failed?.status).toBe('WAITING_FOR_DNS');
      expect(failed?.lastError).toBe('DNS_WRITE_FAILED');
      expect(failed?.lastDnsCheckAt).toBeTruthy();
      // The failed validation write stopped before the routing write and no
      // CONFIGURE_DOMAIN job was minted from the DNS failure.
      expect(ops).toHaveLength(0);
      expect(await configureJobCount(deployment.id)).toBe(1);
      expect(fake.listRecords()).toHaveLength(0);

      // The next driver pass reconciles both records and mints the fresh cycle.
      await runDefaultHttpsCheck(db, deployment, deps({ dns: client, now: laterBy(1) }));
      const recovered = await stateOf(deployment.id);
      expect(recovered?.status).toBe('WAITING_FOR_DNS');
      expect(recovered?.lastError).toBeNull();
      expect(recovered?.lastDnsCheckAt).not.toBe(failed?.lastDnsCheckAt);
      expect(fake.listRecords()).toHaveLength(2);
      expect(await configureJobCount(deployment.id)).toBe(2);
    });

    it('an ALB change (trusted relay-reported routingTarget drift) updates the routing record content', async () => {
      const { client, fake, ops } = trackedClient();
      const { deployment } = await installWithAlbTarget(client);

      await runDefaultHttpsCheck(db, deployment, deps({ dns: client }));
      const newTarget = 'alb-2.us-east-1.elb.amazonaws.com';
      const current = await stateOf(deployment.id);
      await db
        .update(schema.deployments)
        .set({ defaultHttps: { ...current!, routingTarget: newTarget } })
        .where(eq(schema.deployments.id, deployment.id));

      ops.length = 0;
      await runDefaultHttpsCheck(db, deployment, deps({ dns: client, now: laterBy(1) }));

      expect(ops).toEqual([
        { record: 'validation', op: 'noop' },
        { record: 'routing', op: 'updated' },
      ]);
      const hostname = defaultHttpsHostname(deployment.id, apex, prefix);
      const routing = fake.listRecords().find((record) => record.name === hostname);
      expect(routing?.content).toBe(newTarget);
    });
  });

  // Phase 12 — bounded default-DNS reconciliation watchdog. The budget is
  // elapsed time on the injected clock.
  describe('watchdog — bounded default DNS reconciliation (Phase 12)', () => {
    async function seedWaitingForDns(configureAttempts = 0) {
      const deployment = await seedDeployment();
      const state = {
        hostname: defaultHttpsHostname(deployment.id, apex, prefix),
        status: 'WAITING_FOR_DNS' as const,
        validationName: `_x1.${defaultHttpsHostname(deployment.id, apex, prefix)}`,
        validationValue: '_y1.acm-validations.aws.',
        routingTarget: 'alb.us-east-1.elb.amazonaws.com',
        checkCycle: 0,
        lastError: null,
        configureAttempts,
      };
      await db
        .update(schema.deployments)
        .set({ defaultHttps: state })
        .where(eq(schema.deployments.id, deployment.id));
      return deployment;
    }

    function dnsThatFailsValidationWrite(code: 'CLOUDFLARE_RATE_LIMITED' | 'CLOUDFLARE_UNAVAILABLE') {
      const fake = createFakeCloudflareDnsClient({ zoneId: 'zone-1', zoneName: apex });
      const client: CloudflareDnsClient = {
        getRecord: async (id) => fake.getRecord(id),
        upsertDefaultDeploymentRecord: async (id, target) => fake.upsertDefaultDeploymentRecord(id, target),
        upsertDefaultValidationRecord: async () => {
          throw new CloudflareDnsError(`simulated ${code}`, code);
        },
        deleteDefaultDeploymentRecord: async (id) => fake.deleteDefaultDeploymentRecord(id),
        deleteDefaultValidationRecord: async (id, name) => fake.deleteDefaultValidationRecord(id, name),
        listDefaultRecords: async (options) => fake.listDefaultRecords(options),
      };
      return { client, fake };
    }

    /** A controllable clock; `advance` moves it forward. */
    function makeClock(startMs = Date.now() - 2 * 60 * 60_000) {
      let current = startMs;
      return {
        now: () => current,
        advance: (ms: number) => {
          current += ms;
        },
      };
    }

    const MINUTE = DEFAULT_HTTPS_MIN_ATTEMPT_INTERVAL_MS;

    it('unavailable DNS failures are counted and time out to ERROR + DEFAULT_DNS_TIMEOUT after the budget', async () => {
      const deployment = await seedWaitingForDns(0);
      const { client } = dnsThatFailsValidationWrite('CLOUDFLARE_UNAVAILABLE');
      const clock = makeClock();

      let attempts = 0;
      for (let elapsed = 0; elapsed < DEFAULT_HTTPS_CONFIGURE_BUDGET_MS; elapsed += MINUTE) {
        await runDefaultHttpsCheck(db, deployment, deps({ dns: client, now: clock.now }));
        attempts += 1;
        const during = await stateOf(deployment.id);
        expect(during?.status).toBe('WAITING_FOR_DNS');
        expect(during?.lastError).toBe('DNS_WRITE_FAILED');
        expect(during?.configureAttempts).toBe(attempts);
        clock.advance(MINUTE);
      }

      // The next attempt finds the whole budget used and times the machine out.
      await runDefaultHttpsCheck(db, deployment, deps({ dns: client, now: clock.now }));
      const timedOut = await stateOf(deployment.id);
      expect(timedOut?.status).toBe('ERROR');
      expect(timedOut?.lastError).toBe('DEFAULT_DNS_TIMEOUT');
    });

    it('fast heartbeats do not consume the budget or multiply attempts', async () => {
      const deployment = await seedWaitingForDns(0);
      const { client } = dnsThatFailsValidationWrite('CLOUDFLARE_UNAVAILABLE');
      const clock = makeClock();

      // One attempt, then a heartbeat every 5 seconds for 50 seconds.
      await runDefaultHttpsCheck(db, deployment, deps({ dns: client, now: clock.now }));
      for (let i = 0; i < 10; i += 1) {
        clock.advance(5_000);
        await runDefaultHttpsCheck(db, deployment, deps({ dns: client, now: clock.now }));
      }
      const early = await stateOf(deployment.id);
      expect(early?.configureAttempts).toBe(1);
      expect(early?.status).toBe('WAITING_FOR_DNS');

      // The interval has passed: the next heartbeat is a second attempt.
      clock.advance(MINUTE);
      await runDefaultHttpsCheck(db, deployment, deps({ dns: client, now: clock.now }));
      expect((await stateOf(deployment.id))?.configureAttempts).toBe(2);
    });

    it('does not time out before the budget has elapsed', async () => {
      const deployment = await seedWaitingForDns(0);
      const { client } = dnsThatFailsValidationWrite('CLOUDFLARE_UNAVAILABLE');
      const clock = makeClock();

      await runDefaultHttpsCheck(db, deployment, deps({ dns: client, now: clock.now }));
      clock.advance(DEFAULT_HTTPS_CONFIGURE_BUDGET_MS - MINUTE);
      await runDefaultHttpsCheck(db, deployment, deps({ dns: client, now: clock.now }));
      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('WAITING_FOR_DNS');
      expect(state?.configureAttempts).toBe(2);
    });

    it('rate-limited failures are not counted and stay retryable', async () => {
      const deployment = await seedWaitingForDns(0);
      const { client } = dnsThatFailsValidationWrite('CLOUDFLARE_RATE_LIMITED');
      const clock = makeClock();

      for (let i = 0; i < 40; i += 1) {
        await runDefaultHttpsCheck(db, deployment, deps({ dns: client, now: clock.now }));
        clock.advance(MINUTE);
      }
      const state = await stateOf(deployment.id);
      expect(state?.status).toBe('WAITING_FOR_DNS');
      expect(state?.lastError).toBe('CLOUDFLARE_RATE_LIMITED');
      expect(state?.configureAttempts).toBe(0);
    });

    it('recovers to ACTIVE with a fresh budget after a DEFAULT_DNS_TIMEOUT', async () => {
      const deployment = await seedWaitingForDns(0);
      const failing = dnsThatFailsValidationWrite('CLOUDFLARE_UNAVAILABLE');
      const clock = makeClock();
      for (let elapsed = 0; elapsed <= DEFAULT_HTTPS_CONFIGURE_BUDGET_MS; elapsed += MINUTE) {
        await runDefaultHttpsCheck(db, deployment, deps({ dns: failing.client, now: clock.now }));
        clock.advance(MINUTE);
      }
      expect((await stateOf(deployment.id))?.status).toBe('ERROR');

      // ERROR is terminal — automatic retry is removed (DZ-AUDIT-008). The
      // vendor must call the retry route to reset the machine; simulate that
      // here by resetting the state to PENDING + fresh budget.
      const goodDns = createFakeCloudflareDnsClient({ zoneId: 'zone-1', zoneName: apex });
      await runDefaultHttpsCheck(db, deployment, deps({ dns: goodDns }));
      expect((await stateOf(deployment.id))?.status).toBe('ERROR');

      // Simulate the vendor retry: reset to PENDING.
      const s = (await stateOf(deployment.id))!;
      await db
        .update(schema.deployments)
        .set({ defaultHttps: { ...s, status: 'PENDING', configureAttempts: 0, lastError: null } })
        .where(eq(schema.deployments.id, deployment.id));
      await runDefaultHttpsCheck(db, deployment, deps({ dns: goodDns }));
      // PENDING created a fresh configure job — settle it to get validation
      // records and advance to WAITING_FOR_DNS.
      const pendingJob = (await jobsFor(deployment.id))
        .filter((j) => j.type === 'CONFIGURE_DOMAIN')
        .pop()!;
      await db
        .update(schema.deploymentJobs)
        .set({ state: 'SUCCEEDED', finishedAt: new Date() })
        .where(eq(schema.deploymentJobs.id, pendingJob.id));
      await applyDefaultHttpsJobResult(db, deployment.id, pendingJob, {
        success: true,
        output: {
          certificateArn: 'arn:aws:acm:us-east-1:1:certificate/retry',
          validationName: `_x1.${defaultHttpsHostname(deployment.id, apex, prefix)}`,
          validationValue: '_y1.acm-validations.aws.',
          routingTarget: 'alb.us-east-1.elb.amazonaws.com',
        },
      });
      await runDefaultHttpsCheck(db, deployment, deps({ dns: goodDns }));
      expect((await stateOf(deployment.id))?.status).toBe('WAITING_FOR_DNS');

      const jobs = (await jobsFor(deployment.id)).filter((job) => job.type === 'CONFIGURE_DOMAIN');
      const job = jobs[jobs.length - 1]!;
      await db
        .update(schema.deploymentJobs)
        .set({ state: 'SUCCEEDED', finishedAt: new Date() })
        .where(eq(schema.deploymentJobs.id, job.id));
      await applyDefaultHttpsJobResult(db, deployment.id, job, {
        success: true,
        output: { certificateStatus: 'ISSUED', httpsConfigured: true },
      });
      expect((await stateOf(deployment.id))?.status).toBe('CONFIGURING');

      await runDefaultHttpsCheck(db, deployment, deps({ dns: goodDns }));
      const active = await stateOf(deployment.id);
      expect(active?.status).toBe('ACTIVE');
      expect(active?.lastError).toBeNull();
    });

    it('recreates a record that was deleted out-of-band on the next reconciliation', async () => {
      const deployment = await seedDeployment();
      const goodDns = createFakeCloudflareDnsClient({ zoneId: 'zone-1', zoneName: apex });
      await runDefaultHttpsCheck(db, deployment, deps({ dns: goodDns })); // PENDING + job0
      const job = (await jobsFor(deployment.id)).filter((j) => j.type === 'CONFIGURE_DOMAIN')[0]!;
      await db
        .update(schema.deploymentJobs)
        .set({ state: 'SUCCEEDED', finishedAt: new Date() })
        .where(eq(schema.deploymentJobs.id, job.id));
      await applyDefaultHttpsJobResult(db, deployment.id, job, {
        success: true,
        output: {
          validationName: `_x1.${defaultHttpsHostname(deployment.id, apex, prefix)}`,
          validationValue: '_y1.acm-validations.aws.',
          routingTarget: 'alb.us-east-1.elb.amazonaws.com',
        },
      });
      await runDefaultHttpsCheck(db, deployment, deps({ dns: goodDns })); // writes both records
      const hostname = defaultHttpsHostname(deployment.id, apex, prefix);
      expect(goodDns.listRecords().some((record) => record.name === hostname)).toBe(true);

      // Someone deleted the routing record at Cloudflare — the next upsert
      // recreates it rather than erroring.
      await goodDns.deleteDefaultDeploymentRecord(deployment.id);
      expect(goodDns.listRecords().some((record) => record.name === hostname)).toBe(false);

      await runDefaultHttpsCheck(db, deployment, deps({ dns: goodDns, now: laterBy(1) }));
      expect(goodDns.listRecords().some((record) => record.name === hostname)).toBe(true);
    });
  });

  // Phase 11 — purge-time orphan reconciliation (reconcileOrphanedDefaultRecords)
  // over the in-memory fake + PGlite.
  describe('reconcileOrphanedDefaultRecords (Phase 11)', () => {
    const orphanId = crypto.randomUUID();
    const orphanHostname = defaultHttpsHostname(orphanId, apex, prefix);

    function clientWithListing(listing: CloudflareDnsRecord[], listingPrefix = prefix) {
      const fake = createFakeCloudflareDnsClient({ zoneId: 'zone-1', zoneName: apex, prefix: listingPrefix });
      const deleted: string[] = [];
      const client: CloudflareDnsClient = {
        getRecord: async (id) => fake.getRecord(id),
        upsertDefaultDeploymentRecord: async (id, target) => fake.upsertDefaultDeploymentRecord(id, target),
        upsertDefaultValidationRecord: async (id, name, value) =>
          fake.upsertDefaultValidationRecord(id, name, value),
        deleteDefaultDeploymentRecord: async (id) => {
          deleted.push(id);
          return fake.deleteDefaultDeploymentRecord(id);
        },
        deleteDefaultValidationRecord: async (id, name) => fake.deleteDefaultValidationRecord(id, name),
        listDefaultRecords: async () => listing,
      };
      return { fake, client, deleted };
    }

    function listingRecord(name: string, content = 'alb.example.com'): CloudflareDnsRecord {
      return { id: `rec-${crypto.randomUUID()}`, type: 'CNAME', name, content, ttl: 1, proxied: true };
    }

    it('deletes a record whose deployment row no longer exists', async () => {
      const { client, deleted } = clientWithListing([listingRecord(orphanHostname)]);
      const result = await reconcileOrphanedDefaultRecords(db, client, { zone: apex });
      expect(result).toEqual({ deleted: 1, kept: 0 });
      expect(deleted).toEqual([orphanId]);
    });

    it('keeps the record of a live deployment (row exists, deletedAt null)', async () => {
      const deployment = await seedDeployment();
      const { client, deleted } = clientWithListing([
        listingRecord(defaultHttpsHostname(deployment.id, apex, prefix)),
      ]);
      const result = await reconcileOrphanedDefaultRecords(db, client, { zone: apex });
      expect(result).toEqual({ deleted: 0, kept: 1 });
      expect(deleted).toEqual([]);
    });

    it('skips reserved/non-uuid/wrong-zone names with zero delete calls', async () => {
      const { client, deleted } = clientWithListing([
        listingRecord('app.deployz.test'), // structurally reserved
        listingRecord(`d-not-a-uuid.${apex}`), // non-uuid id
        listingRecord(`d-${crypto.randomUUID()}.evil.example`), // wrong zone
      ]);
      const result = await reconcileOrphanedDefaultRecords(db, client, { zone: apex });
      expect(result).toEqual({ deleted: 0, kept: 3 });
      expect(deleted).toEqual([]);
    });

    it.each([
      { own: 's-', other: 'd-' },
      { own: 'd-', other: 's-' },
    ])('a $own plane deletes only its own orphans and never the $other ones', async ({ own, other }) => {
      const ownOrphan = crypto.randomUUID();
      const otherOrphan = crypto.randomUUID();
      const { client, deleted } = clientWithListing(
        [listingRecord(`${own}${ownOrphan}.${apex}`), listingRecord(`${other}${otherOrphan}.${apex}`)],
        own,
      );
      const result = await reconcileOrphanedDefaultRecords(db, client, { zone: apex, prefix: own });
      expect(result).toEqual({ deleted: 1, kept: 1 });
      expect(deleted).toEqual([ownOrphan]);
    });

    it('is idempotent: a second run after a successful one has nothing left to delete', async () => {
      const { client, deleted } = clientWithListing([listingRecord(orphanHostname)]);
      const first = await reconcileOrphanedDefaultRecords(db, client, { zone: apex });
      expect(first.deleted).toBe(1);
      // Second run: list still shows the record but it is already gone.
      const second = await reconcileOrphanedDefaultRecords(db, client, { zone: apex });
      expect(second).toEqual({ deleted: 1, kept: 0 });
      expect(deleted).toHaveLength(2);
    });

    it('already-missing records delete as a noop without error', async () => {
      const { client, deleted } = clientWithListing([]);
      const result = await reconcileOrphanedDefaultRecords(db, client, { zone: apex });
      expect(result).toEqual({ deleted: 0, kept: 0 });
      expect(deleted).toEqual([]);
    });

    it('failure is state-only: a listing error propagates and writes nothing', async () => {
      const before = await db.select({ id: schema.deployments.id }).from(schema.deployments);
      const { fake } = clientWithListing([]);
      const failing: CloudflareDnsClient = {
        getRecord: async (id) => fake.getRecord(id),
        upsertDefaultDeploymentRecord: async (id, target) => fake.upsertDefaultDeploymentRecord(id, target),
        upsertDefaultValidationRecord: async (id, name, value) =>
          fake.upsertDefaultValidationRecord(id, name, value),
        deleteDefaultDeploymentRecord: async (id) => fake.deleteDefaultDeploymentRecord(id),
        deleteDefaultValidationRecord: async (id, name) => fake.deleteDefaultValidationRecord(id, name),
        listDefaultRecords: async () => {
          throw new CloudflareDnsError('boom', 'CLOUDFLARE_UNAVAILABLE');
        },
      };
      await expect(reconcileOrphanedDefaultRecords(db, failing, { zone: apex })).rejects.toThrow(
        CloudflareDnsError,
      );
      const after = await db.select({ id: schema.deployments.id }).from(schema.deployments);
      expect(after).toEqual(before);
    });

    it('parseDefaultDeploymentId accepts only d-<uuid>.<zone> names', () => {
      const uuid = crypto.randomUUID();
      expect(parseDefaultDeploymentId(`d-${uuid}.${DEFAULT_HTTPS_APEX}`)).toBe(uuid);
      expect(parseDefaultDeploymentId(`d-${uuid}.${DEFAULT_HTTPS_FIXTURE_APEX}`, { zone: DEFAULT_HTTPS_FIXTURE_APEX })).toBe(uuid);
      expect(parseDefaultDeploymentId('d-dep-1.deployz.dev')).toBeNull(); // not a uuid
      expect(parseDefaultDeploymentId('app.deployz.dev')).toBeNull(); // not d-
      expect(parseDefaultDeploymentId(`d-${uuid}.evil.example`)).toBeNull(); // wrong zone
      expect(parseDefaultDeploymentId(`s-${uuid}.${DEFAULT_HTTPS_APEX}`, { prefix: 'd-' })).toBeNull(); // other plane
      expect(parseDefaultDeploymentId(`d-${uuid}.${DEFAULT_HTTPS_APEX}`, { prefix: 's-' })).toBeNull(); // other plane
      expect(parseDefaultDeploymentId(`s-${uuid}.${DEFAULT_HTTPS_APEX}`, { prefix: 's-' })).toBe(uuid);
    });
  });
});
