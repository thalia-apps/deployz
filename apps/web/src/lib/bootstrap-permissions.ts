/**
 * The IAM permissions of the connector stack, read from the bootstrap template
 * the customer deploys. The Security Details page renders every IAM action
 * from here, so it can never drift from the template.
 *
 * Source: packages/cdk/artifacts/bootstrap-template-v1.json. The template is
 * committed, and packages/cdk/test/artifacts.test.ts fails if it differs from
 * a fresh synth of packages/cdk/src/bootstrap/bootstrap-stack.ts.
 */
import bootstrapTemplate from '../../../../packages/cdk/artifacts/bootstrap-template-v1.json';

type TemplateValue = string | { [key: string]: unknown } | TemplateValue[];

interface TemplateStatement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: TemplateValue;
  Condition?: Record<string, Record<string, TemplateValue>>;
}

interface TemplateResource {
  Type: string;
  Properties?: Record<string, unknown>;
}

const resources = (bootstrapTemplate as unknown as { Resources: Record<string, TemplateResource> })
  .Resources;

/**
 * How far AWS limits a statement:
 * - `installation`: only this installation's tagged resources or named resources.
 * - `limited`: a resource-name pattern or a service condition, not this installation.
 * - `unrestricted`: any resource in the account.
 */
export type PermissionScope = 'installation' | 'limited' | 'unrestricted';

export interface PermissionStatement {
  sid: string | null;
  label: string;
  actions: string[];
  resources: string[];
  conditions: string[];
  scope: PermissionScope;
  readOnly: boolean;
}

export interface PermissionRole {
  logicalId: string;
  label: string;
  /** Rendered ARNs of AWS managed policies attached to the role. */
  awsManagedPolicies: string[];
  hasPermissionsBoundary: boolean;
  statements: PermissionStatement[];
}

/** Plain-English labels, keyed by the template's statement Sid. */
const STATEMENT_LABELS: Record<string, string> = {
  RelayWriteLogs: 'Write its own activity log',
  RelayAccessCredential: 'Read and refresh its own Deployz credential secret',
  RelayVerifyInstallation: 'Verify its installation stack',
  RelayPendingCommandState: 'Record commands it has not finished',
  ProvisionerCreateStacks: 'Create and update the application stack',
  ProvisionerManageStacks: 'Read and delete the application stack',
  ProvisionerPassRole: 'Give the execution role to CloudFormation',
  ProvisionerAppResourceManage: 'Update and remove the application service and database',
  ProvisionerAcmRequest: 'Request a custom-domain certificate',
  ProvisionerAcmManage: 'Read and delete that certificate',
  ProvisionerDomainIngressDescribe: 'Read load balancer configuration',
  ProvisionerDomainIngressWrite: 'Manage the HTTPS listener and its certificates',
  ProvisionerDomainIngressTag: 'Tag the HTTPS listener',
  ProvisionerCacheCreate: 'Create the cache',
  ProvisionerCacheManage: 'Modify and delete the cache',
  ProvisionerCacheDescribe: 'Read cache configuration',
  RelayDeployObserve: 'Observe and stop application tasks',
  RelayDeployRegister: 'Register new task definitions',
  RelayDeregisterRevisions: 'Remove old application task-definition revisions after a successful update',
  RelayMigrationRun: 'Run one-off tasks, such as database migrations',
  RelayDeployPassRole: 'Give application roles to ECS',
  RelayPurgeStorage: 'Find and empty storage buckets when retained data is deleted',
  RelayPurgeRdsDiscover: 'Find retained databases',
  RelayPurgeSecretsList: 'Find retained secrets',
  RelayInstallationSecrets: 'Read, update and delete application secrets',
  RelayPurgeAcmDiscover: 'Find retained certificates',
  RelayPurgeNetworkDiscover: 'Find network resources',
  RelayPurgeNetworkDelete: 'Delete retained network resources',
  ProvisionApplicationCreate: 'Create application resources',
  ProvisionApplicationCreateOnTagged: 'Repeat create actions on resources already tagged',
  ProvisionApplicationManage: 'Modify and delete application resources',
  ProvisionApplicationRead: 'Read resource configuration',
  ProvisionApplicationStorage: 'Create and configure storage buckets',
  ProvisionApplicationUntaggable: 'Actions that AWS cannot limit by tag',
  ProvisionApplicationRoleCreate: 'Create application roles',
  ProvisionApplicationRolePolicy: 'Give application roles their own permissions',
  ProvisionApplicationRoleAttach: 'Attach the ECS task-execution policy to application roles',
  ProvisionApplicationPassRole: 'Give the application roles to ECS and EventBridge Scheduler',
  ApplicationImagePull: 'Download container images',
  ApplicationLogs: 'Write application logs',
  ApplicationSecrets: "Read this installation's secrets",
  ApplicationStorage: 'Read and write files in the application buckets',
  ApplicationQueues: 'Send and receive application queue messages',
  ApplicationRunTask: 'Start scheduled application tasks',
  ApplicationPassRole: 'Give application roles to ECS tasks',
  ProvisionApplicationServiceLinkedRoles: 'Create AWS service-linked roles',
  ProvisionApplicationQueues: 'Manage application queues',
  ProvisionApplicationSchedules: 'Manage application schedules',
};

