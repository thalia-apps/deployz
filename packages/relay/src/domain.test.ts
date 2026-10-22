import { DEPLOYZ_INSTALLATION_TAG } from '@deployz/contracts';
import { describe, expect, it } from 'vitest';

import type { RelayCommand } from './commands.js';
import {
  createDomainExecutors,
  type AcmClient,
  type ElbClient,
  type ListenerInfo,
  type LoadBalancerInfo,
} from './domain.js';

// ── Fakes ────────────────────────────────────────────────────────────────────

interface FakeCertificate {
  status: string;
  tags?: Record<string, string>;
  validationRecord?: { name: string; value: string };
}

class FakeAcmClient implements AcmClient {
  certificates = new Map<string, FakeCertificate>();
  requestCalls: Array<{ domainName: string; idempotencyToken: string; tags: Record<string, string> }> = [];
  deleteCalls: string[] = [];
  requestError: Error | undefined;
  deleteError: Error | undefined;
  /** How many `deleteCertificate` calls should still throw `deleteError` before succeeding. -1 = always. */
  deleteErrorRemaining = -1;
  #arnCounter = 0;

  async requestCertificate(p: {
    domainName: string;
    idempotencyToken: string;
    tags: Record<string, string>;
  }): Promise<string> {
    this.requestCalls.push(p);
    if (this.requestError) throw this.requestError;
    const arn = `arn:aws:acm:us-east-1:123456789012:certificate/new-${this.#arnCounter++}`;
    if (!this.certificates.has(arn)) {
      this.certificates.set(arn, { status: 'PENDING_VALIDATION' });
    }
    return arn;
  }

  async describeCertificate(arn: string): Promise<FakeCertificate> {
    const cert = this.certificates.get(arn);
    if (!cert) throw new Error(`no fake certificate registered for ${arn}`);
    return cert;
  }

  async certificateTags(arn: string): Promise<Record<string, string> | undefined> {
    const cert = this.certificates.get(arn);
    if (!cert) return undefined;
    return cert.tags ?? { [DEPLOYZ_INSTALLATION_TAG]: INSTALLATION_ID };
  }

  async deleteCertificate(arn: string): Promise<void> {
    this.deleteCalls.push(arn);
    if (this.deleteError && this.deleteErrorRemaining !== 0) {
      if (this.deleteErrorRemaining > 0) this.deleteErrorRemaining--;
      throw this.deleteError;
    }
    // Real client contract: swallow ResourceNotFoundException. The fake
    // models that by simply no-op'ing on an arn it doesn't know about.
    this.certificates.delete(arn);
  }
}

class FakeElbClient implements ElbClient {
  loadBalancer: LoadBalancerInfo | undefined;
  listeners: ListenerInfo[] = [];
  targetGroups: string[] = [];

  createHttpsListenerCalls: Array<{
    loadBalancerArn: string;
    certificateArn: string;
    targetGroupArn: string;
    tagKey: string;
    tagValue: string;
  }> = [];
  ensureListenerTagCalls: Array<{ listenerArn: string; tagKey: string; tagValue: string }> = [];
  addListenerCertificateCalls: Array<{ listenerArn: string; certificateArn: string }> = [];
  removeListenerCertificateCalls: Array<{ listenerArn: string; certificateArn: string }> = [];
  deleteListenerCalls: string[] = [];
  setHttpRedirectCalls: string[] = [];
  setHttpForwardCalls: Array<{ listenerArn: string; targetGroupArn: string }> = [];
  /** Records call names in order, so tests can assert tag-then-act sequencing. */
  callLog: string[] = [];

  async findTaggedLoadBalancer(tagKey: string, tagValue: string): Promise<LoadBalancerInfo | undefined> {
    void tagKey;
    void tagValue;
    return this.loadBalancer;
  }

  async describeListeners(loadBalancerArn: string): Promise<ListenerInfo[]> {
    void loadBalancerArn;
    return this.listeners;
  }

