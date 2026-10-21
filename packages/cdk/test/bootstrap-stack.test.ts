import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BootstrapStack, IAM_MANAGED_POLICY_MAX_CHARS } from '../src/bootstrap/bootstrap-stack.js';

import { withStableAssetHashes } from './stable-template.js';

/**
 * Collect the IAM action strings from a list of policy statements.
 * Handles both `Action: 'x'` and `Action: ['x', 'y']`, and `NotAction`.
 */
function collectActions(statements: unknown): string[] {
  const out: string[] = [];
  for (const stmt of (statements as Array<Record<string, unknown>>) ?? []) {
    for (const key of ['Action', 'NotAction']) {
      const value = stmt?.[key];
      if (typeof value === 'string') {
        out.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') out.push(item);
        }
      }
    }
  }
  return out;
}

type TemplateResource = { Type: string; Properties?: Record<string, unknown> };

function allResources(template: Template): Record<string, TemplateResource> {
  return (template.toJSON() as { Resources: Record<string, TemplateResource> })['Resources'];
}

/**
 * Replace every bundled-asset hash with a fixed placeholder.
 *
 * esbuild emits a byte-different bundle on Windows and on Linux, so the hash
 * in `Code.S3Key` depends on the machine that ran the test, not on the stack.
 * Without this the committed snapshot fails everywhere except the platform
 * that wrote it.
 */
function withStableAssetHashes(template: unknown): unknown {
  return JSON.parse(
    JSON.stringify(template).replace(/[0-9a-f]{64}\.zip/g, '<asset-hash>.zip'),
  );
}

/**
 * Collect every IAM action granted anywhere in the template: inline role
 * `Policies`, standalone `AWS::IAM::Policy`, and `AWS::IAM::ManagedPolicy`.
 */
function allIamActions(template: Template): string[] {
  const resources = allResources(template);
  const out: string[] = [];
  for (const resource of Object.values(resources)) {
    const type = resource.Type;
    const props = resource.Properties ?? {};
    if (type === 'AWS::IAM::Role') {
      for (const p of (props['Policies'] as Array<Record<string, unknown>>) ?? []) {
        out.push(...collectActions((p['PolicyDocument'] as Record<string, unknown>)?.['Statement']));
      }
    }
    if (type === 'AWS::IAM::Policy' || type === 'AWS::IAM::ManagedPolicy') {
      out.push(...collectActions((props['PolicyDocument'] as Record<string, unknown>)?.['Statement']));
    }
  }
  return out;
}

/**
 * The IAM actions granted to the relay role (found via its permissions
 * boundary). The relay's phase-1 statements are emitted as a standalone
 * `AWS::IAM::Policy` whose `Roles` ref the relay role, so collect those.
 */
function relayRoleActions(template: Template): string[] {
  const resources = allResources(template);
  let relayLogicalId: string | undefined;
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type === 'AWS::IAM::Role' && resource.Properties?.['PermissionsBoundary']) {
      relayLogicalId = logicalId;
      break;
    }
  }
  if (!relayLogicalId) {
    throw new Error('Relay role (role with PermissionsBoundary) not found');
  }

  const out: string[] = [];
  for (const resource of Object.values(resources)) {
    if (resource.Type !== 'AWS::IAM::Policy') continue;
    const roles = (resource.Properties?.['Roles'] as Array<{ Ref?: string }>) ?? [];
    const referencesRelay = roles.some((r) => r?.['Ref'] === relayLogicalId);
    if (referencesRelay) {
      out.push(...collectActions((resource.Properties?.['PolicyDocument'] as Record<string, unknown>)?.['Statement']));
    }
  }
  return out;
}

function synth() {
  const app = new App();
  const stack = new BootstrapStack(app, 'BootstrapTest');
  const template = Template.fromStack(stack);
  return { app, stack, template };
}

