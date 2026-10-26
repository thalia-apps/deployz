// @vitest-environment jsdom

import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeploymentPlan, PublicInstallPlan, PublicInstallResolve } from '../src/lib/public-install-types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Radix radio items measure their size with ResizeObserver, which jsdom lacks.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as { Element?: { prototype: { scrollIntoView?: unknown } } }).Element!.prototype.scrollIntoView = vi.fn();

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => routerMocks }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, toString: () => '' }) }));

const confirmMocks = vi.hoisted(() => ({ confirmPublicInstall: vi.fn() }));
vi.mock('../src/lib/public-install-confirm', () => ({
  confirmPublicInstall: confirmMocks.confirmPublicInstall,
}));

const pageMocks = vi.hoisted(() => ({
  fetchPublicInstallData: vi.fn(),
  fetchPublicInstallPlan: vi.fn(),
  fetchInstallData: vi.fn(),
  fetchInstallStatusServer: vi.fn(),
}));
vi.mock('../src/lib/public-install-data', () => ({
  fetchPublicInstallData: pageMocks.fetchPublicInstallData,
  fetchPublicInstallPlan: pageMocks.fetchPublicInstallPlan,
}));
vi.mock('../src/lib/install-data', () => ({
  fetchInstallData: pageMocks.fetchInstallData,
  launchInstall: vi.fn(),
}));
vi.mock('../src/lib/install-status', () => ({
  fetchInstallStatusServer: pageMocks.fetchInstallStatusServer,
}));

const InstallPage = (await import('../src/app/install/[installLinkId]/page')).default;
const { PublicInstallFlow } = await import('../src/components/public-install-flow');

const LINK_ID = '11111111-1111-1111-1111-111111111111';