  async describeTargetGroups(loadBalancerArn: string): Promise<string[]> {
    void loadBalancerArn;
    return this.targetGroups;
  }

  async createHttpsListener(p: {
    loadBalancerArn: string;
    certificateArn: string;
    targetGroupArn: string;
    tagKey: string;
    tagValue: string;
  }): Promise<void> {
    this.createHttpsListenerCalls.push(p);
  }

  async ensureListenerTag(listenerArn: string, tagKey: string, tagValue: string): Promise<void> {
    this.ensureListenerTagCalls.push({ listenerArn, tagKey, tagValue });
    this.callLog.push('ensureListenerTag');
  }

  async addListenerCertificate(listenerArn: string, certificateArn: string): Promise<void> {
    this.addListenerCertificateCalls.push({ listenerArn, certificateArn });
    this.callLog.push('addListenerCertificate');
  }

  async removeListenerCertificate(listenerArn: string, certificateArn: string): Promise<void> {
    this.removeListenerCertificateCalls.push({ listenerArn, certificateArn });
  }

  async deleteListener(listenerArn: string): Promise<void> {
    this.deleteListenerCalls.push(listenerArn);
    this.callLog.push('deleteListener');
  }

  async setHttpRedirect(listenerArn: string): Promise<void> {
    this.setHttpRedirectCalls.push(listenerArn);
  }

