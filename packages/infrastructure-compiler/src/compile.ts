import type {
  DeployzIR,
  InfrastructureComponentKind,
  InfrastructureSizeProfile,
  Region,
  IrBinding,
  IrResource,
  IrSchedule,
  IrWorkload,
  ManifestEnvBinding,
} from '@deployz/contracts';
import { CAPABILITY_KEYS, defaultInfrastructureSizeProfile, oneShotContainerCommand, workloadContainerCommand } from '@deployz/contracts';

import { logicalResourceId, logicalIdViolations } from './stable-identity.js';
import { translateScheduleExpression } from './schedule-expression.js';
import type {
  DeletionPolicy,
  PurgeStrategy,
  ResolvedAwsGraph,
  ResolvedCondition,
  ResolvedOutput,
  ResolvedParameter,
  ResolvedResource,
  Retention,
} from './resolved-graph.js';

// ---------------------------------------------------------------------------
// dynamic-compiler-v2 — the deterministic infrastructure compiler.
//
// Input: DeployzIR + size profile + region + compiler version.
// Output: a resolved AWS graph (resources with stable identity + lifecycle),
// a deterministic CloudFormation template, and the derived footprint /
// verification contract / ownership records.
//
// The compiler is a pure function: no AI, no synth-time AWS discovery, no
// timestamps, no random ids, no unstable iteration. Equivalent IR + profile +
// region + compiler version always produce an equivalent graph.
//
// It composes the current capabilities from DeployzIR (VPC + ECS Fargate +
// ALB + S3 + Secrets Manager + optional RDS PostgreSQL + optional ElastiCache
// Valkey) into a resolved AWS graph with stable semantic logical ids. CDK
// stays the control-plane mechanism; this compiler emits CloudFormation
// directly and is the architectural boundary the relay consumes.
// ---------------------------------------------------------------------------

// ── CFN intrinsic helpers ────────────────────────────────────────────────────
const ref = (id: string): Record<string, unknown> => ({ Ref: id });
const getAtt = (id: string, attr: string): Record<string, unknown> => ({ 'Fn::GetAtt': [id, attr] });
const join = (sep: string, parts: readonly unknown[]): Record<string, unknown> => ({ 'Fn::Join': [sep, parts] });
const select = (i: number, value: unknown): Record<string, unknown> => ({ 'Fn::Select': [i, value] });
const azOf = (i: number): Record<string, unknown> => select(i, { 'Fn::GetAZs': '' });

// ── Tag model (matches runtime-v1 static tags; identity tags are applied by
//    the relay at CreateStack time, never baked into the artifact) ───────────
const TAG_ENVIRONMENT = 'production';
const TAG_MANAGED = 'true';
const TAG_MANAGED_BY = 'deployz';
const TAG_SCOPE = 'customer';

/**
 * The `deployz:component` tag value: fixed vocabulary for the shared
 * infrastructure components, the workload's own component id for everything
 * else (Phase 4A — one tag per workload component).
 */
function componentTag(componentId: string): string {
  switch (componentId) {
    case 'network':
      return 'network';
    case 'primary-db':
      return 'database';
    case 'cache':
      return 'redis';
    case 'storage':
      return 'storage';
    case 'endpoint':
      return 'network';
    default:
      return componentId;
  }
}

function tags(componentId: string): Array<{ Key: string; Value: string }> {
  return [
    { Key: 'deployz:component', Value: componentTag(componentId) },
    { Key: 'deployz:environment', Value: TAG_ENVIRONMENT },
    { Key: 'deployz:managed', Value: TAG_MANAGED },
    { Key: 'deployz:managed-by', Value: TAG_MANAGED_BY },
    { Key: 'deployz:scope', Value: TAG_SCOPE },
  ];
}

// ── Fixed sizing / engine constants (pinned to the active profile + the
//    runtime-v1 template constants; see sizing parity) ───────────────────────
const DB_ENGINE = 'postgres';
const DB_ENGINE_VERSION = '16';
const MYSQL_DB_ENGINE = 'mysql';
const MYSQL_DB_ENGINE_VERSION = '8.0';
const MYSQL_DB_PORT = 3306;
const DB_NAME = 'deployz';
const DB_USER = 'deployz_app';
const DB_PORT = 5432;
const REDIS_ENGINE = 'valkey';
const REDIS_PORT = 6379;
const RDS_CA_VOLUME = 'deployz-rds-ca';
const RDS_CA_DIR = '/deployz/certs';
const RDS_CA_BUNDLE_PATH = `${RDS_CA_DIR}/rds-ca-bundle.pem`;
const RDS_CA_INIT_IMAGE = 'public.ecr.aws/amazonlinux/amazonlinux:2023-minimal';
const DEFAULT_IMAGE_REPOSITORY = 'public.ecr.aws/deployz/fixture';
const DEFAULT_IMAGE_DIGEST =
  'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const APP_PORT = 3000;
const HEALTH_CHECK_PATH = '/health';

// VPC CIDR layout — deterministic, matches runtime-v1's 2-AZ /16 split.
const VPC_CIDR = '10.0.0.0/16';
const PUBLIC_SUBNET_CIDRS = ['10.0.0.0/18', '10.0.64.0/18'] as const;
const PRIVATE_SUBNET_CIDRS = ['10.0.128.0/18', '10.0.192.0/18'] as const;

// Secondary VPC CIDR for DB-only subnets — the /16 is fully allocated to
// public/private subnets, so DB subnets carve from a separate block.
const DB_VPC_CIDR_BLOCK = '10.1.0.0/20';
const DB_SUBNET_CIDRS = [
  '10.1.0.0/24', '10.1.1.0/24', '10.1.2.0/24', '10.1.3.0/24',
  '10.1.4.0/24', '10.1.5.0/24', '10.1.6.0/24', '10.1.7.0/24',
  '10.1.8.0/24', '10.1.9.0/24', '10.1.10.0/24', '10.1.11.0/24',
  '10.1.12.0/24', '10.1.13.0/24', '10.1.14.0/24', '10.1.15.0/24',
] as const;

// Maximum number of AZ slots the compiler emits. us-east-1 has 6 today;
// 8 gives bounded headroom. The relay must fail explicitly when the
// available count exceeds this.
const DB_AZ_SLOT_COUNT = 8;

// ── Compiler version / capability registry identity ─────────────────────────
export const COMPILER_VERSION = 'dynamic-compiler-v2-7' as const;

/** Seconds ECS ignores ALB health checks after a web task starts. */
export const WEB_HEALTH_CHECK_GRACE_SECONDS = 300;

interface ResInput {
  readonly componentId: string;
  readonly componentKind: InfrastructureComponentKind;
  readonly capability: string;
  readonly resourceRole: string;
  readonly cfnType: string;
  readonly stateful?: boolean;
  readonly deletionPolicy?: DeletionPolicy;
  readonly retention?: Retention;
  readonly purgeStrategy?: PurgeStrategy;
  readonly verificationCheck?: string;
  readonly properties: Record<string, unknown>;
  readonly dependsOn?: readonly string[];
}

function res(input: ResInput): ResolvedResource {
  const stateful = input.stateful ?? false;
  const deletionPolicy = input.deletionPolicy ?? (stateful ? 'Retain' : 'Delete');
  return {
    logicalId: logicalResourceId(input.componentId, input.resourceRole),
    componentId: input.componentId,
    componentKind: input.componentKind,
    capability: input.capability,
    resourceRole: input.resourceRole,
    cfnType: input.cfnType,
    stateful,
    deletionPolicy,
    updateReplacePolicy: deletionPolicy,
    retention: input.retention ?? (stateful ? 'retain' : 'delete'),
    purgeStrategy: input.purgeStrategy ?? (stateful ? 'require_manual' : null),
    ...(input.verificationCheck !== undefined ? { verificationCheck: input.verificationCheck } : {}),
    properties: input.properties,
    ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn } : {}),
  };
}

// ── Shared logical ids (single source of truth for cross-references) ────────
interface NetIds {
  readonly vpc: string;
  readonly publicSubnets: readonly [string, string];
  readonly privateSubnets: readonly [string, string];
  readonly igw: string;
  readonly vpcGwAttachment: string;
  readonly natEip: string;
  readonly natGateway: string;
}

function netIds(): NetIds {
  return {
    vpc: logicalResourceId('network', 'vpc'),
    publicSubnets: [logicalResourceId('network', 'public-subnet-1'), logicalResourceId('network', 'public-subnet-2')],
    privateSubnets: [logicalResourceId('network', 'private-subnet-1'), logicalResourceId('network', 'private-subnet-2')],
    igw: logicalResourceId('network', 'internet-gateway'),
    vpcGwAttachment: logicalResourceId('network', 'vpc-gateway-attachment'),
    natEip: logicalResourceId('network', 'nat-eip'),
    natGateway: logicalResourceId('network', 'nat-gateway'),
  };
}

// ── Capability compilers ─────────────────────────────────────────────────────

