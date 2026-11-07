import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPolar, createPolarClient, POLAR_API_VERSION, verifyPolarWebhook } from './polar.js';

// Placeholder values only — never a realistic id or token.
function polarEnv(overrides: Partial<Parameters<typeof createPolar>[0]> = {}) {
  return {
    polarToken: 'polar_oat_replace_me',
    polarWebhookSecret: 'whsec_replace_me',
    polarProductId: 'product_replace_me',
    polarEnvironment: 'sandbox' as const,
    ...overrides,
  };
}

function sign(secret: Buffer, id: string, timestamp: number, body: string): string {
  return `v1,${createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

describe('createPolar', () => {
  it('returns null when POLAR_TOKEN is unset', () => {
    expect(createPolar({ ...polarEnv(), polarToken: undefined })).toBeNull();
  });

  it('returns a client and the resolved config', () => {
    const billing = createPolar(polarEnv());
    expect(billing!.config).toEqual({
      token: 'polar_oat_replace_me',
      webhookSecret: 'whsec_replace_me',
      productId: 'product_replace_me',
      environment: 'sandbox',
    });
  });
});

describe('createPolarClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(status: number, body: unknown) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status });
      }),
    );
    return calls;
  }

  it('sends the token and the pinned API version to the sandbox host', async () => {
    const calls = stubFetch(200, { id: 'sub_1' });
    await createPolarClient({ token: 'tok', environment: 'sandbox' }).getSubscription('sub_1');
    expect(calls[0]!.url).toBe('https://sandbox-api.polar.sh/v1/subscriptions/sub_1');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['polar-version']).toBe(POLAR_API_VERSION);
  });

  it('uses the production host only for the production environment', async () => {
    const calls = stubFetch(200, { id: 'sub_1' });
    await createPolarClient({ token: 'tok', environment: 'production' }).getSubscription('sub_1');
    expect(calls[0]!.url.startsWith('https://api.polar.sh/')).toBe(true);
  });

  it('sets the absolute unit count with the given proration', async () => {
    const calls = stubFetch(200, { id: 'sub_1', units: 3 });
    await createPolarClient({ token: 'tok', environment: 'sandbox' }).updateSubscriptionUnits('sub_1', 3, 'invoice');
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ units: 3, proration_behavior: 'invoice' });
  });

  it('opens a checkout for one product that accepts discount codes and no trials', async () => {
    const calls = stubFetch(201, { id: 'chk_1', url: 'https://sandbox.polar.sh/checkout/x', status: 'open' });
    await createPolarClient({ token: 'tok', environment: 'sandbox' }).createCheckout({
      productId: 'prod_1',
      units: 1,
      externalCustomerId: 'org_1',
      customerEmail: 'owner@example.com',
      metadata: { organizationId: 'org_1', checkoutIntentId: 'intent_1' },
      successUrl: 'https://app.example.com/dashboard/settings/billing',
    });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      products: ['prod_1'],
      units: 1,
      external_customer_id: 'org_1',
      customer_email: 'owner@example.com',
      metadata: { organizationId: 'org_1', checkoutIntentId: 'intent_1' },
      success_url: 'https://app.example.com/dashboard/settings/billing',
      allow_discount_codes: true,
      allow_trial: false,
    });
  });

  it('throws a PolarApiError with the HTTP status on a non-2xx answer', async () => {
    stubFetch(404, { detail: 'Not found' });
    await expect(
      createPolarClient({ token: 'tok', environment: 'sandbox' }).getSubscription('missing'),
    ).rejects.toMatchObject({ name: 'PolarApiError', status: 404, code: null });
  });

  it("carries Polar's error code, e.g. PaymentFailed on a declined unit change", async () => {
    stubFetch(402, { error: 'PaymentFailed', detail: 'card declined' });
    await expect(
      createPolarClient({ token: 'tok', environment: 'sandbox' }).updateSubscriptionUnits('sub_1', 2, 'invoice'),
    ).rejects.toMatchObject({ name: 'PolarApiError', status: 402, code: 'PaymentFailed' });
  });

  it('asks Polar to generate a missing invoice and reports it as not ready', async () => {
    const calls = stubFetch(202, null);
    const url = await createPolarClient({ token: 'tok', environment: 'sandbox' }).getOrderInvoiceUrl({
      id: 'ord_1',
      is_invoice_generated: false,
    } as Parameters<ReturnType<typeof createPolarClient>['getOrderInvoiceUrl']>[0]);
    expect(url).toBeNull();
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://sandbox-api.polar.sh/v1/orders/ord_1/invoice');
  });
});

describe('verifyPolarWebhook', () => {
  const body = '{"type":"subscription.updated","timestamp":"2026-11-06T10:00:00Z","data":{}}';
  const secret = 'polar_whs_replace_me';
  const now = 1_793_000_000;

  it('accepts a signature made with the secret bytes', () => {
    const signature = sign(Buffer.from(secret), 'msg_1', now, body);
    expect(verifyPolarWebhook(body, { id: 'msg_1', timestamp: String(now), signature }, secret, now)).toBe(true);
  });

  it('accepts a whsec_ base64 secret, as the official SDK does', () => {
    const key = Buffer.from('a-shared-signing-key');
    const whsec = `whsec_${key.toString('base64')}`;
    const signature = sign(key, 'msg_1', now, body);
    expect(verifyPolarWebhook(body, { id: 'msg_1', timestamp: String(now), signature }, whsec, now)).toBe(true);
  });

  it('accepts any v1 signature in a space-separated list', () => {
    const signature = `v1,bm90LXRoaXMtb25l ${sign(Buffer.from(secret), 'msg_1', now, body)}`;
    expect(verifyPolarWebhook(body, { id: 'msg_1', timestamp: String(now), signature }, secret, now)).toBe(true);
  });

  it('rejects a changed body, a wrong secret, a changed id and missing headers', () => {
    const signature = sign(Buffer.from(secret), 'msg_1', now, body);
    const headers = { id: 'msg_1', timestamp: String(now), signature };
    expect(verifyPolarWebhook(`${body} `, headers, secret, now)).toBe(false);
    expect(verifyPolarWebhook(body, headers, 'another_secret', now)).toBe(false);
    expect(verifyPolarWebhook(body, { ...headers, id: 'msg_2' }, secret, now)).toBe(false);
    expect(verifyPolarWebhook(body, { ...headers, signature: undefined }, secret, now)).toBe(false);
  });

  it('rejects a delivery older or newer than five minutes (replay)', () => {
    const old = now - 301;
    const signature = sign(Buffer.from(secret), 'msg_1', old, body);
    expect(verifyPolarWebhook(body, { id: 'msg_1', timestamp: String(old), signature }, secret, now)).toBe(false);
    const future = now + 301;
    const futureSignature = sign(Buffer.from(secret), 'msg_1', future, body);
    expect(
      verifyPolarWebhook(body, { id: 'msg_1', timestamp: String(future), signature: futureSignature }, secret, now),
    ).toBe(false);
  });
});