  async setHttpForward(listenerArn: string, targetGroupArn: string): Promise<void> {
    this.setHttpForwardCalls.push({ listenerArn, targetGroupArn });
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const INSTALLATION_ID = 'inst-abc123';

function configureCommand(overrides: Partial<Record<string, unknown>> = {}): RelayCommand {
  return {
    id: 'job-1',
    deploymentId: 'dep-1',
    type: 'CONFIGURE_DOMAIN',
    idempotencyKey: 'ik-1',
    payload: {
      hostname: 'custom.example.com',
      domainId: '11111111-2222-3333-4444-555555555555',
      ...overrides,
    },
  };
}

function removeCommand(overrides: Partial<Record<string, unknown>> = {}): RelayCommand {
  return {
    id: 'job-2',
    deploymentId: 'dep-1',
    type: 'REMOVE_DOMAIN',
    idempotencyKey: 'ik-2',
    payload: {
      hostname: 'custom.example.com',
      domainId: '11111111-2222-3333-4444-555555555555',
      ...overrides,
    },
  };
}

function makeLb(): LoadBalancerInfo {
  return { arn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/lb/abc', dnsName: 'lb-abc.us-east-1.elb.amazonaws.com' };
}

/** Records delays without waiting, so retry tests run instantly. */
function fakeSleep(calls: number[]): (ms: number) => Promise<void> {
  return async (ms: number) => {
    calls.push(ms);
  };
}

function resourceInUseError(): Error {
  const err = new Error('certificate is in use');
  err.name = 'ResourceInUseException';
  return err;
}

// ── CONFIGURE_DOMAIN ─────────────────────────────────────────────────────────

describe('createDomainExecutors — CONFIGURE_DOMAIN', () => {
  it('fresh configure: requests a cert, reports validation record + routing target, httpsConfigured false while pending', async () => {
    const acm = new FakeAcmClient();
    const elb = new FakeElbClient();
    elb.loadBalancer = makeLb();

    const executors = createDomainExecutors({ acm, elb, installationId: INSTALLATION_ID });
    const command = configureCommand();
    const domainId = (command.payload as { domainId: string }).domainId;
    const result = await executors.CONFIGURE_DOMAIN(command);

    expect(acm.requestCalls).toHaveLength(1);
    expect(acm.requestCalls[0]).toEqual({
      domainName: 'custom.example.com',
      idempotencyToken: domainId.replace(/-/g, ''),
      tags: { 'deployz:installation': INSTALLATION_ID, 'deployz:component': 'tls' },
    });
    // 32-char idempotency token: uuid sans dashes — ACM's IdempotencyToken limit.
    expect(acm.requestCalls[0]?.idempotencyToken).toHaveLength(32);

    expect(result.success).toBe(true);
    expect(result.output?.certificateStatus).toBe('PENDING_VALIDATION');
    expect(result.output?.httpsConfigured).toBe(false);
    expect(result.output?.routingTarget).toBe('lb-abc.us-east-1.elb.amazonaws.com');
    expect(elb.createHttpsListenerCalls).toHaveLength(0);
    expect(elb.addListenerCertificateCalls).toHaveLength(0);
  });

  it('before the load balancer exists: requests the cert and reports the validation record, with no listener and no failure', async () => {
    const acm = new FakeAcmClient();
    const elb = new FakeElbClient();
    const executors = createDomainExecutors({ acm, elb, installationId: INSTALLATION_ID });
    const first = await executors.CONFIGURE_DOMAIN(configureCommand());
    const arn = first.output?.certificateArn as string;
    acm.certificates.set(arn, {
      status: 'PENDING_VALIDATION',
      validationRecord: { name: '_v.custom.example.com.', value: '_v.acm-validations.aws.' },
    });

    const result = await executors.CONFIGURE_DOMAIN(configureCommand({ certificateArn: arn }));

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      certificateArn: arn,
      validationName: '_v.custom.example.com.',
      validationValue: '_v.acm-validations.aws.',
      httpsConfigured: false,
    });
    expect(result.output).not.toHaveProperty('routingTarget');
    expect(elb.createHttpsListenerCalls).toHaveLength(0);
  });

  it('once the load balancer exists the same certificate gets its routing target and, when issued, the listener', async () => {
    const acm = new FakeAcmClient();
    acm.certificates.set('arn:cert-1', { status: 'ISSUED' });
    const elb = new FakeElbClient();
    const executors = createDomainExecutors({ acm, elb, installationId: INSTALLATION_ID });
    const early = await executors.CONFIGURE_DOMAIN(configureCommand({ certificateArn: 'arn:cert-1' }));
    expect(early.output?.httpsConfigured).toBe(false);

    elb.loadBalancer = makeLb();
    elb.listeners = [{ arn: 'listener-80', port: 80, redirectsToHttps: false, forwardTargetGroupArn: 'tg-1' }];
    const later = await executors.CONFIGURE_DOMAIN(configureCommand({ certificateArn: 'arn:cert-1' }));

    expect(later.output).toMatchObject({ routingTarget: 'lb-abc.us-east-1.elb.amazonaws.com', httpsConfigured: true });
    expect(elb.createHttpsListenerCalls).toHaveLength(1);
  });

  it('deferListener: an issued cert and an existing load balancer still get no listener while the install runs', async () => {
    const acm = new FakeAcmClient();
    acm.certificates.set('arn:cert-1', { status: 'ISSUED' });
    const elb = new FakeElbClient();
    elb.loadBalancer = makeLb();
    elb.listeners = [{ arn: 'listener-80', port: 80, redirectsToHttps: false, forwardTargetGroupArn: 'tg-1' }];
    const executors = createDomainExecutors({ acm, elb, installationId: INSTALLATION_ID });

    const result = await executors.CONFIGURE_DOMAIN(
      configureCommand({ certificateArn: 'arn:cert-1', deferListener: true }),
    );

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ routingTarget: 'lb-abc.us-east-1.elb.amazonaws.com', httpsConfigured: false });
    expect(elb.createHttpsListenerCalls).toHaveLength(0);
    expect(elb.setHttpRedirectCalls).toHaveLength(0);
  });

  it('configure with certificateArn in payload does not request a new certificate', async () => {
    const acm = new FakeAcmClient();
    acm.certificates.set('arn:existing-cert', { status: 'PENDING_VALIDATION' });
    const elb = new FakeElbClient();
    elb.loadBalancer = makeLb();

    const executors = createDomainExecutors({ acm, elb, installationId: INSTALLATION_ID });
    const result = await executors.CONFIGURE_DOMAIN(configureCommand({ certificateArn: 'arn:existing-cert' }));

    expect(acm.requestCalls).toHaveLength(0);
    expect(result.success).toBe(true);
    expect(result.output?.certificateArn).toBe('arn:existing-cert');
  });