/** VPC + subnets + routes + NAT — shared by every topology. */
function compileNetwork(ids: NetIds): ResolvedResource[] {
  const out: ResolvedResource[] = [];
  const net = { componentId: 'network', componentKind: 'network' as const, capability: 'aws.network' };

  out.push(res({
    ...net,
    resourceRole: 'vpc',
    cfnType: 'AWS::EC2::VPC',
    properties: {
      CidrBlock: VPC_CIDR,
      EnableDnsHostnames: true,
      EnableDnsSupport: true,
      InstanceTenancy: 'default',
      Tags: tags('network'),
    },
  }));

  const routeTables: string[] = [];
  for (let i = 0; i < 2; i++) {
    const pubSubnet = logicalResourceId('network', `public-subnet-${i + 1}`);
    const privSubnet = logicalResourceId('network', `private-subnet-${i + 1}`);
    const pubRt = logicalResourceId('network', `public-route-table-${i + 1}`);
    const privRt = logicalResourceId('network', `private-route-table-${i + 1}`);

    out.push(res({
      ...net, resourceRole: `public-subnet-${i + 1}`, cfnType: 'AWS::EC2::Subnet',
      properties: { AvailabilityZone: azOf(i), CidrBlock: PUBLIC_SUBNET_CIDRS[i], MapPublicIpOnLaunch: true, Tags: tags('network'), VpcId: ref(ids.vpc) },
    }));
    out.push(res({
      ...net, resourceRole: `private-subnet-${i + 1}`, cfnType: 'AWS::EC2::Subnet',
      properties: { AvailabilityZone: azOf(i), CidrBlock: PRIVATE_SUBNET_CIDRS[i], MapPublicIpOnLaunch: false, Tags: tags('network'), VpcId: ref(ids.vpc) },
    }));
    out.push(res({ ...net, resourceRole: `public-route-table-${i + 1}`, cfnType: 'AWS::EC2::RouteTable', properties: { Tags: tags('network'), VpcId: ref(ids.vpc) } }));
    out.push(res({ ...net, resourceRole: `private-route-table-${i + 1}`, cfnType: 'AWS::EC2::RouteTable', properties: { Tags: tags('network'), VpcId: ref(ids.vpc) } }));
    out.push(res({
      ...net, resourceRole: `public-route-table-association-${i + 1}`, cfnType: 'AWS::EC2::SubnetRouteTableAssociation',
      properties: { RouteTableId: ref(pubRt), SubnetId: ref(pubSubnet) },
    }));
    out.push(res({
      ...net, resourceRole: `private-route-table-association-${i + 1}`, cfnType: 'AWS::EC2::SubnetRouteTableAssociation',
      properties: { RouteTableId: ref(privRt), SubnetId: ref(privSubnet) },
    }));
    out.push(res({
      ...net, resourceRole: `public-route-${i + 1}`, cfnType: 'AWS::EC2::Route',
      properties: { DestinationCidrBlock: '0.0.0.0/0', GatewayId: ref(ids.igw), RouteTableId: ref(pubRt) },
      dependsOn: [ids.vpcGwAttachment],
    }));
    out.push(res({
      ...net, resourceRole: `private-route-${i + 1}`, cfnType: 'AWS::EC2::Route',
      properties: { DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: ref(ids.natGateway), RouteTableId: ref(privRt) },
    }));
    routeTables.push(pubRt, privRt);
  }

  out.push(res({ ...net, resourceRole: 'internet-gateway', cfnType: 'AWS::EC2::InternetGateway', properties: { Tags: tags('network') } }));
  out.push(res({
    ...net, resourceRole: 'vpc-gateway-attachment', cfnType: 'AWS::EC2::VPCGatewayAttachment',
    properties: { InternetGatewayId: ref(ids.igw), VpcId: ref(ids.vpc) },
  }));
  out.push(res({ ...net, resourceRole: 'nat-eip', cfnType: 'AWS::EC2::EIP', properties: { Domain: 'vpc', Tags: tags('network') } }));
  out.push(res({
    ...net, resourceRole: 'nat-gateway', cfnType: 'AWS::EC2::NatGateway',
    properties: { AllocationId: getAtt(ids.natEip, 'AllocationId'), SubnetId: ref(ids.publicSubnets[0]), Tags: tags('network') },
    dependsOn: [logicalResourceId('network', 'public-route-1'), logicalResourceId('network', 'public-route-table-association-1')],
  }));

  // Secondary VPC CIDR for DB-only subnets — the /16 is fully allocated.
  out.push(res({
    ...net, resourceRole: 'db-vpc-cidr-block', cfnType: 'AWS::EC2::VPCCidrBlock',
    properties: { CidrBlock: DB_VPC_CIDR_BLOCK, VpcId: ref(ids.vpc) },
  }));

  return out;
}

/**
 * DB-only subnets for AZ slots 3..N. Each subnet is conditionally created
 * based on whether the corresponding AZ parameter is non-empty. These subnets
 * have no NAT gateway and no internet route — they are isolated from the
 * internet and only reachable from the VPC's private subnets.
 */
function compileDbSubnets(ids: NetIds): ResolvedResource[] {
  const out: ResolvedResource[] = [];
  for (let i = 3; i <= DB_AZ_SLOT_COUNT; i++) {
    out.push(res({
      componentId: 'network',
      componentKind: 'network',
      capability: 'aws.network',
      resourceRole: `db-subnet-${i}`,
      cfnType: 'AWS::EC2::Subnet',
      properties: {
        AvailabilityZone: ref(`paramDbAz${i}`),
        CidrBlock: DB_SUBNET_CIDRS[i - 1],
        MapPublicIpOnLaunch: false,
        Tags: tags('network'),
        VpcId: ref(ids.vpc),
      },
      dependsOn: [logicalResourceId('network', 'db-vpc-cidr-block')],
    }));
  }
  return out;
}

/** App config secret (Secrets Manager) — always present, Delete lifecycle. */
function compileAppSecret(): ResolvedResource {
  return res({
    componentId: 'application',
    componentKind: 'other',
    capability: CAPABILITY_KEYS.SECRETS_MANAGER,
    resourceRole: 'config-secret',
    cfnType: 'AWS::SecretsManager::Secret',
    stateful: false,
    properties: {
      Description: 'Application runtime secrets (vendor/customer config) supplied via NoEcho parameters at deploy time. Never returned to the control plane.',
      SecretString: join('', ['{"apiKey":"', ref('paramAppApiKey'), '","signingSecret":"', ref('paramAppSigningSecret'), '"}']),
      Tags: tags('application'),
    },
  });
}

/** S3 object storage — always present, Retain lifecycle. */
function compileS3(): ResolvedResource[] {
  const bucket = logicalResourceId('storage', 'bucket');
  return [
    res({
      componentId: 'storage',
      componentKind: 'storage',
      capability: CAPABILITY_KEYS.S3,
      resourceRole: 'bucket',
      cfnType: 'AWS::S3::Bucket',
      stateful: true,
      retention: 'retain',
      purgeStrategy: 'require_manual',
      verificationCheck: 'storage',
      properties: {
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
        LifecycleConfiguration: {
          Rules: [
            { Id: 'ExpireNoncurrentVersions', NoncurrentVersionExpiration: { NoncurrentDays: 30 }, Status: 'Enabled' },
            { AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }, Id: 'AbortIncompleteMultipartUploads', Status: 'Enabled' },
          ],
        },
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        Tags: tags('storage'),
        VersioningConfiguration: { Status: 'Enabled' },
      },
    }),
    res({
      componentId: 'storage',
      componentKind: 'storage',
      capability: CAPABILITY_KEYS.S3,
      resourceRole: 'bucket-policy',
      cfnType: 'AWS::S3::BucketPolicy',
      properties: {
        Bucket: ref(bucket),
        PolicyDocument: {
          Statement: [{
            Action: 's3:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            Effect: 'Deny',
            Principal: { AWS: '*' },
            Resource: [getAtt(bucket, 'Arn'), join('', [getAtt(bucket, 'Arn'), '/*'])],
          }],
          Version: '2012-10-17',
        },
      },
    }),
  ];
}

/** Log group for one workload's ECS tasks — one week retention, Delete lifecycle. */
function compileLogGroup(componentId: string): ResolvedResource {
  return res({
    componentId,
    componentKind: 'monitoring',
    capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE,
    resourceRole: 'log-group',
    cfnType: 'AWS::Logs::LogGroup',
    properties: { RetentionInDays: 7, Tags: tags(componentId) },
  });
}

/**
 * The per-engine facts of the managed RDS database. One managed instance per
 * deployment on the SAME resource shape — the engine only changes the
 * CFN Engine/EngineVersion, the port, the URL scheme, and the display
 * strings. The postgres descriptor's strings are byte-pinned: changing them
 * is a CloudFormation replacement.
 */
interface RdsEngineDescriptor {
  readonly capability: string;
  readonly engine: string;
  readonly engineVersion: string;
  readonly port: number;
  readonly urlScheme: string;
  readonly urlSuffix: string;
  readonly masterSecretDescription: string;
  readonly securityGroupDescription: string;
  readonly urlSecretDescription: string;
  readonly ingressDescription: string;
}

const RDS_POSTGRES_DESCRIPTOR: RdsEngineDescriptor = {
  capability: CAPABILITY_KEYS.RDS_POSTGRES,
  engine: DB_ENGINE,
  engineVersion: DB_ENGINE_VERSION,
  port: DB_PORT,
  urlScheme: 'postgresql',
  urlSuffix: '?sslmode=require',
  masterSecretDescription:
    'RDS PostgreSQL master credentials for the customer application. Generated by CloudFormation at deploy time — never a template parameter.',
  securityGroupDescription: 'RDS PostgreSQL access for the customer application',
  urlSecretDescription:
    'Complete PostgreSQL connection URL for the customer application. Assembled at deploy time from the generated master credentials — the password never appears in the template or task definition.',
  ingressDescription: 'Allow the application to reach RDS PostgreSQL',
};

const RDS_MYSQL_DESCRIPTOR: RdsEngineDescriptor = {
  capability: CAPABILITY_KEYS.RDS_MYSQL,
  engine: MYSQL_DB_ENGINE,
  engineVersion: MYSQL_DB_ENGINE_VERSION,
  port: MYSQL_DB_PORT,
  urlScheme: 'mysql',
  urlSuffix: '',
  masterSecretDescription:
    'RDS MySQL master credentials for the customer application. Generated by CloudFormation at deploy time — never a template parameter.',
  securityGroupDescription: 'RDS MySQL access for the customer application',
  urlSecretDescription:
    'Complete MySQL connection URL for the customer application. Assembled at deploy time from the generated master credentials — the password never appears in the template or task definition.',
  ingressDescription: 'Allow the application to reach RDS MySQL',
};

function rdsDescriptorFor(capabilityKey: string): RdsEngineDescriptor {
  return capabilityKey === CAPABILITY_KEYS.RDS_MYSQL ? RDS_MYSQL_DESCRIPTOR : RDS_POSTGRES_DESCRIPTOR;
}

