// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { DeploymentPlan } from '@deployz/contracts';

import { SecurityDetailsContent } from '../src/components/security-details-content';
import { CONNECTOR_ROLE, EXECUTION_ROLE } from '../src/lib/bootstrap-permissions';
import {
  DENIED_LOG_READ_ACTIONS,
  OWNERSHIP_NOTE,
  REVOKE_ORDER_NOTE,
  SECRET_HANDLING_STATEMENT,
  TRAFFIC_RECOMMENDATION,
} from '../src/lib/security-details';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The Security Details page: three tabs (Overview, AWS permissions, Data &
// control). The resource list and the diagram are plan-driven, and a null
// plan shows unavailable states. Every IAM action comes from the deployed
// bootstrap template. Rendered interactively, so the tab and accordion
// behavior is exercised the way a customer uses it.

const BACK_HREF = '/install/11111111-1111-1111-1111-111111111111';

function awsResource(
  overrides: Partial<DeploymentPlan['awsResources'][number]> = {},
): DeploymentPlan['awsResources'][number] {
  return {
    id: 'ecs_service',
    name: 'ECS Fargate service',
    purpose: 'Runs the application container and restarts it if it stops',
    group: 'compute_networking',
    componentKind: 'application',
    lifecycle: 'delete',
    ...overrides,
  };
}

/** Mirrors buildInstallPlan output: catalog components and AWS resources,
 * filtered by the same profile the manifest would derive. */
function installPlan({ postgres, redis }: { postgres: boolean; redis: boolean }): DeploymentPlan {
  const components: DeploymentPlan['components'] = [
    { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' },
    { kind: 'endpoint', name: 'Secure endpoint', action: 'CREATE', lifecycle: 'delete' },
  ];
  if (postgres) {
    components.push({ kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain' });
  }
  components.push({ kind: 'storage', name: 'Storage', action: 'CREATE', lifecycle: 'retain' });
  if (redis) {
    components.push({ kind: 'cache', name: 'Cache', action: 'CREATE', lifecycle: 'delete' });
  }

  const awsResources: DeploymentPlan['awsResources'] = [
    awsResource({
      id: 'vpc',
      name: 'Private network (VPC)',
      purpose: 'Isolates the application from other resources in your account',
      componentKind: 'network',
    }),
    awsResource(),
    awsResource({
      id: 'load_balancer',
      name: 'Application Load Balancer',
      purpose: 'Receives web traffic and sends it to the application',
      componentKind: 'endpoint',
    }),
  ];
  if (postgres) {
    awsResources.push(
      awsResource({
        id: 'database',
        name: 'RDS PostgreSQL database',
        purpose: 'Stores persistent application data',
        group: 'data',
        componentKind: 'database',
        lifecycle: 'retain',
      }),
    );
  }
  if (redis) {
    awsResources.push(
      awsResource({
        id: 'cache',
        name: 'ElastiCache Valkey cache',
        purpose: 'Speeds up application requests',
        group: 'data',
        componentKind: 'cache',
      }),
    );
  }
  awsResources.push(
    awsResource({
      id: 'storage_bucket',
      name: 'S3 bucket',
      purpose: 'Stores uploaded files',
      group: 'data',
      componentKind: 'storage',
      lifecycle: 'retain',
    }),
    awsResource({
      id: 'log_group',
      name: 'CloudWatch log group',
      purpose: 'Collects application logs',
      group: 'security_operations',
      componentKind: 'monitoring',
    }),
  );

  return {
    schemaVersion: 1,
    action: 'INSTALL',
    region: 'us-east-1',
    components,
    awsResources,
    requirementDrift: [],
  };
}

const STATELESS = installPlan({ postgres: false, redis: false });

const cleanups: Array<() => void> = [];

function render(plan: DeploymentPlan | null): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(<SecurityDetailsContent plan={plan} backHref={BACK_HREF} />);
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
  document.body.innerHTML = '';
});

function tab(container: HTMLElement, name: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (candidate) => candidate.textContent === name,
  );
  if (!found) throw new Error(`No tab named ${name}`);
  return found;
}

/** Radix activates a tab on mouse down, not on click. */
function openTab(container: HTMLElement, name: string): void {
  act(() => {
    tab(container, name).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }),
    );
  });
}