describe('BootstrapStack', () => {
  it('synthesizes without errors', () => {
    const { template } = synth();
    expect(template).toBeDefined();
  });

  it('creates the relay Lambda with install identity in the environment', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Lambda::Function', 4); // relay + install-id + provider framework + log-retention
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          DEPLOYZ_CONTROL_PLANE_URL: Match.anyValue(),
          DEPLOYZ_INSTALLATION_ID: Match.anyValue(),
          DEPLOYZ_CREDENTIAL_SECRET_ARN: Match.anyValue(),
        }),
      }),
    });
  });

  it('schedules the relay to poll every minute without retrying a dropped event', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Events::Rule', 1);
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 minute)',
      Targets: [
        Match.objectLike({
          RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 },
        }),
      ],
    });
  });

  it('does not reserve concurrency (a new account may not be able to)', () => {
    const { template } = synth();
    for (const resource of Object.values(allResources(template))) {
      expect(resource.Properties?.['ReservedConcurrentExecutions']).toBeUndefined();
    }
  });

  it('reports the build identity through DEPLOYZ_BOOTSTRAP_VERSION', () => {
    const app = new App();
    const stack = new BootstrapStack(app, 'BootstrapBuildId', { buildId: 'abc123def456' });
    Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({ DEPLOYZ_BOOTSTRAP_VERSION: 'abc123def456' }),
      }),
    });
    const { template } = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({ DEPLOYZ_BOOTSTRAP_VERSION: 'dev' }),
      }),
    });
  });

  it('keeps every function log retention at one week', () => {
    const { template } = synth();
    // relay + install-id + provider framework function
    template.resourceCountIs('Custom::LogRetention', 3);
    template.allResourcesProperties('Custom::LogRetention', {
      RetentionInDays: 7,
    });
  });

  it('keeps the logical ids an in-place stack update must not replace', () => {
    // A customer-approved update re-applies this template to the live stack.
    // Renaming or moving one of these resources makes CloudFormation replace
    // it: a new installation id, a new relay credential, a new role, or a new
    // relay function. Change the template without changing these ids.
    const { template } = synth();
    const prefixes = [
      'InstallIdFunction',
      'InstallationId',
      'RelayCredentialFromParam',
      'RelayCredentialGenerated',
      'PermissionsBoundary',
      'ProvisionerPolicy',
      'RelayRole',
      'ApplicationExecutionRole',
      'RelayFunction',
      'RelaySchedule',
    ];
    const stable = Object.keys(allResources(template))
      .filter((id) => prefixes.some((prefix) => id.startsWith(prefix)))
      .filter((id) => !/LogRetention|AllowEventRule/.test(id))
      .sort();
    expect(stable).toEqual([
      'ApplicationExecutionRoleB4697B7D',
      'InstallIdFunctionE00E99D3',
      'InstallIdFunctionServiceRole9CEC2041',
      'InstallationId',
      'PermissionsBoundary2D0B48CC',
      'ProvisionerPolicyCCE83F9D',
      'RelayCredentialFromParam',
      'RelayCredentialGenerated',
      'RelayFunctionD137DF95',
      'RelayRoleDefaultPolicyF6F9CA99',
      'RelayRoleF85CA969',
      'RelaySchedule27C29C24',
    ]);
  });

  it('creates two mutually exclusive credential secrets (DZ-AUDIT-013, replaces one secret)', () => {
    const { template } = synth();
    // DZ-AUDIT-013: two CfnSecrets, one always created (conditioned away).
    template.resourceCountIs('AWS::SecretsManager::Secret', 2);
    // At least one of them uses GenerateSecretString for legacy deployments.
    const generated = Object.values(allResources(template)).filter(
      (r) => r.Type === 'AWS::SecretsManager::Secret' && r.Properties?.['GenerateSecretString'],
    );
    expect(generated.length).toBeGreaterThanOrEqual(1);
  });

  it('mints the installation identifier via a custom resource', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
  });

  it('tags every taggable resource with deployz:component=bootstrap', () => {
    const { template } = synth();
    // AWS::IAM::ManagedPolicy is excluded: CloudFormation has no `Tags`
    // property for managed policies, so they cannot carry deployz: tags.
    const taggable = [
      'AWS::IAM::Role',
      'AWS::Lambda::Function',
      'AWS::SecretsManager::Secret',
      'AWS::Events::Rule',
    ] as const;

    for (const type of taggable) {
      const resources = template.findResources(type) as Record<
        string,
        { Properties?: Record<string, unknown> }
      >;
      for (const [logicalId, resource] of Object.entries(resources)) {
        const tags = (resource.Properties?.['Tags'] as Array<Record<string, unknown>>) ?? [];
        const component = tags.find((t) => t['Key'] === 'deployz:component');
        expect(component?.['Value'], `${type} ${logicalId}`).toBe('bootstrap');
      }
    }
  });

  it('tags the downstream resources with deployz:installation', () => {
    const { template } = synth();
    const json = template.toJSON();
    const resources = json['Resources'] as Record<string, Record<string, unknown>>;

    const hasTag = (props: Record<string, unknown> | undefined, key: string) =>
      ((props?.['Tags'] as Array<Record<string, unknown>>) ?? []).some(
        (t) => t['Key'] === key,
      );

    // The relay role, relay function, credential secret and schedule rule must
    // carry deployz:installation. The install-id generator Lambda/role cannot
    // (it mints the id) and carries only deployz:component.
    const relayRole = Object.values(resources).find(
      (r) => r['Type'] === 'AWS::IAM::Role' && r['Properties']?.['PermissionsBoundary'],
    );
    expect(hasTag(relayRole?.['Properties'] as Record<string, unknown>, 'deployz:installation')).toBe(true);

    const relayFn = Object.values(resources).find(
      (r) =>
        r['Type'] === 'AWS::Lambda::Function' &&
        (r['Properties']?.['Environment'] as Record<string, unknown>)?.Variables?.[
          'DEPLOYZ_INSTALLATION_ID'
        ],
    );
    expect(hasTag(relayFn?.['Properties'] as Record<string, unknown>, 'deployz:installation')).toBe(true);

    const secrets = Object.values(resources).filter(
      (r) => r['Type'] === 'AWS::SecretsManager::Secret',
    );
    for (const secret of secrets) {
      expect(hasTag(secret['Properties'] as Record<string, unknown>, 'deployz:installation')).toBe(true);
    }

    const rule = Object.values(resources).find((r) => r['Type'] === 'AWS::Events::Rule');
    expect(hasTag(rule?.['Properties'] as Record<string, unknown>, 'deployz:installation')).toBe(true);
  });

  it('grants the relay role a permissions boundary', () => {
    const { stack } = synth();
    expect(stack.relayRole.permissionsBoundary).toBeDefined();
    const resources = allResources(Template.fromStack(stack));
    const relayRole = Object.values(resources).find(
      (r) => r.Type === 'AWS::IAM::Role' && r.Properties?.['PermissionsBoundary'],
    );
    expect(relayRole).toBeDefined();
  });

  it('gives the relay role least-privilege phase-1 permissions (logs write + secret access)', () => {
    const { template } = synth();
    const actions = relayRoleActions(template);

    // Phase 1 allows writing logs (required for CloudWatch) ...
    expect(actions).toContain('logs:CreateLogGroup');
    expect(actions).toContain('logs:CreateLogStream');
    expect(actions).toContain('logs:PutLogEvents');
    // ... and reading/writing the bootstrap credential secret ...
    expect(actions).toContain('secretsmanager:GetSecretValue');
    // ... but NOTHING else (no cloudformation, ecs, ec2, rds at install time).
    expect(actions).not.toContain('cloudformation:CreateStack');
    expect(actions).not.toContain('ecs:UpdateService');
    expect(actions).not.toContain('rds:ModifyDBInstance');
  });

  it('attaches the provisioner policy, under the permissions boundary', () => {
    const { stack } = synth();
    const resources = allResources(Template.fromStack(stack));
    const relayRole = Object.values(resources).find(
      (r) => r.Type === 'AWS::IAM::Role' && r.Properties?.['PermissionsBoundary'],
    );
    // This used to assert the opposite, on the theory that the control plane
    // would attach the policy after first contact. It cannot: §15 forbids
    // Deployz from holding credentials in the customer's account, so there
    // is no principal able to make that call. The boundary — which the role
    // still carries — is what caps the grant.
    expect(relayRole?.Properties?.['ManagedPolicyArns']).toBeDefined();
    expect(stack.provisionerPolicy).toBeDefined();
  });

  it('constrains the provisioner policy to the deployz: tag boundary', () => {
    const { stack } = synth();
    const statements = stack.provisionerPolicy.document.toJSON()[
      'Statement'
    ] as Array<Record<string, unknown>>;

    const conditions = statements.flatMap((s) => {
      const cond = s['Condition'] as Record<string, Record<string, string>> | undefined;
      return cond ? Object.values(cond).map((c) => Object.keys(c)) : [];
    });

    const flatKeys = conditions.flat();
    expect(flatKeys).toContain('aws:RequestTag/deployz:installation');
    expect(flatKeys).toContain('aws:ResourceTag/deployz:installation');
    expect(flatKeys).toContain('iam:PassedToService');
  });

  it('grants the relay least-privilege custom-domain ACM + listener permissions', () => {
    const { stack } = synth();
    const actions = collectActions(stack.provisionerPolicy.document.toJSON()['Statement']);

    // ACM certificate lifecycle.
    expect(actions).toContain('acm:RequestCertificate');
    expect(actions).toContain('acm:AddTagsToCertificate');
    expect(actions).toContain('acm:DescribeCertificate');
    expect(actions).toContain('acm:DeleteCertificate');
    expect(actions).toContain('acm:ListTagsForCertificate');

    // ELB listener management on the deployment's ALB.
    expect(actions).toContain('elasticloadbalancing:DescribeListeners');
    expect(actions).toContain('elasticloadbalancing:DescribeListenerCertificates');
    expect(actions).toContain('elasticloadbalancing:DescribeTags');
    expect(actions).toContain('elasticloadbalancing:DescribeRules');
    expect(actions).toContain('elasticloadbalancing:CreateListener');
    expect(actions).toContain('elasticloadbalancing:ModifyListener');
    expect(actions).toContain('elasticloadbalancing:DeleteListener');
    expect(actions).toContain('elasticloadbalancing:AddListenerCertificates');
    expect(actions).toContain('elasticloadbalancing:RemoveListenerCertificates');

    // No wildcard ACM grant anywhere.
    expect(actions).not.toContain('acm:*');

    // Statement structure: ACM request is request-tag-conditioned, ACM manage
    // and the ELB writes are resource-tag-conditioned, and the ELB Describe*
    // set is condition-free (Describe actions don't support resource scoping).
    const statements = stack.provisionerPolicy.document.toJSON()[
      'Statement'
    ] as Array<Record<string, unknown>>;

    const findBySid = (sid: string) => statements.find((s) => s['Sid'] === sid);

    const acmRequestStatement = findBySid('ProvisionerAcmRequest');
    expect(acmRequestStatement).toBeDefined();
    expect(
      (acmRequestStatement?.['Condition'] as Record<string, Record<string, unknown>>)?.[
        'StringEquals'
      ]?.['aws:RequestTag/deployz:installation'],
    ).toBeDefined();

    const acmManageStatement = findBySid('ProvisionerAcmManage');
    expect(acmManageStatement).toBeDefined();
    expect(
      (acmManageStatement?.['Condition'] as Record<string, Record<string, unknown>>)?.[
        'StringEquals'
      ]?.['aws:ResourceTag/deployz:installation'],
    ).toBeDefined();

    const domainIngressDescribeStatement = findBySid('ProvisionerDomainIngressDescribe');
    expect(domainIngressDescribeStatement).toBeDefined();
    expect(domainIngressDescribeStatement?.['Condition']).toBeUndefined();

    const domainIngressWriteStatement = findBySid('ProvisionerDomainIngressWrite');
    expect(domainIngressWriteStatement).toBeDefined();
    expect(
      (domainIngressWriteStatement?.['Condition'] as Record<string, Record<string, unknown>>)?.[
        'StringEquals'
      ]?.['aws:ResourceTag/deployz:installation'],
    ).toBeDefined();

    // AddTags: the relay creates the 443 listener itself, so — unlike every
    // other domain-ingress write — the resource carries no tag yet the FIRST
    // time this runs. A resource-tag condition could never match an
    // untagged listener (that was the production defect), so this is
    // request-tag-conditioned instead, like acm:RequestCertificate /
    // elasticache:AddTagsToResource.
    expect(actions).toContain('elasticloadbalancing:AddTags');
    const domainIngressTagStatement = findBySid('ProvisionerDomainIngressTag');
    expect(domainIngressTagStatement).toBeDefined();
    expect(collectActions([domainIngressTagStatement])).toEqual(['elasticloadbalancing:AddTags']);
    expect(
      (domainIngressTagStatement?.['Condition'] as Record<string, Record<string, unknown>>)?.[
        'StringEquals'
      ]?.['aws:RequestTag/deployz:installation'],
    ).toBeDefined();
    expect(
      (domainIngressTagStatement?.['Condition'] as Record<string, Record<string, unknown>>)?.[
        'ForAllValues:StringEquals'
      ]?.['aws:TagKeys'],
    ).toEqual(['deployz:installation']);
  });

  it('grants the ELB lookups the domain executor makes unconditionally', () => {
    const { stack } = synth();
    const statements = stack.provisionerPolicy.document.toJSON()[
      'Statement'
    ] as Array<Record<string, unknown>>;

    const findBySid = (sid: string) => statements.find((s) => s['Sid'] === sid);
    const actionsOf = (sid: string) => collectActions([findBySid(sid)]);

    // `findTaggedLoadBalancer` calls DescribeLoadBalancers with no ARN filter
    // and `describeTargetGroups` filters by load balancer, so neither request
    // carries a resource whose tags IAM can read. A resource-tag condition can
    // therefore never match, and the grant has to be condition-free — the same
    // exception the other ELB Describe* actions already take.
    expect(actionsOf('ProvisionerDomainIngressDescribe')).toContain(
      'elasticloadbalancing:DescribeLoadBalancers',
    );
    expect(actionsOf('ProvisionerDomainIngressDescribe')).toContain(
      'elasticloadbalancing:DescribeTargetGroups',
    );
    expect(actionsOf('ProvisionerAppResourceManage')).not.toContain(
      'elasticloadbalancing:DescribeLoadBalancers',
    );
    expect(actionsOf('ProvisionerAppResourceManage')).not.toContain(
      'elasticloadbalancing:DescribeTargetGroups',
    );
  });

  it('grants the relay least-privilege ElastiCache permissions (Redis MVP)', () => {
    const { stack } = synth();
    const actions = collectActions(stack.provisionerPolicy.document.toJSON()['Statement']);

    expect(actions).toContain('elasticache:CreateCacheCluster');
    expect(actions).toContain('elasticache:DeleteCacheCluster');
    expect(actions).toContain('elasticache:DescribeCacheClusters');
    expect(actions).toContain('elasticache:ModifyCacheCluster');
    expect(actions).toContain('elasticache:DeleteReplicationGroup');
    expect(actions).toContain('elasticache:DescribeReplicationGroups');
    expect(actions).toContain('elasticache:CreateCacheSubnetGroup');
    expect(actions).toContain('elasticache:DeleteCacheSubnetGroup');
    expect(actions).toContain('elasticache:DescribeCacheSubnetGroups');
    expect(actions).toContain('elasticache:AddTagsToResource');
    expect(actions).toContain('elasticache:ListTagsForResource');

    // No wildcard ElastiCache grant.
    expect(actions).not.toContain('elasticache:*');

    // Statement structure mirrors the ACM/domain-ingress precedent:
    // Create is request-tag-conditioned (brand-new resource, no tag yet),
    // Delete/Modify is resource-tag-conditioned (resource already
    // carries the installation tag), and Describe is condition-free because
    // ElastiCache Describe* calls don't support resource-level
    // permissions/conditions.
    //
    // elasticache:AddTagsToResource sits in the CREATE bucket, not manage:
    // a resource-tag condition can never authorize the FIRST call that tags
    // a brand-new, untagged cache (same reasoning bootstrap-stack.ts applies
    // to acm:AddTagsToCertificate, which rides with acm:RequestCertificate
    // rather than the ACM manage/delete bucket).
    const statements = stack.provisionerPolicy.document.toJSON()[
      'Statement'
    ] as Array<Record<string, unknown>>;
    const findBySid = (sid: string) => statements.find((s) => s['Sid'] === sid);
    const sortedActions = (statement: Record<string, unknown> | undefined): string[] =>
      [...((statement?.['Action'] as string[] | undefined) ?? [])].sort();

    const cacheCreateStatement = findBySid('ProvisionerCacheCreate');
    expect(cacheCreateStatement).toBeDefined();
    expect(sortedActions(cacheCreateStatement)).toEqual(
      [
        'elasticache:AddTagsToResource',
        'elasticache:CreateCacheCluster',
        'elasticache:CreateCacheSubnetGroup',
      ].sort(),
    );
    expect(
      (cacheCreateStatement?.['Condition'] as Record<string, Record<string, unknown>>)?.[
        'StringEquals'
      ]?.['aws:RequestTag/deployz:installation'],
    ).toBeDefined();

    const cacheManageStatement = findBySid('ProvisionerCacheManage');
    expect(cacheManageStatement).toBeDefined();
    expect(sortedActions(cacheManageStatement)).toEqual(
      [
        'elasticache:DeleteCacheCluster',
        'elasticache:ModifyCacheCluster',
        'elasticache:DeleteReplicationGroup',
        'elasticache:DeleteCacheSubnetGroup',
      ].sort(),
    );
    // AddTagsToResource is explicitly NOT in the manage bucket.
    expect(cacheManageStatement?.['Action']).not.toContain('elasticache:AddTagsToResource');
    expect(
      (cacheManageStatement?.['Condition'] as Record<string, Record<string, unknown>>)?.[
        'StringEquals'
      ]?.['aws:ResourceTag/deployz:installation'],
    ).toBeDefined();

    const cacheDescribeStatement = findBySid('ProvisionerCacheDescribe');
    expect(cacheDescribeStatement).toBeDefined();
    expect(sortedActions(cacheDescribeStatement)).toEqual(
      [
        'elasticache:DescribeCacheClusters',
        'elasticache:DescribeReplicationGroups',
        'elasticache:DescribeCacheSubnetGroups',
        // PURGE reads the tags of every replication group in the region, so a
        // sibling installation's group must not deny the read.
        'elasticache:ListTagsForResource',
      ].sort(),
    );
    expect(cacheDescribeStatement?.['Condition']).toBeUndefined();

    // Every ElastiCache action granted must also be within the permissions
    // boundary (the ceiling).
    const boundaryActions = collectActions(
      stack.permissionsBoundary.document.toJSON()['Statement'],
    );
    for (const action of actions.filter((a) => a.startsWith('elasticache:'))) {
      expect(boundaryActions).toContain(action);
    }
  });

  it('DENIES log read (§16: no logs:GetLogEvents / logs:FilterLogEvents)', () => {
    const { stack, template } = synth();

    // The relay role's own phase-1 grants ...
    const relay = relayRoleActions(template);
    // ... the permissions boundary (the ceiling) ...
    const boundary = collectActions(
      stack.permissionsBoundary.document.toJSON()['Statement'],
    );
    // ... and the phase-2 provisioner policy.
    const provisioner = collectActions(
      stack.provisionerPolicy.document.toJSON()['Statement'],
    );

    for (const actions of [relay, boundary, provisioner]) {
      expect(actions).not.toContain('logs:GetLogEvents');
      expect(actions).not.toContain('logs:FilterLogEvents');
    }

    // Strongest form: NO IAM policy anywhere in the bootstrap template grants
    // log read — the §16 data boundary is enforced at IAM across the stack.
    const all = allIamActions(template);
    expect(all).not.toContain('logs:GetLogEvents');
    expect(all).not.toContain('logs:FilterLogEvents');
  });

  it('grants the relay ecs:RunTask for the deploy-time migration one-off', () => {
    const { stack } = synth();
    const statements = stack.provisionerPolicy.document.toJSON()[
      'Statement'
    ] as Array<Record<string, unknown>>;

    const run = statements.find((s) => collectActions([s]).includes('ecs:RunTask'));
    expect(run).toBeDefined();
    // RunTask is evaluated against the task definition AND further untagged
    // resource ARNs in some configurations, so no tag condition could
    // reliably match. The ecs:cluster condition limits it to this
    // installation's cluster instead.
    expect(Object.keys(run?.['Condition'] as Record<string, unknown>)).toEqual(['ArnLike']);

    // The permissions boundary (the ceiling) covers it too.
    const boundary = collectActions(stack.permissionsBoundary.document.toJSON()['Statement']);
    expect(boundary).toContain('ecs:RunTask');
  });

  it('grants the relay tag-scoped read/write of the application config secret for CONFIG_UPDATE (DEPLOY-012)', () => {
    const { stack } = synth();
    const statements = stack.provisionerPolicy.document.toJSON()['Statement'] as Array<Record<string, unknown>>;
    const grant = statements.find((s) => s['Sid'] === 'RelayInstallationSecrets');
    expect(collectActions([grant]).sort()).toEqual([
      'secretsmanager:DeleteSecret',
      'secretsmanager:GetSecretValue',
      'secretsmanager:PutSecretValue',
    ]);
    expect(
      (grant?.['Condition'] as Record<string, Record<string, unknown>>)?.['StringEquals']?.['aws:ResourceTag/deployz:installation'],
    ).toBeDefined();
    // The boundary caps the role: the same grant must be there too (without its Sid).
    const boundary = stack.permissionsBoundary.document.toJSON()['Statement'] as Array<Record<string, unknown>>;
    expect(
      boundary.some((s) => collectActions([s]).includes('secretsmanager:PutSecretValue') && s['Condition'] !== undefined),
    ).toBe(true);
  });

  it('grants the relay the Phase 9 purge discovery reads and tag-scoped retained-credential deletion', () => {
    const { stack } = synth();
    const statements = [stack.provisionerPolicy, stack.provisionerPurgePolicy].flatMap(
      (policy) => policy.document.toJSON()['Statement'] as Array<Record<string, unknown>>,
    );
    const findBySid = (sid: string) => statements.find((s) => s['Sid'] === sid);
    const actionsOf = (sid: string) => collectActions([findBySid(sid)]);

    // RDS orphan discovery is condition-free (DescribeDBInstances has no
    // resource-level permissions; ListTagsForResource does not evaluate tag
    // conditions) — the purge code verifies ownership from the tags itself.
    const rdsDiscover = findBySid('RelayPurgeRdsDiscover');
    expect(actionsOf('RelayPurgeRdsDiscover')).toEqual([
      'rds:DescribeDBInstances',
      'rds:ListTagsForResource',
    ]);
    expect(rdsDiscover?.['Condition']).toBeUndefined();

    // Secrets: ListSecrets + DescribeSecret are condition-free discovery
    // reads (a tag condition on DescribeSecret would deny the ownership check
    // for every foreign secret in the account); the destructive delete is
    // scoped to the retained DB-credential secrets that already carry the
    // installation tag.
    const secretsList = findBySid('RelayPurgeSecretsList');
    expect(actionsOf('RelayPurgeSecretsList')).toEqual([
      'secretsmanager:ListSecrets',
      'secretsmanager:DescribeSecret',
    ]);
    expect(secretsList?.['Condition']).toBeUndefined();

    const secretsDelete = findBySid('RelayInstallationSecrets');
    expect(actionsOf('RelayInstallationSecrets')).toContain('secretsmanager:DeleteSecret');
    expect(
      (secretsDelete?.['Condition'] as Record<string, Record<string, unknown>>)?.[
        'StringEquals'
      ]?.['aws:ResourceTag/deployz:installation'],
    ).toBeDefined();

    // Phase 11 ACM orphan sweep: condition-free list (ACM certs cannot be
    // tag-scoped at list time; ownership is verified from the returned tags),
    // deletion already covered by the tag-scoped ProvisionerAcmManage grant.
    expect(findBySid('RelayPurgeAcmDiscover')).toBeDefined();
    // Both reads condition-free: a tag-scoped ListTagsForCertificate is denied
    // on every certificate that is not ours, and the sweep (rightly) refuses
    // to treat a denied tag read as "not ours" — so it never completed.
    expect(actionsOf('RelayPurgeAcmDiscover').sort()).toEqual(
      ['acm:ListCertificates', 'acm:ListTagsForCertificate'].sort(),
    );
    expect(findBySid('RelayPurgeAcmDiscover')?.['Condition']).toBeUndefined();

    // The same grants sit inside the permissions boundary (the ceiling) —
    // matched by action, since the boundary carries no statement ids.
    const boundary = collectActions(stack.permissionsBoundary.document.toJSON()['Statement']);
    for (const sid of [
      'RelayPurgeRdsDiscover',
      'RelayPurgeSecretsList',
      'RelayPurgeSecretsDelete',
      'RelayPurgeAcmDiscover',
    ]) {
      for (const action of actionsOf(sid)) expect(boundary).toContain(action);
    }
  });

  it('carries the RelayCredential NoEcho parameter (DZ-AUDIT-013) alongside the existing public params', () => {
    const { template } = synth();
    const json = template.toJSON();
    const params = (json['Parameters'] ?? {}) as Record<string, Record<string, unknown>>;

    // CDK synthesizes a synthetic BootstrapVersion parameter (not a secret).
    const names = Object.keys(params);
    expect(names).toContain('BootstrapVersion');
    const appParams = Object.fromEntries(
      Object.entries(params).filter(([name]) => name !== 'BootstrapVersion'),
    );

    // RelayCredential is the one NoEcho parameter — allowing it is the
    // DZ-AUDIT-013 change; the rest stay non-secret.
    for (const [name, param] of Object.entries(appParams)) {
      if (name === 'RelayCredential') {
        expect(param['NoEcho'], 'RelayCredential must be NoEcho').toBe(true);
        expect(param['Type']).toBe('String');
        expect(param['Default']).toBe('');
      } else {
        expect(param['NoEcho'], `parameter ${name} must not be NoEcho`).not.toBe(true);
        expect(['ControlPlaneUrl', 'EnrollmentCode']).toContain(name);
      }
    }
    expect(Object.keys(appParams).sort()).toEqual([
      'ControlPlaneUrl',
      'EnrollmentCode',
      'RelayCredential',
    ]);
  });

  it('publishes plain stack outputs with no Export blocks', () => {
    const { template } = synth();
    const outputs = (template.toJSON()['Outputs'] ?? {}) as Record<
      string,
      Record<string, unknown>
    >;

    // The template is synthesized once and deployed many times per account:
    // a fixed export name would collide across deployments and roll the
    // second stack back. Plain outputs keep the DescribeStacks handshake.
    for (const [name, output] of Object.entries(outputs)) {
      expect(output['Export'], `output ${name} must not be an export`).toBeUndefined();
    }
    expect(Object.keys(outputs)).toEqual(
      expect.arrayContaining([
        'RelayFunctionArn',
        'CredentialSecretArn',
        'ProvisionerPolicyArn',
        'InstallationId',
        'ApplicationExecutionRoleArn',
      ]),
    );
  });

  it('tells the relay its own deployed bootstrap stack name', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          // Ref AWS::StackName — the DEPLOYED name, not a synth-time literal.
          DEPLOYZ_BOOTSTRAP_STACK_NAME: { Ref: 'AWS::StackName' },
        }),
      }),
    });
  });

  it('lets the relay read its own application stack', () => {
    const template = Template.fromStack(new BootstrapStack(new App(), 'TestStack'));

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'RelayVerifyInstallation',
            Effect: 'Allow',
            Action: [
              'cloudformation:DescribeStacks',
              'cloudformation:DescribeStackResources',
              'cloudformation:ListStackResources',
            ],
          }),
        ]),
      },
    });
  });

  it('matches the committed snapshot', () => {
    const { template } = synth();
    expect(withStableAssetHashes(template.toJSON())).toMatchSnapshot();
  });
});

