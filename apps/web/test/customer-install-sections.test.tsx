import { JSDOM } from 'jsdom';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DeploymentPlan, DeploymentPlanAwsResource } from '@deployz/contracts';

import { CustomerInstallSections } from '../src/components/customer-install-sections';
import {
  buildAwsResourceSections,
  buildResourceCategories,
  buildEnvVarRows,
  retentionSummary,
  rowCost,
  summarizeEnvVars,
} from '../src/lib/customer-install-resources';

const SAMPLE_RESOURCES: DeploymentPlanAwsResource[] = [
  {
    id: 'ecs_service',
    name: 'ECS Fargate service',
    purpose: 'Runs the application container and restarts it if it stops',
    group: 'compute_networking',
    componentKind: 'application',
    lifecycle: 'delete',
  },
  {
    id: 'load_balancer',
    name: 'Application Load Balancer',
    purpose: 'Receives web traffic and sends it to the application',
    group: 'compute_networking',
    componentKind: 'endpoint',
    lifecycle: 'delete',
  },
  {
    id: 'nat_gateway',
    name: 'NAT gateway',
    purpose: 'Lets the application reach the internet from the private network',
    group: 'compute_networking',
    componentKind: 'network',
    lifecycle: 'delete',
  },
  {
    id: 'database',
    name: 'RDS PostgreSQL database',
    purpose: 'Stores persistent application data',
    group: 'data',
    componentKind: 'database',
    lifecycle: 'retain',
  },
  {
    id: 'storage_bucket',
    name: 'S3 bucket',
    purpose: 'Stores uploaded files',
    group: 'data',
    componentKind: 'storage',
    lifecycle: 'retain',
  },
  {
    id: 'security_groups',
    name: 'Security groups',
    purpose: 'Restrict network traffic between the components',
    group: 'security_operations',
    componentKind: 'network',
    lifecycle: 'delete',
  },
  {
    id: 'log_group',
    name: 'CloudWatch log group',
    purpose: 'Collects application logs',
    group: 'security_operations',
    componentKind: 'monitoring',
    lifecycle: 'delete',
  },
];

const PLAN: DeploymentPlan = {
  schemaVersion: 1,
  action: 'INSTALL',
  region: 'us-east-1',
  components: [],
  awsResources: SAMPLE_RESOURCES,
  costEstimate: {
    currency: 'USD',
    monthlyMin: 30,
    monthlyMax: 60,
    complete: true,
    items: [
      {
        resourceId: 'web',
        label: 'Web',
        monthlyMin: 8,
        monthlyMax: 11,
        pricingStatus: 'estimated',
      },
      {
        resourceId: 'worker',
        label: 'Worker',
        monthlyMin: 4,
        monthlyMax: 5,
        pricingStatus: 'estimated',
      },
      {
        resourceId: 'endpoint',
        label: 'ALB',
        monthlyMin: 15,
        monthlyMax: 25,
        pricingStatus: 'estimated',
      },
      {
        resourceId: 'database',
        label: 'RDS',
        monthlyMin: 14,
        monthlyMax: 19,
        pricingStatus: 'estimated',
      },
      {
        resourceId: 'storage',
        label: 'S3',
        pricingStatus: 'usage_based',
      },
      {
        resourceId: 'nat-gateway',
        label: 'NAT',
        monthlyMin: 33,
        monthlyMax: 40,
        pricingStatus: 'estimated',
      },
    ],
    usageDependent: ['Outbound data transfer'],
  },
  requirementDrift: [],
};

describe('buildAwsResourceSections', () => {
  it('renders every detailed AWS resource from the plan', () => {
    const sections = buildAwsResourceSections(PLAN);
    const ids = sections.flatMap((section) => section.rows.map((row) => row.id));
    for (const resource of SAMPLE_RESOURCES) {
      expect(ids).toContain(resource.id);
    }
  });

  it('groups resources by their existing plan group without changing order', () => {
    const sections = buildAwsResourceSections(PLAN);
    const groupLabels = sections.map((section) => section.label);
    // compute_networking first, then data, then security_operations — no
    // empty groups, no reordering.
    expect(groupLabels).toEqual(['Compute & Networking', 'Data', 'Security & Operations']);
  });

  it('renders the lifecycle column only inside Configuration, never as its own column', () => {
    const sections = buildAwsResourceSections(PLAN);
    const retained = sections
      .flatMap((section) => section.rows)
      .find((row) => row.id === 'database');
    expect(retained?.configuration).toContain('Persistent');
    expect(retained?.configuration).toContain('retained');
  });

  it('only renders a per-resource cost when the existing cost model supplies it', () => {
    const sections = buildAwsResourceSections(PLAN);
    const findRow = (id: string) =>
      sections.flatMap((section) => section.rows).find((row) => row.id === id);
    // estimated rows show ~$N–/mo
    expect(findRow('ecs_service')?.cost).toEqual({ kind: 'estimated', label: '~$12\u201316/mo' });
    expect(findRow('load_balancer')?.cost).toEqual({ kind: 'estimated', label: '~$15\u201325/mo' });
    expect(findRow('nat_gateway')?.cost).toEqual({ kind: 'estimated', label: '~$33\u201340/mo' });
    // usage-based rows show the literal label
    expect(findRow('storage_bucket')?.cost?.kind).toBe('usage_based');
    // rows the cost model never priced render as null ("—" in the table)
    expect(findRow('security_groups')?.cost).toBeNull();
    expect(findRow('log_group')?.cost).toBeNull();
  });
});