  it('issued + no 443 listener: creates HTTPS listener with the 80-listener target group and sets the 80 redirect', async () => {
    const acm = new FakeAcmClient();
    acm.certificates.set('arn:cert-1', { status: 'ISSUED' });
    const elb = new FakeElbClient();
    const lb = makeLb();
    elb.loadBalancer = lb;
    elb.listeners = [
      { arn: 'listener-80', port: 80, redirectsToHttps: false, forwardTargetGroupArn: 'tg-1' },
    ];

    const executors = createDomainExecutors({ acm, elb, installationId: INSTALLATION_ID });
    const result = await executors.CONFIGURE_DOMAIN(configureCommand({ certificateArn: 'arn:cert-1' }));

    expect(elb.createHttpsListenerCalls).toEqual([
      {
        loadBalancerArn: lb.arn,
        certificateArn: 'arn:cert-1',
        targetGroupArn: 'tg-1',
        tagKey: 'deployz:installation',
        tagValue: INSTALLATION_ID,
      },
    ]);
    expect(elb.setHttpRedirectCalls).toEqual(['listener-80']);
    expect(result.success).toBe(true);
    expect(result.output?.httpsConfigured).toBe(true);
  });

  it('issued + 443 already ours: no create/add calls (idempotent), still httpsConfigured true', async () => {
    const acm = new FakeAcmClient();
    acm.certificates.set('arn:cert-1', { status: 'ISSUED' });
    const elb = new FakeElbClient();
    const lb = makeLb();
    elb.loadBalancer = lb;
    elb.listeners = [
      { arn: 'listener-443', port: 443, defaultCertificateArn: 'arn:cert-1', redirectsToHttps: false },
      { arn: 'listener-80', port: 80, redirectsToHttps: true },
    ];

    const executors = createDomainExecutors({ acm, elb, installationId: INSTALLATION_ID });
    const result = await executors.CONFIGURE_DOMAIN(configureCommand({ certificateArn: 'arn:cert-1' }));

    expect(elb.createHttpsListenerCalls).toHaveLength(0);
    expect(elb.addListenerCertificateCalls).toHaveLength(0);
    expect(elb.setHttpRedirectCalls).toHaveLength(0);
    expect(result.success).toBe(true);
    expect(result.output?.httpsConfigured).toBe(true);
  });

  it('issued + 443 with a different default cert: addListenerCertificate is called', async () => {
    const acm = new FakeAcmClient();
    acm.certificates.set('arn:cert-1', { status: 'ISSUED' });
    const elb = new FakeElbClient();
    const lb = makeLb();
    elb.loadBalancer = lb;
    elb.listeners = [
      { arn: 'listener-443', port: 443, defaultCertificateArn: 'arn:other-cert', redirectsToHttps: false },
      { arn: 'listener-80', port: 80, redirectsToHttps: true },
    ];

    const executors = createDomainExecutors({ acm, elb, installationId: INSTALLATION_ID });
    const result = await executors.CONFIGURE_DOMAIN(configureCommand({ certificateArn: 'arn:cert-1' }));

    expect(elb.addListenerCertificateCalls).toEqual([{ listenerArn: 'listener-443', certificateArn: 'arn:cert-1' }]);
    expect(elb.createHttpsListenerCalls).toHaveLength(0);
    expect(result.success).toBe(true);
    expect(result.output?.httpsConfigured).toBe(true);

    // The relay creates the 443 listener itself with no other tagger, so it
    // must (re-)tag an existing listener before modifying it — heals a
    // listener that predates this fix.
    expect(elb.ensureListenerTagCalls).toEqual([
      { listenerArn: 'listener-443', tagKey: 'deployz:installation', tagValue: INSTALLATION_ID },
    ]);
    expect(elb.callLog).toEqual(['ensureListenerTag', 'addListenerCertificate']);
  });