it('creates two mutually exclusive credential secrets with conditions (DZ-AUDIT-013)', () => {
    const { template } = synth();
    const resources = allResources(template);

    const secrets = Object.entries(resources).filter(
      ([, r]) => r.Type === 'AWS::SecretsManager::Secret',
    );

    // Two CfnSecrets: one from parameter (HasRelayCredential), one generated (NoRelayCredential).
    expect(secrets).toHaveLength(2);

    for (const [, resource] of secrets) {
      expect(resource.Properties?.['Tags']).toEqual(
        expect.arrayContaining([{ Key: 'deployz:component', Value: 'bootstrap' }]),
      );
      if (resource.Properties?.['SecretString'] !== undefined) {
        expect(resource.Properties!['GenerateSecretString']).toBeUndefined();
      } else {
        expect(resource.Properties!['GenerateSecretString']).toBeDefined();
      }
    }

    // Conditions present in the Conditions section.
    const json = template.toJSON();
    const conditions = json['Conditions'] as Record<string, unknown> | undefined;
    expect(conditions).toBeDefined();
    expect(conditions!['HasRelayCredential']).toBeDefined();
    expect(conditions!['NoRelayCredential']).toBeDefined();
  });

  it('the credential secret ARN in the relay Lambda env uses Fn::If (DZ-AUDIT-013)', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          DEPLOYZ_CREDENTIAL_SECRET_ARN: { 'Fn::If': Match.anyValue() },
        }),
      },
    });
  });

  it('the CredentialSecretArn output uses Fn::If (DZ-AUDIT-013)', () => {
    const { template } = synth();
    const outputs = (template.toJSON()['Outputs'] ?? {}) as Record<string, Record<string, unknown>>;
    const credOutput = outputs['CredentialSecretArn'];
    expect(credOutput).toBeDefined();
    const value = credOutput!['Value'] as Record<string, unknown>;
    expect(value).toBeDefined();
    expect(value['Fn::If']).toBeDefined();
  });

  it('creates the HasRelayCredential and NoRelayCredential conditions (DZ-AUDIT-013)', () => {
    const { template } = synth();
    const json = template.toJSON();
    const conditions = json['Conditions'] as Record<string, unknown>;
    expect(conditions).toBeDefined();
    expect(conditions!['HasRelayCredential']).toBeDefined();
    expect(conditions!['NoRelayCredential']).toBeDefined();
  });

