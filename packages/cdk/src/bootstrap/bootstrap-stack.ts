/**
 * Bootstrap stack — the first CloudFormation template a Deployz customer
 * deploys into their OWN AWS account via the one-click Quick Create link.
 *
 * This is DISTINCT from the control-plane stack (DeployzStack, todo 7). It
 * runs in the customer account and establishes the egress-only trust channel:
 *
 *   1. Installation identifier  — a UUIDv4 minted at deploy time by a Custom
 *      Resource (never a template parameter, never in the Quick Create URL).
 *   2. Communication credential — a bootstrap-generated secret
 *      (`AWS::SecretsManager::Secret` + `GenerateSecretString`); CloudFormation
 *      mints it at deploy time, so it is never a template parameter and never
 *      carried in the Quick Create URL. The control plane binds install ID ↔
 *      token on the relay's FIRST poll.
 *   3. Relay Lambda + EventBridge schedule — the outbound actor that polls the
 *      control plane on a fixed schedule (egress-only: the control plane never
 *      reaches INTO the customer account).
 *   4. Execution role — least privilege + a permissions boundary, with a
 *      two-phase permission design:
 *        - Phase 1 (install-time): minimal — write relay logs + read/write the
 *          bootstrap-generated credential secret.
 *        - Phase 2 (post-first-contact): provisioner permissions to apply the
 *          versioned application stack, ALL constrained by the `deployz:`
 *          tag boundary. Not attached at install; the control plane attaches
 *          it after the relay registers.
 *   5. `deployz:` tags on every taggable resource (§15).
 *   6. IAM data-boundary denial: the relay role has NO `logs:GetLogEvents` /
 *      `logs:FilterLogEvents` (§16 — it writes logs, never reads them back).
 */