function planFixture(): DeploymentPlan {
  return {
    schemaVersion: 1,
    action: 'INSTALL',
    region: null,
    components: [
      { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' as const },
      { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE', lifecycle: 'delete' as const },
      { kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain' as const },
    ],
    awsResources: [
      {
        id: 'ecs_service',
        name: 'ECS Fargate service',
        purpose: 'Runs the application container and restarts it if it stops',
        group: 'compute_networking' as const,
        componentKind: 'application' as const,
        lifecycle: 'delete' as const,
      },
      {
        id: 'database',
        name: 'RDS PostgreSQL database',
        purpose: 'Stores persistent application data',
        group: 'data' as const,
        componentKind: 'database' as const,
        lifecycle: 'retain' as const,
      },
    ],
    requirementDrift: [],
  };
}

function sizeOption(
  id: 'small' | 'medium' | 'large',
  label: string,
  recommended: boolean,
  cpuUnits: number,
  memoryMiB: number,
): PublicInstallResolve['sizing']['options'][number] {
  return {
    id,
    label,
    description: `${label} description`,
    recommended,
    workload: { cpuUnits, memoryMiB, desiredCount: 1 },
    database: { instanceClass: `db.${id}`, storageGb: 20 },
    cache: { nodeType: `cache.${id}`, nodeCount: 1 },
  };
}

/** The plan the server returns for a Region and size; Regions other than the two fixtures cannot deploy. */
function sizedPlan(region: string, profile: string): PublicInstallPlan {
  return {
    ...planFixture(),
    region: region as DeploymentPlan['region'],
    sizeProfile: profile as PublicInstallPlan['sizeProfile'],
    planFingerprint: `${profile[0]}`.repeat(64),
  };
}

function resolveFixture(overrides: Partial<PublicInstallResolve> = {}): PublicInstallResolve {
  return {
    application: { name: 'Acme App' },
    publisher: { name: 'Acme Inc' },
    release: { version: '1.2.0', createdAt: '2026-09-01T00:00:00.000Z' },
    recommendedRegion: null,
    regionSelection: 'customer',
    regions: [
      { value: 'us-east-1', label: 'US East (N. Virginia)' },
      { value: 'us-west-2', label: 'US West (Oregon)' },
    ],
    requiredInputs: [
      { key: 'API_KEY', required: true, secret: true },
      { key: 'ORG_NAME', required: true, secret: false },
      { key: 'WEBHOOK_URL', required: false, secret: false },
    ],
    sizing: {
      recommended: 'medium',
      minimum: 'small',
      options: [
        sizeOption('small', 'Small', false, 1024, 2048),
        sizeOption('medium', 'Medium', true, 2048, 4096),
      ],
    },
    plan: planFixture(),
    ...overrides,
  };
}

async function renderServer(linkId: string = LINK_ID): Promise<Document> {
  const element = await InstallPage({
    params: Promise.resolve({ installLinkId: linkId }),
  });
  const { window } = new JSDOM(renderToString(element));
  return window.document;
}

const cleanups: Array<() => void> = [];

function renderFlow(
  resolve: PublicInstallResolve = resolveFixture(),
  props: { token?: string; customerKnown?: boolean } = {},
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <PublicInstallFlow
        linkId={LINK_ID}
        resolve={resolve}
        {...(props.token !== undefined ? { token: props.token } : {})}
        {...(props.customerKnown !== undefined ? { customerKnown: props.customerKnown } : {})}
      />,
    );
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/**
 * React tracks value on the instance, so assigning `.value` directly makes
 * React ignore the following input event. Set through the prototype's native
 * setter so the dispatched event reaches React's onChange.
 */
function typeInto(element: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(element, text);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('InstallPage public resolution', () => {
  beforeEach(() => {
    pageMocks.fetchPublicInstallData.mockReset();
    pageMocks.fetchInstallData.mockReset();
    pageMocks.fetchInstallStatusServer.mockReset().mockResolvedValue(null);
  });

  it('renders the public confirm flow when the link resolves', async () => {
    pageMocks.fetchPublicInstallData.mockResolvedValue({ status: 'ok', data: resolveFixture() });
    const doc = await renderServer();

    expect(doc.body.textContent).toContain('Acme App');
    expect(doc.body.textContent).toContain('Acme Inc');
    expect(doc.body.textContent).toContain('Release 1.2.0');
    // No recommendation: the region waits for an explicit choice (the
    // options themselves are covered by the client-side flow tests).
    expect(doc.body.textContent).toContain('Select a region');
    expect(doc.body.textContent).toContain('API_KEY');
    expect(doc.body.textContent).toContain('Application');
    expect(doc.body.textContent).toContain('Secure endpoint');
    expect(doc.body.textContent).toContain('Database');
    expect(doc.body.textContent).toContain(
      'When this deployment is removed, Database stays in your AWS account.',
    );
  });

  it('renders public-flow error copy for a disabled public link', async () => {
    pageMocks.fetchPublicInstallData.mockResolvedValue({
      status: 'gone',
      code: 'PUBLIC_INSTALL_LINK_DISABLED',
    });
    const doc = await renderServer();

    expect(doc.body.textContent).toContain('This application cannot be installed');
    expect(doc.body.textContent).toContain(
      'This application is not currently available for installation. Contact your software provider.',
    );
  });

  it('renders public-flow error copy for a revoked public link', async () => {
    pageMocks.fetchPublicInstallData.mockResolvedValue({
      status: 'gone',
      code: 'PUBLIC_INSTALL_LINK_REVOKED',
    });
    const doc = await renderServer();

    expect(doc.body.textContent).toContain('This application cannot be installed');
    expect(doc.body.textContent).toContain(
      'This installation link has been revoked. Contact your software provider for a new link.',
    );
  });

  it('renders public-flow error copy when no release is published', async () => {
    pageMocks.fetchPublicInstallData.mockResolvedValue({
      status: 'gone',
      code: 'RELEASE_NOT_PUBLISHED',
    });
    const doc = await renderServer();

    expect(doc.body.textContent).toContain('This application has no published release yet');
  });

  it('falls through to the per-deployment flow when the public link is unknown', async () => {
    pageMocks.fetchPublicInstallData.mockResolvedValue(null);
    pageMocks.fetchInstallData.mockResolvedValue({
      status: 'ok',
      data: {
        applicationName: 'Existing App',
        publisherName: 'Existing Publisher',
        customerName: 'Customer',
        region: 'us-east-1',
      sizeProfile: 'medium',
      planFingerprint: 'm'.repeat(64),
        plan: null,
        quickCreateUrl: 'https://quick.create',
        alreadyInstalled: false,
        viewer: { kind: 'customer', email: 'owner@example.com' },
        deploymentId: 'dep-1',
        deploymentState: 'NOT_INSTALLED',
        domain: null,
        routingTarget: null,
        bootstrapStackName: 'bootstrap',
        waitingForRelay: false,
        relayStuck: false,
        components: null,
      },
    });

    const doc = await renderServer();

    expect(doc.body.textContent).toContain('to your AWS account');
    expect(pageMocks.fetchInstallData).toHaveBeenCalledWith(LINK_ID, '');
  });
});

describe('PublicInstallFlow', () => {
  beforeEach(() => {
    confirmMocks.confirmPublicInstall.mockReset();
    routerMocks.push.mockReset();
    pageMocks.fetchPublicInstallPlan
      .mockReset()
      .mockImplementation((_link: string, region: string, profile: string) =>
        Promise.resolve(sizedPlan(region, profile)),
      );
    vi.stubGlobal('crypto', { randomUUID: () => 'idem-key-1' });
  });

  afterEach(() => {
    while (cleanups.length) {
      cleanups.pop()?.();
    }
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('renders identity, release, region select, required inputs, secret password fields, plan and retention sentence', () => {
    renderFlow();

    expect(document.body.textContent).toContain('Acme App');
    expect(document.body.textContent).toContain('Acme Inc');
    expect(document.body.textContent).toContain('Release 1.2.0');

    const secretInput = document.querySelector('input#API_KEY') as HTMLInputElement;
    expect(secretInput).not.toBeNull();
    expect(secretInput.type).toBe('password');

    const plainInput = document.querySelector('input#ORG_NAME') as HTMLInputElement;
    expect(plainInput).not.toBeNull();
    expect(plainInput.type).toBe('text');

    expect(document.body.textContent).toContain('Application');
    expect(document.body.textContent).toContain('Secure endpoint');
    expect(document.body.textContent).toContain('Database');
    expect(document.body.textContent).toContain(
      'When this deployment is removed, Database stays in your AWS account.',
    );
  });

  it('shows the Application settings section: vendor label, help text, technical key, and a required/optional marker per field', () => {
    renderFlow(
      resolveFixture({
        requiredInputs: [
          { key: 'API_KEY', required: true, secret: true, label: 'API key', help: 'From your provider dashboard.' },
          { key: 'ORG_NAME', required: true, secret: false },
          { key: 'WEBHOOK_URL', required: false, secret: false },
        ],
      }),
    );

    expect(document.body.textContent).toContain('Application settings');

    const apiKeyField = document.querySelector('input#API_KEY')!.closest('div')!.parentElement as HTMLElement;
    expect(apiKeyField.textContent).toContain('API key');
    expect(apiKeyField.textContent).toContain('From your provider dashboard.');
    expect(apiKeyField.textContent).toContain('API_KEY');
    expect(apiKeyField.textContent).toContain('Required');

    const orgNameField = document.querySelector('input#ORG_NAME')!.closest('div')!.parentElement as HTMLElement;
    // No vendor label set: falls back to a humanised form of the key.
    expect(orgNameField.textContent).toContain('Org name');

    const webhookField = document.querySelector('input#WEBHOOK_URL')!.closest('div')!.parentElement as HTMLElement;
    expect(webhookField.textContent).toContain('Optional');
  });

  it('hides the Application settings section entirely when there are no inputs', () => {
    renderFlow(resolveFixture({ requiredInputs: [] }));

    expect(document.body.textContent).not.toContain('Application settings');
  });

  it('shows a format error for an invalid *_URL value once the field is touched, and clears it once valid', async () => {
    renderFlow();

    const webhook = document.querySelector('input#WEBHOOK_URL') as HTMLInputElement;
    await act(async () => {
      typeInto(webhook, 'not-a-url');
      webhook.focus();
      webhook.blur();
    });

    expect(document.body.textContent).toContain('Enter a full URL, for example https://example.com.');

    await act(async () => {
      typeInto(webhook, 'https://example.com/hook');
    });

    expect(document.body.textContent).not.toContain('Enter a full URL, for example https://example.com.');
  });

  it('links a field error to its input and names the Region control', async () => {
    renderFlow();

    const webhook = document.querySelector('input#WEBHOOK_URL') as HTMLInputElement;
    await act(async () => {
      typeInto(webhook, 'not-a-url');
      webhook.focus();
      webhook.blur();
    });

    expect(webhook.getAttribute('aria-describedby')).toBe('WEBHOOK_URL-error');
    expect(document.getElementById('WEBHOOK_URL-error')?.textContent).toContain('Enter a full URL');
    const trigger = document.querySelector('[data-slot="select-trigger"]') as HTMLElement;
    expect(document.getElementById(trigger.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
      'AWS Region',
    );
  });

  it('shows no cost number until a Region is chosen', async () => {
    renderFlow(resolveFixture({ recommendedRegion: null }));

    expect(document.querySelector('[data-testid="footprint-cost-pending"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="footprint-cost-range"]')).toBeNull();

    await selectRegion('US East (N. Virginia)');

    expect(document.querySelector('[data-testid="footprint-cost-pending"]')).toBeNull();
  });

  it('does not accept spaces alone as a required secret', async () => {
    renderFlow();

    const apiKey = document.querySelector('input#API_KEY') as HTMLInputElement;
    await act(async () => {
      typeInto(apiKey, '   ');
      apiKey.focus();
      apiKey.blur();
    });

    expect(document.body.textContent).toContain('This value is required.');
    expect(document.body.textContent).toContain('1 of 3 settings complete');
  });

  it('shows a completion count that reaches "All settings complete" once every setting is valid', async () => {
    renderFlow();

    expect(document.body.textContent).toContain('1 of 3 settings complete');

    await fillForm();

    expect(document.body.textContent).toContain('All settings complete');
  });

  it('disables submit with an inline explanation while a required setting is missing', async () => {
    renderFlow();

    const button = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // Blocked reasons resolve in form order: region first.
    expect(document.body.textContent).toContain('Select an AWS Region to continue.');

    await selectRegion('US East (N. Virginia)');
    expect(button.disabled).toBe(true);
    expect(document.body.textContent).toContain('Complete the required application settings to continue.');

    await fillForm();

    expect(button.disabled).toBe(false);
    expect(document.body.textContent).not.toContain('Complete the required application settings to continue.');
  });

  it('only offers regions from the resolved list', async () => {
    renderFlow();

    const trigger = document.querySelector('[data-slot="select-trigger"]') as HTMLElement;
    await act(async () => {
      click(trigger);
    });

    const options = document.querySelectorAll('[role="option"]');
    expect(options.length).toBe(2);
    expect(Array.from(options).map((option) => option.textContent)).toEqual([
      'US East (N. Virginia)',
      'US West (Oregon)',
    ]);
    expect(document.body.textContent).not.toContain('Europe (Ireland)');
  });

  it('leaves the region unselected until the customer chooses one when there is no recommendation', () => {
    renderFlow(resolveFixture({ recommendedRegion: null }));

    const trigger = document.querySelector('[data-slot="select-trigger"]') as HTMLElement;
    expect(trigger.textContent).toContain('Select a region');
  });

  it('preselects a valid recommendation, marks it Recommended, and shows the recommends sentence', async () => {
    renderFlow(resolveFixture({ recommendedRegion: 'us-west-2' }));

    expect(document.body.textContent).toContain(
      'Acme Inc recommends US West (Oregon).',
    );

    const trigger = document.querySelector('[data-slot="select-trigger"]') as HTMLElement;
    expect(trigger.textContent).toContain('US West (Oregon)');

    await act(async () => {
      click(trigger);
    });
    const recommended = Array.from(document.querySelectorAll('[role="option"]')).find((option) =>
      option.textContent?.includes('US West (Oregon)'),
    );
    expect(recommended?.textContent).toContain('Recommended');
  });

  it('re-fetches the plan when the region changes and keeps entered settings', async () => {
    renderFlow();
    await fillForm();

    expect(pageMocks.fetchPublicInstallPlan).toHaveBeenLastCalledWith(LINK_ID, 'us-east-1', 'medium', undefined);

    await selectRegion('US West (Oregon)');

    expect(pageMocks.fetchPublicInstallPlan).toHaveBeenLastCalledWith(LINK_ID, 'us-west-2', 'medium', undefined);
    // Entered values survive the region change.
    expect((document.querySelector('input#API_KEY') as HTMLInputElement).value).toBe('secret-key');
    expect((document.querySelector('input#ORG_NAME') as HTMLInputElement).value).toBe('Acme');
  });

  it('a stale plan response from an earlier region cannot overwrite the latest selection', async () => {
    const east = deferred<DeploymentPlan | null>();
    const west = deferred<DeploymentPlan | null>();
    pageMocks.fetchPublicInstallPlan
      .mockImplementationOnce(() => east.promise)
      .mockImplementationOnce(() => west.promise);
    renderFlow();

    await selectRegion('US East (N. Virginia)');
    await selectRegion('US West (Oregon)');

    await act(async () => {
      west.resolve({
        ...planFixture(),
        components: [
          ...planFixture().components,
          { kind: 'application', name: 'WEST PLAN', action: 'CREATE', lifecycle: 'delete' as const },
        ],
      });
    });
    expect(document.body.textContent).toContain('WEST PLAN');

    // The earlier region's response arrives last — it must be discarded.
    await act(async () => {
      east.resolve({
        ...planFixture(),
        components: [
          ...planFixture().components,
          { kind: 'application', name: 'STALE EAST PLAN', action: 'CREATE', lifecycle: 'delete' as const },
        ],
      });
    });
    expect(document.body.textContent).not.toContain('STALE EAST PLAN');
    expect(document.body.textContent).toContain('WEST PLAN');
  });

  it('renders the invitation flow without customer fields and omits customer from the confirm body', async () => {
    confirmMocks.confirmPublicInstall.mockResolvedValue({ ok: true, installLinkId: 'new-link-id', installLinkToken: 'new-link-token' });
    renderFlow(resolveFixture(), { customerKnown: true, token: 'one-time-token' });

    expect(document.querySelector('input#customer-name')).toBeNull();
    expect(document.querySelector('input#customer-email')).toBeNull();
    expect(document.body.textContent).not.toContain('Your details');

    const apiKey = document.querySelector('input#API_KEY') as HTMLInputElement;
    const orgName = document.querySelector('input#ORG_NAME') as HTMLInputElement;
    await act(async () => {
      typeInto(apiKey, 'secret-key');
      typeInto(orgName, 'Acme');
    });
    await selectRegion('US East (N. Virginia)');

    const button = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await act(async () => {
      click(button);
    });

    expect(confirmMocks.confirmPublicInstall).toHaveBeenCalledTimes(1);
    expect(confirmMocks.confirmPublicInstall.mock.calls[0]![0]).toBe(LINK_ID);
    expect(confirmMocks.confirmPublicInstall.mock.calls[0]![1]).toEqual({
      idempotencyKey: 'idem-key-1',
      region: 'us-east-1',
      sizeProfile: 'medium',
      planFingerprint: 'm'.repeat(64),
      config: [
        { key: 'API_KEY', value: 'secret-key', isSecret: true },
        { key: 'ORG_NAME', value: 'Acme', isSecret: false },
      ],
    });
    expect(confirmMocks.confirmPublicInstall.mock.calls[0]![2]).toBe('one-time-token');
    expect(routerMocks.push).toHaveBeenCalledWith('/install/new-link-id#new-link-token');
  });

  it('disables deploy until all required values are filled and a region is chosen', async () => {
    renderFlow();

    const button = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    const apiKey = document.querySelector('input#API_KEY') as HTMLInputElement;
    const orgName = document.querySelector('input#ORG_NAME') as HTMLInputElement;
    const customerName = document.querySelector('input#customer-name') as HTMLInputElement;
    const customerEmail = document.querySelector('input#customer-email') as HTMLInputElement;

      await act(async () => {
      typeInto(apiKey, 'secret-key');
      typeInto(orgName, 'Acme');
    });

    expect(button.disabled).toBe(true);

    await act(async () => {
      typeInto(customerName, 'Ada Lovelace');
      typeInto(customerEmail, 'ada@example.com');
    });

    // Everything except the region: still disabled — the choice is explicit.
    expect(button.disabled).toBe(true);

    await selectRegion('US East (N. Virginia)');

    expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('posts the confirm body with a stable idempotency key and navigates on success', async () => {
    confirmMocks.confirmPublicInstall.mockResolvedValue({ ok: true, installLinkId: 'new-link-id', installLinkToken: 'new-link-token' });
    renderFlow();

    await fillForm();

    const button = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      click(button);
    });

    expect(confirmMocks.confirmPublicInstall).toHaveBeenCalledTimes(1);
    expect(confirmMocks.confirmPublicInstall.mock.calls[0]![0]).toBe(LINK_ID);
    expect(confirmMocks.confirmPublicInstall.mock.calls[0]![1]).toEqual({
      idempotencyKey: 'idem-key-1',
      region: 'us-east-1',
      sizeProfile: 'medium',
      planFingerprint: 'm'.repeat(64),
      customer: { name: 'Ada Lovelace', email: 'ada@example.com' },
      config: [
        { key: 'API_KEY', value: 'secret-key', isSecret: true },
        { key: 'ORG_NAME', value: 'Acme', isSecret: false },
      ],
    });
    expect(routerMocks.push).toHaveBeenCalledWith('/install/new-link-id#new-link-token');
  });

  it('ignores a second click while pending and re-uses the same idempotency key on retry', async () => {
    const def = deferred<{ ok: false; code: string }>();
    confirmMocks.confirmPublicInstall.mockReturnValue(def.promise);
    renderFlow();

    await fillForm();

    const button = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      click(button);
    });

    click(button);
    expect(confirmMocks.confirmPublicInstall).toHaveBeenCalledTimes(1);

    await act(async () => {
      def.resolve({ ok: false, code: 'PUBLIC_INSTALL_CONFIG_INVALID' });
    });

    // Retry after error.
    confirmMocks.confirmPublicInstall.mockResolvedValue({ ok: true, installLinkId: 'new-link-id', installLinkToken: 'new-link-token' });
    const retryButton = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      click(retryButton);
    });

    expect(confirmMocks.confirmPublicInstall).toHaveBeenCalledTimes(2);
    expect(confirmMocks.confirmPublicInstall.mock.calls[1]![0]).toBe(LINK_ID);
    expect(confirmMocks.confirmPublicInstall.mock.calls[1]![1].idempotencyKey).toBe('idem-key-1');
  });

  it('offers only the permitted sizes, preselects the recommendation and badges it', () => {
    renderFlow();

    const radios = Array.from(document.querySelectorAll('[role="radio"]')) as HTMLElement[];
    expect(radios.map((radio) => radio.id)).toEqual(['size-small', 'size-medium']);
    expect(document.querySelector('#size-large')).toBeNull();
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true']);

    const small = document.querySelector('label[for="size-small"]')!;
    const medium = document.querySelector('label[for="size-medium"]')!;
    expect(medium.textContent).toContain('Recommended by your software provider');
    expect(small.textContent).not.toContain('Recommended by your software provider');
    expect(small.textContent).toContain('1 vCPU \u00b7 2 GiB per service');
    expect(medium.textContent).toContain('2 vCPU \u00b7 4 GiB per service');
    expect(medium.textContent).toContain('Database db.medium');
    expect(medium.textContent).not.toContain('Cache cache.medium');
    expect(document.querySelector('[data-testid="selected-size"]')?.textContent).toContain('Medium');
  });

  it('re-fetches the plan with the chosen size and keeps entered values', async () => {
    renderFlow();
    await fillForm();

    await act(async () => {
      click(document.querySelector('#size-small') as HTMLElement);
    });

    expect(pageMocks.fetchPublicInstallPlan).toHaveBeenLastCalledWith(LINK_ID, 'us-east-1', 'small', undefined);
    expect((document.querySelector('input#API_KEY') as HTMLInputElement).value).toBe('secret-key');
    expect((document.querySelector('input#customer-email') as HTMLInputElement).value).toBe('ada@example.com');
    expect(document.querySelector('[data-testid="selected-size"]')?.textContent).toContain('Small');
  });

  it('confirms the fingerprint of the plan for the chosen size', async () => {
    confirmMocks.confirmPublicInstall.mockResolvedValue({ ok: true, installLinkId: 'new-link-id', installLinkToken: 'new-link-token' });
    renderFlow();
    await fillForm();
    await act(async () => {
      click(document.querySelector('#size-small') as HTMLElement);
    });

    await act(async () => {
      click(document.querySelector('button[type="submit"]') as HTMLButtonElement);
    });

    expect(confirmMocks.confirmPublicInstall.mock.calls[0]![1]).toMatchObject({
      region: 'us-east-1',
      sizeProfile: 'small',
      planFingerprint: 's'.repeat(64),
    });
  });

  it('disables confirm while the plan loads and when the Region has no fingerprint', async () => {
    const pendingPlan = deferred<PublicInstallPlan | null>();
    renderFlow();
    await fillForm();
    const button = () => document.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button().disabled).toBe(false);

    pageMocks.fetchPublicInstallPlan.mockImplementationOnce(() => pendingPlan.promise);
    await act(async () => {
      click(document.querySelector('#size-small') as HTMLElement);
    });
    expect(button().disabled).toBe(true);
    expect(document.body.textContent).toContain('Updating for this selection');

    await act(async () => {
      pendingPlan.resolve({ ...sizedPlan('us-east-1', 'small'), planFingerprint: null });
    });
    expect(button().disabled).toBe(true);
    expect(document.body.textContent).toContain('This Region cannot be installed right now.');
  });

  it('refetches the plan on PLAN_CHANGED, keeps the inputs and asks the customer to confirm again', async () => {
    confirmMocks.confirmPublicInstall.mockResolvedValueOnce({ ok: false, code: 'PLAN_CHANGED' });
    renderFlow();
    await fillForm();
    const callsBefore = pageMocks.fetchPublicInstallPlan.mock.calls.length;
    pageMocks.fetchPublicInstallPlan.mockImplementationOnce(() =>
      Promise.resolve({ ...sizedPlan('us-east-1', 'medium'), planFingerprint: 'b'.repeat(64) }),
    );

    await act(async () => {
      click(document.querySelector('button[type="submit"]') as HTMLButtonElement);
    });

    expect(pageMocks.fetchPublicInstallPlan.mock.calls.length).toBe(callsBefore + 1);
    expect(document.body.textContent).toContain(
      'The installation plan changed after you reviewed it. Review the updated plan and confirm again.',
    );
    expect((document.querySelector('input#API_KEY') as HTMLInputElement).value).toBe('secret-key');
    expect((document.querySelector('input#customer-name') as HTMLInputElement).value).toBe('Ada Lovelace');

    confirmMocks.confirmPublicInstall.mockResolvedValue({ ok: true, installLinkId: 'new-link-id', installLinkToken: 'new-link-token' });
    await act(async () => {
      click(document.querySelector('button[type="submit"]') as HTMLButtonElement);
    });
    expect(confirmMocks.confirmPublicInstall.mock.calls[1]![1].planFingerprint).toBe('b'.repeat(64));
  });

  it('shows actionable error copy for SUBSCRIPTION_REQUIRED and PUBLIC_INSTALL_CONFIG_INVALID', async () => {
    confirmMocks.confirmPublicInstall.mockResolvedValue({ ok: false, code: 'SUBSCRIPTION_REQUIRED' });
    renderFlow();

    await fillForm();

    const button = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      click(button);
    });

    expect(document.body.textContent).toContain(
      'Your software provider must fix their Deployz subscription before this application can be installed. Contact your software provider.',
    );

    confirmMocks.confirmPublicInstall.mockResolvedValue({
      ok: false,
      code: 'PUBLIC_INSTALL_CONFIG_INVALID',
    });
    const retryButton = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      click(retryButton);
    });

    expect(document.body.textContent).toContain(
      'Some configuration values are missing or not valid. Check the fields and try again.',
    );
  });
});

async function selectRegion(label: string): Promise<void> {
  const trigger = document.querySelector('[data-slot="select-trigger"]') as HTMLElement;
  await act(async () => {
    click(trigger);
  });
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (element) => element.textContent === label,
  ) as HTMLElement;
  await act(async () => {
    click(option);
  });
}

async function fillForm(): Promise<void> {
  const apiKey = document.querySelector('input#API_KEY') as HTMLInputElement;
  const orgName = document.querySelector('input#ORG_NAME') as HTMLInputElement;
  const customerName = document.querySelector('input#customer-name') as HTMLInputElement;
  const customerEmail = document.querySelector('input#customer-email') as HTMLInputElement;

  await act(async () => {
    typeInto(apiKey, 'secret-key');
    typeInto(orgName, 'Acme');
    typeInto(customerName, 'Ada Lovelace');
    typeInto(customerEmail, 'ada@example.com');
  });
  await selectRegion('US East (N. Virginia)');
}