// ── Provisioning the application stack ──────────────────────────────────────
//
// Everything below exists because the relay's INSTALL executor calls
// `CreateStack`, and nothing in this stack previously let it. The
// provisioner policy was defined and attached to no principal, and its
// `iam:PassRole` pointed at `role/deployz/*`, where no role existed.

describe('BootstrapStack — application provisioning', () => {
  /** Statements of every inline policy attached to `role`. */
  function inlinePolicyStatements(
    template: Template,
    roleLogicalId: string,
  ): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const resource of Object.values(allResources(template))) {
      if (resource.Type !== 'AWS::IAM::Policy') continue;
      const roles = (resource.Properties?.['Roles'] as Array<{ Ref?: string }>) ?? [];
      if (!roles.some((r) => r?.['Ref'] === roleLogicalId)) continue;
      out.push(
        ...(((resource.Properties?.['PolicyDocument'] as Record<string, unknown>)?.[
          'Statement'
        ] as Array<Record<string, unknown>>) ?? []),
      );
    }
    return out;
  }

  function findRole(
    template: Template,
    predicate: (resource: TemplateResource) => boolean,
  ): { logicalId: string; resource: TemplateResource } {
    for (const [logicalId, resource] of Object.entries(allResources(template))) {
      if (resource.Type === 'AWS::IAM::Role' && predicate(resource)) {
        return { logicalId, resource };
      }
    }
    throw new Error('No matching IAM role in the template');
  }

  const executionRole = (template: Template) =>
    findRole(template, (r) => r.Properties?.['Path'] === '/deployz/');

  const relayRole = (template: Template) =>
    findRole(template, (r) => Boolean(r.Properties?.['PermissionsBoundary']));

  it('attaches the provisioner policy to the relay role', () => {
    const { template } = synth();
    const { resource } = relayRole(template);

    // Nothing can attach this later: the control plane holds no credentials
    // in the customer's account (§15), so a policy left unattached here is
    // one the relay never gets. Without it `cloudformation:CreateStack` is
    // denied and every install fails.
    expect(resource.Properties?.['ManagedPolicyArns']).toBeDefined();
  });

  it('creates a CloudFormation execution role where iam:PassRole can find it', () => {
    const { template } = synth();
    const { resource } = executionRole(template);

    // The relay's existing PassRole is scoped to `arn:aws:iam::*:role/deployz/*`,
    // which only matches a role created at this path.
    expect(resource.Properties?.['Path']).toBe('/deployz/');
  });

  it('lets only CloudFormation assume the execution role, and only for this account', () => {
    const { template } = synth();
    const { resource } = executionRole(template);
    const trust = JSON.stringify(resource.Properties?.['AssumeRolePolicyDocument']);

    expect(trust).toContain('cloudformation.amazonaws.com');
    expect(trust).toContain('aws:SourceAccount');
  });

  it('grants the execution role the services the application stack provisions', () => {
    const { template } = synth();
    const actions = inlinePolicyStatements(template, executionRole(template).logicalId).flatMap(
      (s) => collectActions([s]),
    );

    for (const action of [
      'ec2:CreateVpc',
      // AWS::EC2::VPCCidrBlock (the database-only subnets' secondary CIDR):
      // without it every database install rolled back (real AWS, 2026-10-02).
      'ec2:AssociateVpcCidrBlock',
      'ec2:DisassociateVpcCidrBlock',
      'ec2:CreateNatGateway',
      'ec2:CreateSecurityGroup',
      'ecs:CreateCluster',
      'ecs:CreateService',
      'ecs:RegisterTaskDefinition',
      'rds:CreateDBInstance',
      'rds:CreateDBSubnetGroup',
      'elasticloadbalancing:CreateLoadBalancer',
      'elasticloadbalancing:CreateTargetGroup',
      'elasticloadbalancing:CreateListener',
      's3:CreateBucket',
      'secretsmanager:CreateSecret',
      'logs:CreateLogGroup',
      'iam:CreateRole',
      'elasticache:CreateReplicationGroup',
      'cloudwatch:PutMetricAlarm',
    ]) {
      expect(actions).toContain(action);
    }
  });

  it('grants the execution role replication-group lifecycle actions on its own tagged cache only', () => {
    const { template } = synth();
    const statements = inlinePolicyStatements(template, executionRole(template).logicalId);
    const grantingWithout = (action: string, condition?: string) =>
      statements.filter(
        (s) =>
          collectActions([s]).includes(action) &&
          (condition === undefined
            ? s['Condition'] === undefined
            : (s['Condition'] as Record<string, unknown> | undefined)?.[condition] !== undefined),
      );

    // Live-proven multi-resource auth trap (see PROVISION_CACHE_COMPANION_ACTIONS):
    // CreateReplicationGroup is also evaluated against the untagged default
    // parameter group. The replication group itself stays tag-scoped; only
    // the parameter group and the member cache nodes are granted without a
    // tag condition.
    const companions = statements.find((s) => s['Sid'] === 'ProvisionApplicationCacheCompanions');
    expect(JSON.stringify(companions?.['Resource'])).toContain(':parametergroup:*');
    expect(JSON.stringify(companions?.['Resource'])).toContain(':cluster:*');
    expect(JSON.stringify(companions?.['Resource'])).not.toContain(':replicationgroup:');
    for (const action of [
      'elasticache:CreateReplicationGroup',
      'elasticache:ModifyReplicationGroup',
      'elasticache:DeleteReplicationGroup',
    ]) {
      expect(collectActions([companions])).toContain(action);
      expect(grantingWithout(action, 'StringEquals').length, action).toBeGreaterThan(0);
    }
    expect(grantingWithout('elasticache:DeleteCacheCluster')).toHaveLength(0);
  });

  it('never grants the execution role a service wildcard', () => {
    const { template } = synth();
    const actions = inlinePolicyStatements(template, executionRole(template).logicalId).flatMap(
      (s) => collectActions([s]),
    );

    for (const action of actions) {
      expect(action).not.toBe('*');
      expect(action.endsWith(':*')).toBe(false);
    }
  });

  it('scopes the execution role creates to this installation tag', () => {
    const { template } = synth();
    const statements = inlinePolicyStatements(template, executionRole(template).logicalId);

    const creating = statements.find((s) =>
      collectActions([s]).includes('rds:CreateDBInstance'),
    );
    const condition = JSON.stringify(creating?.['Condition']);

    expect(condition).toContain('aws:RequestTag/deployz:installation');
  });

  it('scopes the execution role deletes to resources already carrying the tag', () => {
    const { template } = synth();
    const statements = inlinePolicyStatements(template, executionRole(template).logicalId);

    const deleting = statements.find((s) =>
      collectActions([s]).includes('rds:DeleteDBInstance'),
    );
    const condition = JSON.stringify(deleting?.['Condition']);

    expect(condition).toContain('aws:ResourceTag/deployz:installation');
  });

  it('scopes the execution role alarm creation to this installation tag', () => {
    const { template } = synth();
    const statements = inlinePolicyStatements(template, executionRole(template).logicalId);

    const creating = statements.find((s) =>
      collectActions([s]).includes('cloudwatch:PutMetricAlarm'),
    );
    const condition = JSON.stringify(creating?.['Condition']);

    expect(condition).toContain('aws:RequestTag/deployz:installation');
  });

  it('scopes the execution role alarm deletes to resources already carrying the tag', () => {
    const { template } = synth();
    const statements = inlinePolicyStatements(template, executionRole(template).logicalId);

    const deleting = statements.find((s) =>
      collectActions([s]).includes('cloudwatch:DeleteAlarms'),
    );
    const condition = JSON.stringify(deleting?.['Condition']);

    expect(condition).toContain('aws:ResourceTag/deployz:installation');
  });

  it('restricts what the execution role may pass a role to', () => {
    const { template } = synth();
    const statements = inlinePolicyStatements(template, executionRole(template).logicalId);

    const passRole = statements.find((s) => collectActions([s]).includes('iam:PassRole'));
    const condition = JSON.stringify(passRole?.['Condition']);

    expect(condition).toContain('iam:PassedToService');
    expect(condition).toContain('ecs-tasks.amazonaws.com');
    // Phase 5: the execution role may pass the scheduler execution role to
    // Scheduler when it creates an AWS::Scheduler::Schedule.
    expect(condition).toContain('scheduler.amazonaws.com');
  });

  it('never lets the relay role itself pass a role to Scheduler (Phase 5)', () => {
    // The relay registers task definitions, never schedules — its own
    // PassRole grant stays ECS-only, unlike the application execution
    // role's (see above).
    const { stack } = synth();
    const boundary = stack.permissionsBoundary.document.toJSON()['Statement'] as Record<string, unknown>[];
    const boundaryPassRole = boundary.find((s) => collectActions([s]).includes('iam:PassRole'));
    expect(boundaryPassRole).toBeDefined();
    expect(JSON.stringify(boundaryPassRole?.['Condition'] ?? '')).not.toContain('scheduler.amazonaws.com');

    const provisioner = stack.provisionerPolicy.document.toJSON()['Statement'] as Record<string, unknown>[];
    const provisionerPassRole = provisioner.find((s) => collectActions([s]).includes('iam:PassRole'));
    expect(provisionerPassRole).toBeDefined();
    expect(JSON.stringify(provisionerPassRole?.['Condition'] ?? '')).not.toContain('scheduler.amazonaws.com');
  });

  it('grants queue and schedule lifecycle actions, resource-ARN scoped (Phase 5)', () => {
    const { template } = synth();
    const statements = inlinePolicyStatements(template, executionRole(template).logicalId);

    const sqs = statements.find((s) => collectActions([s]).includes('sqs:CreateQueue'));
    expect(sqs).toBeDefined();
    for (const action of [
      'sqs:CreateQueue',
      'sqs:GetQueueAttributes',
      'sqs:SetQueueAttributes',
      'sqs:DeleteQueue',
      'sqs:TagQueue',
      'sqs:UntagQueue',
      'sqs:ListQueueTags',
      'sqs:GetQueueUrl',
    ]) {
      expect(collectActions([sqs!])).toContain(action);
    }
    expect(JSON.stringify(sqs?.['Resource'])).toContain(':deployz-app-",{"Fn::Select":[0,{"Fn::Split":["-"');
    expect(sqs?.['Condition']).toBeUndefined();

    const scheduler = statements.find((s) => collectActions([s]).includes('scheduler:CreateSchedule'));
    expect(scheduler).toBeDefined();
    for (const action of [
      'scheduler:CreateSchedule',
      'scheduler:GetSchedule',
      'scheduler:UpdateSchedule',
      'scheduler:DeleteSchedule',
    ]) {
      expect(collectActions([scheduler!])).toContain(action);
    }
    expect(JSON.stringify(scheduler?.['Resource'])).toContain('schedule/default/deployz-app-",{"Fn::Select"');
    expect(scheduler?.['Condition']).toBeUndefined();
  });

  it('the relay role itself is granted no sqs:/scheduler: actions (Phase 5)', () => {
    const { stack, template } = synth();
    const relayRole = findRole(template, (r) => Boolean(r.Properties?.['PermissionsBoundary']));
    const statements = inlinePolicyStatements(template, relayRole.logicalId);
    const relayActions = [
      ...collectActions(statements),
      ...collectActions(stack.provisionerPolicy.document.toJSON()['Statement']),
      ...collectActions(stack.permissionsBoundary.document.toJSON()['Statement']),
    ];
    expect(relayActions.some((a) => a.startsWith('sqs:'))).toBe(false);
    expect(relayActions.some((a) => a.startsWith('scheduler:'))).toBe(false);
  });

  it('restricts which service-linked roles the execution role may create', () => {
    const { template } = synth();
    const statements = inlinePolicyStatements(template, executionRole(template).logicalId);

    const slr = statements.find((s) =>
      collectActions([s]).includes('iam:CreateServiceLinkedRole'),
    );
    const condition = JSON.stringify(slr?.['Condition']);

    expect(condition).toContain('iam:AWSServiceName');
  });

  it('tells the relay which execution role to use', () => {
    const { template } = synth();

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          DEPLOYZ_APPLICATION_EXECUTION_ROLE_ARN: Match.anyValue(),
        }),
      }),
    });
  });

  // A role the execution role creates is a separate principal: without these
  // conditions a template could create a tagged role with any policy and
  // pass it to ECS — account administrator in one step.
  describe('roles the application stack creates', () => {
    function statementGranting(template: Template, action: string): Record<string, unknown> {
      const granting = inlinePolicyStatements(template, executionRole(template).logicalId).filter(
        (s) => collectActions([s]).includes(action),
      );
      expect(granting, action).toHaveLength(1);
      return granting[0]!;
    }

    function boundaryRef(stack: BootstrapStack): unknown {
      return stack.resolve(stack.applicationRoleBoundary.managedPolicyArn);
    }

    it('requires the application role boundary to create a role or grant it a policy', () => {
      const { stack, template } = synth();
      for (const action of ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy']) {
        const statement = statementGranting(template, action);
        const conditions = statement['Condition'] as Record<string, Record<string, unknown>>;
        expect(conditions['StringEquals']?.['iam:PermissionsBoundary'], action).toEqual(boundaryRef(stack));
        expect(JSON.stringify(statement['Resource']), action).toContain(':role/deployz/deployz-app-",{"Fn::Select"');
      }
    });

    it('attaches only the ECS task-execution managed policy', () => {
      const { template } = synth();
      const statement = statementGranting(template, 'iam:AttachRolePolicy');
      expect((statement['Condition'] as Record<string, unknown>)['ArnEquals']).toEqual({
        'iam:PolicyARN': 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
      });
    });

    it('passes only the application roles', () => {
      const { template } = synth();
      expect(JSON.stringify(statementGranting(template, 'iam:PassRole')['Resource'])).toContain(
        ':role/deployz/deployz-app-",{"Fn::Select"',
      );
    });

    it('reaches only the application buckets', () => {
      const { template } = synth();
      expect(JSON.stringify(statementGranting(template, 's3:PutBucketPolicy')['Resource'])).toContain(
        'arn:aws:s3:::deployz-app-",{"Fn::Select"',
      );
    });

    it('caps application roles without any IAM management, under the size quota', () => {
      const { stack } = synth();
      const document = stack.applicationRoleBoundary.document.toJSON() as { Statement: unknown[] };
      const iamActions = collectActions(document['Statement']).filter((a) => a.startsWith('iam:'));
      expect(iamActions).toEqual(['iam:PassRole']);
      expect(collectActions(document['Statement'])).not.toContain('*');
      expect(JSON.stringify(stack.resolve(document)).replace(/\s/g, '').length).toBeLessThan(
        IAM_MANAGED_POLICY_MAX_CHARS,
      );
    });

    it('tells the relay which boundary to pass', () => {
      const { stack, template } = synth();
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: Match.objectLike({
          Variables: Match.objectLike({ DEPLOYZ_APPLICATION_ROLE_BOUNDARY_ARN: boundaryRef(stack) }),
        }),
      });
    });
  });

  it('lets the relay remember a command it has not finished', () => {
    const { template } = synth();
    const actions = relayRoleActions(template);

    // The relay defers an INSTALL whose stack outlives the invocation and
    // picks it up on the next poll. Without somewhere durable to write that
    // down, the job sits in RUNNING forever.
    expect(actions).toContain('ssm:PutParameter');
    expect(actions).toContain('ssm:GetParameter');
    expect(actions).toContain('ssm:DeleteParameter');
  });

  it('scopes the relay pending-command parameter to its own installation', () => {
    const { template } = synth();
    const { logicalId } = relayRole(template);
    const statements = inlinePolicyStatements(template, logicalId);

    const ssm = statements.find((s) => collectActions([s]).includes('ssm:PutParameter'));
    expect(JSON.stringify(ssm?.['Resource'])).toContain('parameter/deployz/');
  });

  it('keeps the permissions boundary above everything the relay is granted', () => {
    const { stack, template } = synth();
    const boundary = collectActions(stack.permissionsBoundary.document.toJSON()['Statement']);

    for (const action of relayRoleActions(template)) {
      expect(boundary).toContain(action);
    }
    for (const action of collectActions(stack.provisionerPolicy.document.toJSON()['Statement'])) {
      expect(boundary).toContain(action);
    }
  });

  // IAM refuses a managed policy over 6,144 non-whitespace characters, and
  // CloudFormation reports it as a failed CreateStack for every new install
  // ("Cannot exceed quota for PolicySize") — seen live once the purge sweeps
  // pushed the boundary to 6,350. IAM measures the document after
  // CloudFormation resolves its intrinsics, so each policy is measured as
  // synthesized and as resolved to the longest values each intrinsic can
  // take, for both credential branches.
  it('keeps both managed policies under the IAM policy-size quota', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::ManagedPolicy');
    expect(Object.keys(policies).length).toBeGreaterThanOrEqual(2);
    for (const [logicalId, resource] of Object.entries(policies)) {
      const document = resource['Properties']?.['PolicyDocument'];
      const documents = [
        document,
        resolveIntrinsics(document, { hasRelayCredential: true, ...WORST_CASE_ENV }),
        resolveIntrinsics(document, { hasRelayCredential: false, ...WORST_CASE_ENV }),
      ];
      for (const json of documents.map((d) => JSON.stringify(d))) {
        const size = json.replace(/\s/g, '').length;
        expect(size, `${logicalId} policy document is ${size} chars`).toBeLessThan(IAM_MANAGED_POLICY_MAX_CHARS);
      }
    }
  });

  it('carries the same grants in the boundary as in the provisioner policy, without statement ids', () => {
    const { stack } = synth();
    const boundaryStatements = stack.permissionsBoundary.document.toJSON()['Statement'] as Record<string, unknown>[];
    expect(boundaryStatements.every((s) => s['Sid'] === undefined)).toBe(true);
    const provisionerStatements = stack.provisionerPolicy.document.toJSON()['Statement'] as Record<string, unknown>[];
    expect(provisionerStatements.every((s) => typeof s['Sid'] === 'string')).toBe(true);
    expect(collectActions(boundaryStatements)).toEqual(
      expect.arrayContaining(collectActions(provisionerStatements)),
    );
  });
});