/** Managed RDS database (PostgreSQL or MySQL) — Retain lifecycle (stateful). */
function compileRds(dbResource: IrResource, profile: InfrastructureSizeProfile, ids: NetIds, serviceSecurityGroups: readonly { componentId: string; sgRole: string }[]): ResolvedResource[] {
  const engine = rdsDescriptorFor(dbResource.capabilityKey);
  const out: ResolvedResource[] = [];
  const componentId = dbResource.componentId;
  const secret = logicalResourceId(componentId, 'master-secret');
  const sg = logicalResourceId(componentId, 'security-group');
  const subnetGroup = logicalResourceId(componentId, 'subnet-group');
  const instance = logicalResourceId(componentId, 'instance');
  // A driver-specific scheme (`mysql+pymysql`) from the analysis, else the engine's own.
  const configuredScheme = dbResource.configuration['urlScheme'];
  const urlScheme = typeof configuredScheme === 'string' ? configuredScheme : engine.urlScheme;

  out.push(res({
    componentId, componentKind: 'database', capability: engine.capability, resourceRole: 'master-secret',
    cfnType: 'AWS::SecretsManager::Secret', stateful: true, retention: 'retain', purgeStrategy: 'require_manual',
    properties: {
      Description: engine.masterSecretDescription,
      GenerateSecretString: { ExcludePunctuation: true, GenerateStringKey: 'password', PasswordLength: 32, SecretStringTemplate: `{"username":"${DB_USER}"}` },
      Tags: tags(componentId),
    },
  }));

  out.push(res({
    componentId, componentKind: 'database', capability: engine.capability, resourceRole: 'security-group',
    cfnType: 'AWS::EC2::SecurityGroup',
    properties: { GroupDescription: engine.securityGroupDescription, SecurityGroupEgress: [{ CidrIp: '0.0.0.0/0', Description: 'Allow all outbound traffic by default', IpProtocol: '-1' }], Tags: tags(componentId), VpcId: ref(ids.vpc) },
  }));

  // Build the subnet group with all available AZs. Slots 1-2 are the private
  // subnets; slots 3-N are conditionally included DB-only subnets.
  const subnetIds: unknown[] = [ref(ids.privateSubnets[0]), ref(ids.privateSubnets[1])];
  for (let i = 3; i <= DB_AZ_SLOT_COUNT; i++) {
    subnetIds.push({
      'Fn::If': [`condDbAz${i}`, ref(logicalResourceId('network', `db-subnet-${i}`)), { Ref: 'AWS::NoValue' }],
    });
  }
  out.push(res({
    componentId, componentKind: 'database', capability: engine.capability, resourceRole: 'subnet-group',
    cfnType: 'AWS::RDS::DBSubnetGroup', stateful: true, retention: 'retain',
    properties: { DBSubnetGroupDescription: `Subnet group for ${componentId} database`, SubnetIds: subnetIds, Tags: tags(componentId) },
  }));

  out.push(res({
    componentId, componentKind: 'database', capability: engine.capability, resourceRole: 'instance',
    cfnType: 'AWS::RDS::DBInstance', stateful: true, retention: 'retain', purgeStrategy: 'require_manual', verificationCheck: 'database',
    properties: {
      AllocatedStorage: String(profile.database.storageGb),
      BackupRetentionPeriod: 7,
      CopyTagsToSnapshot: true,
      DBInstanceClass: profile.database.instanceClass,
      DBName: DB_NAME,
      DBSubnetGroupName: ref(subnetGroup),
      DeleteAutomatedBackups: false,
      DeletionProtection: true,
      Engine: engine.engine,
      EngineVersion: engine.engineVersion,
      MasterUserPassword: join('', [`{{resolve:secretsmanager:`, ref(secret), `:SecretString:password::}}`]),
      MasterUsername: DB_USER,
      MaxAllocatedStorage: profile.database.maxStorageGb,
      PreferredBackupWindow: '03:00-05:00',
      PubliclyAccessible: false,
      StorageEncrypted: true,
      StorageType: profile.database.storageType,
      Tags: tags(componentId),
      VPCSecurityGroups: [getAtt(sg, 'GroupId')],
    },
  }));

  out.push(res({
    componentId, componentKind: 'database', capability: engine.capability, resourceRole: 'secret-attachment',
    cfnType: 'AWS::SecretsManager::SecretTargetAttachment',
    properties: { SecretId: ref(secret), TargetId: ref(instance), TargetType: 'AWS::RDS::DBInstance' },
  }));

  out.push(res({
    componentId, componentKind: 'database', capability: engine.capability, resourceRole: 'url-secret',
    cfnType: 'AWS::SecretsManager::Secret', stateful: true, retention: 'retain', purgeStrategy: 'require_manual',
    properties: {
      Description: engine.urlSecretDescription,
      SecretString: join('', [`${urlScheme}://${DB_USER}:{{resolve:secretsmanager:`, ref(secret), `:SecretString:password::}}@`, getAtt(instance, 'Endpoint.Address'), `:${engine.port}/${DB_NAME}${engine.urlSuffix}`]),
      Tags: tags(componentId),
    },
  }));

  // One ingress rule per workload service/task security group — every
  // workload that binds the database must reach it (Phase 4A: N workloads;
  // Phase 5D: scheduled jobs too, via their own task security group).
  for (const { componentId: serviceComponentId, sgRole } of serviceSecurityGroups) {
    out.push(res({
      componentId, componentKind: 'database', capability: engine.capability, resourceRole: `app-service-ingress-${serviceComponentId}`,
      cfnType: 'AWS::EC2::SecurityGroupIngress',
      properties: { Description: engine.ingressDescription, FromPort: engine.port, GroupId: getAtt(sg, 'GroupId'), IpProtocol: 'tcp', SourceSecurityGroupId: getAtt(logicalResourceId(serviceComponentId, sgRole), 'GroupId'), ToPort: engine.port },
    }));
  }

  return out;
}

/** ElastiCache Valkey — stateless (Delete on stack delete). */
function compileElasticache(cacheResource: IrResource, profile: InfrastructureSizeProfile, ids: NetIds): ResolvedResource[] {
  const componentId = cacheResource.componentId;
  const sg = logicalResourceId(componentId, 'security-group');
  const subnetGroup = logicalResourceId(componentId, 'subnet-group');

  return [
    res({
      componentId, componentKind: 'cache', capability: CAPABILITY_KEYS.ELASTICACHE_VALKEY, resourceRole: 'subnet-group',
      cfnType: 'AWS::ElastiCache::SubnetGroup',
      properties: { Description: 'Deployz-managed private subnet group for the ElastiCache Valkey cache', SubnetIds: [ref(ids.privateSubnets[0]), ref(ids.privateSubnets[1])], Tags: tags(componentId) },
    }),
    res({
      componentId, componentKind: 'cache', capability: CAPABILITY_KEYS.ELASTICACHE_VALKEY, resourceRole: 'security-group',
      cfnType: 'AWS::EC2::SecurityGroup',
      properties: {
        GroupDescription: 'ElastiCache Valkey access for the customer application',
        SecurityGroupEgress: [{ CidrIp: '0.0.0.0/0', Description: 'Allow all outbound traffic by default', IpProtocol: '-1' }],
        SecurityGroupIngress: [{ CidrIp: VPC_CIDR, Description: 'Allow the application to reach the ElastiCache Valkey cache', FromPort: REDIS_PORT, IpProtocol: 'tcp', ToPort: REDIS_PORT }],
        Tags: tags(componentId),
        VpcId: ref(ids.vpc),
      },
    }),
    res({
      componentId, componentKind: 'cache', capability: CAPABILITY_KEYS.ELASTICACHE_VALKEY, resourceRole: 'replication-group',
      cfnType: 'AWS::ElastiCache::ReplicationGroup', verificationCheck: 'cache',
      properties: {
        AutomaticFailoverEnabled: false,
        CacheNodeType: profile.cache.nodeType,
        CacheSubnetGroupName: ref(subnetGroup),
        Engine: REDIS_ENGINE,
        MultiAZEnabled: false,
        NumCacheClusters: profile.cache.nodeCount,
        Port: REDIS_PORT,
        ReplicationGroupDescription: 'Deployz-managed single-node Valkey cache for the customer application',
        SecurityGroupIds: [getAtt(sg, 'GroupId')],
        Tags: tags(componentId),
        TransitEncryptionEnabled: false,
      },
      dependsOn: [subnetGroup],
    }),
  ];
}

// ── ECS + ALB (the workload/ingress half) ────────────────────────────────────

interface EcsContext {
  readonly ids: NetIds;
  readonly hasDb: boolean;
  readonly hasRedis: boolean;
  readonly db: { componentId: string; engine: 'postgres' | 'mysql'; secret: string; urlSecret: string; instance: string } | undefined;
  readonly cache: { componentId: string; replicationGroup: string } | undefined;
  /** The app's own env names for each managed value (MEMOS_DSN, SPRING_DATASOURCE_URL, …), from the IR resources. */
  readonly aliases: readonly { readonly resource: 'db' | 'cache' | 'storage'; readonly binding: ManifestEnvBinding }[];
}

/** Statements granting read access to a set of Secrets Manager secret logical ids. */
function secretReadStatements(secrets: readonly string[]): unknown[] {
  return secrets.map((s) => ({
    Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
    Effect: 'Allow',
    Resource: ref(s),
  }));
}

/** The Secrets Manager secrets every workload's task role reads (DB + app config). */
function computeSecretArns(ctx: EcsContext): string[] {
  const dbSecrets = ctx.db !== undefined ? [ctx.db.secret, ctx.db.urlSecret] : [];
  return [...dbSecrets, logicalResourceId('application', 'config-secret')];
}

/** Cluster + the shared execution role/policy (image pull, logs, secrets injection). */
function compileEcsShared(ctx: EcsContext, services: readonly IrWorkload[]): ResolvedResource[] {
  // The shared compute identity (cluster, execution role) anchors on the web
  // workload's component id, keeping every logical id stable with the
  // single-workload deployments this compiler replaces. The web workload is
  // always present in the MVP graph.
  const componentId = 'web';
  const execRole = logicalResourceId(componentId, 'task-execution-role');
  const execPolicy = logicalResourceId(componentId, 'task-execution-role-policy');

  const secretArns = computeSecretArns(ctx);
  const logGroupArns = services.map((s) => getAtt(logicalResourceId(s.componentId, 'log-group'), 'Arn'));

  return [
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, resourceRole: 'cluster',
      cfnType: 'AWS::ECS::Cluster', properties: { Tags: tags(componentId) },
    }),
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, resourceRole: 'task-execution-role',
      cfnType: 'AWS::IAM::Role',
      properties: {
        AssumeRolePolicyDocument: { Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' } }], Version: '2012-10-17' },
        Description: 'Allows ECS to pull the application image, write task logs, and inject secrets from Secrets Manager at task start.',
        ManagedPolicyArns: [join('', ['arn:', ref('AWS::Partition'), ':iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'])],
        Path: '/deployz/',
        PermissionsBoundary: roleBoundary(),
        Tags: tags(componentId),
      },
    }),
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, resourceRole: 'task-execution-role-policy',
      cfnType: 'AWS::IAM::Policy',
      properties: {
        PolicyDocument: {
          Statement: [
            ...secretReadStatements(secretArns),
            { Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Effect: 'Allow', Resource: logGroupArns },
          ],
          Version: '2012-10-17',
        },
        PolicyName: execPolicy,
        Roles: [ref(execRole)],
      },
    }),
  ];
}