function accordionTrigger(container: HTMLElement, name: string): HTMLElement {
  const found = [
    ...container.querySelectorAll<HTMLElement>('[data-slot="accordion-trigger"]'),
  ].find((trigger) => trigger.textContent === name);
  if (!found) throw new Error(`No accordion item named ${name}`);
  return found;
}

function expanded(container: HTMLElement, name: string): string | null {
  return accordionTrigger(container, name).getAttribute('aria-expanded');
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

const PERMISSION_SECTIONS = [
  'AWS resources created',
  'Initial installation permissions',
  'Ongoing connector permissions',
  'Read-only permissions and exceptions',
];

function openAllPermissions(container: HTMLElement): void {
  openTab(container, 'AWS permissions');
  for (const name of PERMISSION_SECTIONS) click(accordionTrigger(container, name));
}

function activePanel(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[role="tabpanel"][data-state="active"]')!;
}

describe('SecurityDetailsContent layout', () => {
  it('renders the title, subtitle and three highlights above the tabs', () => {
    const container = render(STATELESS);
    expect(container.querySelector('h1')?.textContent).toBe('Security & AWS access');
    expect(container.textContent).toContain(
      'Review what Deployz installs, what it can access, and how you stay in control.',
    );
    const highlights = container.querySelector('[aria-label="Security highlights"]')!;
    expect(
      [...highlights.querySelectorAll('li')].map((item) => item.querySelector('p')?.textContent),
    ).toEqual(['Your AWS account', 'Outbound connection', 'IAM permissions']);
    expect(highlights.closest('[role="tabpanel"]')).toBeNull();
    expect(container.textContent).not.toContain('The honest version');
  });

  it('defaults to the Overview tab and switches tabs in place', () => {
    const container = render(STATELESS);
    expect([...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual([
      'Overview',
      'AWS permissions',
      'Data & control',
    ]);
    expect(tab(container, 'Overview').getAttribute('aria-selected')).toBe('true');
    expect(activePanel(container).textContent).toContain('How it works');

    openTab(container, 'Data & control');
    expect(tab(container, 'Data & control').getAttribute('aria-selected')).toBe('true');
    expect(activePanel(container).querySelector('#revoke')?.textContent).toBe('Revoke access');

    openTab(container, 'AWS permissions');
    expect(activePanel(container).textContent).toContain('AWS resources created');
  });

  it('opens the AWS permissions tab from the Overview pointer', () => {
    const container = render(STATELESS);
    const pointer = [...container.querySelectorAll<HTMLElement>('button')].find(
      (button) => button.textContent === 'Review AWS permissions',
    )!;
    click(pointer);
    expect(tab(container, 'AWS permissions').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab(container, 'AWS permissions'));
  });

  it('keeps every accordion collapsed by default and expands each independently', () => {
    const container = render(STATELESS);
    openTab(container, 'AWS permissions');
    for (const name of PERMISSION_SECTIONS) expect(expanded(container, name)).toBe('false');
    expect(container.textContent).not.toContain('cloudformation:CreateStack');

    click(accordionTrigger(container, 'Ongoing connector permissions'));
    click(accordionTrigger(container, 'AWS resources created'));
    expect(expanded(container, 'Ongoing connector permissions')).toBe('true');
    expect(expanded(container, 'AWS resources created')).toBe('true');
    expect(expanded(container, 'Initial installation permissions')).toBe('false');
    expect(container.textContent).toContain('cloudformation:CreateStack');

    click(accordionTrigger(container, 'AWS resources created'));
    expect(expanded(container, 'AWS resources created')).toBe('false');
    expect(expanded(container, 'Ongoing connector permissions')).toBe('true');
  });

  it('links back to the given backHref', () => {
    const container = render(STATELESS);
    const back = [...container.querySelectorAll('a')].find(
      (anchor) => anchor.textContent === 'Back to installation',
    );
    expect(back?.getAttribute('href')).toBe(BACK_HREF);
  });
});

describe('SecurityDetailsContent plan-driven content', () => {
  function resourcesText(container: HTMLElement): string {
    openTab(container, 'AWS permissions');
    click(accordionTrigger(container, 'AWS resources created'));
    return activePanel(container).textContent ?? '';
  }

  function diagramText(container: HTMLElement): string {
    return container.querySelector('figure')?.textContent ?? '';
  }

  it('shows no database or cache for a stateless plan', () => {
    const container = render(STATELESS);
    const diagram = diagramText(container);
    expect(diagram).not.toMatch(/database|cache/i);
    const resources = resourcesText(container);
    expect(resources).not.toContain('PostgreSQL');
    expect(resources).not.toContain('Valkey');
  });

  it('shows the database and cache when the plan includes them', () => {
    const container = render(installPlan({ postgres: true, redis: true }));
    expect(diagramText(container)).toContain('Database');
    expect(diagramText(container)).toContain('Cache');
    const resources = resourcesText(container);
    expect(resources).toContain('RDS PostgreSQL database');
    expect(resources).toContain('ElastiCache Valkey cache');
    expect(resources).toContain('Compute & Networking');
    expect(resources).toContain('Security & Operations');
  });

  it('shows the account boundary, the connector and the outbound HTTPS link', () => {
    const diagram = diagramText(render(STATELESS));
    expect(diagram).toContain('Your AWS account');
    expect(diagram).toContain('Deployz connector');
    expect(diagram).toContain('Outbound HTTPS');
    expect(diagram).toContain('Deployz control plane');
  });

  it('shows unavailable states, and still the connector stack, when the plan is null', () => {
    const container = render(null);
    expect(container.querySelector('figure')).toBeNull();
    expect(activePanel(container).textContent).toContain('Infrastructure details are unavailable');
    const resources = resourcesText(container);
    expect(resources).toContain('Infrastructure details are unavailable');
    expect(resources).not.toContain('S3 bucket');
    expect(resources).toContain('Connector role');
  });
});

describe('SecurityDetailsContent permissions from the template', () => {
  it('renders every action and Sid of both roles from the bootstrap template', () => {
    const container = render(STATELESS);
    openAllPermissions(container);
    const codes = new Set([...container.querySelectorAll('code')].map((code) => code.textContent));
    for (const role of [CONNECTOR_ROLE, EXECUTION_ROLE]) {
      for (const statement of role.statements) {
        for (const action of statement.actions) expect(codes).toContain(action);
        if (statement.sid) expect(codes).toContain(statement.sid);
      }
    }
  });

  it('discloses the tag conditions, the exceptions and the role facts', () => {
    const container = render(STATELESS);
    openAllPermissions(container);
    const text = container.textContent ?? '';
    expect(text).toContain('aws:RequestTag/deployz:installation');
    expect(text).toContain('aws:ResourceTag/deployz:installation');
    expect(text).toContain("Only when the request carries this installation's tag.");
    expect(text).toContain('Any resource in the account.');
    expect(text).not.toContain('any secret in the account');
    expect(text).toContain('${RelayCredentialFromParam} or ${RelayCredentialGenerated}');
    expect(text).toContain('not after its first check-in');
    expect(text).toContain('A permissions boundary caps the role at these permissions.');
    expect(text).toContain(
      'It can create IAM roles for your application only under /deployz/, and each role must have the application role boundary.',
    );
    expect(text).not.toContain('attach any policy');
    expect(text).toContain('Application role boundary');
    expect(text).toContain('It has no permissions boundary.');
  });

  it('lists the log-read actions as not granted', () => {
    const container = render(STATELESS);
    openAllPermissions(container);
    const exceptions = accordionTrigger(container, 'Read-only permissions and exceptions').closest(
      '[data-slot="accordion-item"]',
    )!;
    expect(exceptions.textContent).toContain('Not granted');
    for (const action of DENIED_LOG_READ_ACTIONS) expect(exceptions.textContent).toContain(action);
  });
});

describe('SecurityDetailsContent data and control', () => {
  it('shows the six sections with the verified secret, traffic, revoke and deletion copy', () => {
    const container = render(STATELESS);
    openTab(container, 'Data & control');
    const panel = activePanel(container);
    expect([...panel.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual([
      'Application data',
      'Application traffic',
      'Secrets & credentials',
      'Data shared with Deployz',
      'Revoke access',
      'Deletion & retained resources',
    ]);
    expect(panel.textContent).toContain(SECRET_HANDLING_STATEMENT);
    expect(panel.querySelector('[aria-labelledby="traffic"]')?.textContent).toContain(TRAFFIC_RECOMMENDATION);
    expect(panel.querySelector('[aria-labelledby="revoke"]')?.textContent).toContain(OWNERSHIP_NOTE);
    expect(panel.textContent).toContain(REVOKE_ORDER_NOTE);
    expect(panel.textContent).toContain('Delete retained data');
  });
});