describe('BootstrapStack — the relay credential secret ARN', () => {
  /**
   * Ref on an AWS::SecretsManager::Secret returns the ARN; the type has no
   * `Arn` attribute. A Fn::GetAtt makes CloudFormation reject the whole
   * template — "Requested attribute Arn does not exist in schema for
   * AWS::SecretsManager::Secret" — so the first stack a customer deploys
   * fails and no install can succeed (found on real AWS, 2026-09-10).
   */
  it('never reads an Arn attribute off a SecretsManager secret', () => {
    const { template } = synth();
    const secretIds = Object.entries(template.toJSON().Resources as Record<string, { Type: string }>)
      .filter(([, resource]) => resource.Type === 'AWS::SecretsManager::Secret')
      .map(([logicalId]) => logicalId);
    expect(secretIds.length).toBeGreaterThan(0);

    const badAttributes: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'Fn::GetAtt' && Array.isArray(value) && secretIds.includes(String(value[0]))) {
          badAttributes.push(`${String(value[0])}.${String(value[1])}`);
        }
        walk(value);
      }
    };
    walk(template.toJSON());
    expect(badAttributes).toEqual([]);
  });

  it('resolves the credential ARN by Ref through the condition', () => {
    const { template } = synth();
    const json = JSON.stringify(template.toJSON());
    expect(json).toContain('"Ref":"RelayCredentialFromParam"');
    expect(json).toContain('"Ref":"RelayCredentialGenerated"');
  });
});