/**
 * One workload's OWN task role + policy (Phase 5): the baseline S3 + secret
 * read statements every workload needs, plus its own queue edge statements
 * (item 3) — never the shared web policy, so a worker never inherits the web
 * producer's SendMessage and vice versa. For `componentId === 'web'` this
 * reproduces the pre-Phase-5 shared `web/task-role(-policy)` byte-for-byte
 * when it has no queue edges.
 */
function compileWorkloadTaskRole(componentId: string, secretArns: readonly string[], edgeStatements: readonly unknown[]): ResolvedResource[] {
  const taskRole = logicalResourceId(componentId, 'task-role');
  const taskPolicy = logicalResourceId(componentId, 'task-role-policy');
  return [
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, resourceRole: 'task-role',
      cfnType: 'AWS::IAM::Role',
      properties: {
        AssumeRolePolicyDocument: { Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' } }], Version: '2012-10-17' },
        Description: 'Runtime role for the customer application container.',
        Path: '/deployz/',
        PermissionsBoundary: roleBoundary(),
        Tags: tags(componentId),
      },
    }),
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, resourceRole: 'task-role-policy',
      cfnType: 'AWS::IAM::Policy',
      properties: {
        PolicyDocument: {
          Statement: [
            {
              Action: ['s3:GetObject*', 's3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutObject', 's3:PutObjectLegalHold', 's3:PutObjectRetention', 's3:PutObjectTagging', 's3:PutObjectVersionTagging', 's3:Abort*'],
              Effect: 'Allow',
              Resource: [getAtt(logicalResourceId('storage', 'bucket'), 'Arn'), join('', [getAtt(logicalResourceId('storage', 'bucket'), 'Arn'), '/*'])],
            },
            ...secretReadStatements(secretArns),
            ...edgeStatements,
          ],
          Version: '2012-10-17',
        },
        PolicyName: taskPolicy,
        Roles: [ref(taskRole)],
      },
    }),
  ];
}

/** The SQS-capability resources' componentId -> capabilityKey, for filtering queue edges. */
function resourceCapabilityMap(ir: DeployzIR): Map<string, string> {
  return new Map(ir.resources.map((r) => [r.componentId, r.capabilityKey]));
}

/**
 * A workload's own produce/consume queue edges (item 3), sorted by target so
 * the emitted IAM statements/env vars never depend on the IR's binding
 * array order.
 */
function queueEdgeBindingsFor(ir: DeployzIR, componentId: string): IrBinding[] {
  const capabilityByComponent = resourceCapabilityMap(ir);
  return ir.bindings
    .filter(
      (b) =>
        b.sourceId === componentId &&
        (b.access === 'produce' || b.access === 'consume') &&
        capabilityByComponent.get(b.targetId) === CAPABILITY_KEYS.SQS,
    )
    .slice()
    .sort((a, b) => a.targetId.localeCompare(b.targetId) || a.id.localeCompare(b.id));
}

/** One least-privilege IAM statement per queue edge — never a wildcard resource. */
function queueEdgeStatements(ir: DeployzIR, componentId: string): unknown[] {
  return queueEdgeBindingsFor(ir, componentId).map((b) => ({
    Action: b.iamActions,
    Effect: 'Allow',
    Resource: getAtt(logicalResourceId(b.targetId, 'queue'), 'Arn'),
  }));
}

/**
 * The queue env vars a workload's produce/consume edges inject, appended
 * after the shared environment. Fails closed on an unsupported env kind or
 * on two different queues bound under the same env name.
 */
function queueEnvEntries(ir: DeployzIR, componentId: string): Array<{ Name: string; Value: unknown }> {
  const entries: Array<{ Name: string; Value: unknown }> = [];
  const targetByEnvName = new Map<string, string>();
  for (const binding of queueEdgeBindingsFor(ir, componentId)) {
    for (const eb of binding.envBindings) {
      const previousTarget = targetByEnvName.get(eb.name);
      if (previousTarget !== undefined && previousTarget !== binding.targetId) {
        throw new Error(
          `compiler: workload "${componentId}" binds env "${eb.name}" to two different queues ("${previousTarget}" and "${binding.targetId}")`,
        );
      }
      targetByEnvName.set(eb.name, binding.targetId);
      const queueLogical = logicalResourceId(binding.targetId, 'queue');
      if (eb.kind === 'url') {
        entries.push({ Name: eb.name, Value: ref(queueLogical) });
      } else if (eb.kind === 'arn') {
        entries.push({ Name: eb.name, Value: getAtt(queueLogical, 'Arn') });
      } else {
        throw new Error(`compiler: queue env binding kind "${eb.kind}" is not supported`);
      }
    }
  }
  return entries;
}

/**
 * The managed env/secrets bindings every application task definition carries
 * — the SAME set for web, workers and the migration task, so a one-shot
 * migration sees exactly what the workloads that depend on it see.
 */
function appEnvironment(ctx: EcsContext, extraEnv: readonly unknown[] = []): { environment: unknown[]; secrets: unknown[] } {
  const environment: unknown[] = [
    { Name: 'NODE_ENV', Value: 'production' },
    { Name: 'PORT', Value: ref('paramContainerPort') },
  ];
  const secrets: unknown[] = [
    { Name: 'APP_API_KEY', ValueFrom: join('', [ref(logicalResourceId('application', 'config-secret')), ':apiKey::']) },
    { Name: 'APP_SIGNING_SECRET', ValueFrom: join('', [ref(logicalResourceId('application', 'config-secret')), ':signingSecret::']) },
  ];
  if (ctx.db !== undefined) {
    environment.push(
      { Name: 'DATABASE_HOST', Value: getAtt(ctx.db.instance, 'Endpoint.Address') },
      { Name: 'DATABASE_PORT', Value: String(ctx.db.engine === 'mysql' ? MYSQL_DB_PORT : DB_PORT) },
      { Name: 'DATABASE_NAME', Value: DB_NAME },
      { Name: 'DATABASE_USER', Value: DB_USER },
    );
    secrets.push(
      { Name: 'DATABASE_PASSWORD', ValueFrom: join('', [ref(ctx.db.secret), ':password::']) },
      { Name: 'DATABASE_URL', ValueFrom: ref(ctx.db.urlSecret) },
    );
    // The RDS CA bundle under the NEUTRAL name every runtime honours, plus
    // the engine's own conventional variable (Phase 4B).
    environment.push({ Name: 'NODE_EXTRA_CA_CERTS', Value: RDS_CA_BUNDLE_PATH });
    if (ctx.db.engine === 'mysql') {
      // MYSQL_* aliases so engines that read them by name get the same
      // managed values as the generic DATABASE_*/DB_* names.
      // MYSQL_ATTR_SSL_CA is Laravel's name (config/database.php): its schema load passes it to the mysql
      // client as --ssl-ca, and without it that client rejects the RDS certificate.
      environment.push(
        { Name: 'MYSQL_SSL_CA', Value: RDS_CA_BUNDLE_PATH },
        { Name: 'MYSQL_ATTR_SSL_CA', Value: RDS_CA_BUNDLE_PATH },
        { Name: 'MYSQL_HOST', Value: getAtt(ctx.db.instance, 'Endpoint.Address') },
        { Name: 'MYSQL_PORT', Value: String(MYSQL_DB_PORT) },
      );
      secrets.push({ Name: 'MYSQL_URL', ValueFrom: ref(ctx.db.urlSecret) });
    } else {
      environment.push({ Name: 'PGSSLROOTCERT', Value: RDS_CA_BUNDLE_PATH });
    }
  }
  environment.push(
    { Name: 'STORAGE_BUCKET', Value: ref(logicalResourceId('storage', 'bucket')) },
    { Name: 'S3_BUCKET', Value: ref(logicalResourceId('storage', 'bucket')) },
    { Name: 'AWS_S3_BUCKET', Value: ref(logicalResourceId('storage', 'bucket')) },
    { Name: 'AWS_REGION', Value: ref('AWS::Region') },
  );
  if (ctx.cache !== undefined) {
    environment.push(
      { Name: 'REDIS_URL', Value: join('', ['redis://', getAtt(ctx.cache.replicationGroup, 'PrimaryEndPoint.Address'), `:${REDIS_PORT}`]) },
      { Name: 'REDIS_HOST', Value: getAtt(ctx.cache.replicationGroup, 'PrimaryEndPoint.Address') },
      { Name: 'REDIS_PORT', Value: String(REDIS_PORT) },
    );
  }
  // The app's own names for the same managed values, after the standard
  // names and never replacing one. Every task definition (web, workers, the
  // migration and scheduled jobs) gets them from the template itself.
  const taken = new Set([...environment, ...secrets].map((entry) => (entry as { Name: string }).Name));
  for (const { resource, binding } of ctx.aliases) {
    if (taken.has(binding.name)) continue;
    const entry = aliasEntry(ctx, resource, binding.kind);
    if (entry === null) continue;
    taken.add(binding.name);
    if (entry.secret) secrets.push({ Name: binding.name, ValueFrom: entry.value });
    else environment.push({ Name: binding.name, Value: entry.value });
  }
  // Queue env bindings (Phase 5A) — per-workload only, appended after the
  // shared environment every workload sees.
  environment.push(...extraEnv);
  return { environment, secrets };
}

