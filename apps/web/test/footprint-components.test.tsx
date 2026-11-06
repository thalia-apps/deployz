// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { estimateFootprintCost, resolveDeploymentFootprint } from '@deployz/contracts';
import type { DeploymentFootprint, FootprintCostEstimate } from '@deployz/contracts';
import type { DeploymentManifest } from '@deployz/contracts';

import { FootprintCost } from '../src/components/footprint-cost';
import { FootprintSummary } from '../src/components/footprint-summary';

function manifestWith(overrides: Partial<DeploymentManifest> = {}): DeploymentManifest {
  return {
    schemaVersion: 1,
    application: { root: '.', runtime: 'node', framework: null, dockerfilePath: 'Dockerfile' },
    build: { command: 'npm run build', context: '.' },
    web: { command: 'npm start', port: 3000 },
    health: { path: '/health' },
    database: { postgres: false },
    redis: { required: false, envBindings: [] },
    storage: { required: false, envBindings: [] },
    migration: { command: null },
    worker: { command: null },
    environment: { variables: [] },
    externalServices: [],
    unsupported: [],
    ...overrides,
  };
}

const STATELESS = manifestWith();
const WITH_POSTGRES_REDIS = manifestWith({
  database: { postgres: true },
  redis: { required: true, envBindings: [] },
});

function footprintFor(manifest: DeploymentManifest, region: 'us-east-1' | null = 'us-east-1'): DeploymentFootprint {
  return resolveDeploymentFootprint({ manifest, region });
}

const cleanups: Array<() => void> = [];