describe('BootstrapStack — the relay credential secret value', () => {
  /**
   * The relay reads this secret as JSON and takes its `token` field
   * (packages/relay/src/auth.ts, readCredential). Both variants must
   * therefore hold `{"token": "..."}`. Storing the server-established
   * parameter bare made every relay poll fail with
   * "relay:credential-read-failed ... Unexpected non-whitespace character
   * after JSON", so the installation never enrolled and the deployment sat
   * in WAITING_FOR_RELAY (found on real AWS, 2026-09-10).
   */
  it('wraps the server-established credential as JSON so the relay can parse it', () => {
    const { template } = synth();
    const secret = (template.toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, unknown> }>)[
      'RelayCredentialFromParam'
    ];
    expect(secret?.Type).toBe('AWS::SecretsManager::Secret');

    const secretString = secret?.Properties?.['SecretString'];
    // Never the bare parameter — that is the shape the relay cannot parse.
    expect(secretString).not.toEqual({ Ref: 'RelayCredential' });

    const parts = (secretString as { 'Fn::Join'?: [string, unknown[]] })['Fn::Join']?.[1];
    expect(parts).toEqual(['{"token":"', { Ref: 'RelayCredential' }, '"}']);
  });

  it('generates the other variant with the same token field', () => {
    const { template } = synth();
    const secret = (template.toJSON().Resources as Record<string, { Properties?: Record<string, unknown> }>)[
      'RelayCredentialGenerated'
    ];
    const generate = secret?.Properties?.['GenerateSecretString'] as Record<string, unknown> | undefined;
    expect(generate?.['GenerateStringKey']).toBe('token');
    expect(generate?.['SecretStringTemplate']).toBe('{}');
  });
});

/** The values each intrinsic in the relay's IAM policies resolves to. */
type IntrinsicEnv = {
  hasRelayCredential: boolean;
  partition: string;
  region: string;
  account: string;
  installationId: string;
};

const TEST_ENV = {
  partition: 'aws',
  region: 'eu-west-1',
  account: '123456789012',
  installationId: '11111111-1111-4111-8111-111111111111',
};

// The longest value each intrinsic can resolve to: `aws-us-gov` is the
// longest partition, 14 characters the longest region name.
const WORST_CASE_ENV = {
  partition: 'aws-us-gov',
  region: 'ap-southeast-4',
  account: '123456789012',
  installationId: '11111111-1111-4111-8111-111111111111',
};

/**
 * The ARN CloudFormation gives an unnamed secret: `<logical id>-<12 chars>`,
 * plus Secrets Manager's `-<6 chars>` suffix (as seen on real AWS:
 * `secret:RelayCredentialFromParam-84TbUNfHetTK-t2AbJ7`).
 */
function generatedSecretArn(logicalId: string, env: Omit<IntrinsicEnv, 'hasRelayCredential'>): string {
  return `arn:${env.partition}:secretsmanager:${env.region}:${env.account}:secret:${logicalId}-AbCdEfGhIjKl-AbCdEf`;
}

/**
 * The ARN CloudFormation gives the connector's execution role: path
 * `/deployz/`, a generated name at IAM's 64-character maximum (the bootstrap
 * stack name is long), unique to the installation.
 */
function executionRoleArn(env: Omit<IntrinsicEnv, 'hasRelayCredential'>, installationId: string): string {
  const name = `deployz-bootstrap-app-${installationId.slice(0, 8)}-ApplicationExecutionRole-AbCdEf`.padEnd(64, 'x');
  return `arn:${env.partition}:iam::${env.account}:role/deployz/${name}`;
}

/** Resolve the intrinsics the relay's IAM policies use; any other intrinsic fails the test. */
function resolveIntrinsics(node: unknown, env: IntrinsicEnv): unknown {
  if (Array.isArray(node)) return node.map((item) => resolveIntrinsics(item, env));
  if (!node || typeof node !== 'object') return node;
  const entries = Object.entries(node as Record<string, unknown>);
  const [key, value] = entries[0] ?? [];
  if (entries.length === 1 && key === 'Fn::If') {
    const [condition, whenTrue, whenFalse] = value as [string, unknown, unknown];
    const conditions: Record<string, boolean> = {
      HasRelayCredential: env.hasRelayCredential,
      NoRelayCredential: !env.hasRelayCredential,
    };
    if (!(condition in conditions)) throw new Error(`Unknown condition ${condition}`);
    return resolveIntrinsics(conditions[condition] ? whenTrue : whenFalse, env);
  }
  if (entries.length === 1 && key === 'Ref') {
    const refs: Record<string, string> = {
      'AWS::Partition': env.partition,
      'AWS::Region': env.region,
      'AWS::AccountId': env.account,
      RelayCredentialFromParam: generatedSecretArn('RelayCredentialFromParam', env),
      RelayCredentialGenerated: generatedSecretArn('RelayCredentialGenerated', env),
    };
    if (String(value).startsWith('ApplicationRoleBoundary')) {
      return `arn:${env.partition}:iam::${env.account}:policy/deployz/deployz-bootstrap-ApplicationRoleBoundary-AbCdEf`;
    }
    if (!(String(value) in refs)) throw new Error(`Unknown Ref ${String(value)}`);
    return refs[String(value)];
  }
  if (entries.length === 1 && key === 'Fn::GetAtt') {
    const [logicalId, attribute] = value as [string, string];
    if (logicalId.startsWith('ApplicationExecutionRole') && attribute === 'Arn') {
      return executionRoleArn(env, env.installationId);
    }
    if (logicalId !== 'InstallationId' || attribute !== 'InstallationId') {
      throw new Error(`Unknown Fn::GetAtt ${logicalId}.${attribute}`);
    }
    return env.installationId;
  }
  if (entries.length === 1 && key === 'Fn::Select') {
    const [index, list] = value as [number, unknown];
    return (resolveIntrinsics(list, env) as unknown[])[index];
  }
  if (entries.length === 1 && key === 'Fn::Split') {
    const [separator, source] = value as [string, unknown];
    return String(resolveIntrinsics(source, env)).split(separator);
  }
  if (entries.length === 1 && key === 'Fn::Join') {
    const [separator, parts] = value as [string, unknown[]];
    return (resolveIntrinsics(parts, env) as unknown[]).join(separator);
  }
  if (key?.startsWith('Fn::')) throw new Error(`Unsupported intrinsic ${key}`);
  return Object.fromEntries(entries.map(([k, v]) => [k, resolveIntrinsics(v, env)]));
}

type Statement = {
  Effect: string;
  Action?: string | string[];
  Resource?: unknown;
  Condition?: Record<string, Record<string, string | string[]>>;
  NotAction?: unknown;
  NotResource?: unknown;
};

/** The secret-value actions: anything that reads or writes a secret's contents. */
const SECRET_VALUE_ACTIONS = [
  'secretsmanager:GetSecretValue',
  'secretsmanager:PutSecretValue',
  'secretsmanager:UpdateSecret',
] as const;