/** The value one alias binding resolves to, or null when the resource has no such value. */
function aliasEntry(
  ctx: EcsContext,
  resource: 'db' | 'cache' | 'storage',
  kind: ManifestEnvBinding['kind'],
): { secret: boolean; value: unknown } | null {
  if (resource === 'db') {
    if (ctx.db === undefined) return null;
    const host = getAtt(ctx.db.instance, 'Endpoint.Address');
    const port = ctx.db.engine === 'mysql' ? MYSQL_DB_PORT : DB_PORT;
    switch (kind) {
      case 'url':
        return { secret: true, value: ref(ctx.db.urlSecret) };
      case 'password':
        return { secret: true, value: join('', [ref(ctx.db.secret), ':password::']) };
      case 'host':
        return { secret: false, value: host };
      case 'port':
        return { secret: false, value: String(port) };
      case 'database':
        return { secret: false, value: DB_NAME };
      case 'username':
        return { secret: false, value: DB_USER };
      case 'jdbc_url':
        return {
          secret: false,
          value: ctx.db.engine === 'mysql'
            ? join('', ['jdbc:mysql://', host, `:${port}/${DB_NAME}?sslMode=REQUIRED`])
            : join('', ['jdbc:postgresql://', host, `:${port}/${DB_NAME}?sslmode=require`]),
        };
      default:
        return null;
    }
  }
  if (resource === 'cache') {
    if (ctx.cache === undefined) return null;
    const host = getAtt(ctx.cache.replicationGroup, 'PrimaryEndPoint.Address');
    if (kind === 'url') return { secret: false, value: join('', ['redis://', host, `:${REDIS_PORT}`]) };
    if (kind === 'host') return { secret: false, value: host };
    if (kind === 'port') return { secret: false, value: String(REDIS_PORT) };
    return null;
  }
  return kind === 'bucket' ? { secret: false, value: ref(logicalResourceId('storage', 'bucket')) } : null;
}

/** The app container's `EntryPoint` and `Command` for a one-shot task: the command replaces the image ENTRYPOINT. */
function oneShotContainerCommandProperties(command: string): { EntryPoint: string[]; Command: string[] } {
  const { entryPoint, command: args } = oneShotContainerCommand(command);
  return { EntryPoint: entryPoint, Command: args };
}

/**
 * The one-shot migration task definition (Phase 4C): the SAME image, env,
 * secrets and CA-sidecar treatment as the app services, with the FROZEN
 * migration command baked into the container `EntryPoint` and `Command` — the relay runs THIS
 * definition as-is and can never inject a command of its own. No service, no
 * ALB, no desired-count parameter, and deliberately NO verification check:
 * a migration is proven by its task exit code, never by a long-lived service.
 */
function compileMigrationTask(ctx: EcsContext, workload: IrWorkload, profile: InfrastructureSizeProfile, extraEnv: readonly unknown[] = []): ResolvedResource[] {
  const componentId = workload.componentId;
  const logGroup = logicalResourceId(componentId, 'log-group');
  const execRole = logicalResourceId('web', 'task-execution-role');
  const taskRole = logicalResourceId(componentId, 'task-role');

  const { environment, secrets } = appEnvironment(ctx, extraEnv);
  const containerDefs: unknown[] = [{
    Name: 'App',
    Essential: true,
    Image: ref('paramImageReference'),
    // The analyzed, frozen command — the graph only ever creates a migration
    // workload WITH a resolved command, so this is always present.
    ...(workload.command !== null ? oneShotContainerCommandProperties(workload.command) : {}),
    LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-group': ref(logGroup), 'awslogs-stream-prefix': 'deployz-migrate', 'awslogs-region': ref('AWS::Region') } },
    Environment: environment,
    Secrets: secrets,
    ...(ctx.db !== undefined
      ? {
          DependsOn: [{ Condition: 'SUCCESS', ContainerName: 'RdsCaBundle' }],
          MountPoints: [{ ContainerPath: RDS_CA_DIR, ReadOnly: true, SourceVolume: RDS_CA_VOLUME }],
        }
      : {}),
  }];
  if (ctx.db !== undefined) {
    containerDefs.push({
      Name: 'RdsCaBundle',
      Essential: false,
      Image: RDS_CA_INIT_IMAGE,
      Command: ['sh', '-c', join('', [`curl -fsSL "https://truststore.pki.rds.amazonaws.com/`, ref('AWS::Region'), `/`, ref('AWS::Region'), `-bundle.pem" -o ${RDS_CA_BUNDLE_PATH} || echo "RDS CA bundle fetch failed; the application starts without it"`])],
      LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-group': ref(logGroup), 'awslogs-stream-prefix': 'deployz-rds-ca', 'awslogs-region': ref('AWS::Region') } },
      MountPoints: [{ ContainerPath: RDS_CA_DIR, ReadOnly: false, SourceVolume: RDS_CA_VOLUME }],
    });
  }

  return [
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, resourceRole: 'task-definition',
      cfnType: 'AWS::ECS::TaskDefinition',
      properties: {
        ContainerDefinitions: containerDefs,
        Cpu: String(profile.workload.cpuUnits),
        ExecutionRoleArn: getAtt(execRole, 'Arn'),
        Family: taskFamily(componentId),
        Memory: String(profile.workload.memoryMiB),
        NetworkMode: 'awsvpc',
        RequiresCompatibilities: ['FARGATE'],
        RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' },
        Tags: tags(componentId),
        TaskRoleArn: getAtt(taskRole, 'Arn'),
        ...(ctx.db !== undefined ? { Volumes: [{ Name: RDS_CA_VOLUME }] } : {}),
      },
      dependsOn: [
        logicalResourceId(componentId, 'task-role-policy'),
        logicalResourceId(componentId, 'task-role'),
      ],
    }),
  ];
}

/** Task definition + service + security group for one workload (web or worker). */
function compileWorkloadService(ctx: EcsContext, workload: IrWorkload, profile: InfrastructureSizeProfile, ingress: { targetGroup: string; listener: string } | undefined, extraEnv: readonly unknown[] = []): ResolvedResource[] {
  const componentId = workload.componentId;
  const logGroup = logicalResourceId(componentId, 'log-group');
  const execRole = logicalResourceId('web', 'task-execution-role');
  const taskRole = logicalResourceId(componentId, 'task-role');
  const taskDef = logicalResourceId(componentId, 'task-definition');
  const serviceSg = logicalResourceId(componentId, 'service-security-group');

  const { environment, secrets } = appEnvironment(ctx, extraEnv);

  const containerDefs: unknown[] = [{
    Name: 'App',
    Essential: true,
    Image: ref('paramImageReference'),
    // Only workloads with a declared, runnable start command freeze the
    // command into the task definition (Phase 4A workers). The web workload
    // keeps the image's own CMD — the web command slot may hold a detector
    // pattern label, never a runnable override here.
    ...(workload.kind === 'worker' && workload.command !== null
      ? { Command: workloadContainerCommand(workload.command) }
      : {}),
    ...(workload.port !== null ? { PortMappings: [{ ContainerPort: ref('paramContainerPort'), Protocol: 'tcp' }] } : {}),
    LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-group': ref(logGroup), 'awslogs-stream-prefix': 'deployz-app', 'awslogs-region': ref('AWS::Region') } },
    Environment: environment,
    Secrets: secrets,
    ...(ctx.db !== undefined
      ? {
          DependsOn: [{ Condition: 'SUCCESS', ContainerName: 'RdsCaBundle' }],
          MountPoints: [{ ContainerPath: RDS_CA_DIR, ReadOnly: true, SourceVolume: RDS_CA_VOLUME }],
        }
      : {}),
  }];

  if (ctx.db !== undefined) {
    containerDefs.push({
      Name: 'RdsCaBundle',
      Essential: false,
      Image: RDS_CA_INIT_IMAGE,
      Command: ['sh', '-c', join('', [`curl -fsSL "https://truststore.pki.rds.amazonaws.com/`, ref('AWS::Region'), `/`, ref('AWS::Region'), `-bundle.pem" -o ${RDS_CA_BUNDLE_PATH} || echo "RDS CA bundle fetch failed; the application starts without it"`])],
      LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-group': ref(logGroup), 'awslogs-stream-prefix': 'deployz-rds-ca', 'awslogs-region': ref('AWS::Region') } },
      MountPoints: [{ ContainerPath: RDS_CA_DIR, ReadOnly: false, SourceVolume: RDS_CA_VOLUME }],
    });
  }

  const out: ResolvedResource[] = [
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, resourceRole: 'task-definition',
      cfnType: 'AWS::ECS::TaskDefinition',
      properties: {
        ContainerDefinitions: containerDefs,
        Cpu: String(profile.workload.cpuUnits),
        ExecutionRoleArn: getAtt(execRole, 'Arn'),
        Family: taskFamily(componentId),
        Memory: String(profile.workload.memoryMiB),
        NetworkMode: 'awsvpc',
        RequiresCompatibilities: ['FARGATE'],
        RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' },
        Tags: tags(componentId),
        TaskRoleArn: getAtt(taskRole, 'Arn'),
        ...(ctx.db !== undefined ? { Volumes: [{ Name: RDS_CA_VOLUME }] } : {}),
      },
    }),
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, resourceRole: 'service-security-group',
      cfnType: 'AWS::EC2::SecurityGroup',
      properties: { GroupDescription: `DeployzApp/${componentId}/SecurityGroup`, SecurityGroupEgress: [{ CidrIp: '0.0.0.0/0', Description: 'Allow all outbound traffic by default', IpProtocol: '-1' }], Tags: tags(componentId), VpcId: ref(ctx.ids.vpc) },
    }),
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_SERVICE, resourceRole: 'service',
      cfnType: 'AWS::ECS::Service', verificationCheck: 'compute',
      properties: {
        Cluster: ref(logicalResourceId('web', 'cluster')),
        DeploymentConfiguration: {
          Alarms: { AlarmNames: [], Enable: false, Rollback: false },
          DeploymentCircuitBreaker: { Enable: true, Rollback: true },
          MaximumPercent: 200,
          MinimumHealthyPercent: 100,
        },
        DeploymentController: { Type: 'ECS' },
        // Every service shares the deployment-level desired-count parameter:
        // an install starts 0 tasks and the first deploy scales up, so a
        // worker service must not boot the fixture image at install time.
        DesiredCount: ref('paramDesiredCount'),
        EnableECSManagedTags: false,
        // The ALB grace period only applies to a load-balanced service — a
        // worker has no HTTP health check at all (service-stability only).
        // It covers a boot that migrates first: an app that needs about 90 s on
        // 0.25 vCPU (ghostfolio: prisma migrate, seed, Nest) was killed after
        // 60 s and every rollout of it failed.
        ...(ingress !== undefined ? { HealthCheckGracePeriodSeconds: WEB_HEALTH_CHECK_GRACE_SECONDS } : {}),
        LaunchType: 'FARGATE',
        ...(ingress !== undefined
          ? { LoadBalancers: [{ ContainerName: 'App', ContainerPort: ref('paramContainerPort'), TargetGroupArn: ref(ingress.targetGroup) }] }
          : {}),
        NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: 'DISABLED', SecurityGroups: [getAtt(serviceSg, 'GroupId')], Subnets: [ref(ctx.ids.privateSubnets[0]), ref(ctx.ids.privateSubnets[1])] } },
        Tags: tags(componentId),
        TaskDefinition: ref(taskDef),
      },
      dependsOn: [
        ...(ingress !== undefined ? [ingress.targetGroup, ingress.listener] : []),
        logicalResourceId(componentId, 'task-role-policy'),
        logicalResourceId(componentId, 'task-role'),
      ],
    }),
  ];

  return out;
}

