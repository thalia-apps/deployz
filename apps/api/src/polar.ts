import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from './env.js';

/**
 * Resolved Polar billing configuration. The token and webhook secret never
 * leave the server. The product id comes only from here; the deploy workflow
 * creates the product once (scripts/billing/polar-setup.mjs) and passes its id
 * through config. Nothing in the request path creates a product or a price.
 */
export interface PolarConfig {
  token: string;
  webhookSecret: string;
  productId: string;
  environment: 'sandbox' | 'production';
}

/** The pinned Polar API contract. Requests, responses and the webhook
 *  endpoint all use this version (docs/billing/polar-billing.md). */
export const POLAR_API_VERSION = '2026-10';

const POLAR_API_BASE_URL: Record<PolarConfig['environment'], string> = {
  sandbox: 'https://sandbox-api.polar.sh',
  production: 'https://api.polar.sh',
};

const REQUEST_TIMEOUT_MS = 10_000;

/** The subset of a Polar subscription Deployz reads. */
export interface PolarSubscription {
  id: string;
  status: string;
  amount: number;
  currency: string;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  ends_at: string | null;
  customer_id: string;
  product_id: string;
  checkout_id: string | null;
  units: number | null;
  modified_at: string | null;
  metadata: Record<string, string | number | boolean>;
  prices?: Array<{ amount_type: string; price_amount?: number }>;
}

export interface PolarCheckout {
  id: string;
  status: string;
  url: string;
  expires_at: string;
}

export interface PolarOrder {
  id: string;
  created_at: string;
  status: string;
  paid: boolean;
  total_amount: number;
  refunded_amount: number;
  currency: string;
  invoice_number: string | null;
  is_invoice_generated: boolean;
  subscription_id: string | null;
  description: string;
}

export interface PolarPaymentMethod {
  type: string;
  method_metadata?: {
    brand?: string;
    last4?: string;
    exp_month?: number;
    exp_year?: number;
  };
}

export interface CreateCheckoutInput {
  productId: string;
  units: number;
  externalCustomerId: string;
  customerEmail: string | null;
  metadata: Record<string, string>;
  successUrl: string;
}

/** A non-2xx answer from Polar. `status` is the HTTP status; `code` is
 *  Polar's `error` field when the body carries one (`PaymentFailed`,
 *  `AlreadyCanceledSubscription`, ...). */
export class PolarApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'PolarApiError';
  }
}

/** How Polar bills a unit change: `invoice` charges (or credits) the
 *  prorated difference now; `prorate` puts it on the next renewal. */
export type ProrationBehavior = 'invoice' | 'prorate';