function asList<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function globMatches(pattern: string, value: string, ignoreCase: boolean): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`, ignoreCase ? 'i' : '').test(value);
}

/**
 * IAM condition evaluation for the keys the relay's statements use. An
 * absent key fails every operator except `ForAllValues:*`, which IAM treats
 * as true; an operator this helper does not model fails the test.
 */
function conditionsHold(condition: Statement['Condition'], context: Record<string, string>): boolean {
  for (const [operator, keys] of Object.entries(condition ?? {})) {
    for (const [key, expected] of Object.entries(keys)) {
      const actual = context[key];
      if (actual === undefined) {
        if (operator.startsWith('ForAllValues:') || operator.endsWith('IfExists')) continue;
        return false;
      }
      if (operator === 'StringEquals' || operator === 'StringEqualsIfExists') {
        if (!asList(expected).includes(actual)) return false;
      } else if (operator === 'StringLike' || operator === 'ArnLike') {
        if (!asList(expected).some((pattern) => globMatches(pattern, actual, false))) return false;
      } else if (operator === 'ForAllValues:StringEquals') {
        if (!actual.split(',').every((value) => asList(expected).includes(value))) return false;
      } else {
        throw new Error(`Unsupported condition operator ${operator} on ${key}`);
      }
    }
  }
  return true;
}

function statementAllows(
  statement: Statement,
  action: string,
  resource: string,
  context: Record<string, string>,
): boolean {
  if (statement.NotAction !== undefined || statement.NotResource !== undefined) {
    throw new Error('NotAction/NotResource is not modelled');
  }
  return (
    statement.Effect === 'Allow' &&
    asList(statement.Action).some((pattern) => globMatches(pattern, action, true)) &&
    asList(statement.Resource as string | string[]).some((pattern) => globMatches(pattern, resource, false)) &&
    conditionsHold(statement.Condition, context)
  );
}

/**
 * The relay role's identity statements (its inline policy and the attached
 * provisioner policy) and its permissions boundary, resolved for one
 * credential branch. The template has no Deny statements, so an action is
 * allowed when an identity statement AND a boundary statement allow it.
 */
function relayPolicies(template: Template, env: IntrinsicEnv) {
  const resources = allResources(template);
  const roleId = Object.keys(resources).find(
    (id) => resources[id]?.Type === 'AWS::IAM::Role' && resources[id]?.Properties?.['PermissionsBoundary'],
  )!;
  const roleProps = resources[roleId]!.Properties!;
  expect(roleProps['Policies']).toBeUndefined();
  const documentOf = (id: string) =>
    resolveIntrinsics(resources[id]?.Properties?.['PolicyDocument'], env) as { Statement: Statement[] };

  const boundaryId = (roleProps['PermissionsBoundary'] as { Ref: string }).Ref;
  const managedIds = (roleProps['ManagedPolicyArns'] as Array<{ Ref: string }>).map((ref) => ref.Ref);
  const inlineIds = Object.keys(resources).filter(
    (id) =>
      resources[id]?.Type === 'AWS::IAM::Policy' &&
      ((resources[id]?.Properties?.['Roles'] as Array<{ Ref?: string }>) ?? []).some((r) => r.Ref === roleId),
  );

  const identity = [...managedIds, ...inlineIds].flatMap((id) => documentOf(id).Statement);
  const boundary = documentOf(boundaryId).Statement;
  const allows = (action: string, resource: string, context: Record<string, string> = {}) =>
    identity.some((s) => statementAllows(s, action, resource, context)) &&
    boundary.some((s) => statementAllows(s, action, resource, context));
  return { identity, boundary, allows };
}

describe('BootstrapStack — the relay credential grant scope', () => {
  const OWN_TAG = { 'aws:ResourceTag/deployz:installation': TEST_ENV.installationId };
  const credentialStatements = (statements: Statement[]) =>
    statements.filter((s) => asList(s.Action).includes('secretsmanager:UpdateSecret'));

  it('grants the credential actions on the conditional credential ARN, in the role and the boundary', () => {
    const { stack, template } = synth();
    const credentialArn = {
      'Fn::If': ['HasRelayCredential', { Ref: 'RelayCredentialFromParam' }, { Ref: 'RelayCredentialGenerated' }],
    };
    const resources = allResources(template);
    const statementsOf = (id: string) =>
      (resources[id]?.Properties?.['PolicyDocument'] as { Statement: Statement[] }).Statement;
    const relayRoleId = (stack.resolve(stack.relayRole.roleName) as { Ref: string }).Ref;
    const roleStatements = Object.keys(resources)
      .filter(
        (id) =>
          resources[id]?.Type === 'AWS::IAM::Policy' &&
          (resources[id]?.Properties?.['Roles'] as Array<{ Ref?: string }>).some((r) => r.Ref === relayRoleId),
      )
      .flatMap((id) => credentialStatements(statementsOf(id)));
    const boundaryId = (stack.resolve(stack.permissionsBoundary.managedPolicyArn) as { Ref: string }).Ref;

    for (const statements of [roleStatements, credentialStatements(statementsOf(boundaryId))]) {
      expect(statements).toHaveLength(1);
      expect(statements[0]?.Condition).toBeUndefined();
      expect(statements[0]?.Resource).toEqual(credentialArn);
      expect([...asList(statements[0]?.Action)].sort()).toEqual([
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'secretsmanager:PutSecretValue',
        'secretsmanager:UpdateSecret',
      ]);
    }
    // The same ARN the relay reads its credential from.
    expect(stack.resolve(stack.credentialSecretArn)).toEqual(credentialArn);
  });

  it.each([
    { hasRelayCredential: true, created: 'RelayCredentialFromParam', absent: 'RelayCredentialGenerated' },
    { hasRelayCredential: false, created: 'RelayCredentialGenerated', absent: 'RelayCredentialFromParam' },
  ])('selects the created secret when HasRelayCredential is $hasRelayCredential', ({ hasRelayCredential, created, absent }) => {
    const { template } = synth();
    const conditionOf = (id: string) =>
      (template.toJSON().Resources as Record<string, { Condition?: string }>)[id]?.Condition;
    expect(conditionOf(created)).toBe(hasRelayCredential ? 'HasRelayCredential' : 'NoRelayCredential');
    expect(conditionOf(absent)).toBe(hasRelayCredential ? 'NoRelayCredential' : 'HasRelayCredential');

    const env = { hasRelayCredential, ...TEST_ENV };
    const { identity, boundary, allows } = relayPolicies(template, env);
    for (const statements of [identity, boundary]) {
      expect(credentialStatements(statements).map((s) => s.Resource)).toEqual([generatedSecretArn(created, env)]);
    }
    for (const action of [...SECRET_VALUE_ACTIONS, 'secretsmanager:DescribeSecret']) {
      expect(allows(action, generatedSecretArn(created, env), OWN_TAG), action).toBe(true);
      // The grant does not depend on the tag, so enrollment and refresh work
      // even before CloudFormation has tagged the secret.
      expect(allows(action, generatedSecretArn(created, env)), `${action} untagged`).toBe(true);
    }
  });

  it.each([true, false])(
    'denies secret-value access to unrelated and other installations’ secrets (HasRelayCredential %s)',
    (hasRelayCredential) => {
      const { template } = synth();
      const { allows } = relayPolicies(template, { hasRelayCredential, ...TEST_ENV });
      const arn = (name: string) => `arn:aws:secretsmanager:eu-west-1:123456789012:secret:${name}`;
      const otherInstallation = { 'aws:ResourceTag/deployz:installation': '22222222-2222-4222-8222-222222222222' };

      const denied: Array<[string, Record<string, string>]> = [
        [arn('prod/payments/api-key-XyZ123'), {}],
        [arn('prod/payments/api-key-XyZ123'), { 'aws:ResourceTag/team': 'payments' }],
        [arn('RelayCredentialGenerated-ZyXwVuTsRqPo-ZyXwVu'), otherInstallation],
        [arn('AppConfigSecret251CAC1E-ZyXwVuTsRqPo-ZyXwVu'), otherInstallation],
      ];
      for (const [secret, context] of denied) {
        for (const action of SECRET_VALUE_ACTIONS) {
          expect(allows(action, secret, context), `${action} on ${secret}`).toBe(false);
        }
        // Metadata discovery stays condition-free (disclosed on Security
        // Details): the purge sweep reads tags to find its retained secrets.
        expect(allows('secretsmanager:DescribeSecret', secret, context)).toBe(true);
      }
    },
  );

  it.each([true, false])(
    'keeps application configuration delivery on the installation’s own secret (HasRelayCredential %s)',
    (hasRelayCredential) => {
      const { template } = synth();
      const { allows } = relayPolicies(template, { hasRelayCredential, ...TEST_ENV });
      const appConfig =
        'arn:aws:secretsmanager:eu-west-1:123456789012:secret:AppConfigSecret251CAC1E-AbCdEfGhIjKl-AbCdEf';
      expect(allows('secretsmanager:GetSecretValue', appConfig, OWN_TAG)).toBe(true);
      expect(allows('secretsmanager:PutSecretValue', appConfig, OWN_TAG)).toBe(true);
      expect(allows('secretsmanager:DeleteSecret', appConfig, OWN_TAG)).toBe(true);
    },
  );

  it.each([true, false])(
    'grants secret-value actions only on the credential ARN or behind the installation tag (HasRelayCredential %s)',
    (hasRelayCredential) => {
      const { template } = synth();
      const env = { hasRelayCredential, ...TEST_ENV };
      const { identity, boundary } = relayPolicies(template, env);
      const credential = generatedSecretArn(
        hasRelayCredential ? 'RelayCredentialFromParam' : 'RelayCredentialGenerated',
        env,
      );
      for (const statement of [...identity, ...boundary]) {
        const grantsSecretValue = SECRET_VALUE_ACTIONS.some((action) =>
          asList(statement.Action).some((pattern) => globMatches(pattern, action, true)),
        );
        if (!grantsSecretValue) continue;
        const scopedToCredential = asList(statement.Resource).every((resource) => resource === credential);
        const scopedToInstallation =
          statement.Condition?.['StringEquals']?.['aws:ResourceTag/deployz:installation'] === TEST_ENV.installationId;
        expect(scopedToCredential || scopedToInstallation, JSON.stringify(statement)).toBe(true);
      }
    },
  );
});

describe('BootstrapStack — installation isolation in a shared account and Region', () => {
  const env = { hasRelayCredential: true, ...TEST_ENV };
  const OTHER_ID = '22222222-2222-4222-8222-222222222222';
  const own = (name: string) => `deployz-app-11111111-${name}`;
  const other = (name: string) => `deployz-app-22222222-${name}`;
  const OWN_TAG = { 'aws:ResourceTag/deployz:installation': TEST_ENV.installationId };
  const OTHER_TAG = { 'aws:ResourceTag/deployz:installation': OTHER_ID };
  const OWN_REQUEST = { 'aws:RequestTag/deployz:installation': TEST_ENV.installationId };
  const arn = (service: string, resource: string) => `arn:aws:${service}:eu-west-1:123456789012:${resource}`;
  const cluster = (name: string) => ({ 'ecs:cluster': arn('ecs', `cluster/${name}`) });

  function documentStatements(template: Template, ids: string[]): Statement[] {
    const resources = allResources(template);
    return ids.flatMap(
      (id) =>
        (resolveIntrinsics(resources[id]?.Properties?.['PolicyDocument'], env) as { Statement: Statement[] })
          .Statement,
    );
  }

  function allowsUnder(statements: Statement[]) {
    return (action: string, resource: string, context: Record<string, string> = {}) =>
      statements.some((s) => statementAllows(s, action, resource, context));
  }

  function executionRoleAllows(template: Template) {
    const resources = allResources(template);
    const roleId = Object.keys(resources).find(
      (id) => resources[id]?.Type === 'AWS::IAM::Role' && resources[id]?.Properties?.['Path'] === '/deployz/',
    )!;
    const ids = Object.keys(resources).filter(
      (id) =>
        resources[id]?.Type === 'AWS::IAM::Policy' &&
        ((resources[id]?.Properties?.['Roles'] as Array<{ Ref?: string }>) ?? []).some((r) => r.Ref === roleId),
    );
    return allowsUnder(documentStatements(template, ids));
  }

  function applicationBoundaryAllows(template: Template) {
    const id = Object.keys(allResources(template)).find((key) => key.startsWith('ApplicationRoleBoundary'))!;
    return allowsUnder(documentStatements(template, [id]));
  }

  it('lets the relay pass only its own execution role to CloudFormation', () => {
    const { template } = synth();
    const { allows } = relayPolicies(template, env);
    const toCloudFormation = { 'iam:PassedToService': 'cloudformation.amazonaws.com' };
    expect(allows('iam:PassRole', executionRoleArn(TEST_ENV, TEST_ENV.installationId), toCloudFormation)).toBe(true);
    expect(allows('iam:PassRole', executionRoleArn(TEST_ENV, OTHER_ID), toCloudFormation)).toBe(false);
  });

  it('lets the relay pass only its own application roles to ECS', () => {
    const { template } = synth();
    const { allows } = relayPolicies(template, env);
    const toEcsTasks = { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' };
    for (const path of ['role/deployz/', 'role/']) {
      expect(allows('iam:PassRole', `arn:aws:iam::123456789012:${path}${own('TaskRole-AbC')}`, toEcsTasks)).toBe(true);
      expect(allows('iam:PassRole', `arn:aws:iam::123456789012:${path}${other('TaskRole-AbC')}`, toEcsTasks)).toBe(false);
    }
  });

  it('lets the relay run and stop tasks only in its own cluster', () => {
    const { template } = synth();
    const { allows } = relayPolicies(template, env);
    const taskDefinition = arn('ecs', 'task-definition/DeployzAppWeb11111111:3');
    const task = arn('ecs', 'task/x/abc');
    expect(allows('ecs:RunTask', taskDefinition, cluster(own('ClusterEB0386A7-AbC')))).toBe(true);
    expect(allows('ecs:StopTask', task, cluster(own('ClusterEB0386A7-AbC')))).toBe(true);
    expect(allows('ecs:RunTask', taskDefinition, cluster(other('ClusterEB0386A7-AbC')))).toBe(false);
    expect(allows('ecs:StopTask', task, cluster(other('ClusterEB0386A7-AbC')))).toBe(false);
  });

  it('lets the relay empty and delete only its own buckets', () => {
    const { template } = synth();
    const { allows } = relayPolicies(template, env);
    for (const action of ['s3:ListBucketVersions', 's3:DeleteObjectVersion', 's3:DeleteBucket']) {
      expect(allows(action, `arn:aws:s3:::${own('appstorage995579da-abc')}`), action).toBe(true);
      expect(allows(action, `arn:aws:s3:::${other('appstorage995579da-abc')}`), action).toBe(false);
      expect(allows(action, 'arn:aws:s3:::customer-data'), action).toBe(false);
    }
    expect(allows('s3:DeleteObject', `arn:aws:s3:::${own('appstorage995579da-abc')}/key`)).toBe(true);
    expect(allows('s3:GetBucketTagging', 'arn:aws:s3:::customer-data')).toBe(true);
  });

  it('never lets a request tag take over a resource of another installation', () => {
    const { template } = synth();
    const { allows } = relayPolicies(template, env);
    const stack = arn('cloudformation', 'stack/deployz-app-22222222/abc');
    expect(allows('cloudformation:UpdateStack', stack, { ...OWN_REQUEST, ...OTHER_TAG })).toBe(false);
    expect(allows('cloudformation:UpdateStack', stack, { ...OWN_REQUEST, ...OWN_TAG })).toBe(true);
    expect(allows('cloudformation:CreateStack', stack, OWN_REQUEST)).toBe(true);
    const listener = arn('elasticloadbalancing', 'listener/app/x/y/z');
    const tagKeys = { 'aws:TagKeys': 'deployz:installation' };
    expect(allows('elasticloadbalancing:AddTags', listener, { ...OWN_REQUEST, ...tagKeys })).toBe(true);
    expect(allows('elasticloadbalancing:AddTags', listener, { ...OWN_REQUEST, ...tagKeys, ...OTHER_TAG })).toBe(false);
    const cache = arn('elasticache', 'replicationgroup:other');
    expect(allows('elasticache:AddTagsToResource', cache, { ...OWN_REQUEST, ...OTHER_TAG })).toBe(false);

    const executionAllows = executionRoleAllows(template);
    const vpc = arn('ec2', 'vpc/vpc-123');
    expect(executionAllows('ec2:CreateTags', vpc, { ...OWN_REQUEST, ...OTHER_TAG })).toBe(false);
    expect(executionAllows('ec2:CreateTags', vpc, OWN_REQUEST)).toBe(true);
  });

  it('limits the name-scoped grants of the execution role to its own application stack', () => {
    const { template } = synth();
    const allows = executionRoleAllows(template);
    const cases: Array<[string, (name: string) => string]> = [
      ['logs:DeleteLogGroup', (name) => arn('logs', `log-group:${name}`)],
      ['logs:PutRetentionPolicy', (name) => arn('logs', `log-group:${name}`)],
      ['s3:DeleteBucket', (name) => `arn:aws:s3:::${name.toLowerCase()}`],
      ['sqs:DeleteQueue', (name) => arn('sqs', name)],
      ['scheduler:DeleteSchedule', (name) => arn('scheduler', `schedule/default/${name}`)],
    ];
    for (const [action, resource] of cases) {
      expect(allows(action, resource(own('App-AbC'))), action).toBe(true);
      expect(allows(action, resource(other('App-AbC'))), action).toBe(false);
    }
    const role = (name: string) => `arn:aws:iam::123456789012:role/deployz/${name}`;
    const toEcsTasks = { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' };
    expect(allows('iam:PassRole', role(own('TaskRole-AbC')), toEcsTasks)).toBe(true);
    expect(allows('iam:PassRole', role(other('TaskRole-AbC')), toEcsTasks)).toBe(false);
  });

  it('limits the cache lifecycle of the execution role to its own tagged replication group', () => {
    const { template } = synth();
    const allows = executionRoleAllows(template);
    const group = arn('elasticache', 'replicationgroup:dep-ap-1abc');
    const parameterGroup = arn('elasticache', 'parametergroup:default.valkey8');
    expect(allows('elasticache:CreateReplicationGroup', group, OWN_REQUEST)).toBe(true);
    expect(allows('elasticache:CreateReplicationGroup', parameterGroup)).toBe(true);
    expect(allows('elasticache:DeleteReplicationGroup', group, OWN_TAG)).toBe(true);
    expect(allows('elasticache:DeleteReplicationGroup', group, OTHER_TAG)).toBe(false);
    expect(allows('elasticache:ModifyReplicationGroup', group, OTHER_TAG)).toBe(false);
    expect(allows('elasticache:DeleteCacheCluster', arn('elasticache', 'cluster:x'), OTHER_TAG)).toBe(false);
  });

  it('limits every application role to the resources of its own installation', () => {
    const { template } = synth();
    const allows = applicationBoundaryAllows(template);
    expect(allows('s3:PutObject', `arn:aws:s3:::${own('appstorage-abc')}/key`)).toBe(true);
    expect(allows('s3:PutObject', `arn:aws:s3:::${other('appstorage-abc')}/key`)).toBe(false);
    expect(allows('sqs:SendMessage', arn('sqs', own('Jobs-AbC')))).toBe(true);
    expect(allows('sqs:SendMessage', arn('sqs', other('Jobs-AbC')))).toBe(false);
    expect(allows('logs:PutLogEvents', arn('logs', `log-group:${own('WebLogGroup-AbC')}:log-stream:x`))).toBe(true);
    expect(allows('logs:PutLogEvents', arn('logs', `log-group:${other('WebLogGroup-AbC')}:log-stream:x`))).toBe(false);
    const family = arn('ecs', 'task-definition/DeployzAppJob11111111');
    expect(allows('ecs:RunTask', family, cluster(own('ClusterEB0386A7-AbC')))).toBe(true);
    expect(allows('ecs:RunTask', family, cluster(other('ClusterEB0386A7-AbC')))).toBe(false);
    const toEcsTasks = { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' };
    expect(allows('iam:PassRole', `arn:aws:iam::123456789012:role/deployz/${own('TaskRole-AbC')}`, toEcsTasks)).toBe(true);
    expect(allows('iam:PassRole', `arn:aws:iam::123456789012:role/deployz/${other('TaskRole-AbC')}`, toEcsTasks)).toBe(false);
  });
});
