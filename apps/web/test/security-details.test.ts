import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  APPLICATION_ROLE_BOUNDARY,
  CONNECTOR_ROLE,
  EXECUTION_ROLE,
  EXECUTION_ROLE_REQUIRES_BOUNDARY,
  INSTALL_HELPER_ROLES,
  isGrantedToConnector,
  type PermissionRole,
} from '../src/lib/bootstrap-permissions';
import {
  DATA_NOT_SENT_TO_DEPLOYZ,
  DENIED_LOG_READ_ACTIONS,
  SECRET_HANDLING_STATEMENT,
} from '../src/lib/security-details';

// §45 copy-truthfulness lock. The Security Details page reads its IAM
// permissions from packages/cdk/artifacts/bootstrap-template-v1.json, the
// template the customer deploys (packages/cdk/test/artifacts.test.ts keeps it
// equal to a fresh synth). This test reads the same template independently
// and checks that the page model drops nothing, and that the page's fixed
// claims about the template are still true.

type Statement = {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, Record<string, unknown>>;
};
type Resource = { Type: string; Properties: Record<string, unknown> };

const TEMPLATE_PATH = fileURLToPath(
  new URL('../../../packages/cdk/artifacts/bootstrap-template-v1.json', import.meta.url),
);
const resources = (JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8')) as { Resources: Record<string, Resource> })
  .Resources;

function logicalId(prefix: string, type: string): string {
  const id = Object.keys(resources).find((key) => key.startsWith(prefix) && resources[key]?.Type === type);
  if (!id) throw new Error(`${prefix} (${type}) not found in the bootstrap template`);
  return id;
}

function statementsOf(policyId: string): Statement[] {
  return (resources[policyId]?.Properties.PolicyDocument as { Statement: Statement[] }).Statement;
}

function actionsOf(statements: Statement[]): string[] {
  return statements.flatMap((statement) => [statement.Action].flat());
}

const relayRoleId = logicalId('RelayRole', 'AWS::IAM::Role');
const relayRole = resources[relayRoleId]!;
const provisionerPolicyId = logicalId('ProvisionerPolicy', 'AWS::IAM::ManagedPolicy');
const boundaryId = logicalId('PermissionsBoundary', 'AWS::IAM::ManagedPolicy');
const executionRoleId = logicalId('ApplicationExecutionRole', 'AWS::IAM::Role');

/** Every inline IAM::Policy statement the template attaches to a role. */
function inlinePolicyStatements(roleId: string): Statement[] {
  return Object.values(resources)
    .filter(
      (resource) =>
        resource.Type === 'AWS::IAM::Policy' &&
        (resource.Properties.Roles as { Ref?: string }[]).some((role) => role.Ref === roleId),
    )
    .flatMap((resource) => (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
}

function modelActions(role: PermissionRole): string[] {
  return role.statements.flatMap((statement) => statement.actions);
}

describe('bootstrap permissions ↔ deployed template', () => {
  it('the connector role model holds every action of its inline and provisioner policies', () => {
    const expected = [
      ...inlinePolicyStatements(relayRoleId),
      ...statementsOf(provisionerPolicyId),
    ];
    expect(CONNECTOR_ROLE.statements).toHaveLength(expected.length);
    expect(modelActions(CONNECTOR_ROLE)).toEqual(actionsOf(expected));
  });

  it('the execution role model holds every action of its policies', () => {
    const expected = inlinePolicyStatements(executionRoleId);
    expect(EXECUTION_ROLE.statements).toHaveLength(expected.length);
    expect(modelActions(EXECUTION_ROLE)).toEqual(actionsOf(expected));
  });

  it('every other role is shown as an installation helper', () => {
    const roleIds = Object.keys(resources).filter((key) => resources[key]?.Type === 'AWS::IAM::Role');
    expect(INSTALL_HELPER_ROLES.map((role) => role.logicalId).sort()).toEqual(
      roleIds.filter((id) => id !== relayRoleId && id !== executionRoleId).sort(),
    );
    for (const role of INSTALL_HELPER_ROLES) {
      expect(role.statements).toHaveLength(inlinePolicyStatements(role.logicalId).length);
      expect(role.label).not.toBe(role.logicalId);
    }
  });

  it('every statement Sid has a plain-English label', () => {
    for (const statement of [...CONNECTOR_ROLE.statements, ...EXECUTION_ROLE.statements]) {
      expect(statement.sid).not.toBeNull();
      expect(statement.label).not.toBe(statement.sid);
    }
  });

  it('classifies tag-conditioned statements as installation-scoped', () => {
    for (const statement of [...CONNECTOR_ROLE.statements, ...EXECUTION_ROLE.statements]) {
      const tagged = statement.conditions.some((condition) =>
        /aws:(Request|Resource)Tag\/deployz:installation/.test(condition),
      );
      if (tagged) expect(statement.scope).toBe('installation');
    }
    const bySid = (sid: string) =>
      [...CONNECTOR_ROLE.statements, ...EXECUTION_ROLE.statements].find((s) => s.sid === sid);
    expect(bySid('RelayPendingCommandState')?.scope).toBe('installation');
    expect(bySid('ProvisionerPassRole')?.scope).toBe('limited');
    expect(bySid('RelayAccessCredential')?.scope).toBe('installation');
  });

  it('limits the credential grant to the connector’s own credential secret', () => {
    const grant = CONNECTOR_ROLE.statements.find((s) => s.sid === 'RelayAccessCredential');
    expect(grant?.resources).toEqual(['${RelayCredentialFromParam} or ${RelayCredentialGenerated}']);
    // No connector statement reads or writes secret values on any resource.
    const secretValueActions = ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue', 'secretsmanager:UpdateSecret'];
    for (const statement of CONNECTOR_ROLE.statements) {
      if (statement.actions.some((action) => secretValueActions.includes(action))) {
        expect(statement.scope, statement.sid ?? '').toBe('installation');
      }
    }
  });

  // The page states these facts in words; each must stay true.
  it('attaches the provisioner policy at install, capped by the permissions boundary', () => {
    expect(relayRole.Properties.ManagedPolicyArns).toEqual([{ Ref: provisionerPolicyId }]);
    expect(relayRole.Properties.PermissionsBoundary).toEqual({ Ref: boundaryId });
    expect(CONNECTOR_ROLE.hasPermissionsBoundary).toBe(true);
    const boundary = new Set(actionsOf(statementsOf(boundaryId)));
    for (const action of modelActions(CONNECTOR_ROLE)) expect(boundary).toContain(action);
  });

  it('lets only CloudFormation use the execution role, which has no boundary', () => {
    const trust = (resources[executionRoleId]!.Properties.AssumeRolePolicyDocument as {
      Statement: { Principal: { Service: string } }[];
    }).Statement;
    expect(trust.map((statement) => statement.Principal.Service)).toEqual([
      'cloudformation.amazonaws.com',
    ]);
    expect(EXECUTION_ROLE.hasPermissionsBoundary).toBe(false);
    expect(modelActions(EXECUTION_ROLE)).toEqual(
      expect.arrayContaining(['iam:CreateRole', 'iam:AttachRolePolicy']),
    );
  });

  it('creates application roles only with the application role boundary, which grants no IAM management', () => {
    expect(EXECUTION_ROLE_REQUIRES_BOUNDARY).toBe(true);
    const iamActions = APPLICATION_ROLE_BOUNDARY.flatMap((statement) => statement.actions).filter(
      (action) => action.startsWith('iam:'),
    );
    expect(iamActions).toEqual(['iam:PassRole']);
    for (const statement of APPLICATION_ROLE_BOUNDARY) {
      expect(statement.label).not.toBe(statement.sid);
    }
  });

  it('grants the log-read actions nowhere (§16)', () => {
    for (const action of DENIED_LOG_READ_ACTIONS) expect(isGrantedToConnector(action)).toBe(false);
    expect(isGrantedToConnector('logs:PutLogEvents')).toBe(true);
  });

  it('creates the connector resources the page lists', () => {
    const types = Object.values(resources).map((resource) => resource.Type);
    for (const type of [
      'AWS::Lambda::Function',
      'AWS::Events::Rule',
      'AWS::SecretsManager::Secret',
      'AWS::IAM::ManagedPolicy',
      'Custom::LogRetention',
    ]) {
      expect(types).toContain(type);
    }
    const schedule = resources[logicalId('RelaySchedule', 'AWS::Events::Rule')]!;
    expect(schedule.Properties.ScheduleExpression).toBe('rate(1 minute)');
    const retention = resources[logicalId('RelayFunctionLogRetention', 'Custom::LogRetention')]!;
    expect(retention.Properties.RetentionInDays).toBe(7);
  });
});

// ux-guidelines §8: secrets are the one exception to "not sent to Deployz" —
// they pass through Deployz encrypted before delivery, so the page must
// never list them alongside data that genuinely never leaves the customer's
// AWS account.
describe('secrets truthfulness (§8)', () => {
  it('does not list application secrets as data never sent to Deployz', () => {
    expect(DATA_NOT_SENT_TO_DEPLOYZ.join(' ')).not.toMatch(/secret/i);
  });

  it('does not name a database engine the application may not use', () => {
    expect(DATA_NOT_SENT_TO_DEPLOYZ.join(' ')).not.toMatch(/postgres|mysql/i);
  });

  it('states the verified secret-handling facts verbatim', () => {
    expect(SECRET_HANDLING_STATEMENT).toContain('sent to Deployz over HTTPS and stored encrypted');
    expect(SECRET_HANDLING_STATEMENT).toContain('deletes the active copy');
    expect(SECRET_HANDLING_STATEMENT).toContain('24 hours');
    expect(SECRET_HANDLING_STATEMENT).toContain('7 days');
    expect(SECRET_HANDLING_STATEMENT).toContain('does not display secret values');
  });
});