function errorCode(text: string): string | null {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

/** The Polar calls Deployz makes. Tests replace this with a double. */
export interface PolarClient {
  getSubscription(id: string): Promise<PolarSubscription>;
  /** Sets the ABSOLUTE unit count, billing the prorated difference the way
   *  `proration` says. */
  updateSubscriptionUnits(id: string, units: number, proration: ProrationBehavior): Promise<PolarSubscription>;
  createCheckout(input: CreateCheckoutInput): Promise<PolarCheckout>;
  getCheckout(id: string): Promise<PolarCheckout>;
  /** A short-lived, pre-authenticated customer portal URL. */
  createCustomerPortalUrl(customerId: string): Promise<string>;
  listSubscriptionOrders(subscriptionId: string, limit: number): Promise<PolarOrder[]>;
  getOrder(id: string): Promise<PolarOrder>;
  /** The invoice PDF URL, or null while Polar is still generating it. */
  getOrderInvoiceUrl(order: PolarOrder): Promise<string | null>;
  listPaymentMethods(customerId: string): Promise<PolarPaymentMethod[]>;
}

export interface PolarBilling {
  client: PolarClient;
  config: PolarConfig;
}

export function createPolarClient(config: Pick<PolarConfig, 'token' | 'environment'>): PolarClient {
  const baseUrl = POLAR_API_BASE_URL[config.environment];

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        'polar-version': POLAR_API_VERSION,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new PolarApiError(
        response.status,
        `Polar ${method} ${path} answered ${response.status}: ${text.slice(0, 500)}`,
        errorCode(text),
      );
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  return {
    getSubscription: (id) => request('GET', `/v1/subscriptions/${encodeURIComponent(id)}`),
    updateSubscriptionUnits: (id, units, proration) =>
      request('PATCH', `/v1/subscriptions/${encodeURIComponent(id)}`, { units, proration_behavior: proration }),
    createCheckout: (input) =>
      request('POST', '/v1/checkouts/', {
        products: [input.productId],
        units: input.units,
        min_units: input.units,
        max_units: input.units,
        external_customer_id: input.externalCustomerId,
        ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
        metadata: input.metadata,
        success_url: input.successUrl,
        allow_discount_codes: true,
        allow_trial: false,
      }),
    getCheckout: (id) => request('GET', `/v1/checkouts/${encodeURIComponent(id)}`),
    createCustomerPortalUrl: async (customerId) => {
      const session = await request<{ customer_portal_url: string }>('POST', '/v1/customer-sessions/', {
        customer_id: customerId,
      });
      return session.customer_portal_url;
    },
    listSubscriptionOrders: async (subscriptionId, limit) => {
      const page = await request<{ items: PolarOrder[] }>(
        'GET',
        `/v1/orders/?subscription_id=${encodeURIComponent(subscriptionId)}&limit=${limit}&sorting=-created_at`,
      );
      return page.items;
    },
    getOrder: (id) => request('GET', `/v1/orders/${encodeURIComponent(id)}`),
    getOrderInvoiceUrl: async (order) => {
      if (!order.is_invoice_generated) {
        // Generation is asynchronous: ask for it and let the caller retry.
        await request('POST', `/v1/orders/${encodeURIComponent(order.id)}/invoice`);
        return null;
      }
      const invoice = await request<{ url: string }>('GET', `/v1/orders/${encodeURIComponent(order.id)}/invoice`);
      return invoice.url;
    },
    listPaymentMethods: async (customerId) => {
      const page = await request<{ items: PolarPaymentMethod[] }>(
        'GET',
        `/v1/customers/${encodeURIComponent(customerId)}/payment-methods?limit=10`,
      );
      return page.items;
    },
  };
}

/** The subset of env.ts's flat fields createPolar needs, shaped so a test can supply a fixture without importing env.ts. */
type PolarEnvSource = {
  polarToken: string | undefined;
  polarWebhookSecret: string | undefined;
  polarProductId: string | undefined;
  polarEnvironment: 'sandbox' | 'production';
};

/**
 * Builds the Polar client and config, or `null` when POLAR_TOKEN is unset —
 * billing stays optional at boot (env.ts warns once; every billing surface
 * then reports BILLING_DISABLED). When POLAR_TOKEN is set, env.ts has already
 * validated the other values at startup, so they are present here.
 */
export function createPolar(source: PolarEnvSource = env): PolarBilling | null {
  if (!source.polarToken) return null;
  const config: PolarConfig = {
    token: source.polarToken,
    webhookSecret: source.polarWebhookSecret!,
    productId: source.polarProductId!,
    environment: source.polarEnvironment,
  };
  return { client: createPolarClient(config), config };
}

/** How far a delivery's timestamp may be from now, as in the official SDK. */
const WEBHOOK_TOLERANCE_SECONDS = 300;

export interface WebhookHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

/**
 * Verifies a Polar delivery (Standard Webhooks: HMAC-SHA256 over
 * `id.timestamp.body`). Polar signs with the secret's UTF-8 bytes; a
 * `whsec_`-prefixed base64 secret is also accepted, as the official SDK does.
 * Returns false for anything that does not verify, including a timestamp
 * outside the tolerance window (replay protection).
 */
export function verifyPolarWebhook(
  rawBody: string,
  headers: WebhookHeaders,
  secret: string,
  nowSeconds: number = Date.now() / 1000,
): boolean {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(nowSeconds - seconds) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const keys = [Buffer.from(secret, 'utf8')];
  const encoded = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length > 0 && decoded.toString('base64') === encoded && !decoded.equals(keys[0]!)) {
    keys.push(decoded);
  }

  const signedContent = `${id}.${Math.floor(seconds)}.${rawBody}`;
  const expected = keys.map((key) => createHmac('sha256', key).update(signedContent).digest());
  for (const versioned of signature.split(' ')) {
    const [version, value] = versioned.split(',', 2);
    if (version !== 'v1' || !value) continue;
    const candidate = Buffer.from(value, 'base64');
    if (expected.some((digest) => digest.length === candidate.length && timingSafeEqual(digest, candidate))) {
      return true;
    }
  }
  return false;
}