describe('rowCost', () => {
  it('returns null when the cost model never priced the resource', () => {
    expect(rowCost('security_groups', { byId: new Map(), hasUsageBased: false })).toBeNull();
  });
});

describe('retentionSummary', () => {
  it('names only the retained resources', () => {
    const summary = retentionSummary(PLAN);
    expect(summary).toContain('RDS PostgreSQL database');
    expect(summary).toContain('S3 bucket');
    expect(summary).not.toContain('ECS Fargate service');
  });

  it('is null when nothing is retained', () => {
    const stateless: DeploymentPlan = {
      ...PLAN,
      awsResources: SAMPLE_RESOURCES.filter((resource) => resource.lifecycle === 'delete'),
    };
    expect(retentionSummary(stateless)).toBeNull();
  });
});

describe('buildEnvVarRows / summarizeEnvVars', () => {
  it('maps Deployz-managed bindings to the Deployz source label as Ready', () => {
    const rows = buildEnvVarRows([
      { key: 'DATABASE_URL', required: true, secret: false, classification: 'deployz_managed', purpose: 'Database connection' },
    ]);
    expect(rows[0]?.sourceLabel).toBe('Deployz');
    // Deployz delivers this binding — the customer does not supply it,
    // so it renders Ready, not Required.
    expect(rows[0]?.status).toBe('Ready');
  });

  it('maps customer-required inputs to the You source label', () => {
    const rows = buildEnvVarRows([
      { key: 'JWT_SECRET', required: true, secret: true, classification: 'customer_required', purpose: 'Signing secret' },
    ]);
    expect(rows[0]?.sourceLabel).toBe('You');
    expect(rows[0]?.status).toBe('Required');
  });

  it('does not render the secret value, only the status', () => {
    const rendered = renderToString(
      <CustomerInstallSections
        plan={null}
        envVarInputs={[
          { key: 'JWT_SECRET', required: true, secret: true, classification: 'customer_required', purpose: 'Signing secret' },
        ]}
      />,
    );
    expect(rendered).toContain('JWT_SECRET');
    expect(rendered).toContain('Required');
    expect(rendered).not.toContain('hunter2');
  });

  it('summarises required vs configured without inventing values', () => {
    const summary = summarizeEnvVars(
      buildEnvVarRows([
        { key: 'DATABASE_URL', required: true, secret: false, classification: 'deployz_managed' },
        { key: 'S3_BUCKET', required: true, secret: false, classification: 'deployz_managed' },
        { key: 'JWT_SECRET', required: true, secret: true, classification: 'customer_required' },
        { key: 'SMTP_API_KEY', required: true, secret: true, classification: 'customer_required' },
      ]),
    );
    expect(summary.needInput).toBe(2);
    expect(summary.configured).toBe(2);
    expect(summary.total).toBe(4);
    expect(summary.headline).toContain('2 need your input');
    expect(summary.headline).toContain('2 configured');
  });
});

