#!/usr/bin/env node
// Makes sure the Polar resources Deployz bills with exist, and hands their ids
// to the deploy. Idempotent: it reads before it writes, creates only what is
// missing, and never changes the prices of an existing product.
//
//   1. The product, found by its metadata key (PRODUCT_CONFIG_KEY): a $49
//      fixed monthly price plus a $19 unit-based price, tax-exclusive, at
//      least one unit. A new price shape needs a new key, never an edit.
//   2. The webhook endpoint, found by its URL, pinned to POLAR_API_VERSION
//      and the events the API handles.
//   3. Customer portal settings: no unit, plan or pause changes (Deployz owns
//      the quantity). Best effort — a failure only warns.
//
// Inputs (environment): POLAR_TOKEN, POLAR_ENVIRONMENT (sandbox|production),
// POLAR_WEBHOOK_URL, EXPECTED_ENVIRONMENT (the GitHub Environment).
// Outputs: POLAR_PRODUCT_ID and POLAR_WEBHOOK_SECRET appended to $GITHUB_ENV,
// the secret masked first. Without $GITHUB_ENV it prints the ids only.
// It never prints the token or the webhook secret.
import { appendFileSync } from 'node:fs';

const POLAR_API_VERSION = '2026-10';
const PRODUCT_CONFIG_KEY = 'deployz_monthly_v1';
const WEBHOOK_EVENTS = [
  'subscription.created',
  'subscription.active',
  'subscription.updated',
  'subscription.canceled',
  'subscription.uncanceled',
  'subscription.past_due',
  'subscription.paused',
  'subscription.resumed',
  'subscription.revoked',
];

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

const token = process.env.POLAR_TOKEN;
const environment = process.env.POLAR_ENVIRONMENT || 'sandbox';
const webhookUrl = process.env.POLAR_WEBHOOK_URL;
const expectedEnvironment = process.env.EXPECTED_ENVIRONMENT;

if (!token) fail('POLAR_TOKEN is not set.');
if (environment !== 'sandbox' && environment !== 'production') {
  fail(`POLAR_ENVIRONMENT must be "sandbox" or "production"; got "${environment}".`);
}
if (environment === 'production' && expectedEnvironment !== 'production') {
  fail('Only the production GitHub Environment may use POLAR_ENVIRONMENT=production.');
}
if (!webhookUrl || !webhookUrl.startsWith('https://')) fail('POLAR_WEBHOOK_URL must be an https URL.');

const baseUrl = environment === 'production' ? 'https://api.polar.sh' : 'https://sandbox-api.polar.sh';

async function polar(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'polar-version': POLAR_API_VERSION,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Polar ${method} ${path} answered ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function listAll(path) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const result = await polar('GET', `${path}${separator}limit=100&page=${page}`);
    items.push(...result.items);
    if (page >= (result.pagination?.max_page ?? 1)) return items;
  }
}

async function ensureProduct() {
  const owned = (await listAll('/v1/products/?is_archived=false')).filter(
    (product) => product.metadata?.deployz_config === PRODUCT_CONFIG_KEY,
  );
  if (owned.length > 1) {
    throw new Error(`More than one product carries deployz_config=${PRODUCT_CONFIG_KEY}: ${owned.map((p) => p.id).join(', ')}.`);
  }
  if (owned.length === 1) {
    console.log(`Product ${owned[0].id} exists.`);
    return owned[0];
  }
  const product = await polar('POST', '/v1/products/', {
    name: 'Deployz',
    description: 'Platform fee plus one unit per live customer deployment.',
    recurring_interval: 'month',
    recurring_interval_count: 1,
    visibility: 'private',
    metadata: { deployz_config: PRODUCT_CONFIG_KEY },
    prices: [
      { amount_type: 'fixed', price_currency: 'usd', tax_behavior: 'exclusive', price_amount: 4900 },
      {
        amount_type: 'unit_based',
        price_currency: 'usd',
        tax_behavior: 'exclusive',
        tiers: { type: 'volume', tiers: [{ bound: null, unit_amount: 1900 }] },
        minimum_units: 1,
        unit_label: { en: { '=1': 'customer deployment', other: 'customer deployments' } },
      },
    ],
  });
  console.log(`Product ${product.id} created.`);
  return product;
}

async function ensureWebhook() {
  const desired = { url: webhookUrl, format: 'raw', api_version: POLAR_API_VERSION, events: WEBHOOK_EVENTS };
  const matches = (await listAll('/v1/webhooks/endpoints')).filter((endpoint) => endpoint.url === webhookUrl);
  if (matches.length > 1) throw new Error(`More than one webhook endpoint uses ${webhookUrl}.`);
  if (matches.length === 0) {
    const created = await polar('POST', '/v1/webhooks/endpoints', { name: 'Deployz billing', ...desired });
    console.log(`Webhook endpoint ${created.id} created.`);
    return created;
  }
  const endpoint = matches[0];
  const sameEvents =
    endpoint.events.length === WEBHOOK_EVENTS.length && WEBHOOK_EVENTS.every((event) => endpoint.events.includes(event));
  if (endpoint.format === 'raw' && endpoint.api_version === POLAR_API_VERSION && sameEvents && endpoint.enabled) {
    console.log(`Webhook endpoint ${endpoint.id} exists.`);
    return endpoint;
  }
  const updated = await polar('PATCH', `/v1/webhooks/endpoints/${endpoint.id}`, { ...desired, enabled: true });
  console.log(`Webhook endpoint ${updated.id} updated.`);
  return updated;
}

async function lockPortalSubscriptionSettings(organizationId) {
  try {
    const organization = await polar('GET', `/v1/organizations/${organizationId}`);
    const portal = organization.customer_portal_settings;
    const subscription = { ...portal.subscription, update_units: false, update_plan: false, pause: false };
    if (Object.keys(subscription).every((key) => subscription[key] === portal.subscription[key])) {
      console.log('Customer portal settings already lock units, plan and pause.');
      return;
    }
    await polar('PATCH', `/v1/organizations/${organizationId}`, {
      customer_portal_settings: { ...portal, subscription },
    });
    console.log('Customer portal settings now lock units, plan and pause.');
  } catch (error) {
    console.log(`::warning::Could not lock the customer portal settings: ${error instanceof Error ? error.message : error}`);
  }
}

let product;
let endpoint;
try {
  product = await ensureProduct();
  endpoint = await ensureWebhook();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
await lockPortalSubscriptionSettings(product.organization_id);

if (!endpoint.secret) fail(`Webhook endpoint ${endpoint.id} returned no signing secret.`);
if (process.env.GITHUB_ENV) {
  console.log(`::add-mask::${endpoint.secret}`);
  appendFileSync(process.env.GITHUB_ENV, `POLAR_PRODUCT_ID=${product.id}\nPOLAR_WEBHOOK_SECRET=${endpoint.secret}\n`);
}
console.log(`POLAR_PRODUCT_ID=${product.id}`);
console.log(`Webhook endpoint id: ${endpoint.id}`);