/** ALB + listener + target group + alarm + ingress — for public workloads. */
/** The target-group status codes beyond the default 200: 400 for a Host-checked app, 3xx for the default `/`. */
function healthMatcher(check: IrWorkload['healthCheck']): { Matcher?: { HttpCode: string } } {
  if (check?.redirectsAccepted === true) return { Matcher: { HttpCode: check.hostChecked === true ? '200-400' : '200-399' } };
  return check?.hostChecked === true ? { Matcher: { HttpCode: '200,400' } } : {};
}

function compileAlb(ctx: EcsContext, workload: IrWorkload): ResolvedResource[] {
  const componentId = 'endpoint';
  const alb = logicalResourceId(componentId, 'load-balancer');
  const albSg = logicalResourceId(componentId, 'load-balancer-security-group');
  const targetGroup = logicalResourceId(componentId, 'target-group');
  const serviceSg = logicalResourceId(workload.componentId, 'service-security-group');

  return [
    res({
      componentId, componentKind: 'endpoint', capability: CAPABILITY_KEYS.ALB, resourceRole: 'load-balancer-security-group',
      cfnType: 'AWS::EC2::SecurityGroup',
      properties: {
        GroupDescription: 'Automatically created Security Group for the application load balancer',
        SecurityGroupIngress: [
          { CidrIp: '0.0.0.0/0', Description: 'HTTPS for a custom domain attached after install', FromPort: 443, IpProtocol: 'tcp', ToPort: 443 },
          { CidrIp: '0.0.0.0/0', Description: 'Allow from anyone on port 80', FromPort: 80, IpProtocol: 'tcp', ToPort: 80 },
        ],
        Tags: tags(componentId),
        VpcId: ref(ctx.ids.vpc),
      },
    }),
    res({
      componentId, componentKind: 'endpoint', capability: CAPABILITY_KEYS.ALB, resourceRole: 'load-balancer',
      cfnType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', verificationCheck: 'ingress',
      properties: {
        LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'false' }],
        Scheme: 'internet-facing',
        SecurityGroups: [getAtt(albSg, 'GroupId')],
        Subnets: [ref(ctx.ids.publicSubnets[0]), ref(ctx.ids.publicSubnets[1])],
        Tags: tags(componentId),
        Type: 'application',
      },
      dependsOn: [
        logicalResourceId('network', 'public-route-1'),
        logicalResourceId('network', 'public-route-table-association-1'),
        logicalResourceId('network', 'public-route-2'),
        logicalResourceId('network', 'public-route-table-association-2'),
      ],
    }),
    res({
      componentId, componentKind: 'endpoint', capability: CAPABILITY_KEYS.ALB, resourceRole: 'target-group',
      cfnType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
      properties: {
        HealthCheckPath: ref('paramHealthCheckPath'),
        // The ALB health check sends the task IP as Host. An app that checks the Host header answers it 400
        // while it serves its own domain, so for that app 400 also proves the process is up. The default `/`
        // of an app without health evidence may redirect to a login or setup page, which also proves it.
        ...healthMatcher(workload.healthCheck),
        Port: ref('paramContainerPort'),
        Protocol: 'HTTP',
        Tags: tags(componentId),
        TargetGroupAttributes: [{ Key: 'stickiness.enabled', Value: 'false' }],
        TargetType: 'ip',
        VpcId: ref(ctx.ids.vpc),
      },
    }),
    res({
      componentId, componentKind: 'endpoint', capability: CAPABILITY_KEYS.ALB, resourceRole: 'http-listener',
      cfnType: 'AWS::ElasticLoadBalancingV2::Listener',
      properties: {
        DefaultActions: [{ TargetGroupArn: ref(targetGroup), Type: 'forward' }],
        LoadBalancerArn: ref(alb),
        Port: 80,
        Protocol: 'HTTP',
        Tags: tags(componentId),
      },
    }),
    res({
      componentId, componentKind: 'endpoint', capability: CAPABILITY_KEYS.ALB, resourceRole: 'load-balancer-to-service-ingress',
      cfnType: 'AWS::EC2::SecurityGroupIngress',
      properties: { Description: 'Load balancer to target', FromPort: ref('paramContainerPort'), GroupId: getAtt(serviceSg, 'GroupId'), IpProtocol: 'tcp', SourceSecurityGroupId: getAtt(albSg, 'GroupId'), ToPort: ref('paramContainerPort') },
    }),
    res({
      componentId, componentKind: 'endpoint', capability: CAPABILITY_KEYS.ALB, resourceRole: 'load-balancer-to-service-egress',
      cfnType: 'AWS::EC2::SecurityGroupEgress',
      properties: { Description: 'Load balancer to target', DestinationSecurityGroupId: getAtt(serviceSg, 'GroupId'), FromPort: ref('paramContainerPort'), GroupId: getAtt(albSg, 'GroupId'), IpProtocol: 'tcp', ToPort: ref('paramContainerPort') },
    }),
    res({
      componentId, componentKind: 'monitoring', capability: CAPABILITY_KEYS.ALB, resourceRole: 'unhealthy-target-alarm',
      cfnType: 'AWS::CloudWatch::Alarm',
      properties: {
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        DatapointsToAlarm: 3,
        Dimensions: [
          { Name: 'LoadBalancer', Value: getAtt(alb, 'LoadBalancerFullName') },
          { Name: 'TargetGroup', Value: getAtt(targetGroup, 'TargetGroupFullName') },
        ],
        EvaluationPeriods: 3,
        MetricName: 'UnHealthyHostCount',
        Namespace: 'AWS/ApplicationELB',
        Period: 60,
        Statistic: 'Average',
        Threshold: 1,
        TreatMissingData: 'notBreaching',
      },
    }),
  ];
}

// ── Scheduled jobs, queues, EventBridge Scheduler (Phase 5) ─────────────────

/**
 * The one-shot scheduled-job task definition (Phase 5D): the same shape as
 * the migration task (frozen command, no service, no ALB, NO verification
 * check — a scheduled job is never deployment-gating) but with its own
 * security group (for the RDS ingress rule and the scheduler's ECS network
 * configuration) and its own stream prefix, kept separate from the migration
 * task's naming.
 */
function compileScheduledJobTask(ctx: EcsContext, workload: IrWorkload, profile: InfrastructureSizeProfile, extraEnv: readonly unknown[] = []): ResolvedResource[] {
  const componentId = workload.componentId;
  const logGroup = logicalResourceId(componentId, 'log-group');
  const execRole = logicalResourceId('web', 'task-execution-role');
  const taskRole = logicalResourceId(componentId, 'task-role');

  const { environment, secrets } = appEnvironment(ctx, extraEnv);
  const containerDefs: unknown[] = [{
    Name: 'App',
    Essential: true,
    Image: ref('paramImageReference'),
    ...(workload.command !== null ? oneShotContainerCommandProperties(workload.command) : {}),
    LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-group': ref(logGroup), 'awslogs-stream-prefix': 'deployz-job', 'awslogs-region': ref('AWS::Region') } },
    Environment: environment,
    Secrets: secrets,
    ...(ctx.db !== undefined
      ? {
          DependsOn: [{ Condition: 'SUCCESS', ContainerName: 'RdsCaBundle' }],
          MountPoints: [{ ContainerPath: RDS_CA_DIR, ReadOnly: true, SourceVolume: RDS_CA_VOLUME }],
        }
      : {}),
  }];
  if (ctx.db !== undefined) {
    containerDefs.push({
      Name: 'RdsCaBundle',
      Essential: false,
      Image: RDS_CA_INIT_IMAGE,
      Command: ['sh', '-c', join('', [`curl -fsSL "https://truststore.pki.rds.amazonaws.com/`, ref('AWS::Region'), `/`, ref('AWS::Region'), `-bundle.pem" -o ${RDS_CA_BUNDLE_PATH} || echo "RDS CA bundle fetch failed; the application starts without it"`])],
      LogConfiguration: { LogDriver: 'awslogs', Options: { 'awslogs-group': ref(logGroup), 'awslogs-stream-prefix': 'deployz-rds-ca', 'awslogs-region': ref('AWS::Region') } },
      MountPoints: [{ ContainerPath: RDS_CA_DIR, ReadOnly: false, SourceVolume: RDS_CA_VOLUME }],
    });
  }

  return [
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_TASK, resourceRole: 'task-definition',
      cfnType: 'AWS::ECS::TaskDefinition',
      properties: {
        ContainerDefinitions: containerDefs,
        Cpu: String(profile.workload.cpuUnits),
        ExecutionRoleArn: getAtt(execRole, 'Arn'),
        Family: taskFamily(componentId),
        Memory: String(profile.workload.memoryMiB),
        NetworkMode: 'awsvpc',
        RequiresCompatibilities: ['FARGATE'],
        RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' },
        Tags: tags(componentId),
        TaskRoleArn: getAtt(taskRole, 'Arn'),
        ...(ctx.db !== undefined ? { Volumes: [{ Name: RDS_CA_VOLUME }] } : {}),
      },
      dependsOn: [
        logicalResourceId(componentId, 'task-role-policy'),
        logicalResourceId(componentId, 'task-role'),
      ],
    }),
    res({
      componentId, componentKind: 'application', capability: CAPABILITY_KEYS.ECS_FARGATE_TASK, resourceRole: 'task-security-group',
      cfnType: 'AWS::EC2::SecurityGroup',
      properties: { GroupDescription: `DeployzApp/${componentId}/SecurityGroup`, SecurityGroupEgress: [{ CidrIp: '0.0.0.0/0', Description: 'Allow all outbound traffic by default', IpProtocol: '-1' }], Tags: tags(componentId), VpcId: ref(ctx.ids.vpc) },
    }),
  ];
}