import {
  CfnCondition,
  CfnOutput,
  CfnParameter,
  CustomResource,
  Duration,
  Fn,
  Stack,
  Tags,
  Token,
  type StackProps,
} from 'aws-cdk-lib';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import {
  Effect,
  ManagedPolicy,
  Policy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, type OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CfnSecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { join } from 'node:path';

export interface BootstrapStackProps extends StackProps {
  /**
   * Base URL of the Deployz control plane that the relay polls.
   *
   * This is a NON-secret, public URL. It is intentionally a template parameter
   * (so the Quick Create URL can point the relay at the right control plane),
   * but it is never a credential. Defaults to the production control plane.
   */
  readonly controlPlaneUrl?: string;
  /**
   * Single-use enrollment code minted by the control plane and carried in the
   * install link. Not a standing credential: it is spent on the relay's first
   * contact and is worthless afterwards.
   */
  readonly enrollmentCode?: string;
  /** Deployz application identifier — applied as `deployz:application` tag. */
  readonly applicationId?: string;
  /** Deployz vendor identifier — applied as `deployz:vendor` tag. */
  readonly vendorId?: string;
  /**
   * Server-established relay credential (DZ-AUDIT-013). When set, the stack
   * uses this value as the SecretString instead of generating one via
   * GenerateSecretString. Relay code reads the secret by name and is unchanged.
   */
  readonly relayCredential?: string;
  /**
   * Identity of this bootstrap build, reported by the relay as its
   * `bootstrapVersion` and used as the key of the immutable published
   * template. The publish script passes the source commit; an unset value is
   * the deterministic `dev` so a plain synth is stable.
   */
  readonly buildId?: string;
}

const DEFAULT_CONTROL_PLANE_URL = 'https://api.deployz.dev';
const DEFAULT_BUILD_ID = 'dev';

/** Relay (phase 1) + provisioner (phase 2) permission actions, all granted at install. */
const PHASE_1_LOG_WRITE_ACTIONS = [
  'logs:CreateLogGroup',
  'logs:CreateLogStream',
  'logs:PutLogEvents',
] as const;

const PHASE_1_SECRET_ACTIONS = [
  'secretsmanager:GetSecretValue',
  'secretsmanager:PutSecretValue',
  'secretsmanager:UpdateSecret',
  'secretsmanager:DescribeSecret',
] as const;

/**
 * IAM caps a managed policy at this many non-whitespace characters. The
 * permissions boundary must stay under it (see its construction below).
 */
export const IAM_MANAGED_POLICY_MAX_CHARS = 6144;

/** The same grant without its Sid — for the boundary, where ids only cost quota. */
function withoutSid(statement: PolicyStatement): PolicyStatement {
  const { Sid: _sid, ...json } = statement.toJSON() as Record<string, unknown>;
  return PolicyStatement.fromJson(json);
}

/**
 * The boundary form of an installation-scoped grant: the same actions on
 * `resources`, without the conditions that only narrow it further (another
 * installation's tag, the installation's cluster).
 */
function widened(statement: PolicyStatement, resources: string[] = ['*']): PolicyStatement {
  const { Sid: _sid, Condition: condition, ...json } = statement.toJSON() as Record<string, unknown>;
  const {
    StringEqualsIfExists: _otherInstallation,
    ArnLike: _cluster,
    ...kept
  } = (condition ?? {}) as Record<string, unknown>;
  return PolicyStatement.fromJson({
    ...json,
    Resource: resources,
    ...(Object.keys(kept).length > 0 ? { Condition: kept } : {}),
  });
}

/** Phase 2 — CloudFormation stack create/update within the tag boundary. */
const PHASE_2_CREATE_STACK_ACTIONS = [
  'cloudformation:CreateStack',
  'cloudformation:UpdateStack',
  'cloudformation:CreateChangeSet',
  'cloudformation:ExecuteChangeSet',
] as const;

/** Phase 2 — CloudFormation stack manage (read/delete) within the tag boundary. */
const PHASE_2_MANAGE_STACK_ACTIONS = [
  'cloudformation:DeleteStack',
  'cloudformation:DeleteChangeSet',
  'cloudformation:DescribeStacks',
  'cloudformation:DescribeStackEvents',
  'cloudformation:DescribeStackResources',
  'cloudformation:ListStackResources',
] as const;

/**
 * Phase 2 — read-only stack access so the relay can verify its own
 * installation and page its full resource inventory. All actions are already
 * inside `PHASE_2_MANAGE_STACK_ACTIONS`, so this grant does not raise the
 * permissions boundary's ceiling — it only extends what the role is
 * actually granted beneath it.
 */
const PHASE_2_VERIFY_STACK_ACTIONS = [
  'cloudformation:DescribeStacks',
  'cloudformation:DescribeStackResources',
  'cloudformation:ListStackResources',
] as const;

/**
 * Phase 2 — application-stack resource lifecycle within the tag boundary.
 * The application stack's OWN service role (todo 9) carries the bulk of the
 * resource provisioning; this set lets the relay reconcile desired-vs-observed
 * state on the resources it manages.
 */
const PHASE_2_APP_RESOURCE_ACTIONS = [
  'ecs:UpdateService',
  'ecs:DeleteService',
  'ecs:DescribeServices',
  'rds:ModifyDBInstance',
  'rds:DeleteDBInstance',
  'rds:DescribeDBInstances',
] as const;

/** Phase 2 — custom-domain certificate lifecycle (custom-domains MVP). */
const PHASE_2_ACM_REQUEST_ACTIONS = ['acm:RequestCertificate', 'acm:AddTagsToCertificate'] as const;
const PHASE_2_ACM_MANAGE_ACTIONS = [
  'acm:DescribeCertificate',
  'acm:DeleteCertificate',
  'acm:ListTagsForCertificate',
] as const;
/**
 * Phase 2 — find the deployment's ALB and manage its HTTPS listener
 * (custom-domains MVP). The two lookups the domain executor starts from —
 * DescribeLoadBalancers (unfiltered) and DescribeTargetGroups (filtered by
 * load balancer) — belong here, not in PHASE_2_APP_RESOURCE_ACTIONS: neither
 * request names a resource, so IAM has no tags to read and the resource-tag
 * condition that statement carries could never match.
 */
const PHASE_2_DOMAIN_INGRESS_ACTIONS = [
  'elasticloadbalancing:DescribeLoadBalancers',
  'elasticloadbalancing:DescribeTargetGroups',
  // Same non-resource shape as the two lookups above: DescribeTargetHealth
  // ignores resource-tag conditions entirely, so inside the tag-conditioned
  // app-resource statement it was ALWAYS denied and the load-balancer
  // component reported Health unknown over a healthy target (verified live).
  'elasticloadbalancing:DescribeTargetHealth',
  'elasticloadbalancing:DescribeListeners',
  'elasticloadbalancing:DescribeListenerCertificates',
  'elasticloadbalancing:DescribeTags',
  'elasticloadbalancing:DescribeRules',
  'elasticloadbalancing:CreateListener',
  'elasticloadbalancing:ModifyListener',
  'elasticloadbalancing:DeleteListener',
  'elasticloadbalancing:AddListenerCertificates',
  'elasticloadbalancing:RemoveListenerCertificates',
] as const;

/** Phase 2 — provision and reconcile the application's ElastiCache Valkey cache (Redis MVP). */
const PHASE_2_CACHE_ACTIONS = [
  'elasticache:CreateCacheCluster',
  'elasticache:DeleteCacheCluster',
  'elasticache:DescribeCacheClusters',
  'elasticache:ModifyCacheCluster',
  'elasticache:DeleteReplicationGroup',
  'elasticache:DescribeReplicationGroups',
  'elasticache:CreateCacheSubnetGroup',
  'elasticache:DeleteCacheSubnetGroup',
  'elasticache:DescribeCacheSubnetGroups',
  'elasticache:AddTagsToResource',
  'elasticache:ListTagsForResource',
] as const;

/**
 * Phase 2 — the relay's durable note of a command it has not finished.
 *
 * An application stack takes longer to create than a Lambda invocation may
 * run, and the control plane never re-offers a job once it has handed it
 * out. The relay therefore records which command it still owes an answer to
 * and picks it back up on a later poll. Scoped by parameter ARN — the name
 * carries the installation id — rather than by tag, because a parameter
 * being written for the first time has no tags to match on.
 */
const PHASE_2_RELAY_STATE_ACTIONS = [
  'ssm:GetParameter',
  'ssm:PutParameter',
  'ssm:DeleteParameter',
] as const;

/**
 * Phase 2 — PURGE retained-resource sweep (S3).
 *
 * S3 bucket/object actions do not honour `aws:ResourceTag` (the same
 * finding PROVISION_STORAGE_ACTIONS documents for the execution role), so
 * these cannot be tag-scoped at IAM. The deletes are scoped by bucket name
 * to this installation's application stack instead, and the purge executor
 * also verifies `deployz:installation` via GetBucketTagging before touching
 * any bucket. ListAllMyBuckets and GetBucketTagging are account-level,
 * read-only discovery for that verification.
 */
const PHASE_2_PURGE_STORAGE_DISCOVER_ACTIONS = ['s3:ListAllMyBuckets', 's3:GetBucketTagging'] as const;
const PHASE_2_PURGE_STORAGE_ACTIONS = [
  's3:ListBucketVersions',
  's3:DeleteObject',
  's3:DeleteObjectVersion',
  's3:DeleteBucket',
] as const;

/**
 * Phase 9 — PURGE's RDS orphan discovery. The purge identifies the retained
 * DB instances left behind by a deleted application stack via
 * DescribeDBInstances + ListTagsForResource (the ownership check is code-side,
 * same as the S3 sweep). DescribeDBInstances does not support resource-level
 * permissions and ListTagsForResource returns tags by ARN without evaluating
 * tag conditions, so both are condition-free read grants — mirroring the
 * Describe* precedents above.
 */
const PHASE_2_PURGE_RDS_DISCOVER_ACTIONS = [
  'rds:DescribeDBInstances',
  'rds:ListTagsForResource',
] as const;

/**
 * Phase 9 — PURGE's retained-DB-credential sweep (Secrets Manager). The
 * application stack's DatabaseSecret/DatabaseUrlSecret are RETAINed alongside
 * the database (the disconnect path must never strand a retained database
 * without its password); PURGE deletes them after the retained database is
 * gone. ListSecrets + DescribeSecret are account-level, read-only discovery
 * (the sweep verifies ownership from the tags itself, same shape as the S3
 * and RDS orphan discovery); only DeleteSecret is scoped — to the secrets
 * that already carry this installation's resource tag.
 */
const PHASE_2_PURGE_SECRET_DISCOVER_ACTIONS = [
  'secretsmanager:ListSecrets',
  'secretsmanager:DescribeSecret',
] as const;
const PHASE_2_PURGE_SECRET_DELETE_ACTIONS = ['secretsmanager:DeleteSecret'] as const;

/**
 * CONFIG_UPDATE — the relay merges vendor/customer secret values (and the
 * secrets it mints) into the application stack's `AppConfigSecret`, then
 * binds them on the task definition. Resource-tag-scoped: the secret
 * carries this installation's `deployz:installation` tag (DEPLOY-012 — the
 * grant lived only on the CloudFormation execution role, so every config
 * pass was denied `GetSecretValue`).
 */
const PHASE_2_CONFIG_SECRET_ACTIONS = [
  'secretsmanager:GetSecretValue',
  'secretsmanager:PutSecretValue',
] as const;

/**
 * CANARY-015 — PURGE's orphaned-network sweep. A data-preserving Disconnect
 * that retains the RDS instance also retains the private subnet its ENI
 * pins alive, the DB security group, and (once those two block DeleteVpc)
 * the VPC itself, plus the RETAIN-ed RDS subnet group — none of which the
 * RDS/cache/S3/secrets sweeps above touch. Reads are condition-free reads
 * like every Describe* precedent above (none support resource-level
 * permissions); the sweep verifies ownership itself from the returned tags
 * before touching anything, same as every other purge client.
 */
const PHASE_2_PURGE_NETWORK_DISCOVER_ACTIONS = [
  'ec2:DescribeVpcs',
  'ec2:DescribeSubnets',
  'ec2:DescribeSecurityGroups',
  'ec2:DescribeRouteTables',
  'ec2:DescribeInternetGateways',
  'ec2:DescribeNatGateways',
  // Install-time AZ discovery for RDS AZ placement — the relay calls
  // DescribeAvailabilityZones before CreateStack to fill the template's
  // paramDbAz1…paramDbAzN. Condition-free like the Describe* reads here.
  'ec2:DescribeAvailabilityZones',
  'ec2:DescribeNetworkInterfaces',
  'rds:DescribeDBSubnetGroups',
] as const;

/**
 * CANARY-015 — the delete half of the orphaned-network sweep. Every action
 * here already carries a resource tag by the time PURGE reaches it — the
 * ORIGINAL create call applied it — so, exactly like PROVISION_MANAGE_ACTIONS'
 * counterparts on the execution role, these are scoped to the installation's
 * RESOURCE tag rather than granted condition-free.
 */
const PHASE_2_PURGE_NETWORK_DELETE_ACTIONS = [
  'ec2:DeleteVpc',
  'ec2:DeleteSubnet',
  'ec2:DeleteSecurityGroup',
  'ec2:DeleteRouteTable',
  'ec2:DeleteInternetGateway',
  'ec2:DetachInternetGateway',
  'ec2:DeleteNatGateway',
  'rds:DeleteDBSubnetGroup',
] as const;

/**
 * Phase 4 — task-level reads behind runtime observation and deploy
 * idempotence. Task and task-definition ARNs carry no usable tag condition,
 * so these stay condition-free like the Describe* precedents above.
 */
const PHASE_4_DEPLOY_OBSERVE_ACTIONS = [
  'ecs:ListTasks',
  'ecs:DescribeTasks',
  'ecs:DescribeTaskDefinition',
  // Revision cleanup lists a family's ACTIVE revisions. ListTaskDefinitions
  // is a list action with no resource-level scoping; read-only.
  'ecs:ListTaskDefinitions',
] as const;

/**
 * Phase 4 — the deploy-time migration one-off (RunTask), and DESTROY's stop
 * of a RUNNING standalone task (a scheduled job or migration mid-run) before
 * it deletes the cluster. ECS evaluates RunTask against the task definition
 * plus further untagged resource ARNs in some configurations, and task ARNs
 * carry no usable tag, so a tag condition could never reliably match. Both
 * actions carry the `ecs:cluster` condition key instead, which limits them to
 * the cluster of this installation's application stack.
 */
const PHASE_4_TASK_RUN_ACTIONS = ['ecs:RunTask', 'ecs:StopTask'] as const;

/**
 * Phase 4 — registering a task-definition copy names a resource that does
 * not exist yet, so (like stack create / cache create) it is scoped by the
 * REQUEST tag the relay stamps on every register. ECS authorizes the tags
 * on that register as a separate ecs:TagResource call (verified live: a
 * deploy died on exactly that denial), satisfied by the same request-tag
 * condition.
 */
const PHASE_4_DEPLOY_CREATE_ACTIONS = ['ecs:RegisterTaskDefinition', 'ecs:TagResource'] as const;

// ── Application-stack provisioning (the CloudFormation execution role) ──────
//
// Creates: conditioned on the installation REQUEST tag. CloudFormation
// propagates the stack-level `Tags` the relay passes on `CreateStack` onto
// every resource that supports tag-on-create, so these conditions are
// satisfied by the same tag the verifier later reads back off the stack.
const PROVISION_CREATE_ACTIONS = [
  'ec2:CreateVpc',
  'ec2:CreateSubnet',
  'ec2:CreateRouteTable',
  'ec2:CreateInternetGateway',
  'ec2:CreateNatGateway',
  'ec2:AllocateAddress',
  'ec2:CreateSecurityGroup',
  'ec2:CreateTags',
  'ecs:CreateCluster',
  'ecs:CreateService',
  'ecs:RegisterTaskDefinition',
  'ecs:TagResource',
  'rds:CreateDBSubnetGroup',
  'rds:CreateDBInstance',
  'rds:AddTagsToResource',
  'elasticloadbalancing:CreateLoadBalancer',
  'elasticloadbalancing:CreateTargetGroup',
  'elasticloadbalancing:CreateListener',
  'elasticloadbalancing:AddTags',
  'secretsmanager:CreateSecret',
  'secretsmanager:TagResource',
  'logs:CreateLogGroup',
  'logs:TagResource',
  'elasticache:CreateCacheSubnetGroup',
  'elasticache:CreateReplicationGroup',
  'elasticache:AddTagsToResource',
  'iam:TagRole',
  // The application stack's UnhealthyTargetAlarm gets stack-level deployz
  // tags via that stack's Tags.of aspect, and CreateStack passes the
  // installation tag, so the request-tag condition on this statement is
  // satisfied the same way it is for elasticache:AddTagsToResource (see the
  // comment further below).
  'cloudwatch:PutMetricAlarm',
  'cloudwatch:TagResource',
] as const;

// Modifies and deletes: conditioned on the installation RESOURCE tag. By the
// time any of these runs, the resource already carries the tag the matching
// create applied.
const PROVISION_MANAGE_ACTIONS = [
  'ec2:CreateRoute',
  'ec2:DeleteRoute',
  'ec2:AssociateRouteTable',
  'ec2:DisassociateRouteTable',
  'ec2:AttachInternetGateway',
  'ec2:DetachInternetGateway',
  'ec2:ModifyVpcAttribute',
  // The secondary VPC CIDR for the database-only subnets
  // (AWS::EC2::VPCCidrBlock) acts on the tagged VPC.
  'ec2:AssociateVpcCidrBlock',
  'ec2:DisassociateVpcCidrBlock',
  'ec2:ModifySubnetAttribute',
  'ec2:AuthorizeSecurityGroupIngress',
  'ec2:AuthorizeSecurityGroupEgress',
  'ec2:RevokeSecurityGroupIngress',
  'ec2:RevokeSecurityGroupEgress',
  'ec2:DeleteVpc',
  'ec2:DeleteSubnet',
  'ec2:DeleteRouteTable',
  'ec2:DeleteInternetGateway',
  'ec2:DeleteNatGateway',
  'ec2:ReleaseAddress',
  'ec2:DeleteSecurityGroup',
  'ec2:DeleteTags',
  'ecs:DeleteCluster',
  'ecs:UpdateService',
  'ecs:DeleteService',
  'rds:ModifyDBInstance',
  'rds:DeleteDBInstance',
  'rds:DeleteDBSubnetGroup',
  'elasticloadbalancing:ModifyLoadBalancerAttributes',
  'elasticloadbalancing:ModifyTargetGroup',
  'elasticloadbalancing:ModifyTargetGroupAttributes',
  'elasticloadbalancing:ModifyListener',
  'elasticloadbalancing:DeleteLoadBalancer',
  'elasticloadbalancing:DeleteTargetGroup',
  'elasticloadbalancing:DeleteListener',
  'elasticloadbalancing:RegisterTargets',
  'elasticloadbalancing:DeregisterTargets',
  'secretsmanager:GetSecretValue',
  'secretsmanager:PutSecretValue',
  'secretsmanager:UpdateSecret',
  'secretsmanager:DeleteSecret',
  'secretsmanager:GetResourcePolicy',
  'secretsmanager:PutResourcePolicy',
  'elasticache:DeleteCacheSubnetGroup',
  'elasticache:ModifyReplicationGroup',
  'elasticache:DeleteReplicationGroup',
  // Recovery and rollback paths may still meet legacy CacheCluster
  // resources from stacks created before the replication group.
  'elasticache:DeleteCacheCluster',
  'iam:DeleteRolePolicy',
  'iam:DetachRolePolicy',
  'iam:DeleteRole',
  'iam:UntagRole',
  'cloudwatch:DeleteAlarms',
] as const;

/**
 * Reads. None of these support resource-level permissions, so a tag
 * condition on them would never match and would deny the whole stack.
 */
const PROVISION_READ_ACTIONS = [
  'ec2:DescribeVpcs',
  'ec2:DescribeVpcAttribute',
  'ec2:DescribeSubnets',
  'ec2:DescribeRouteTables',
  'ec2:DescribeInternetGateways',
  'ec2:DescribeNatGateways',
  'ec2:DescribeAddresses',
  'ec2:DescribeSecurityGroups',
  'ec2:DescribeSecurityGroupRules',
  // Not a Describe*, and easy to miss for that reason: ELBv2 calls it for
  // the caller while creating a load balancer, and a live install failed
  // with "not authorized to perform: ec2:GetSecurityGroupsForVpc".
  'ec2:GetSecurityGroupsForVpc',
  'ec2:DescribeAvailabilityZones',
  'ec2:DescribeAccountAttributes',
  'ec2:DescribeNetworkInterfaces',
  'ec2:DescribeTags',
  'ecs:DescribeClusters',
  'ecs:DescribeServices',
  'ecs:DescribeTaskDefinition',
  'ecs:ListTagsForResource',
  'rds:DescribeDBInstances',
  'rds:DescribeDBSubnetGroups',
  'rds:ListTagsForResource',
  'elasticloadbalancing:DescribeLoadBalancers',
  'elasticloadbalancing:DescribeLoadBalancerAttributes',
  'elasticloadbalancing:DescribeTargetGroups',
  'elasticloadbalancing:DescribeTargetGroupAttributes',
  'elasticloadbalancing:DescribeListeners',
  'elasticloadbalancing:DescribeTags',
  'elasticloadbalancing:DescribeTargetHealth',
  'secretsmanager:DescribeSecret',
  'secretsmanager:ListSecretVersionIds',
  'logs:DescribeLogGroups',
  'logs:ListTagsForResource',
  'elasticache:DescribeCacheClusters',
  'elasticache:DescribeReplicationGroups',
  'elasticache:DescribeCacheSubnetGroups',
  'elasticache:ListTagsForResource',
  'iam:GetRole',
  'iam:GetRolePolicy',
  'iam:ListRolePolicies',
  'iam:ListAttachedRolePolicies',
  'iam:ListRoleTags',
  'cloudwatch:DescribeAlarms',
] as const;

/**
 * S3 bucket lifecycle. S3 supports neither condition: `CreateBucket` takes
 * no request tags (CloudFormation tags the bucket afterwards, with
 * `PutBucketTagging`), and bucket actions do not honour `aws:ResourceTag`.
 * Granted without a tag condition rather than with one that could never
 * match, and scoped by bucket name instead: the application bucket has no
 * `BucketName`, so CloudFormation names it after the application stack
 * (`deployz-app-<short installation id>-…`). No other bucket in the account,
 * and no other installation's bucket, is reachable.
 */
const PROVISION_STORAGE_ACTIONS = [
  's3:CreateBucket',
  's3:DeleteBucket',
  's3:ListBucket',
  's3:GetBucketLocation',
  's3:GetBucketTagging',
  's3:PutBucketTagging',
  's3:GetBucketVersioning',
  's3:PutBucketVersioning',
  's3:GetEncryptionConfiguration',
  's3:PutEncryptionConfiguration',
  's3:GetBucketPublicAccessBlock',
  's3:PutBucketPublicAccessBlock',
  's3:GetBucketPolicy',
  's3:PutBucketPolicy',
  's3:DeleteBucketPolicy',
  's3:GetBucketAcl',
  's3:GetLifecycleConfiguration',
  's3:PutLifecycleConfiguration',
] as const;

/**
 * Actions AWS provides no usable tag condition for.
 *
 * Every entry here was moved out of the request-tag or resource-tag
 * statement above because a live probe stack proved the condition never
 * matches, not because scoping was inconvenient:
 *
 * - `secretsmanager:GetRandomPassword` acts on no resource at all — it
 *   returns a random string. `GenerateSecretString` (the database master
 *   password) calls it, so without this the application stack cannot create
 *   its database secret.
 * - `ecs:DeregisterTaskDefinition` supports no resource-level permissions:
 *   ECS task definitions carry tags, but the action does not evaluate them
 *   and an ARN-scoped grant never matches. Deregistering a revision does not
 *   stop a task that runs it.
 *
 * Both stay on `*`. They are contained by the role's trust policy, which
 * admits only CloudFormation acting for this account.
 */
const PROVISION_UNTAGGABLE_ACTIONS = [
  'secretsmanager:GetRandomPassword',
  'ecs:DeregisterTaskDefinition',
] as const;

/**
 * `logs:PutRetentionPolicy` and `logs:DeleteLogGroup` take a log-group ARN
 * but do not honour `aws:ResourceTag`, even on a log group CloudFormation
 * has already tagged. Scoped by log-group name instead: the application
 * stack sets no `LogGroupName`, so CloudFormation names each log group after
 * the application stack (`deployz-app-<short installation id>-…`).
 */
const PROVISION_LOG_GROUP_ACTIONS = ['logs:PutRetentionPolicy', 'logs:DeleteLogGroup'] as const;

/**
 * The `elasticache:*ReplicationGroup` lifecycle actions authorize against
 * MULTIPLE resource ARNs, not just the replication group. A live install
 * proved that `CreateReplicationGroup` is also evaluated against the
 * DEFAULT parameter group (`arn:...:parametergroup:*`), which carries no
 * request tag and no resource tag, so no tagged statement can ever match it
 * — the create is denied and the stack rolls back, and the rollback then
 * wedges on `DeleteReplicationGroup` against a group that never received its
 * tag (ROLLBACK_FAILED).
 *
 * IAM allows a request only when every resource in it is allowed, so the
 * replication group itself stays in the tagged create and manage statements,
 * and this list grants the same actions on the companion resources only: the
 * parameter group and the member cache clusters. A request against another
 * installation's replication group is still denied by its tag.
 */
const PROVISION_CACHE_COMPANION_ACTIONS = [
  'elasticache:CreateReplicationGroup',
  'elasticache:ModifyReplicationGroup',
  'elasticache:DeleteReplicationGroup',
] as const;

/** The services the application stack needs service-linked roles for. */
const PROVISION_SERVICE_LINKED_ROLE_SERVICES = [
  'ecs.amazonaws.com',
  'elasticloadbalancing.amazonaws.com',
  'rds.amazonaws.com',
  'elasticache.amazonaws.com',
] as const;

/** The services the execution role may hand the application task roles to. */
const PROVISION_PASS_ROLE_SERVICES = ['ecs-tasks.amazonaws.com', 'ecs.amazonaws.com'] as const;

/**
 * The services the APPLICATION stack's execution role may hand roles to —
 * the relay's own PassRole grant (`PROVISION_PASS_ROLE_SERVICES` above)
 * deliberately stays ECS-only: the relay registers task definitions, never
 * schedules, so it has no business passing a role to Scheduler. Only the
 * CloudFormation execution role that creates `AWS::Scheduler::Schedule`
 * resources (Phase 5) needs the extra service.
 */
const PROVISION_APPLICATION_PASS_ROLE_SERVICES = [
  ...PROVISION_PASS_ROLE_SERVICES,
  'scheduler.amazonaws.com',
] as const;

/**
 * SQS queue lifecycle (Phase 5: `AWS::SQS::Queue` + `AWS::SQS::QueuePolicy`).
 * CloudFormation also calls `GetQueueUrl` to resolve a queue's URL from its
 * name/ARN. SQS's resource-level policy support does not reliably honour
 * `aws:RequestTag`/`aws:ResourceTag` across every one of these actions, so —
 * per the same "don't grant a condition that can never match" rule the
 * S3/ElastiCache/CloudWatch-Logs untaggable actions above follow — this is
 * scoped by resource ARN instead: every application-stack queue's
 * CloudFormation-generated name (no `QueueName` is set) is
 * `<application stack name>-<LogicalId>-<suffix>`, and the application stack
 * name is `deployz-app-<short installation id>`
 * (`applicationStackNameForInstallation` in `@deployz/contracts`), so the
 * grant reaches this installation's queues only.
 */
const PROVISION_SQS_ACTIONS = [
  'sqs:CreateQueue',
  'sqs:GetQueueAttributes',
  'sqs:SetQueueAttributes',
  'sqs:DeleteQueue',
  'sqs:TagQueue',
  'sqs:UntagQueue',
  'sqs:ListQueueTags',
  'sqs:GetQueueUrl',
] as const;

/**
 * `AWS::Scheduler::Schedule` lifecycle (Phase 5). Schedules carry no tags at
 * all — unlike everything else in this file, there is no tag condition to
 * even attempt — so this is scoped by resource ARN: the `default` schedule
 * group CloudFormation uses, and the compiler names every schedule
 * `<application stack name>-<ScheduleId>` (same installation prefix as the
 * queue actions above).
 */
const PROVISION_SCHEDULER_ACTIONS = [
  'scheduler:CreateSchedule',
  'scheduler:GetSchedule',
  'scheduler:UpdateSchedule',
  'scheduler:DeleteSchedule',
] as const;

export class BootstrapStack extends Stack {
  public readonly relayFunction: NodejsFunction;
  public readonly relayRole: Role;
  public readonly credentialSecretArn: string;
  public readonly permissionsBoundary: ManagedPolicy;
  public readonly provisionerPolicy: ManagedPolicy;
  /** The relay's PURGE grants, apart from `provisionerPolicy` for the size quota. */
  public readonly provisionerPurgePolicy: ManagedPolicy;
  /** CloudFormation execution role for the application stack (`role/deployz/*`). */
  public readonly applicationExecutionRole: Role;
  /** Permissions boundary every application-stack role must carry. */
  public readonly applicationRoleBoundary: ManagedPolicy;
  /** Deploy-time token resolving to the minted installation UUID. */
  public readonly installationId: string;

  constructor(scope: Construct, id: string, props: BootstrapStackProps = {}) {
    super(scope, id, props);

    // ── Control-plane URL (non-secret parameter) ────────────────────────
    const controlPlaneUrlParam = new CfnParameter(this, 'ControlPlaneUrl', {
      type: 'String',
      description:
        'Base URL of the Deployz control plane the relay polls. NOT a credential.',
      default: props.controlPlaneUrl ?? DEFAULT_CONTROL_PLANE_URL,
    });

    // ── Enrollment code (single-use, non-secret parameter) ──────────────
    //
    // The one thing that ties this stack to a deployment in the control
    // plane. The installation identifier below is minted HERE, inside the
    // customer's account, so the control plane has never seen it and cannot
    // look anything up by it — without this code the relay's first call
    // would 404 and the deployment would never leave "Not installed".
    //
    // Single use: the control plane burns it when it binds this relay's id
    // and token, and refuses any later attempt to bind the same code to a
    // different relay. That is what stops whoever holds the install link
    // from registering a token of their own and taking the deployment over.
    const enrollmentCodeParam = new CfnParameter(this, 'EnrollmentCode', {
      type: 'String',
      description:
        'Single-use code from your install link. Ties this installation to your deployment.',
      default: props.enrollmentCode ?? '',
    });

    // ── 1. Installation identifier (minted at deploy time) ──────────────
    const installIdFunction = new NodejsFunction(this, 'InstallIdFunction', {
      runtime: Runtime.NODEJS_22_X,
      entry: join(import.meta.dirname, '..', '..', 'src', 'lambda', 'bootstrap-init.ts'),
      handler: 'handler',
      timeout: Duration.minutes(1),
      memorySize: 128,
      logRetention: RetentionDays.ONE_WEEK,
      bundling: {
        format: 'esm' as OutputFormat,
        target: 'node22',
        sourceMap: false,
      },
    });

    const installIdProvider = new Provider(this, 'InstallIdProvider', {
      onEventHandler: installIdFunction,
      logRetention: RetentionDays.ONE_WEEK,
    });

    const installIdResource = new CustomResource(this, 'InstallationId', {
      serviceToken: installIdProvider.serviceToken,
    });

    this.installationId = installIdResource.getAttString('InstallationId');

    // ── 2. Communication credential (server-established or bootstrap-generated) ─
    //
    // DZ-AUDIT-013: when the control plane provides a relay credential via the
    // `RelayCredential` parameter, the stack uses it as the secret value.
    // Otherwise CloudFormation generates one via GenerateSecretString (legacy
    // behavior, preserved for existing in-flight deployments).
    //
    // Two mutually exclusive CfnSecret resources — one is always created, the
    // other conditioned out. The ARN is resolved via Fn::ConditionIf. The relay
    // reads the secret by the ARN in DEPLOYZ_CREDENTIAL_SECRET_ARN unchanged.
    const relayCredentialParam = new CfnParameter(this, 'RelayCredential', {
      type: 'String',
      description:
        'Server-established relay credential. When set, used as the ' +
        'secret value instead of generating one inside the account. ' +
        'Not a customer secret.',
      default: '',
      noEcho: true,
    });

    const hasRelayCredential = new CfnCondition(this, 'HasRelayCredential', {
      expression: Fn.conditionNot(Fn.conditionEquals(relayCredentialParam.valueAsString, '')),
    });
    const noRelayCredential = new CfnCondition(this, 'NoRelayCredential', {
      expression: Fn.conditionEquals(relayCredentialParam.valueAsString, ''),
    });

    // Shared tags for both secret variants.
    const credentialTags = [
      { key: 'deployz:component', value: 'bootstrap' },
      { key: 'deployz:installation', value: this.installationId },
    ];

    // Secret from the server-established parameter — created when the
    // parameter is non-empty.
    const cfnSecretFromParam = new CfnSecret(this, 'RelayCredentialFromParam', {
      description:
        'Server-established relay communication credential. Value was ' +
        'minted by the control plane and delivered via the Quick Create URL.',
      // The relay reads this secret as JSON and takes its `token` field
      // (packages/relay/src/auth.ts, readCredential), which is the shape the
      // generated variant below produces via generateStringKey. Storing the
      // parameter bare makes every relay poll fail to parse it, so the
      // installation never enrols. mintRelayCredential returns 64 hex
      // characters, so there is nothing here that needs JSON escaping.
      secretString: Fn.join('', ['{"token":"', relayCredentialParam.valueAsString, '"}']),
      tags: credentialTags,
    });
    cfnSecretFromParam.cfnOptions.condition = hasRelayCredential;

    // Bootstrap-generated secret — created when the parameter is empty
    // (legacy and pre-established links that carry no credential).
    const cfnSecretGenerated = new CfnSecret(this, 'RelayCredentialGenerated', {
      description:
        'Bootstrap-generated relay communication credential. Minted by ' +
        'CloudFormation at deploy time; registered with the control plane ' +
        'on the relay first poll.',
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'token',
        passwordLength: 64,
        excludePunctuation: false,
      },
      tags: credentialTags,
    });
    cfnSecretGenerated.cfnOptions.condition = noRelayCredential;

    // Conditional ARN for use where only one value is allowed (Lambda env,
    // stack output). Resolved via Fn::ConditionIf.
    //
    // Ref on an AWS::SecretsManager::Secret returns the secret's ARN; the
    // type has no `Arn` attribute, so Fn::GetAtt makes CloudFormation reject
    // the whole template ("Requested attribute Arn does not exist in schema
    // for AWS::SecretsManager::Secret") and every install fails on the first
    // stack a customer deploys.
    const credentialArn = Fn.conditionIf(
      'HasRelayCredential',
      Fn.ref('RelayCredentialFromParam'),
      Fn.ref('RelayCredentialGenerated'),
    );

    this.credentialSecretArn = Token.asString(credentialArn);

    // ── 3. Installation scope ───────────────────────────────────────────
    //
    // Several deployments can share one AWS account and Region, each with its
    // own connector. Every grant below is limited to this installation: by
    // the `deployz:installation` tag where AWS evaluates it, and otherwise by
    // name. The application stack is `deployz-app-<short installation id>`
    // (`applicationStackNameForInstallation` in `@deployz/contracts`: the
    // first group of the installation UUID), and CloudFormation names every
    // unnamed resource after its stack.
    const applicationPrefix = `deployz-app-${Fn.select(0, Fn.split('-', this.installationId))}-`;

    // Added to the request-tag statements. A request tag alone would let a
    // tagging call stamp this installation's tag over another installation's
    // resource and so take it over; this denies a resource that already
    // carries a different installation's tag. A new resource has no tag yet.
    const notAnotherInstallation = {
      'aws:ResourceTag/deployz:installation': this.installationId,
    };

    // The cluster of this installation's application stack.
    const ownCluster = {
      'ecs:cluster': `arn:aws:ecs:${this.region}:${this.account}:cluster/${applicationPrefix}*`,
    };

    // ── 3a. CloudFormation execution role for the application stack ─────
    //
    // The relay asks CloudFormation to create the application stack;
    // CloudFormation builds it. Those are two different principals, and only
    // the first is the relay. Passing this role on `CreateStack` is what
    // keeps it that way: the relay itself has no `ec2:CreateVpc`, no
    // `rds:CreateDBInstance` and no `iam:CreateRole`, and should not — it may
    // only ask CloudFormation to apply a published template that does.
    //
    // The path is `/deployz/`, which the permissions boundary's
    // `iam:PassRole` ceiling (`role/deployz/*`) admits; the provisioner
    // policy passes this one role only.
    //
    // Four things bound the role:
    //
    //   1. Who may assume it — only `cloudformation.amazonaws.com`, and only
    //      on behalf of THIS account. Not the relay, not a user, and not
    //      CloudFormation acting for anyone else.
    //   2. The installation tag — creates require the REQUEST tag, modifies
    //      and deletes require the RESOURCE tag. Both are satisfied by the
    //      stack-level `Tags` the relay passes on `CreateStack`, which
    //      CloudFormation propagates onto every resource that supports
    //      tagging. That is the same tag `verifyInstallation` reads back, so
    //      a stack that provisions is a stack that verifies.
    //   3. No wildcards — every action is named. A bare `ec2:*` would make
    //      the tag conditions decorative, since it would carry actions that
    //      cannot be tag-conditioned at all.
    //   4. The application role boundary — every IAM role it creates, or
    //      grants a policy to, must carry `applicationRoleBoundary` (below).
    //      Without it the role could create a tagged role with any policy
    //      and pass it to ECS: account administrator by one step. The
    //      boundary on THIS role would not help — a boundary does not carry
    //      over to the roles a principal creates.
    //
    // Reads, S3 bucket operations and `iam:CreateServiceLinkedRole` are the
    // three groups that genuinely cannot carry a tag condition; each is
    // granted without one, and scoped by whatever AWS does support, rather
    // than with a condition that could never match. See the action lists.
    this.applicationExecutionRole = new Role(this, 'ApplicationExecutionRole', {
      path: '/deployz/',
      assumedBy: new ServicePrincipal('cloudformation.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
        },
      }),
      description:
        'CloudFormation execution role for the Deployz application stack. Assumable only by ' +
        'CloudFormation on behalf of this account; every grant is scoped to the deployz: tag ' +
        'boundary where AWS supports it.',
    });

    // ── 3b. Relay role — least privilege + permissions boundary ─────────
    const phase1LogWrite = new PolicyStatement({
      sid: 'RelayWriteLogs',
      effect: Effect.ALLOW,
      actions: [...PHASE_1_LOG_WRITE_ACTIONS],
      resources: ['*'],
    });

    const phase1SecretAccess = new PolicyStatement({
      sid: 'RelayAccessCredential',
      effect: Effect.ALLOW,
      actions: [...PHASE_1_SECRET_ACTIONS],
      // Only this connector's own credential secret. DZ-AUDIT-013 creates one
      // of two mutually exclusive CfnSecrets, so the grant takes the same
      // Fn::If ARN the relay reads from DEPLOYZ_CREDENTIAL_SECRET_ARN. The
      // boundary (below) carries this identical statement.
      resources: [this.credentialSecretArn],
    });

    const phase2VerifyStack = new PolicyStatement({
      sid: 'RelayVerifyInstallation',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_VERIFY_STACK_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
        },
      },
    });

    // Phase 2 — provisioner permissions, all constrained by the deployz: tag
    // boundary. Create/update requires the deployz:installation request tag;
    // manage/delete requires the resource already carries it.
    const phase2CreateStacks = new PolicyStatement({
      sid: 'ProvisionerCreateStacks',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_CREATE_STACK_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:RequestTag/deployz:installation': this.installationId,
        },
        StringEqualsIfExists: notAnotherInstallation,
      },
    });

    const phase2ManageStacks = new PolicyStatement({
      sid: 'ProvisionerManageStacks',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_MANAGE_STACK_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
        },
      },
    });

    // Only this connector's own execution role, never another deployment's.
    const phase2PassRole = new PolicyStatement({
      sid: 'ProvisionerPassRole',
      effect: Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [this.applicationExecutionRole.roleArn],
      conditions: {
        StringEquals: {
          'iam:PassedToService': 'cloudformation.amazonaws.com',
        },
      },
    });

    const phase2AppResources = new PolicyStatement({
      sid: 'ProvisionerAppResourceManage',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_APP_RESOURCE_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
        },
      },
    });

    // Phase 2 — custom-domain certificate lifecycle (custom-domains MVP).
    // Request/tag requires the request tag (same pattern as stack create);
    // ACM has no way to scope RequestCertificate to a resource ARN, since the
    // certificate doesn't exist yet.
    const phase2AcmRequest = new PolicyStatement({
      sid: 'ProvisionerAcmRequest',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_ACM_REQUEST_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:RequestTag/deployz:installation': this.installationId,
        },
        StringEqualsIfExists: notAnotherInstallation,
      },
    });

    // Describe/delete/list-tags requires the certificate already carries the
    // installation's resource tag (same pattern as stack manage/delete).
    const phase2AcmManage = new PolicyStatement({
      sid: 'ProvisionerAcmManage',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_ACM_MANAGE_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
        },
      },
    });

    // Phase 2 — custom-domain HTTPS listener management on the deployment's
    // ALB. The Describe* actions do not support resource-level restrictions,
    // so they stay condition-free (read-only); the listener-write actions are
    // scoped to the ALB/listener resources carrying the installation's tag.
    const domainIngressReadActions = PHASE_2_DOMAIN_INGRESS_ACTIONS.filter((action) =>
      action.startsWith('elasticloadbalancing:Describe'),
    );
    const domainIngressWriteActions = PHASE_2_DOMAIN_INGRESS_ACTIONS.filter(
      (action) => !action.startsWith('elasticloadbalancing:Describe'),
    );

    const phase2DomainIngressDescribe = new PolicyStatement({
      sid: 'ProvisionerDomainIngressDescribe',
      effect: Effect.ALLOW,
      actions: domainIngressReadActions,
      resources: ['*'],
    });

    const phase2DomainIngressWrite = new PolicyStatement({
      sid: 'ProvisionerDomainIngressWrite',
      effect: Effect.ALLOW,
      actions: domainIngressWriteActions,
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
        },
      },
    });

    // The relay creates the 443 listener itself (elasticloadbalancing:
    // CreateListener above), unlike the 80 listener, which CloudFormation
    // creates and tags via the application stack's `Tags`. A resource-tag
    // condition can never authorize the FIRST tag on a resource that doesn't
    // carry it yet — the exact defect that left two production listeners
    // untaggable and their DeleteListener/ModifyListener/
    // AddListenerCertificates calls permanently AccessDenied (verified
    // live). So, like acm:AddTagsToCertificate and
    // elasticache:AddTagsToResource above, AddTags is scoped by the REQUEST
    // tag instead. ForAllValues:StringEquals on aws:TagKeys additionally
    // caps every request to ONLY the deployz:installation key, so the grant
    // can never be used to stamp arbitrary other tags onto an ELB resource.
    const phase2DomainIngressTag = new PolicyStatement({
      sid: 'ProvisionerDomainIngressTag',
      effect: Effect.ALLOW,
      actions: ['elasticloadbalancing:AddTags'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:RequestTag/deployz:installation': this.installationId,
        },
        StringEqualsIfExists: notAnotherInstallation,
        'ForAllValues:StringEquals': {
          'aws:TagKeys': ['deployz:installation'],
        },
      },
    });

    // Phase 2 — ElastiCache Valkey cache lifecycle (Redis MVP). Split the same
    // way as the ACM + domain-ingress precedent above:
    //   - Create* actions provision a brand-new resource that doesn't exist
    //     yet, so (like acm:RequestCertificate) they can only be scoped by the
    //     REQUEST tag applied at creation time, not a resource tag.
    //   - Delete/Modify actions operate on a resource that already carries
    //     the installation's tag, so they are scoped by the RESOURCE tag
    //     (like ACM manage / stack manage).
    //   - Describe* actions do NOT support resource-level permissions in
    //     ElastiCache (same limitation as the ELB Describe* calls above), so
    //     they stay condition-free rather than carrying a condition that
    //     would never actually be evaluated.
    //
    // elasticache:AddTagsToResource sits in the CREATE bucket, not manage,
    // even though its name suggests "manage" — same reasoning ACM applies to
    // acm:AddTagsToCertificate (see PHASE_2_ACM_REQUEST_ACTIONS above). A
    // ResourceTag condition can only match a tag the resource ALREADY
    // carries; it can never authorize the FIRST call that applies
    // deployz:installation to a brand-new, untagged cache — that would be
    // asking the resource to already have the tag the call is meant to add.
    // Two things make this safe: (1) the primary tagging path is tags-on-
    // create — Task 7's ApplicationStack sets `Tags` directly on
    // CfnReplicationGroup/CfnSubnetGroup, so CloudFormation creates them already
    // tagged via the Create* calls (which the RequestTag condition does
    // cover); (2) any subsequent AddTagsToResource — e.g. CloudFormation
    // re-applying the full tag set on a stack update — resends
    // deployz:installation as part of the request, so it still satisfies a
    // RequestTag condition. ListTagsForResource is condition-free, like the
    // RDS precedent (PHASE_2_PURGE_RDS_DISCOVER_ACTIONS): PURGE reads the tags
    // of EVERY replication group in the region to find its own, and a
    // ResourceTag condition denied the read of a sibling installation's group
    // and failed the whole purge (PURGE_FAILED, found on real AWS).
    const cacheDescribeActions = PHASE_2_CACHE_ACTIONS.filter(
      (action) => action.startsWith('elasticache:Describe') || action === 'elasticache:ListTagsForResource',
    );
    const cacheCreateActions = PHASE_2_CACHE_ACTIONS.filter(
      (action) =>
        action.startsWith('elasticache:Create') || action === 'elasticache:AddTagsToResource',
    );
    const cacheManageActions = PHASE_2_CACHE_ACTIONS.filter(
      (action) => !cacheCreateActions.includes(action) && !cacheDescribeActions.includes(action),
    );

    const phase2CacheCreate = new PolicyStatement({
      sid: 'ProvisionerCacheCreate',
      effect: Effect.ALLOW,
      actions: cacheCreateActions,
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:RequestTag/deployz:installation': this.installationId,
        },
        StringEqualsIfExists: notAnotherInstallation,
      },
    });

    const phase2CacheManage = new PolicyStatement({
      sid: 'ProvisionerCacheManage',
      effect: Effect.ALLOW,
      actions: cacheManageActions,
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
        },
      },
    });

    const phase2CacheDescribe = new PolicyStatement({
      sid: 'ProvisionerCacheDescribe',
      effect: Effect.ALLOW,
      actions: cacheDescribeActions,
      resources: ['*'],
    });

    // Phase 2 — the relay's durable note of an unfinished command. Scoped by
    // parameter ARN: the name embeds the installation id, so one relay can
    // never read or overwrite another installation's.
    const phase2RelayState = new PolicyStatement({
      sid: 'RelayPendingCommandState',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_RELAY_STATE_ACTIONS],
      resources: [
        Stack.of(this).formatArn({
          service: 'ssm',
          resource: 'parameter',
          resourceName: `deployz/${this.installationId}/*`,
        }),
      ],
    });

    // Phase 2 — PURGE's S3 sweep. Bucket actions cannot honour
    // aws:ResourceTag, so discovery is condition-free and the deletes are
    // limited to this installation's bucket names; the purge executor also
    // verifies ownership per bucket via GetBucketTagging and refuses anything
    // that does not carry this installation's tag.
    const phase2PurgeStorageDiscover = new PolicyStatement({
      sid: 'RelayPurgeStorageDiscover',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_PURGE_STORAGE_DISCOVER_ACTIONS],
      resources: ['*'],
    });
    const phase2PurgeStorage = new PolicyStatement({
      sid: 'RelayPurgeStorage',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_PURGE_STORAGE_ACTIONS],
      resources: [`arn:aws:s3:::${applicationPrefix}*`],
    });

    // Phase 9 — PURGE's RDS orphan discovery. Condition-free reads (see the
    // const): the orphan sweep verifies ownership itself via the returned
    // tags before touching any instance, and refuses what it cannot verify.
    const phase2PurgeRdsDiscover = new PolicyStatement({
      sid: 'RelayPurgeRdsDiscover',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_PURGE_RDS_DISCOVER_ACTIONS],
      resources: ['*'],
    });

    // Phase 9 — PURGE's retained-DB-credential sweep. ListSecrets +
    // DescribeSecret are condition-free discovery reads (account-level,
    // read-only; the sweep verifies ownership from the returned tags, and a
    // condition on DescribeSecret would deny the ownership check for every
    // foreign secret in the account). DeleteSecret is resource-tag-scoped: a
    // retained DatabaseSecret/DatabaseUrlSecret already carries this
    // installation's deployz:installation tag (the application stack applies
    // it), so the condition matches exactly the secrets the sweep may delete.
    const phase2PurgeSecretsList = new PolicyStatement({
      sid: 'RelayPurgeSecretsList',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_PURGE_SECRET_DISCOVER_ACTIONS],
      resources: ['*'],
    });
    // One tag-scoped statement for every secret operation on this
    // installation's own secrets: PURGE's delete of the retained credentials,
    // and CONFIG_UPDATE's read-merge-write of the application's
    // `AppConfigSecret` (DEPLOY-012). One statement, not two: the provisioner
    // policy sits a few dozen characters under IAM's managed-policy size cap.
    const phase2InstallationSecrets = new PolicyStatement({
      sid: 'RelayInstallationSecrets',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_PURGE_SECRET_DELETE_ACTIONS, ...PHASE_2_CONFIG_SECRET_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
        },
      },
    });

    // Phase 11 — PURGE's ACM certificate orphan sweep. The default-HTTPS and
    // custom-domain certificates live OUTSIDE the application stack, so a
    // force-completed destroy (relay offline) would leave them orphaned.
    // ListCertificates and ListTagsForCertificate are condition-free
    // discovery reads (account-level; the sweep verifies ownership from the
    // returned tags exactly like the RDS/secrets sweeps). The tag read MUST be
    // condition-free: the sweep reads every certificate's tags to decide
    // ownership, and a tag-scoped grant is denied on any certificate that is
    // not ours (e.g. the control plane's own), which the sweep correctly
    // refuses to treat as "not ours" — so the purge never completed and the
    // retained network resources leaked (version canary). Deletion needs no
    // new grant — ProvisionerAcmManage's tag-scoped acm:DeleteCertificate
    // already covers owned certificates.
    const phase2PurgeAcmDiscover = new PolicyStatement({
      sid: 'RelayPurgeAcmDiscover',
      effect: Effect.ALLOW,
      actions: ['acm:ListCertificates', 'acm:ListTagsForCertificate'],
      resources: ['*'],
    });

    // CANARY-015 — PURGE's orphaned-network sweep. Condition-free reads (see
    // the const): the sweep verifies ownership itself from the returned tags
    // before touching anything, same as every other purge client above.
    const phase2PurgeNetworkDiscover = new PolicyStatement({
      sid: 'RelayPurgeNetworkDiscover',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_PURGE_NETWORK_DISCOVER_ACTIONS],
      resources: ['*'],
    });
    // Resource-tag-scoped: every VPC/subnet/security-group/subnet-group
    // orphan already carries this installation's tag from its ORIGINAL
    // create call, so the condition matches exactly what the sweep may
    // delete.
    const phase2PurgeNetworkDelete = new PolicyStatement({
      sid: 'RelayPurgeNetworkDelete',
      effect: Effect.ALLOW,
      actions: [...PHASE_2_PURGE_NETWORK_DELETE_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
        },
      },
    });

    // Phase 4 — deploy/rollback/restart. ListTasks/DescribeTasks/
    // DescribeTaskDefinition carry no usable tag condition (see the const);
    // RegisterTaskDefinition is bounded by the installation request tag the
    // executor stamps on every copy it registers; RunTask and StopTask by
    // this installation's cluster.
    const phase4DeployObserve = new PolicyStatement({
      sid: 'RelayDeployObserve',
      effect: Effect.ALLOW,
      actions: [...PHASE_4_DEPLOY_OBSERVE_ACTIONS],
      resources: ['*'],
    });

    const phase4DeployCreate = new PolicyStatement({
      sid: 'RelayDeployRegister',
      effect: Effect.ALLOW,
      actions: [...PHASE_4_DEPLOY_CREATE_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:RequestTag/deployz:installation': this.installationId,
        },
        StringEqualsIfExists: notAnotherInstallation,
      },
    });

    // ECS does not support resource-level permissions, tags or condition
    // keys for DeregisterTaskDefinition, so an ARN-scoped grant never
    // matches and it stays on `*`. The relay code restricts it to this
    // installation's suffixed task families. Deregistering a revision does
    // not stop a task that runs it.
    const phase4DeregisterRevisions = new PolicyStatement({
      sid: 'RelayDeregisterRevisions',
      effect: Effect.ALLOW,
      actions: ['ecs:DeregisterTaskDefinition'],
      resources: ['*'],
    });

    const phase4MigrationRun = new PolicyStatement({
      sid: 'RelayMigrationRun',
      effect: Effect.ALLOW,
      actions: [...PHASE_4_TASK_RUN_ACTIONS],
      resources: ['*'],
      conditions: { ArnLike: ownCluster },
    });

    // Phase 4 — PassRole strictly to the application's own task/execution
    // roles, only when handed to ECS. Two shapes: role/deployz/ is the
    // contract (application-stack roles carry the /deployz/ path), and the
    // default path covers installs created before that path existed (a
    // deploy against them died on PassRole, verified live).
    //
    // iam:PassRole does not reliably honour resource-tag conditions (the
    // same per-action trap DescribeTargetHealth fell into above), so it is
    // scoped by role name: CloudFormation names each application role after
    // the application stack.
    const phase4DeployPassRole = new PolicyStatement({
      sid: 'RelayDeployPassRole',
      effect: Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [
        `arn:aws:iam::${this.account}:role/deployz/${applicationPrefix}*`,
        `arn:aws:iam::${this.account}:role/${applicationPrefix}*`,
      ],
      conditions: {
        StringEquals: {
          // Task/execution roles are passed to ecs-tasks.amazonaws.com (the
          // roles' own trust principal); express-mode infrastructure roles
          // to ecs.amazonaws.com. 'ecs.amazonaws.com' alone denied every
          // RegisterTaskDefinition (verified live) — same pair the
          // provisioner's PassRole already uses.
          'iam:PassedToService': [...PROVISION_PASS_ROLE_SERVICES],
        },
      },
    });

    const phase2Statements = [
      phase2CreateStacks,
      phase2ManageStacks,
      phase2PassRole,
      phase2AppResources,
      phase2AcmRequest,
      phase2AcmManage,
      phase2DomainIngressDescribe,
      phase2DomainIngressWrite,
      phase2DomainIngressTag,
      phase2CacheCreate,
      phase4DeployObserve,
      phase4DeployCreate,
      phase4MigrationRun,
      phase4DeployPassRole,
      phase2CacheManage,
      phase2CacheDescribe,
      phase2InstallationSecrets,
    ];
    const purgeStatements = [
      phase2PurgeStorageDiscover,
      phase2PurgeStorage,
      phase2PurgeRdsDiscover,
      phase2PurgeSecretsList,
      phase2PurgeAcmDiscover,
      phase2PurgeNetworkDiscover,
      phase2PurgeNetworkDelete,
    ];

    // The permissions boundary is the CEILING for the relay role: the union of
    // phase 1 + phase 2. The role can never exceed it, including the
    // provisioner policies this stack attaches at install (below).
    //
    // The boundary is ONE managed policy and IAM caps a managed policy at
    // 6,144 non-whitespace characters. With the purge sweeps it reached 6,350
    // and CreateStack failed for every new install ("Cannot exceed quota for
    // PolicySize"). Statement ids are documentation, and the provisioner
    // policies below keep them; the boundary carries the same statements
    // without them (~550 characters). For the same reason the boundary
    // carries the wider form of the statements that are limited by name, by
    // cluster or against another installation's tag: the role is allowed only
    // what its policies AND the boundary allow, so the policies alone carry
    // that limit. bootstrap-stack.test.ts pins every policy under the quota.
    //
    // The ManagedPolicy descriptions below are stale (the provisioner policy
    // is attached at install, not by the control plane) but kept on purpose:
    // `Description` is a replacement property of AWS::IAM::ManagedPolicy, and
    // a stack update would replace both policies on every existing connector.
    const boundaryForms = new Map<PolicyStatement, PolicyStatement | undefined>([
      [phase2CreateStacks, widened(phase2CreateStacks)],
      [phase2PassRole, widened(phase2PassRole, ['arn:aws:iam::*:role/deployz/*'])],
      [phase2AcmRequest, widened(phase2AcmRequest)],
      [phase2DomainIngressTag, widened(phase2DomainIngressTag)],
      [phase2CacheCreate, widened(phase2CacheCreate)],
      [phase4DeployCreate, widened(phase4DeployCreate)],
      [
        phase4DeployObserve,
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            ...PHASE_4_DEPLOY_OBSERVE_ACTIONS,
            ...PHASE_4_TASK_RUN_ACTIONS,
            'ecs:DeregisterTaskDefinition',
          ],
          resources: ['*'],
        }),
      ],
      [phase4MigrationRun, undefined],
      [
        phase4DeployPassRole,
        widened(phase4DeployPassRole, [
          'arn:aws:iam::*:role/deployz/*',
          'arn:aws:iam::*:role/deployz-app-*',
        ]),
      ],
      [
        phase2PurgeStorageDiscover,
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [...PHASE_2_PURGE_STORAGE_DISCOVER_ACTIONS, ...PHASE_2_PURGE_STORAGE_ACTIONS],
          resources: ['*'],
        }),
      ],
      [phase2PurgeStorage, undefined],
    ]);
    this.permissionsBoundary = new ManagedPolicy(this, 'PermissionsBoundary', {
      description:
        'Maximum permissions for the Deployz relay execution role (union of ' +
        'phase 1 + phase 2). All within the deployz: tag boundary.',
      statements: [
        phase1LogWrite,
        phase1SecretAccess,
        phase2RelayState,
        ...[...phase2Statements, ...purgeStatements].flatMap((statement) => {
          if (!boundaryForms.has(statement)) return [statement];
          const form = boundaryForms.get(statement);
          return form === undefined ? [] : [form];
        }),
      ].map(withoutSid),
    });

    // Phase 2 provisioner policies — attached to the relay role at install
    // (below). Two policies, because one is over the managed-policy size
    // quota. The first one's ARN is a stack output.
    this.provisionerPolicy = new ManagedPolicy(this, 'ProvisionerPolicy', {
      description:
        'Post-first-contact provisioner permissions for the relay (phase 2). ' +
        'All within the deployz: tag boundary. Attached by the control plane.',
      statements: phase2Statements,
    });
    this.provisionerPurgePolicy = new ManagedPolicy(this, 'ProvisionerPurgePolicy', {
      description: 'Permissions the Deployz relay uses to delete the retained data of this installation.',
      statements: purgeStatements,
    });

    this.relayRole = new Role(this, 'RelayRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description:
        'Execution role for the Deployz relay Lambda. Least privilege ' +
        '(phase 1) with a permissions boundary; phase 2 provisioner policy is ' +
        'attached at install.',
      permissionsBoundary: this.permissionsBoundary,
    });
    this.relayRole.addToPolicy(phase1LogWrite);
    this.relayRole.addToPolicy(phase1SecretAccess);
    this.relayRole.addToPolicy(phase2VerifyStack);
    this.relayRole.addToPolicy(phase2RelayState);
    this.relayRole.addToPolicy(phase4DeregisterRevisions);

    // The provisioner policy used to be created and attached to nothing, on
    // the theory that the control plane would attach it after the relay's
    // first contact. It cannot: §15 forbids Deployz from holding
    // credentials in the customer's account, so no principal exists that
    // could make that call — which left the relay unable to call
    // `cloudformation:CreateStack` at all. Attach it here. The permissions
    // boundary above, which is the union of phase 1 and phase 2 and which
    // the role can never exceed, is what actually caps the grant.
    this.relayRole.addManagedPolicy(this.provisionerPolicy);
    this.relayRole.addManagedPolicy(this.provisionerPurgePolicy);

    const provisionCreate = new PolicyStatement({
      sid: 'ProvisionApplicationCreate',
      effect: Effect.ALLOW,
      actions: [...PROVISION_CREATE_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:RequestTag/deployz:installation': this.installationId,
        },
        StringEqualsIfExists: notAnotherInstallation,
      },
    });

    // The same create actions again, this time against the RESOURCE tag.
    //
    // A create is authorized against every resource in the request, not just
    // the one being made. `ec2:CreateSecurityGroup` is evaluated against the
    // new security group AND the VPC it goes in; `ec2:CreateSubnet` against
    // the VPC; `ecs:CreateService` against the cluster. The new resource
    // carries the request tag, but the parent is an existing resource that
    // carries a resource tag instead, and the statement above cannot match
    // it — a live probe stack failed here with exactly that: "not authorized
    // to perform: ec2:CreateSecurityGroup on resource: .../vpc-...".
    //
    // Two Allow statements are an OR, so each resource in the request is
    // satisfied by whichever one fits. This does not widen the boundary: a
    // brand-new, untagged resource matches neither, so an untagged security
    // group in a tagged VPC is still denied.
    const provisionCreateOnTagged = new PolicyStatement({
      sid: 'ProvisionApplicationCreateOnTagged',
      effect: Effect.ALLOW,
      actions: [...PROVISION_CREATE_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
        },
      },
    });

    const provisionManage = new PolicyStatement({
      sid: 'ProvisionApplicationManage',
      effect: Effect.ALLOW,
      actions: [...PROVISION_MANAGE_ACTIONS],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
        },
      },
    });

    const provisionRead = new PolicyStatement({
      sid: 'ProvisionApplicationRead',
      effect: Effect.ALLOW,
      actions: [...PROVISION_READ_ACTIONS],
      resources: ['*'],
    });

    const provisionUntaggable = new PolicyStatement({
      sid: 'ProvisionApplicationUntaggable',
      effect: Effect.ALLOW,
      actions: [...PROVISION_UNTAGGABLE_ACTIONS],
      resources: ['*'],
    });

    const provisionLogGroups = new PolicyStatement({
      sid: 'ProvisionApplicationLogGroups',
      effect: Effect.ALLOW,
      actions: [...PROVISION_LOG_GROUP_ACTIONS],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:${applicationPrefix}*`],
    });

    const provisionCacheCompanions = new PolicyStatement({
      sid: 'ProvisionApplicationCacheCompanions',
      effect: Effect.ALLOW,
      actions: [...PROVISION_CACHE_COMPANION_ACTIONS],
      resources: [
        `arn:aws:elasticache:${this.region}:${this.account}:parametergroup:*`,
        `arn:aws:elasticache:${this.region}:${this.account}:cluster:*`,
      ],
    });

    const provisionStorage = new PolicyStatement({
      sid: 'ProvisionApplicationStorage',
      effect: Effect.ALLOW,
      actions: [...PROVISION_STORAGE_ACTIONS],
      resources: [`arn:aws:s3:::${applicationPrefix}*`],
    });

    // The ceiling of every role the application stack creates: the union
    // of what the compiler's task-execution, task and scheduler roles are
    // granted, and nothing else — no IAM management, so a role under it
    // cannot create a way out. A role's trust policy cannot be limited by
    // IAM; this ceiling is what limits a role trusted by anyone else.
    const applicationRoleArns = `arn:aws:iam::${this.account}:role/deployz/${applicationPrefix}*`;
    this.applicationRoleBoundary = new ManagedPolicy(this, 'ApplicationRoleBoundary', {
      path: '/deployz/',
      description:
        'Permissions boundary of every IAM role the Deployz application stack creates.',
      statements: [
        new PolicyStatement({
          sid: 'ApplicationImagePull',
          effect: Effect.ALLOW,
          actions: [
            'ecr:GetAuthorizationToken',
            'ecr:BatchCheckLayerAvailability',
            'ecr:GetDownloadUrlForLayer',
            'ecr:BatchGetImage',
          ],
          resources: ['*'],
        }),
        new PolicyStatement({
          sid: 'ApplicationLogs',
          effect: Effect.ALLOW,
          actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:${applicationPrefix}*`],
        }),
        new PolicyStatement({
          sid: 'ApplicationSecrets',
          effect: Effect.ALLOW,
          actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
          resources: ['*'],
          conditions: {
            StringEquals: { 'aws:ResourceTag/deployz:installation': this.installationId },
          },
        }),
        new PolicyStatement({
          sid: 'ApplicationStorage',
          effect: Effect.ALLOW,
          actions: [
            's3:GetObject*',
            's3:GetBucket*',
            's3:List*',
            's3:DeleteObject*',
            's3:PutObject*',
            's3:Abort*',
          ],
          resources: [`arn:aws:s3:::${applicationPrefix}*`],
        }),
        new PolicyStatement({
          sid: 'ApplicationQueues',
          effect: Effect.ALLOW,
          actions: [
            'sqs:SendMessage',
            'sqs:ReceiveMessage',
            'sqs:DeleteMessage',
            'sqs:ChangeMessageVisibility',
            'sqs:GetQueueAttributes',
          ],
          resources: [`arn:aws:sqs:${this.region}:${this.account}:${applicationPrefix}*`],
        }),
        new PolicyStatement({
          sid: 'ApplicationRunTask',
          effect: Effect.ALLOW,
          actions: ['ecs:RunTask'],
          resources: [`arn:aws:ecs:${this.region}:${this.account}:task-definition/DeployzApp*`],
          conditions: { ArnLike: ownCluster },
        }),
        new PolicyStatement({
          sid: 'ApplicationPassRole',
          effect: Effect.ALLOW,
          actions: ['iam:PassRole'],
          resources: [applicationRoleArns],
          conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
        }),
      ],
    });
    const boundaryArn = this.applicationRoleBoundary.managedPolicyArn;

    // Role creation, inline policies and managed-policy attachment: only
    // under `/deployz/`, only for this installation, and only on a role
    // that carries the application role boundary. `iam:AttachRolePolicy`
    // is further limited to the one AWS managed policy the compiler
    // attaches (the ECS task-execution policy).
    const provisionRoleCreate = new PolicyStatement({
      sid: 'ProvisionApplicationRoleCreate',
      effect: Effect.ALLOW,
      actions: ['iam:CreateRole'],
      resources: [applicationRoleArns],
      conditions: {
        StringEquals: {
          'aws:RequestTag/deployz:installation': this.installationId,
          'iam:PermissionsBoundary': boundaryArn,
        },
      },
    });
    const provisionRolePolicy = new PolicyStatement({
      sid: 'ProvisionApplicationRolePolicy',
      effect: Effect.ALLOW,
      actions: ['iam:PutRolePolicy'],
      resources: [applicationRoleArns],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
          'iam:PermissionsBoundary': boundaryArn,
        },
      },
    });
    const provisionRoleAttach = new PolicyStatement({
      sid: 'ProvisionApplicationRoleAttach',
      effect: Effect.ALLOW,
      actions: ['iam:AttachRolePolicy'],
      resources: [applicationRoleArns],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/deployz:installation': this.installationId,
          'iam:PermissionsBoundary': boundaryArn,
        },
        ArnEquals: {
          'iam:PolicyARN': 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
        },
      },
    });

    // CloudFormation hands the application's task roles to ECS when it
    // creates the service. Restricted to this installation's application
    // roles and to the services that legitimately receive them, so the role
    // cannot hand another role in the account to anything.
    const provisionPassRole = new PolicyStatement({
      sid: 'ProvisionApplicationPassRole',
      effect: Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [applicationRoleArns],
      conditions: {
        StringEquals: {
          'iam:PassedToService': [...PROVISION_APPLICATION_PASS_ROLE_SERVICES],
        },
      },
    });

    // Phase 5: queues and schedules. Neither carries a tag condition (see
    // the action lists above for why) — resource-ARN scoped to this
    // installation's application stack instead.
    const provisionSqs = new PolicyStatement({
      sid: 'ProvisionApplicationQueues',
      effect: Effect.ALLOW,
      actions: [...PROVISION_SQS_ACTIONS],
      resources: [`arn:aws:sqs:${this.region}:${this.account}:${applicationPrefix}*`],
    });

    const provisionScheduler = new PolicyStatement({
      sid: 'ProvisionApplicationSchedules',
      effect: Effect.ALLOW,
      actions: [...PROVISION_SCHEDULER_ACTIONS],
      resources: [
        `arn:aws:scheduler:${this.region}:${this.account}:schedule/default/${applicationPrefix}*`,
      ],
    });

    // A first ECS service, load balancer, RDS instance or cache cluster in
    // an account needs that service's service-linked role to exist. Named
    // services only — `iam:CreateServiceLinkedRole` on `*` would let the
    // role bootstrap a principal for any AWS service at all.
    const provisionServiceLinkedRoles = new PolicyStatement({
      sid: 'ProvisionApplicationServiceLinkedRoles',
      effect: Effect.ALLOW,
      actions: ['iam:CreateServiceLinkedRole'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'iam:AWSServiceName': [...PROVISION_SERVICE_LINKED_ROLE_SERVICES],
        },
      },
    });

    // Separate `Policy` constructs rather than one: an inline role policy is
    // capped at 10,240 characters, and this set comfortably exceeds that as
    // a single document.
    new Policy(this, 'ProvisionApplicationWrite', {
      statements: [provisionCreate, provisionCreateOnTagged, provisionManage],
      roles: [this.applicationExecutionRole],
    });
    new Policy(this, 'ProvisionApplicationSupport', {
      statements: [
        provisionRead,
        provisionStorage,
        provisionUntaggable,
        provisionLogGroups,
        provisionCacheCompanions,
        provisionRoleCreate,
        provisionRolePolicy,
        provisionRoleAttach,
        provisionPassRole,
        provisionServiceLinkedRoles,
        provisionSqs,
        provisionScheduler,
      ],
      roles: [this.applicationExecutionRole],
    });

    // ── 4. Relay Lambda + EventBridge schedule ──────────────────────────
    this.relayFunction = new NodejsFunction(this, 'RelayFunction', {
      runtime: Runtime.NODEJS_22_X,
      entry: join(import.meta.dirname, '..', '..', 'src', 'lambda', 'relay-handler.ts'),
      handler: 'handler',
      role: this.relayRole,
      timeout: Duration.minutes(5),
      memorySize: 256,
      logRetention: RetentionDays.ONE_WEEK,
      environment: {
        DEPLOYZ_INSTALLATION_ID: this.installationId,
        DEPLOYZ_BOOTSTRAP_VERSION: props.buildId ?? DEFAULT_BUILD_ID,
        DEPLOYZ_CREDENTIAL_SECRET_ARN: this.credentialSecretArn,
        DEPLOYZ_CONTROL_PLANE_URL: controlPlaneUrlParam.valueAsString,
        DEPLOYZ_ENROLLMENT_CODE: enrollmentCodeParam.valueAsString,
        DEPLOYZ_APPLICATION_EXECUTION_ROLE_ARN: this.applicationExecutionRole.roleArn,
        DEPLOYZ_APPLICATION_ROLE_BOUNDARY_ARN: this.applicationRoleBoundary.managedPolicyArn,
        // The relay purges its own bootstrap stack (destroy flow). Ref
        // AWS::StackName resolves to the DEPLOYED stack name at runtime —
        // even when the customer renames the stack in the console — where a
        // synth-time `this.stackName` literal would go stale.
        DEPLOYZ_BOOTSTRAP_STACK_NAME: Fn.ref('AWS::StackName'),
      },
      bundling: {
        format: 'esm' as OutputFormat,
        target: 'node22',
        // No source map: the map's `sources` embed the checkout path, which
        // would make the asset hash (and the committed template) differ per machine.
        sourceMap: false,
      },
    });

    const relaySchedule = new Rule(this, 'RelaySchedule', {
      description: 'Polls the Deployz control plane every minute (egress-only).',
      schedule: Schedule.rate(Duration.minutes(1)),
      // A scheduled event that is skipped or throttled is dropped, not
      // retried: the next minute's event replaces it, so no backlog builds.
      targets: [
        new LambdaFunction(this.relayFunction, {
          retryAttempts: 0,
          maxEventAge: Duration.minutes(1),
        }),
      ],
    });

    // ── 5. deployz: tags (§15) ──────────────────────────────────────────
    // deployz:component is a static value — applied to EVERY taggable
    // resource, including the install-id custom-resource Lambda/role that
    // mint the identifier.
    Tags.of(this).add('deployz:component', 'bootstrap');
    Tags.of(this).add('deployz:managed', 'true');
    Tags.of(this).add('deployz:scope', 'customer');

    // deployz:installation is a deploy-time token (Fn::GetAtt on the minted
    // id). It is applied to the DOWNSTREAM resources that consume the id. The
    // install-id generator itself cannot self-tag with its own output (that
    // would be a cyclic dependency), so those few resources carry only
    // deployz:component.
    //
    // The credential secret is NOT in this loop: for DZ-AUDIT-013 the secret
    // is one of two mutually exclusive CfnSecrets that carry tags directly.
    for (const target of [
      this.relayRole,
      this.relayFunction,
      relaySchedule,
    ]) {
      Tags.of(target).add('deployz:installation', this.installationId);
      if (props.applicationId !== undefined) {
        Tags.of(target).add('deployz:application-id', props.applicationId);
      }
    }

    const taggableResources = [
      this,
      this.relayRole,
      this.relayFunction,
      relaySchedule,
      installIdFunction,
      installIdProvider,
      installIdResource,
    ] as const;
    if (props.applicationId !== undefined) {
      for (const c of taggableResources) {
        Tags.of(c).add('deployz:application', props.applicationId);
      }
    }
    if (props.vendorId !== undefined) {
      for (const c of taggableResources) {
        Tags.of(c).add('deployz:vendor', props.vendorId);
      }
    }

    // AWS::IAM::ManagedPolicy has no `Tags` property in CloudFormation, so the
    // permissions-boundary and provisioner policies cannot carry deployz:
    // tags. They remain bound to the installation by the deployz:installation
    // IAM condition in their statements and the ARN outputs below.

    // ── 6. Stack outputs (control-plane handshake surface) ──────────────
    // Plain outputs, NOT Fn::Export values: this template is synthesized once
    // with fixed logical ids and deployed many times into the same account,
    // where fixed export names would collide (the second stack rolls back).
    // Nothing imports these — readers use DescribeStacks, which returns plain
    // outputs exactly as it returned exports.
    new CfnOutput(this, 'RelayFunctionArn', {
      value: this.relayFunction.functionArn,
    });
    new CfnOutput(this, 'CredentialSecretArn', {
      value: this.credentialSecretArn,
    });
    new CfnOutput(this, 'ProvisionerPolicyArn', {
      value: this.provisionerPolicy.managedPolicyArn,
    });
    // The install-id CustomResource above already owns the construct id
    // 'InstallationId', so this output takes a distinct construct id and pins
    // the template logical id instead.
    const installationIdOutput = new CfnOutput(this, 'InstallationIdOutput', {
      value: this.installationId,
    });
    installationIdOutput.overrideLogicalId('InstallationId');
    new CfnOutput(this, 'ApplicationExecutionRoleArn', {
      value: this.applicationExecutionRole.roleArn,
    });
  }
}