describe('buildResourceCategories', () => {
  function planWith(awsResources: DeploymentPlanAwsResource[]): DeploymentPlan {
    return { ...PLAN, awsResources };
  }

  const appResource: DeploymentPlanAwsResource = {
    id: 'ecs_service',
    name: 'ECS Fargate service',
    purpose: 'Runs the application container',
    group: 'compute_networking',
    componentKind: 'application',
    lifecycle: 'delete',
  };
  const databaseResource: DeploymentPlanAwsResource = {
    id: 'database',
    name: 'RDS PostgreSQL database',
    purpose: 'Stores persistent application data',
    group: 'data',
    componentKind: 'database',
    lifecycle: 'retain',
  };
  const cacheResource: DeploymentPlanAwsResource = {
    id: 'cache',
    name: 'ElastiCache Valkey',
    purpose: 'Caches application data',
    group: 'data',
    componentKind: 'cache',
    lifecycle: 'delete',
  };
  const storageResource: DeploymentPlanAwsResource = {
    id: 'storage_bucket',
    name: 'S3 bucket',
    purpose: 'Stores uploaded files',
    group: 'data',
    componentKind: 'storage',
    lifecycle: 'retain',
  };

  it('returns nothing without a plan', () => {
    expect(buildResourceCategories(null)).toEqual([]);
  });

  it('lists only the categories the plan creates', () => {
    const categories = buildResourceCategories(planWith([appResource]));
    expect(categories.map((category) => category.category)).toEqual(['application']);
    expect(categories[0]).toMatchObject({ label: 'Application hosting', names: ['ECS Fargate service'] });
  });

  it('labels the database card Database & cache when the plan has both', () => {
    const categories = buildResourceCategories(planWith([databaseResource, cacheResource]));
    expect(categories).toHaveLength(1);
    expect(categories[0]).toMatchObject({
      category: 'database',
      label: 'Database & cache',
      names: ['RDS PostgreSQL database', 'ElastiCache Valkey'],
    });
  });

  it('labels the database card by what it holds when only one exists', () => {
    expect(buildResourceCategories(planWith([databaseResource]))[0]?.label).toBe('Database');
    expect(buildResourceCategories(planWith([cacheResource]))[0]?.label).toBe('Cache');
  });

  it('puts connector, security_operations and network resources under Network & security', () => {
    const categories = buildResourceCategories(
      planWith([
        { ...appResource, id: 'connector_lambda', name: 'Deployz connector', group: 'connector', componentKind: 'other' },
        { ...appResource, id: 'iam_roles', name: 'IAM roles', group: 'security_operations', componentKind: 'application' },
        { ...appResource, id: 'vpc', name: 'Private network', componentKind: 'network' },
      ]),
    );
    expect(categories).toEqual([
      {
        category: 'network_security',
        label: 'Network & security',
        names: ['Deployz connector', 'IAM roles', 'Private network'],
      },
    ]);
  });

  it('orders categories application, database, storage, network_security regardless of plan order', () => {
    const categories = buildResourceCategories(
      planWith([
        { ...appResource, id: 'vpc', name: 'Private network', componentKind: 'network' },
        storageResource,
        databaseResource,
        appResource,
      ]),
    );
    expect(categories.map((category) => category.category)).toEqual([
      'application',
      'database',
      'storage',
      'network_security',
    ]);
    expect(categories[2]?.label).toBe('File storage');
  });
});

describe('CustomerInstallSections composition', () => {
  it('renders the sections in the customer-facing order', async () => {
    const html = renderToString(
      <CustomerInstallSections
        plan={PLAN}
        securityHref="/install/abc/security"
        envVarInputs={[
          { key: 'DATABASE_URL', required: true, secret: false, classification: 'deployz_managed' },
        ]}
      />,
    );
    const { window } = new JSDOM(html);
    const doc = window.document;
    expect(doc.querySelector('[data-testid="customer-install-sections"]')).not.toBeNull();
    expect(doc.querySelector('[data-testid="aws-resources-total"]')).not.toBeNull();
    expect(doc.querySelector('[data-testid="aws-resource-categories"]')).not.toBeNull();
    expect(doc.querySelector('[data-testid="env-vars-table-wrapper"]')).not.toBeNull();
    expect(doc.querySelector('[data-testid="before-you-deploy-security"]')).not.toBeNull();
    // Order: cost -> what will be deployed -> env vars -> Before you deploy.
    const headings = Array.from(doc.querySelectorAll('h2')).map((node) => node.textContent?.trim());
    expect(headings).toEqual([
      'Estimated AWS cost',
      'What will be deployed',
      'Environment variables',
      'Before you deploy',
    ]);
  });

  it('keeps the full resource table behind the closed View AWS resources disclosure', () => {
    const html = renderToString(<CustomerInstallSections plan={PLAN} />);
    const { window } = new JSDOM(html);
    const doc = window.document;
    expect(html).toContain('View AWS resources');
    expect(doc.querySelector('[data-testid="aws-resources-table"]')).toBeNull();
  });

  it('renders the canonical cost estimate before the resource summary', () => {
    const html = renderToString(
      <CustomerInstallSections plan={PLAN} />,
    );
    expect(html).toContain('Estimated AWS cost');
    expect(html).toContain('~$30–60/month');
    expect(html).toContain('AWS bills your account directly; actual charges depend on usage.');
    expect(html.indexOf('Estimated AWS cost')).toBeLessThan(html.indexOf('What will be deployed'));
  });

  it('renders nothing for env vars when the inputs list is empty', () => {
    const html = renderToString(<CustomerInstallSections plan={PLAN} />);
    const { window } = new JSDOM(html);
    const doc = window.document;
    expect(doc.querySelector('[data-testid="env-vars-table-wrapper"]')).toBeNull();
    expect(doc.body.textContent).not.toContain('Environment variables');
    expect(doc.body.textContent).not.toContain('No environment variables declared');
  });

  it('skips the cost and deployed summaries when the plan has no AWS resources', () => {
    const html = renderToString(<CustomerInstallSections plan={{ ...PLAN, awsResources: [] }} />);
    const { window } = new JSDOM(html);
    const doc = window.document;
    expect(doc.querySelector('[data-testid="aws-resources-total"]')).toBeNull();
    expect(doc.querySelector('[data-testid="aws-resource-categories"]')).toBeNull();
    expect(doc.body.textContent).toContain('Before you deploy');
  });
});