  it('issued + 443 with a different default cert, already tagged: ensureListenerTag is still a harmless repeat', async () => {
    const acm = new FakeAcmClient();
    acm.certificates.set('arn:cert-1', { status: 'ISSUED' });
    const elb = new FakeElbClient();
    const lb = makeLb();
    elb.loadBalancer = lb;
    elb.listeners = [
      { arn: 'listener-443', port: 443, defaultCertificateArn: 'arn:other-cert', redirectsToHttps: false },
      { arn: 'listener-80', port: 80, redirectsToHttps: true },
    ];

    const executors = createDomainExecutors({ acm, elb, installationId: INSTALLATION_ID });
    // First pass tags the listener (as the previous test verifies); a second
    // pass against the still-untagged fixture confirms re-tagging an
    // already-tagged listener does not fail or otherwise change behavior.
    await executors.CONFIGURE_DOMAIN(configureCommand({ certificateArn: 'arn:cert-1' }));
    const result = await executors.CONFIGURE_DOMAIN(configureCommand({ certificateArn: 'arn:cert-1' }));

    expect(result.success).toBe(true);
    expect(elb.ensureListenerTagCalls).toHaveLength(2);
    expect(elb.addListenerCertificateCalls).toHaveLength(2);
  });

  it('no load balancer found: succeeds with routingTarget undefined and no listener calls', async () => {
    const acm = new FakeAcmClient();
    acm.certificates.set('arn:cert-1', { status: 'ISSUED' });
    const elb = new FakeElbClient();
    elb.loadBalancer = undefined;

    const executors = createDomainExecutors({ acm, elb, installationId: INSTALLATION_ID });
    const result = await executors.CONFIGURE_DOMAIN(configureCommand({ certificateArn: 'arn:cert-1' }));

    expect(result.success).toBe(true);
    expect(result.output?.routingTarget).toBeUndefined();
    expect(elb.createHttpsListenerCalls).toHaveLength(0);
    expect(elb.addListenerCertificateCalls).toHaveLength(0);
  });

  it('AccessDenied from ACM produces success:false with failureCode AWS_PERMISSION_DENIED', async () => {
    const acm = new FakeAcmClient();
    const err = new Error('not allowed');
    err.name = 'AccessDeniedException';
    acm.requestError = err;
    const elb = new FakeElbClient();
    elb.loadBalancer = makeLb();

    const executors = createDomainExecutors({ acm, elb, installationId: INSTALLATION_ID });
    const result = await executors.CONFIGURE_DOMAIN(configureCommand());

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('AWS_PERMISSION_DENIED');
    expect(result.error).toBeDefined();
  });

  it('an unrelated AWS error produces failureCode UNKNOWN', async () => {
    const acm = new FakeAcmClient();
    acm.requestError = new Error('throttled');
    const elb = new FakeElbClient();
    elb.loadBalancer = makeLb();

    const executors = createDomainExecutors({ acm, elb, installationId: INSTALLATION_ID });
    const result = await executors.CONFIGURE_DOMAIN(configureCommand());

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('UNKNOWN');
  });
});

// ── REMOVE_DOMAIN ────────────────────────────────────────────────────────────