/** Standard SQS queue + its TLS-deny queue policy (Phase 5A). FIFO fails closed — the planner never resolves one, but the compiler stays honest if it ever did. */
function compileQueues(ir: DeployzIR): ResolvedResource[] {
  const out: ResolvedResource[] = [];
  for (const q of ir.resources.filter((r) => r.capabilityKey === CAPABILITY_KEYS.SQS)) {
    const componentId = q.componentId;
    const configuration = q.configuration as { queueType?: unknown; messageRetentionSeconds?: unknown; visibilityTimeoutSeconds?: unknown };
    if (configuration.queueType !== 'standard') {
      throw new Error(`compiler: queue "${componentId}" has unsupported queueType "${String(configuration.queueType)}" (only "standard" is supported)`);
    }
    const queue = logicalResourceId(componentId, 'queue');
    // A queue → queue dead-letter edge sourced FROM this queue sets ITS OWN
    // redrive policy, pointing at the target DLQ.
    const redrive = ir.bindings.find((b) => b.sourceId === componentId && b.access === 'dead-letter');

    out.push(res({
      componentId, componentKind: 'queue', capability: CAPABILITY_KEYS.SQS, resourceRole: 'queue',
      cfnType: 'AWS::SQS::Queue', verificationCheck: 'queue',
      properties: {
        MessageRetentionPeriod: configuration.messageRetentionSeconds,
        VisibilityTimeout: configuration.visibilityTimeoutSeconds,
        SqsManagedSseEnabled: true,
        Tags: tags(componentId),
        ...(redrive !== undefined
          ? { RedrivePolicy: { deadLetterTargetArn: getAtt(logicalResourceId(redrive.targetId, 'queue'), 'Arn'), maxReceiveCount: redrive.maxReceiveCount } }
          : {}),
      },
    }));
    out.push(res({
      componentId, componentKind: 'queue', capability: CAPABILITY_KEYS.SQS, resourceRole: 'queue-policy',
      cfnType: 'AWS::SQS::QueuePolicy',
      properties: {
        PolicyDocument: {
          Statement: [{
            Action: 'sqs:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            Effect: 'Deny',
            Principal: { AWS: '*' },
            Resource: getAtt(queue, 'Arn'),
          }],
          Version: '2012-10-17',
        },
        Queues: [ref(queue)],
      },
    }));
  }
  return out;
}

/** Map one schedule IAM action to its resource(s) + condition, by service prefix — capability-local, fails closed on an unknown action. */
function scheduleActionStatement(action: string, res_: { family: { revisionless: unknown; allRevisions: unknown }; clusterArn: unknown; jobTaskRoleArn: unknown; execRoleArn: unknown; dlqArn: unknown }): unknown {
  const service = action.split(':')[0];
  if (service === 'ecs') {
    return {
      Action: action,
      Effect: 'Allow',
      Resource: [res_.family.revisionless, res_.family.allRevisions],
      Condition: { ArnEquals: { 'ecs:cluster': res_.clusterArn } },
    };
  }
  if (service === 'iam') {
    return {
      Action: action,
      Effect: 'Allow',
      Resource: [res_.jobTaskRoleArn, res_.execRoleArn],
      Condition: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
    };
  }
  if (service === 'sqs') {
    return { Action: action, Effect: 'Allow', Resource: res_.dlqArn };
  }
  throw new Error(`compiler: schedule IAM action "${action}" has no resource mapping`);
}

/**
 * EventBridge Scheduler role + policy + schedule for one IR schedule
 * (Phase 5C): a confused-deputy-guarded role, IAM derived ONLY from the
 * schedule's own invoke/dead-letter bindings, and the schedule resource
 * targeting the ALWAYS-latest (revisionless) task definition family — the
 * relay registers each release as a new revision of the same family. The
 * family is unique to the installation, so no other installation's revision
 * can ever be its latest.
 */
function compileSchedule(ir: DeployzIR, schedule: IrSchedule, ids: NetIds): ResolvedResource[] {
  const id = schedule.id;
  const role = logicalResourceId(id, 'scheduler-role');
  const policy = logicalResourceId(id, 'scheduler-role-policy');

  const familyArn = ['arn:', ref('AWS::Partition'), ':ecs:', ref('AWS::Region'), ':', ref('AWS::AccountId'), ':task-definition/', taskFamily(schedule.targetWorkloadId)];
  const familyRevisionless = join('', familyArn);
  const familyAllRevisions = join('', [...familyArn, ':*']);
  const clusterArn = getAtt(logicalResourceId('web', 'cluster'), 'Arn');
  const jobTaskRoleArn = getAtt(logicalResourceId(schedule.targetWorkloadId, 'task-role'), 'Arn');
  const execRoleArn = getAtt(logicalResourceId('web', 'task-execution-role'), 'Arn');
  const dlqArn = schedule.deadLetterQueueId !== null ? getAtt(logicalResourceId(schedule.deadLetterQueueId, 'queue'), 'Arn') : undefined;

  const invokeBinding = ir.bindings.find((b) => b.sourceId === id && b.access === 'invoke');
  const deadLetterBinding = ir.bindings.find((b) => b.sourceId === id && b.access === 'dead-letter');
  const statementCtx = { family: { revisionless: familyRevisionless, allRevisions: familyAllRevisions }, clusterArn, jobTaskRoleArn, execRoleArn, dlqArn };
  const statements: unknown[] = [
    ...(invokeBinding !== undefined ? invokeBinding.iamActions.map((a) => scheduleActionStatement(a, statementCtx)) : []),
    ...(deadLetterBinding !== undefined ? deadLetterBinding.iamActions.map((a) => scheduleActionStatement(a, statementCtx)) : []),
  ];

  const target: Record<string, unknown> = {
    Arn: clusterArn,
    RoleArn: getAtt(role, 'Arn'),
    RetryPolicy: { MaximumRetryAttempts: schedule.retry.maximumRetryAttempts, MaximumEventAgeInSeconds: schedule.retry.maximumEventAgeSeconds },
    ...(schedule.deadLetterQueueId !== null ? { DeadLetterConfig: { Arn: dlqArn } } : {}),
    EcsParameters: {
      TaskDefinitionArn: familyRevisionless,
      TaskCount: 1,
      LaunchType: 'FARGATE',
      NetworkConfiguration: {
        AwsvpcConfiguration: {
          Subnets: [ref(ids.privateSubnets[0]), ref(ids.privateSubnets[1])],
          SecurityGroups: [getAtt(logicalResourceId(schedule.targetWorkloadId, 'task-security-group'), 'GroupId')],
          AssignPublicIp: 'DISABLED',
        },
      },
    },
  };

  return [
    res({
      componentId: id, componentKind: 'schedule', capability: CAPABILITY_KEYS.EVENTBRIDGE_SCHEDULER, resourceRole: 'scheduler-role',
      cfnType: 'AWS::IAM::Role',
      properties: {
        AssumeRolePolicyDocument: {
          Statement: [{
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: { Service: 'scheduler.amazonaws.com' },
            Condition: { StringEquals: { 'aws:SourceAccount': ref('AWS::AccountId') } },
          }],
          Version: '2012-10-17',
        },
        Description: "Allows EventBridge Scheduler to start this schedule's target task.",
        Path: '/deployz/',
        PermissionsBoundary: roleBoundary(),
        Tags: tags(id),
      },
    }),
    res({
      componentId: id, componentKind: 'schedule', capability: CAPABILITY_KEYS.EVENTBRIDGE_SCHEDULER, resourceRole: 'scheduler-role-policy',
      cfnType: 'AWS::IAM::Policy',
      properties: {
        PolicyDocument: { Statement: statements, Version: '2012-10-17' },
        PolicyName: policy,
        Roles: [ref(role)],
      },
    }),
    res({
      componentId: id, componentKind: 'schedule', capability: CAPABILITY_KEYS.EVENTBRIDGE_SCHEDULER, resourceRole: 'schedule',
      cfnType: 'AWS::Scheduler::Schedule', verificationCheck: 'schedule',
      properties: {
        // A deterministic name under the stack's prefix: the bootstrap
        // execution role may manage only `schedule/default/<stack>*`
        // (schedules carry no tags). ≤ 64 chars: stack name + a ≤ 48-char id.
        Name: join('-', [ref('AWS::StackName'), pascal(id)]),
        ScheduleExpression: translateScheduleExpression(schedule.expression),
        ...(schedule.timezone !== null ? { ScheduleExpressionTimezone: schedule.timezone } : {}),
        FlexibleTimeWindow: { Mode: 'OFF' },
        State: schedule.enabled ? 'ENABLED' : 'DISABLED',
        Target: target,
      },
      dependsOn: [policy, logicalResourceId(schedule.targetWorkloadId, 'task-definition')],
    }),
  ];
}

// ── Parameters / outputs / conditions ───────────────────────────────────────

/**
 * The permissions boundary of every IAM role this stack creates. The relay
 * passes its connector's boundary ARN; the connector's execution role
 * refuses to create a role without it. Empty (a connector published before
 * the boundary) leaves the role without one, as that connector expects.
 */
function roleBoundary(): unknown {
  return { 'Fn::If': ['condRoleBoundary', ref('paramRoleBoundaryArn'), { Ref: 'AWS::NoValue' }] };
}