function render(element: React.ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(element);
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

function expand(container: HTMLElement): void {
  const triggers = [...container.querySelectorAll('[data-slot="collapsible-trigger"]')];
  expect(triggers.length).toBeGreaterThan(0);
  act(() => {
    triggers[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
  document.body.innerHTML = '';
});

describe('FootprintSummary', () => {
  it('renders nothing without a footprint', () => {
    const container = render(<FootprintSummary footprint={null} />);
    expect(container.querySelector('[data-testid^="footprint-summary"]')).toBeNull();
  });

  it('labels the section Planned infrastructure by default and Deployed infrastructure once READY', () => {
    const planned = render(<FootprintSummary footprint={footprintFor(STATELESS)} />);
    expect(planned.querySelector('[data-testid="footprint-summary-planned"]')).not.toBeNull();
    expect(planned.textContent).toContain('Planned infrastructure');
    const deployed = render(<FootprintSummary footprint={footprintFor(STATELESS)} stage="deployed" />);
    expect(deployed.querySelector('[data-testid="footprint-summary-deployed"]')).not.toBeNull();
    expect(deployed.textContent).toContain('Deployed infrastructure');
  });

  it('shows quantity and the exact resolved AWS size for every row', () => {
    const container = render(<FootprintSummary footprint={footprintFor(WITH_POSTGRES_REDIS)} />);
    const web = container.querySelector('[data-testid="footprint-row-web"]')!;
    expect(web.textContent).toContain('Web application');
    expect(web.textContent).toContain('1 × Small');
    expect(web.textContent).toContain('AWS Fargate');
    expect(web.textContent).toContain('0.25 vCPU');
    const database = container.querySelector('[data-testid="footprint-row-database"]')!;
    expect(database.textContent).toContain('PostgreSQL');
    expect(database.textContent).toContain('db.t3.micro');
    expect(database.textContent).toContain('20 GB');
    const cache = container.querySelector('[data-testid="footprint-row-cache"]')!;
    expect(cache.textContent).toContain('Redis (Valkey)');
    expect(cache.textContent).toContain('cache.t4g.micro');
  });

  it('omits the database and cache rows for a stateless application', () => {
    const container = render(<FootprintSummary footprint={footprintFor(STATELESS)} />);
    expect(container.querySelector('[data-testid="footprint-row-database"]')).toBeNull();
    expect(container.querySelector('[data-testid="footprint-row-cache"]')).toBeNull();
    expect(container.querySelector('[data-testid="footprint-row-storage"]')).not.toBeNull();
  });

  it('marks retained resources as persistent, others as removed with the deployment', () => {
    const container = render(<FootprintSummary footprint={footprintFor(WITH_POSTGRES_REDIS)} />);
    expect(container.querySelector('[data-testid="footprint-row-database"]')!.textContent).toContain(
      'Persistent · retained when the deployment is removed',
    );
    expect(container.querySelector('[data-testid="footprint-row-cache"]')!.textContent).toContain(
      'Removed with the deployment',
    );
  });

  it('renders an unknown future resource through the generic row path', () => {
    const footprint = footprintFor(STATELESS);
    const future: DeploymentFootprint = {
      ...footprint,
      resources: [
        ...footprint.resources,
        {
          id: 'queue',
          category: 'queue',
          provider: 'aws',
          service: 'sqs',
          role: 'queue',
          label: 'Task queue',
          quantity: 1,
          configuration: {},
          lifecycle: { persistent: false, retainOnDelete: false },
        },
      ],
    };
    const container = render(<FootprintSummary footprint={future} />);
    const queue = container.querySelector('[data-testid="footprint-row-queue"]')!;
    expect(queue.textContent).toContain('Task queue');
    expect(queue.textContent).toContain('sqs');
  });
});

describe('FootprintCost', () => {
  it('renders nothing without an estimate', () => {
    const container = render(<FootprintCost estimate={null} />);
    expect(container.querySelector('[data-testid="footprint-cost"]')).toBeNull();
  });

  it('shows the rounded price range for a complete estimate', () => {
    const container = render(<FootprintCost estimate={estimateFootprintCost(footprintFor(STATELESS))} />);
    expect(container.querySelector('[data-testid="footprint-cost-range"]')!.textContent).toBe('~$65–95/month');
    expect(container.textContent).toContain('AWS bills your account directly.');
    expect(container.querySelector('[data-testid="footprint-cost-incomplete"]')).toBeNull();
  });

  it('expands to the per-item breakdown with usage-dependent costs', () => {
    const container = render(<FootprintCost estimate={estimateFootprintCost(footprintFor(WITH_POSTGRES_REDIS))} />);
    expect(container.querySelector('[data-testid="footprint-cost-breakdown"]')).toBeNull();
    expand(container);
    const postgres = container.querySelector('[data-testid="footprint-cost-item-database"]')!;
    expect(postgres.textContent).toContain('~$14–19');
    const storage = container.querySelector('[data-testid="footprint-cost-item-storage"]')!;
    expect(storage.textContent).toContain('Usage based');
    expect(container.textContent).toContain('Additional usage-based costs:');
  });

  it('flags an incomplete estimate when a material resource cannot be priced', () => {
    const footprint = footprintFor(STATELESS);
    const partial: FootprintCostEstimate = {
      ...estimateFootprintCost(footprint),
      complete: false,
      items: [
        ...estimateFootprintCost(footprint).items,
        { resourceId: 'search', label: 'Search', pricingStatus: 'unavailable' },
      ],
    };
    const container = render(<FootprintCost estimate={partial} />);
    expect(container.querySelector('[data-testid="footprint-cost-incomplete"]')!.textContent).toContain(
      'Estimate incomplete',
    );
    expand(container);
    expect(container.querySelector('[data-testid="footprint-cost-item-search"]')!.textContent).toContain(
      'Pricing unavailable',
    );
  });

  it('says the estimate is unavailable when nothing could be priced', () => {
    const container = render(
      <FootprintCost estimate={{
        currency: 'USD',
        monthlyMin: null,
        monthlyMax: null,
        complete: false,
        items: [{ resourceId: 'a', label: 'A', pricingStatus: 'unavailable' }],
        usageDependent: [],
      }} />,
    );
    expect(container.querySelector('[data-testid="footprint-cost-unavailable"]')!.textContent).toContain(
      'AWS cost estimate unavailable',
    );
    expect(container.querySelector('[data-testid="footprint-cost-range"]')).toBeNull();
  });
});