/** Plain-English labels for the helper roles, keyed by logical-id prefix. */
const HELPER_ROLE_LABELS: Record<string, string> = {
  InstallIdFunctionServiceRole: 'Installation ID function',
  InstallIdProviderframeworkonEventServiceRole: 'Installation ID provider',
  LogRetention: 'Log retention helper',
};

const INSTALLATION_TAG_KEYS = [
  'aws:RequestTag/deployz:installation',
  'aws:ResourceTag/deployz:installation',
];
const INSTALLATION_ID = '${InstallationId}';

/** CDK appends an 8-character hash to logical ids; drop it for display. */
function displayId(logicalId: string): string {
  return logicalId.replace(/[0-9A-F]{8}$/, '');
}

/** Renders CloudFormation intrinsics as readable `${...}` placeholders. */
function render(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.Ref === 'string') return `\${${displayId(record.Ref)}}`;
    if (Array.isArray(record['Fn::GetAtt'])) {
      const [logicalId, attribute] = record['Fn::GetAtt'] as [string, string];
      return logicalId === 'InstallationId' ? INSTALLATION_ID : `\${${displayId(logicalId)}.${attribute}}`;
    }
    if (Array.isArray(record['Fn::Join'])) {
      const [separator, parts] = record['Fn::Join'] as [string, unknown[]];
      return parts.map(render).join(separator);
    }
    if (Array.isArray(record['Fn::If'])) {
      const [, whenTrue, whenFalse] = record['Fn::If'] as [string, unknown, unknown];
      return `${render(whenTrue)} or ${render(whenFalse)}`;
    }
  }
  return JSON.stringify(value);
}

/** True when the value refers to a resource that this stack creates. */
function refersToStackResource(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(refersToStackResource);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.Ref === 'string') return record.Ref in resources;
  return Object.values(record).some(refersToStackResource);
}

function toList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function isReadOnlyAction(action: string): boolean {
  const name = action.split(':')[1] ?? '';
  return /^(Describe|List|Get)/.test(name) && name !== 'GetSecretValue';
}

function toStatement(statement: TemplateStatement): PermissionStatement {
  const actions = toList(statement.Action).map(String);
  const statementResources = toList(statement.Resource).map(render);
  const conditionKeys: string[] = [];
  const conditions: string[] = [];
  for (const [operator, entries] of Object.entries(statement.Condition ?? {})) {
    for (const [key, value] of Object.entries(entries)) {
      conditionKeys.push(key);
      conditions.push(`${operator} ${key} = ${toList(value).map(render).join(', ')}`);
    }
  }

  const scopedToInstallation =
    conditionKeys.some((key) => INSTALLATION_TAG_KEYS.includes(key)) ||
    statementResources.some((resource) => resource.includes(INSTALLATION_ID)) ||
    toList(statement.Resource).every(refersToStackResource);
  const scope: PermissionScope = scopedToInstallation
    ? 'installation'
    : conditions.length > 0 || statementResources.some((resource) => resource !== '*')
      ? 'limited'
      : 'unrestricted';

  return {
    sid: statement.Sid ?? null,
    label: (statement.Sid && STATEMENT_LABELS[statement.Sid]) ?? statement.Sid ?? 'Unnamed statement',
    actions,
    resources: statementResources,
    conditions,
    scope,
    readOnly: actions.every(isReadOnlyAction),
  };
}

function policyStatements(policyDocument: unknown): PermissionStatement[] {
  const document = policyDocument as { Statement: TemplateStatement[] };
  return document.Statement.filter((statement) => statement.Effect === 'Allow').map(toStatement);
}