describe('createDomainExecutors — REMOVE_DOMAIN', () => {
  it('remove with our default cert: deletes the listener, restores the 80 forward, deletes the cert', async () => {
    const acm = new FakeAcmClient();
    acm.certificates.set('arn:cert-1', { status: 'ISSUED' });
    const elb = new FakeElbClient();
    const lb = makeLb();
    elb.loadBalancer = lb;
    elb.listeners = [
      { arn: 'listener-443', port: 443, defaultCertificateArn: 'arn:cert-1', redirectsToHttps: false },
      { arn: 'listener-80', port: 80, redirectsToHttps: true },
    ];
    elb.targetGroups = ['tg-1'];

    const executors = createDomainExecutors({ acm, elb, installationId: INSTALLATION_ID });
    const result = await executors.REMOVE_DOMAIN(removeCommand({ certificateArn: 'arn:cert-1' }));

    expect(elb.deleteListenerCalls).toEqual(['listener-443']);
    expect(elb.setHttpForwardCalls).toEqual([{ listenerArn: 'listener-80', targetGroupArn: 'tg-1' }]);
    expect(elb.removeListenerCertificateCalls).toHaveLength(0);
    expect(acm.deleteCalls).toEqual(['arn:cert-1']);
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ removed: true });

    // The relay creates the 443 listener itself, so nothing else ever tags
    // it — tag it right before deleting, healing a listener that predates
    // this fix so DeleteListener's resource-tag condition can match.
    expect(elb.ensureListenerTagCalls).toEqual([
      { listenerArn: 'listener-443', tagKey: 'deployz:installation', tagValue: INSTALLATION_ID },
    ]);
    expect(elb.callLog).toEqual(['ensureListenerTag', 'deleteListener']);
  });

  it('remove when the listener default cert is not ours: only removes the SNI certificate', async () => {
    const acm = new FakeAcmClient();
    acm.certificates.set('arn:cert-1', { status: 'ISSUED' });
    const elb = new FakeElbClient();
    const lb = makeLb();
    elb.loadBalancer = lb;
    elb.listeners = [
      { arn: 'listener-443', port: 443, defaultCertificateArn: 'arn:other-cert', redirectsToHttps: false },
      { arn: 'listener-80', port: 80, redirectsToHttps: true },
    ];

    const executors = createDomainExecutors({ acm, elb, installationId: INSTALLATION_ID });
    const result = await executors.REMOVE_DOMAIN(removeCommand({ certificateArn: 'arn:cert-1' }));

    expect(elb.removeListenerCertificateCalls).toEqual([{ listenerArn: 'listener-443', certificateArn: 'arn:cert-1' }]);
    expect(elb.deleteListenerCalls).toHaveLength(0);
    expect(acm.deleteCalls).toEqual(['arn:cert-1']);
    expect(result.success).toBe(true);
    // Only the delete path needs the heal-tag (DeleteListener is the action
    // that was denied in production); removing an SNI cert isn't affected.
    expect(elb.ensureListenerTagCalls).toHaveLength(0);
  });

  it('remove when everything is already gone: still succeeds', async () => {
    const acm = new FakeAcmClient();
    // No certificate registered — the fake's deleteCertificate swallows the
    // not-found case, matching the real client's contract.
    const elb = new FakeElbClient();
    elb.loadBalancer = undefined;

    const executors = createDomainExecutors({ acm, elb, installationId: INSTALLATION_ID });
    const result = await executors.REMOVE_DOMAIN(removeCommand({ certificateArn: 'arn:long-gone' }));

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ removed: true });
    expect(acm.deleteCalls).toEqual([]);
  });

  it('remove refuses a certificate that does not carry this installation tag', async () => {
    const acm = new FakeAcmClient();
    acm.certificates.set('arn:foreign', { status: 'ISSUED', tags: { [DEPLOYZ_INSTALLATION_TAG]: 'other' } });
    acm.certificates.set('arn:untagged', { status: 'ISSUED', tags: {} });
    const elb = new FakeElbClient();
    elb.loadBalancer = undefined;

    const executors = createDomainExecutors({ acm, elb, installationId: INSTALLATION_ID });
    for (const certificateArn of ['arn:foreign', 'arn:untagged']) {
      const result = await executors.REMOVE_DOMAIN(removeCommand({ certificateArn }));
      expect(result.success).toBe(false);
    }

    expect(acm.deleteCalls).toEqual([]);
  });

  it('remove with cert in use but no listener change: fails immediately, no retry', async () => {
    const acm = new FakeAcmClient();
    acm.certificates.set('arn:cert-1', { status: 'ISSUED' });
    acm.deleteError = resourceInUseError();
    const elb = new FakeElbClient();
    elb.loadBalancer = undefined;
    const sleepCalls: number[] = [];

    const executors = createDomainExecutors({
      acm,
      elb,
      installationId: INSTALLATION_ID,
      sleep: fakeSleep(sleepCalls),
    });
    const result = await executors.REMOVE_DOMAIN(removeCommand({ certificateArn: 'arn:cert-1' }));

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // Nothing here detached the certificate from a listener, so ACM's
    // "still in use" is not the transient release delay — no point retrying.
    expect(acm.deleteCalls).toEqual(['arn:cert-1']);
    expect(sleepCalls).toEqual([]);
  });

  it('remove with cert in use after a listener delete: retries and succeeds once ACM releases it', async () => {
    const acm = new FakeAcmClient();
    acm.certificates.set('arn:cert-1', { status: 'ISSUED' });
    acm.deleteError = resourceInUseError();
    acm.deleteErrorRemaining = 2; // in use for the first two attempts, then released
    const elb = new FakeElbClient();
    elb.loadBalancer = makeLb();
    elb.listeners = [
      { arn: 'listener-443', port: 443, defaultCertificateArn: 'arn:cert-1', redirectsToHttps: false },
    ];
    const sleepCalls: number[] = [];

    const executors = createDomainExecutors({
      acm,
      elb,
      installationId: INSTALLATION_ID,
      sleep: fakeSleep(sleepCalls),
    });
    const result = await executors.REMOVE_DOMAIN(removeCommand({ certificateArn: 'arn:cert-1' }));

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ removed: true });
    expect(acm.deleteCalls).toEqual(['arn:cert-1', 'arn:cert-1', 'arn:cert-1']);
    expect(sleepCalls).toEqual([10_000, 10_000]);
  });

  it('remove with cert in use forever after a listener delete: fails after the bounded retries', async () => {
    const acm = new FakeAcmClient();
    acm.certificates.set('arn:cert-1', { status: 'ISSUED' });
    acm.deleteError = resourceInUseError();
    const elb = new FakeElbClient();
    elb.loadBalancer = makeLb();
    elb.listeners = [
      { arn: 'listener-443', port: 443, defaultCertificateArn: 'arn:cert-1', redirectsToHttps: false },
    ];
    const sleepCalls: number[] = [];

    const executors = createDomainExecutors({
      acm,
      elb,
      installationId: INSTALLATION_ID,
      sleep: fakeSleep(sleepCalls),
    });
    const result = await executors.REMOVE_DOMAIN(removeCommand({ certificateArn: 'arn:cert-1' }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('ResourceInUseException');
    expect(acm.deleteCalls).toHaveLength(6);
    expect(sleepCalls).toHaveLength(5);
  });

  it('remove fails on a non-in-use ACM error after a listener delete: no retry', async () => {
    const acm = new FakeAcmClient();
    acm.certificates.set('arn:cert-1', { status: 'ISSUED' });
    const err = new Error('access denied');
    err.name = 'AccessDeniedException';
    acm.deleteError = err;
    const elb = new FakeElbClient();
    elb.loadBalancer = makeLb();
    elb.listeners = [
      { arn: 'listener-443', port: 443, defaultCertificateArn: 'arn:cert-1', redirectsToHttps: false },
    ];
    const sleepCalls: number[] = [];

    const executors = createDomainExecutors({
      acm,
      elb,
      installationId: INSTALLATION_ID,
      sleep: fakeSleep(sleepCalls),
    });
    const result = await executors.REMOVE_DOMAIN(removeCommand({ certificateArn: 'arn:cert-1' }));

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('AWS_PERMISSION_DENIED');
    expect(acm.deleteCalls).toEqual(['arn:cert-1']);
    expect(sleepCalls).toEqual([]);
  });
});