function compileParameters(): ResolvedParameter[] {
  const azParams: ResolvedParameter[] = [];
  for (let i = 1; i <= DB_AZ_SLOT_COUNT; i++) {
    azParams.push({
      id: `paramDbAz${i}`,
      type: 'String',
      noEcho: false,
      defaultValue: '',
      description: `Availability Zone for database subnet slot ${i}. Empty means the slot is unused.`,
    });
  }
  return [
    { id: 'paramTaskFamilySuffix', type: 'String', noEcho: false, allowedPattern: '^[a-z0-9]+$', description: 'Installation-unique suffix of every task-definition family this stack creates. No default: a stack can never fall back to a family another installation shares.' },
    { id: 'paramDesiredCount', type: 'Number', noEcho: false, defaultValue: '1', description: 'Number of application tasks the service starts with. 0 defers the first start to the configured deploy that follows the install.' },
    { id: 'paramImageReference', type: 'String', noEcho: false, defaultValue: `${DEFAULT_IMAGE_REPOSITORY}@${DEFAULT_IMAGE_DIGEST}`, description: 'Container image reference (repository@sha256:...) the application task definitions run.' },
    { id: 'paramContainerPort', type: 'Number', noEcho: true, defaultValue: String(APP_PORT), description: 'TCP port the application container listens on.' },
    { id: 'paramHealthCheckPath', type: 'String', noEcho: true, defaultValue: HEALTH_CHECK_PATH, description: 'Path the ALB target group and container health checks probe.' },
    { id: 'paramAppApiKey', type: 'String', noEcho: true, defaultValue: '', description: 'Application API key (vendor/customer secret).' },
    { id: 'paramAppSigningSecret', type: 'String', noEcho: true, defaultValue: '', description: 'Application signing secret (vendor/customer secret).' },
    { id: 'paramRoleBoundaryArn', type: 'String', noEcho: false, defaultValue: '', description: "Permissions boundary of every IAM role the stack creates. The relay passes its connector's boundary; empty means none." },
    ...azParams,
  ];
}

function compileOutputs(ctx: { hasDb: boolean; db: { instance: string; secret: string } | undefined; hasRedis: boolean; cache: { replicationGroup: string } | undefined; hasIngress: boolean }): ResolvedOutput[] {
  const outputs: ResolvedOutput[] = [];
  if (ctx.hasDb && ctx.db !== undefined) {
    outputs.push({ id: 'DbHost', value: getAtt(ctx.db.instance, 'Endpoint.Address') });
    outputs.push({ id: 'DbSecretArn', value: ref(ctx.db.secret) });
  }
  outputs.push({ id: 'StorageBucketName', value: ref(logicalResourceId('storage', 'bucket')) });
  outputs.push({ id: 'ClusterName', value: ref(logicalResourceId('web', 'cluster')) });
  if (ctx.hasIngress) {
    outputs.push({ id: 'PublicEndpoint', value: getAtt(logicalResourceId('endpoint', 'load-balancer'), 'DNSName') });
  }
  if (ctx.hasRedis && ctx.cache !== undefined) {
    outputs.push({ id: 'CacheEndpoint', value: getAtt(ctx.cache.replicationGroup, 'PrimaryEndPoint.Address') });
  }
  return outputs;
}

/**
 * The task-definition family of one workload: `DeployzApp<Pascal>` plus the
 * installation's suffix (`paramTaskFamilySuffix`). Two installations in one
 * AWS account and Region never share a family. Mirrors `deployzTaskFamily`
 * in `@deployz/contracts`.
 */
function taskFamily(componentId: string): unknown {
  return join('', [`DeployzApp${pascal(componentId)}`, ref('paramTaskFamilySuffix')]);
}

function pascal(token: string): string {
  return token
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface CompileInput {
  readonly ir: DeployzIR;
  readonly region: Region | null;
  readonly sizeProfile?: InfrastructureSizeProfile;
}

export interface CompiledGraph {
  readonly graph: ResolvedAwsGraph;
  readonly compilerVersion: string;
  readonly capabilityRegistryVersion: string;
  readonly region: Region | null;
}

/**
 * The persistent workloads to compile — one ECS service per `web`/`worker`
 * workload (Phase 4A). The one-shot `migration` workload (Phase 4C) and the
 * one-shot `scheduled-job` workload (Phase 5D) each compile a task definition
 * only; the not-yet-supported private-service/lambda kinds stay skipped.
 */
function persistentWorkloads(ir: DeployzIR): IrWorkload[] {
  const persistent = ir.workloads.filter((w) => w.kind === 'web' || w.kind === 'worker');
  if (persistent.length === 0) {
    throw new Error('compiler: DeployzIR has no persistent workload to compile');
  }
  return persistent;
}

function resourceByCapability(ir: DeployzIR, key: string): IrResource | undefined {
  return ir.resources.find((r) => r.capabilityKey === key);
}

export function compileInfrastructure(input: CompileInput): CompiledGraph {
  const { ir, region } = input;
  const profile = input.sizeProfile ?? defaultInfrastructureSizeProfile();

  const dbResource = resourceByCapability(ir, CAPABILITY_KEYS.RDS_POSTGRES) ?? resourceByCapability(ir, CAPABILITY_KEYS.RDS_MYSQL);
  const cacheResource = resourceByCapability(ir, CAPABILITY_KEYS.ELASTICACHE_VALKEY);
  const services = persistentWorkloads(ir);
  // The one-shot migration workload (Phase 4C) — at most one per graph.
  const migrationWorkload = ir.workloads.find((w) => w.kind === 'migration') ?? null;
  // The one-shot scheduled-job workloads (Phase 5D) — each invoked by its
  // own EventBridge Scheduler schedule.
  const scheduledJobWorkloads = ir.workloads.filter((w) => w.kind === 'scheduled-job');

  const ids = netIds();

  // Resolve the db/cache context before ECS so the task definitions can bind
  // to the endpoint/secret logical ids.
  const db = dbResource !== undefined
    ? {
        componentId: dbResource.componentId,
        engine: dbResource.capabilityKey === CAPABILITY_KEYS.RDS_MYSQL ? ('mysql' as const) : ('postgres' as const),
        secret: logicalResourceId(dbResource.componentId, 'master-secret'),
        urlSecret: logicalResourceId(dbResource.componentId, 'url-secret'),
        instance: logicalResourceId(dbResource.componentId, 'instance'),
      }
    : undefined;
  const cache = cacheResource !== undefined
    ? {
        componentId: cacheResource.componentId,
        replicationGroup: logicalResourceId(cacheResource.componentId, 'replication-group'),
      }
    : undefined;

  const storageResource = resourceByCapability(ir, CAPABILITY_KEYS.S3);
  const aliases = [
    ...(db !== undefined ? (dbResource?.envBindings ?? []).map((binding) => ({ resource: 'db' as const, binding })) : []),
    ...(cache !== undefined ? (cacheResource?.envBindings ?? []).map((binding) => ({ resource: 'cache' as const, binding })) : []),
    ...(storageResource?.envBindings ?? []).map((binding) => ({ resource: 'storage' as const, binding })),
  ];
  const ctx: EcsContext = { ids, hasDb: db !== undefined, hasRedis: cache !== undefined, db, cache, aliases };

  // Only PUBLIC workloads sit behind the ALB — a worker gets no target group,
  // no listener and no HTTP health check.
  const publicWorkload = services.find((w) => w.public === true);
  const ingress =
    publicWorkload !== undefined
      ? {
          targetGroup: logicalResourceId('endpoint', 'target-group'),
          listener: logicalResourceId('endpoint', 'http-listener'),
        }
      : undefined;

  // Every workload that runs a container gets its own IAM task role (Phase
  // 5): 'web' first, so a web-only IR reproduces the pre-Phase-5 shared
  // `web/task-role(-policy)` byte-for-byte (it has no queue edges).
  const roleComponentIds = [
    'web',
    ...services.filter((w) => w.componentId !== 'web').map((w) => w.componentId),
    ...(migrationWorkload !== null ? [migrationWorkload.componentId] : []),
    ...scheduledJobWorkloads.map((w) => w.componentId),
  ];
  const secretArns = computeSecretArns(ctx);

  const resources: ResolvedResource[] = [
    ...compileNetwork(ids),
    ...compileDbSubnets(ids),
    compileAppSecret(),
    ...compileS3(),
    // Every workload's tasks log to their own group — the migration and
    // scheduled-job tasks included (their Arns land in the shared
    // execution-role policy below).
    ...services.map((w) => compileLogGroup(w.componentId)),
    ...(migrationWorkload !== null ? [compileLogGroup(migrationWorkload.componentId)] : []),
    ...scheduledJobWorkloads.map((w) => compileLogGroup(w.componentId)),
    ...(dbResource !== undefined
      ? compileRds(dbResource, profile, ids, [
          ...services.map((w) => ({ componentId: w.componentId, sgRole: 'service-security-group' })),
          ...scheduledJobWorkloads.map((w) => ({ componentId: w.componentId, sgRole: 'task-security-group' })),
        ])
      : []),
    ...(cacheResource !== undefined ? compileElasticache(cacheResource, profile, ids) : []),
    ...compileEcsShared(ctx, [...services, ...(migrationWorkload !== null ? [migrationWorkload] : []), ...scheduledJobWorkloads]),
    ...roleComponentIds.flatMap((componentId) => compileWorkloadTaskRole(componentId, secretArns, queueEdgeStatements(ir, componentId))),
    ...services.flatMap((w) => compileWorkloadService(ctx, w, profile, w.public === true ? ingress : undefined, queueEnvEntries(ir, w.componentId))),
    ...(migrationWorkload !== null ? compileMigrationTask(ctx, migrationWorkload, profile, queueEnvEntries(ir, migrationWorkload.componentId)) : []),
    ...scheduledJobWorkloads.flatMap((w) => compileScheduledJobTask(ctx, w, profile, queueEnvEntries(ir, w.componentId))),
    ...compileQueues(ir),
    ...ir.schedules.flatMap((s) => compileSchedule(ir, s, ids)),
    ...(publicWorkload !== undefined ? compileAlb(ctx, publicWorkload) : []),
  ];

  const violations = logicalIdViolations(resources.map((r) => r.logicalId));
  if (violations.length > 0) {
    throw new Error(`compiler: logical id violations:\n${violations.join('\n')}`);
  }

  const conditions: ResolvedCondition[] = [
    { id: 'condRoleBoundary', expression: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'paramRoleBoundaryArn' }, ''] }] } },
  ];
  for (let i = 3; i <= DB_AZ_SLOT_COUNT; i++) {
    conditions.push({
      id: `condDbAz${i}`,
      expression: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: `paramDbAz${i}` }, ''] }] },
    });
  }

  const graph: ResolvedAwsGraph = {
    resources,
    parameters: compileParameters(),
    outputs: compileOutputs({
      hasDb: db !== undefined,
      db,
      hasRedis: cache !== undefined,
      cache,
      hasIngress: publicWorkload !== undefined,
    }),
    conditions,
  };

  return {
    graph,
    compilerVersion: COMPILER_VERSION,
    capabilityRegistryVersion: ir.metadata.capabilityRegistryVersion,
    region,
  };
}