function isRef(value: unknown, logicalId: string): boolean {
  return Boolean(value && typeof value === 'object' && (value as { Ref?: unknown }).Ref === logicalId);
}

function buildRole(logicalId: string, label: string): PermissionRole {
  const properties = resources[logicalId]?.Properties ?? {};
  const statements: PermissionStatement[] = [];
  const awsManagedPolicies: string[] = [];

  for (const inline of (properties.Policies as { PolicyDocument: unknown }[] | undefined) ?? []) {
    statements.push(...policyStatements(inline.PolicyDocument));
  }
  for (const resource of Object.values(resources)) {
    const roles = resource.Properties?.Roles as unknown[] | undefined;
    if (resource.Type === 'AWS::IAM::Policy' && roles?.some((role) => isRef(role, logicalId))) {
      statements.push(...policyStatements(resource.Properties?.PolicyDocument));
    }
  }
  for (const arn of (properties.ManagedPolicyArns as unknown[] | undefined) ?? []) {
    const managedPolicy = Object.entries(resources).find(([id]) => isRef(arn, id));
    if (managedPolicy) {
      statements.push(...policyStatements(managedPolicy[1].Properties?.PolicyDocument));
    } else {
      awsManagedPolicies.push(render(arn));
    }
  }

  return {
    logicalId,
    label,
    awsManagedPolicies,
    hasPermissionsBoundary: properties.PermissionsBoundary !== undefined,
    statements,
  };
}

function roleIdWithPrefix(prefix: string): string {
  const id = Object.entries(resources).find(
    ([logicalId, resource]) => logicalId.startsWith(prefix) && resource.Type === 'AWS::IAM::Role',
  )?.[0];
  if (!id) throw new Error(`The bootstrap template has no ${prefix} role.`);
  return id;
}

const connectorRoleId = roleIdWithPrefix('RelayRole');
const executionRoleId = roleIdWithPrefix('ApplicationExecutionRole');

/** The connector's own role: its inline policy plus the provisioner policy. */
export const CONNECTOR_ROLE = buildRole(connectorRoleId, 'Connector role');

/** The role the connector gives to CloudFormation to build the application stack. */
export const EXECUTION_ROLE = buildRole(executionRoleId, 'CloudFormation execution role');

const applicationRoleBoundaryId = Object.keys(resources).find(
  (logicalId) =>
    logicalId.startsWith('ApplicationRoleBoundary') &&
    resources[logicalId]?.Type === 'AWS::IAM::ManagedPolicy',
);
if (!applicationRoleBoundaryId) throw new Error('The bootstrap template has no application role boundary.');

/** The most that any IAM role in the application stack can do. */
export const APPLICATION_ROLE_BOUNDARY: PermissionStatement[] = policyStatements(
  resources[applicationRoleBoundaryId]?.Properties?.PolicyDocument,
);

/** True when the execution role may create a role only with the application role boundary. */
export const EXECUTION_ROLE_REQUIRES_BOUNDARY = EXECUTION_ROLE.statements
  .filter((statement) => statement.actions.includes('iam:CreateRole'))
  .every((statement) => statement.conditions.some((condition) => condition.includes('iam:PermissionsBoundary')));

/** Roles of the helper functions that run only during connector-stack operations. */
export const INSTALL_HELPER_ROLES: PermissionRole[] = Object.entries(resources)
  .filter(
    ([logicalId, resource]) =>
      resource.Type === 'AWS::IAM::Role' &&
      logicalId !== connectorRoleId &&
      logicalId !== executionRoleId,
  )
  .map(([logicalId]) => {
    const label = Object.entries(HELPER_ROLE_LABELS).find(([prefix]) =>
      logicalId.startsWith(prefix),
    )?.[1];
    return buildRole(logicalId, label ?? displayId(logicalId));
  });

/** True when a granted action, or a wildcard pattern, covers the action. */
function covers(granted: string, action: string): boolean {
  const pattern = new RegExp(`^${granted.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
  return pattern.test(action);
}

/** True when the connector role or the execution role is granted the action. */
export function isGrantedToConnector(action: string): boolean {
  return [CONNECTOR_ROLE, EXECUTION_ROLE].some((role) =>
    role.statements.some((statement) => statement.actions.some((granted) => covers(granted, action))),
  );
}

/** The number of distinct actions a role is granted. */
export function distinctActionCount(role: PermissionRole): number {
  return new Set(role.statements.flatMap((statement) => statement.actions)).size;
}
