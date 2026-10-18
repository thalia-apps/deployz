import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import {
  InstanceType,
  InstanceClass,
  InstanceSize,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
  type IVpc,
} from 'aws-cdk-lib/aws-ec2';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { ComputeType } from 'aws-cdk-lib/aws-codebuild';
import {
  Credentials,
  DatabaseInstance,
  DatabaseInstanceEngine,
  PostgresEngineVersion,
} from 'aws-cdk-lib/aws-rds';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import {
  BlockPublicAccess,
  Bucket,
  BucketAccessControl,
  ObjectOwnership,
  type IBucket,
} from 'aws-cdk-lib/aws-s3';
import { DomainName, HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';

import { CONFIG_SECRET_KMS_CONTEXT_KEYS, CONFIG_SECRET_KMS_PURPOSE } from '@deployz/contracts';

import { ApiLambda } from './api-lambda.js';
import { BuildPipeline } from './pipeline/build-pipeline.js';
import { stageNames, type DeployzStage } from './stage.js';
import { WorkerLambda } from './worker-lambda.js';

export interface DeployzStackProps extends StackProps {
  /**
   * Which control plane this stack is. Selects the account-unique names
   * (KMS alias, ECR repository, template-bucket prefix) so a staging stack
   * can stand beside production in one account. Default: production.
   */
  readonly stage?: DeployzStage;
}

/**
 * Deployz control-plane stack.
 *
 * Provisions the core infrastructure for the Deployz backend:
 * - VPC with private subnets for RDS
 * - RDS PostgreSQL (db.t4g.micro for MVP; swap to Serverless v2 post-MVP)
 * - Lambda function wrapping the Fastify API (bundled via esbuild)
 * - HTTP API Gateway in front of the Lambda
 * - SQS queue + worker Lambda for async job processing
 * - CodeBuild + ECR release build pipeline, and the public bucket the
 *   customer bootstrap template is published to
 *
 * Region: us-east-1 (hardcoded per plan §32 region allowlist).
 *
 * Credentials are injected by loading the repo-root .env in bin/deployz.ts
 * (dotenv config with explicit path). The env vars are collected here and
 * passed to the Lambda via the `environment` prop.
 */
export class DeployzStack extends Stack {
  constructor(scope: Construct, id: string, props?: DeployzStackProps) {
    super(scope, id, { ...props, env: { region: 'us-east-1' } });

    const names = stageNames(props?.stage ?? 'production');

    Tags.of(this).add('deployz:managed', 'true');
    Tags.of(this).add('deployz:scope', 'control-plane');

    // ── VPC ──────────────────────────────────────────────────────────────
    const vpc = new Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'Public', subnetType: SubnetType.PUBLIC },
        { name: 'Private', subnetType: SubnetType.PRIVATE_WITH_EGRESS },
        { name: 'Isolated', subnetType: SubnetType.PRIVATE_ISOLATED },
      ],
    });

    // exactOptionalPropertyTypes: Vpc concrete type has wider optional
    // properties than IVpc — cast to satisfy the interface contract.
    const vpcResource = vpc as unknown as IVpc;

    // ── RDS PostgreSQL ───────────────────────────────────────────────────
    const dbSecurityGroup = new SecurityGroup(this, 'DbSecurityGroup', {
      vpc: vpc as unknown as IVpc,
      description: 'RDS PostgreSQL access',
    });

    const dbInstance = new DatabaseInstance(this, 'Database', {
      engine: DatabaseInstanceEngine.postgres({
        version: PostgresEngineVersion.VER_16,
      }),
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO),
      vpc: vpc as unknown as IVpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      credentials: Credentials.fromGeneratedSecret('deployz_admin'),
      databaseName: 'deployz',
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      backupRetention: Duration.days(7),
      deletionProtection: true,
      deleteAutomatedBackups: false,
    });

    // ── SQS (async job processing) ───────────────────────────────────────
    // The dead-letter queue is what makes a poisoned message visible: without
    // one a message that always throws is retried until it silently expires.
    const jobDeadLetterQueue = new Queue(this, 'JobDeadLetterQueue', {
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(3),
    });
    const jobQueue = new Queue(this, 'JobQueue', {
      encryption: QueueEncryption.SQS_MANAGED,
      // Must be at least the worker's timeout, or SQS re-delivers a message
      // that is still being processed.
      visibilityTimeout: Duration.minutes(15),
      retentionPeriod: Duration.days(14),
      deadLetterQueue: { queue: jobDeadLetterQueue, maxReceiveCount: 3 },
    });

    // ── Release build pipeline (ECR + CodeBuild) ─────────────────────────
    // Repository tarballs land here; CodeBuild reads them (the source comes
    // from a GitHub App installation token, which CodeBuild cannot hold).
    const sourceBucket = new Bucket(this, 'BuildSourceBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
    });
    // Set once the Docker Hub credential exists in THIS stack's region (see
    // docs/docker-hub-credentials.md). Deliberately opt-in: CodeBuild
    // resolves the secret when a build STARTS, so a name it cannot resolve
    // fails every build, and an unset value keeps today's anonymous pulls
    // instead. An unset GitHub Actions variable arrives as an EMPTY STRING
    // rather than an absent one, which is exactly that unresolvable name —
    // so empty counts as unset.
    const dockerHubSecretName = [
      this.node.tryGetContext('dockerHubSecretName') as string | undefined,
      process.env.DOCKERHUB_SECRET_NAME,
    ].find((value) => value !== undefined && value.trim().length > 0);

    const buildPipeline = new BuildPipeline(this, 'BuildPipeline', {
      // exactOptionalPropertyTypes: the concrete Bucket's optional members are
      // narrower than IBucket's, so the interface type has to be asserted.
      sourceBucket: sourceBucket as IBucket,
      repositoryName: names.ecrRepositoryName,
      // Documenso's monorepo image build exceeds the default SMALL (3 GB)
      // builder and could brush the default 30-minute timeout.
      computeType: ComputeType.LARGE,
      timeoutMinutes: 60,
      ...(dockerHubSecretName === undefined ? {} : { dockerHubSecretName }),
    });

    // ── Public template bucket ───────────────────────────────────────────
    // CloudFormation in the CUSTOMER's account fetches the bootstrap template
    // and its Lambda assets from here with no credentials of ours, so the
    // objects have to be publicly readable. Nothing secret is ever published:
    // the template's only parameter is the non-secret control-plane URL, and
    // the relay's credential is generated inside the customer's own account.
    const templateBucket = new Bucket(this, 'TemplateBucket', {
      publicReadAccess: true,
      blockPublicAccess: new BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      accessControl: BucketAccessControl.PRIVATE,
      enforceSSL: true,
    });

    // ── Config-secret KMS key ────────────────────────────────────────────
    // Encrypts vendor secrets (application_configs.encrypted_value) and the
    // pending-secret vault (docs/pending-secret-delivery.md). RETAIN: every
    // stored ciphertext is unreadable without this exact key, so a stack
    // delete or a logical-id change must never schedule it for deletion.
    // Keep the construct id stable — a new id replaces the key.
    const configSecretsKey = new Key(this, 'ConfigSecretsKey', {
      description: 'Deployz control-plane config secrets (vendor secrets and pending-secret vault).',
      alias: names.kmsAlias,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ── API Lambda ───────────────────────────────────────────────────────
    const credentialEnv = collectEnvVars();

    // Set once the publisher has uploaded a template (see
    // `pnpm --filter @deployz/cdk run publish:bootstrap`, which prints the
    // URL). Deliberately not derived from the bucket name: a bucket with no
    // template in it would produce a link that 404s.
    const bootstrapTemplateUrl =
      (this.node.tryGetContext('bootstrapTemplateUrl') as string | undefined) ??
      process.env.BOOTSTRAP_TEMPLATE_URL;

    // Build id of the connector template the publisher uploads in the same
    // deploy. Set only when that republish runs; the API offers a connector
    // update to a versioned template only once it exists.
    const bootstrapBuildId =
      (this.node.tryGetContext('bootstrapBuildId') as string | undefined) ??
      process.env.BOOTSTRAP_BUILD_ID;

    // Regions whose regional bootstrap artifacts are confirmed published
    // (see @deployz/contracts resolveBootstrapTemplate). Unset → the API
    // fail-closes to us-east-1 only. The publisher prints the exact value.
    const deployableAwsRegions =
      (this.node.tryGetContext('deployableAwsRegions') as string | undefined) ??
      process.env.DEPLOYABLE_AWS_REGIONS;

    const buildLogGroupName = `/aws/codebuild/${buildPipeline.project.projectName}`;

    const apiLambda = new ApiLambda(this, 'ApiLambda', {
      vpc: vpcResource,
      dbSecurityGroup,
      dbSecretArn: dbInstance.secret?.secretArn ?? '',
      environment: {
        ...credentialEnv,
        JOB_QUEUE_URL: jobQueue.queueUrl,
        // Where the customer's CloudFormation fetches the bootstrap template
        // from. The API builds every install link off this value, so an
        // unpublished template yields no link rather than a broken one.
        ...(bootstrapTemplateUrl ? { BOOTSTRAP_TEMPLATE_URL: bootstrapTemplateUrl } : {}),
        ...(bootstrapBuildId ? { BOOTSTRAP_BUILD_ID: bootstrapBuildId } : {}),
        // The API rejects deployment creation in regions whose regional
        // artifacts are not confirmed published (fail closed). The publisher
        // prints this value after verifying every region.
        ...(deployableAwsRegions ? { DEPLOYABLE_AWS_REGIONS: deployableAwsRegions } : {}),
        // Prefix of the regional buckets the API publishes each deployment's
        // compiled template into. Set only outside production: `env.ts`
        // defaults the key to `deployz-templates`, so leaving it absent keeps
        // the synthesized production template byte-identical — which is the
        // proof that the stage work cannot change production.
        ...(props?.stage && props.stage !== 'production'
          ? { DEPLOYZ_TEMPLATE_BUCKET_PREFIX: names.templateBucketPrefix }
          : {}),
        // Phase 1.1 ECR pull-grant lifecycle: the repository whose policy the
        // API mutates when an installation is granted/revoked.
        DEPLOYZ_ECR_REPOSITORY_NAME: buildPipeline.repository.repositoryName,
        // CodeBuild's default log group for the release build project. The
        // API reads a failed release's build log from it (vendor build
        // output only — never customer runtime logs).
        BUILD_LOG_GROUP_NAME: buildLogGroupName,
        DEPLOYZ_KMS_KEY_ARN: configSecretsKey.keyArn,
      },
    });

    jobQueue.grantSendMessages(apiLambda.function);

    // Phase 1.1: the API rewrites the ECR repository policy to grant/revoke
    // per-installation cross-account pull access. Scoped to this repository,
    // not ecr:* on everything. BatchGetImage is the release-image
    // availability check (a READY release whose image was deleted is refused
    // before a deploy is queued).
    apiLambda.function.addToRolePolicy(
      new PolicyStatement({
        actions: [
          'ecr:GetRepositoryPolicy',
          'ecr:SetRepositoryPolicy',
          'ecr:DeleteRepositoryPolicy',
          'ecr:BatchGetImage',
        ],
        resources: [buildPipeline.repository.repositoryArn],
      }),
    );

    // Failed-release evidence: read one build's log stream in the release
    // build project's log group, and nothing else.
    apiLambda.function.addToRolePolicy(
      new PolicyStatement({
        actions: ['logs:GetLogEvents'],
        resources: [
          this.formatArn({
            service: 'logs',
            resource: 'log-group',
            resourceName: `${buildLogGroupName}:log-stream:*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // Compiler-v2: the API freezes each deployment's compiled template into
    // the region's template bucket (deployz-templates-<region>) under the
    // content-addressed compiler-v2/ prefix, before the deployment row is
    // written.
    apiLambda.function.addToRolePolicy(
      new PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [`arn:aws:s3:::${names.templateBucketPrefix}-*/compiler-v2/*`],
      }),
    );

    dbSecurityGroup.addIngressRule(
      apiLambda.function.connections.securityGroups[0] ?? Peer.anyIpv4(),
      Port.tcp(5432),
      'Allow Lambda to reach RDS',
    );

    // ── Worker Lambda (SQS consumer) ─────────────────────────────────────
    const worker = new WorkerLambda(this, 'Worker', {
      vpc: vpcResource,
      dbSecurityGroup,
      dbSecretArn: dbInstance.secret?.secretArn ?? '',
      queue: jobQueue,
      environment: {
        ...credentialEnv,
        SOURCE_BUCKET: sourceBucket.bucketName,
        BUILD_PROJECT_NAME: buildPipeline.project.projectName,
        DEPLOYZ_KMS_KEY_ARN: configSecretsKey.keyArn,
      },
    });

    sourceBucket.grantPut(worker.function);
    // aws-codebuild has no grant helper for StartBuild/BatchGetBuilds, so the
    // statement is written out — scoped to this project, not codebuild:* on
    // everything. CodeBuild authorizes both actions against the PROJECT
    // resource (BatchGetBuilds included, even though its inputs are build
    // ids — verified live: a `build/<project>:*` scope is AccessDenied).
    worker.function.addToRolePolicy(
      new PolicyStatement({
        actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
        resources: [buildPipeline.project.projectArn],
      }),
    );

    // Only the fixed purpose and the known opaque scope keys pass
    // (docs/pending-secret-delivery.md § Cipher contract).
    const configSecretsKeyConditions = {
      StringEquals: { 'kms:EncryptionContext:purpose': CONFIG_SECRET_KMS_PURPOSE },
      'ForAllValues:StringEquals': { 'kms:EncryptionContextKeys': [...CONFIG_SECRET_KMS_CONTEXT_KEYS] },
    };
    // API: encrypts on config save and deployment creation, decrypts for the
    // relay config fetch and staged-row materialization.
    apiLambda.function.addToRolePolicy(
      new PolicyStatement({
        actions: ['kms:Encrypt', 'kms:Decrypt'],
        resources: [configSecretsKey.keyArn],
        conditions: configSecretsKeyConditions,
      }),
    );
    // Worker: only decrypts (vendor build variables).
    worker.function.addToRolePolicy(
      new PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [configSecretsKey.keyArn],
        conditions: configSecretsKeyConditions,
      }),
    );
    new CfnOutput(this, 'ConfigSecretsKeyArn', { value: configSecretsKey.keyArn });

    // ── HTTP API Gateway ─────────────────────────────────────────────────
    //
    // The custom domain is optional so that a plain `cdk deploy` (and every
    // synth in the test suite) still works without one. Supply both values to
    // turn it on, via `cdk deploy -c apiDomainName=... -c apiCertificateArn=...`
    // or via the repo-root .env that bin/deployz.ts already loads.
    //
    // The certificate is deliberately NOT created here. DNS lives on
    // Cloudflare, so a CDK-managed DNS-validated certificate would need a
    // Route 53 zone that does not exist, and CloudFormation would sit blocked
    // for the validation timeout waiting on a record only a human can add.
    // Request it out of band (`aws acm request-certificate`), let it reach
    // ISSUED, then pass the ARN in.
    const apiDomainName =
      (this.node.tryGetContext('apiDomainName') as string | undefined) ??
      process.env.API_DOMAIN_NAME;
    const apiCertificateArn =
      (this.node.tryGetContext('apiCertificateArn') as string | undefined) ??
      process.env.API_CERTIFICATE_ARN;

    const apiDomain =
      apiDomainName && apiCertificateArn
        ? new DomainName(this, 'ApiDomain', {
            domainName: apiDomainName,
            certificate: Certificate.fromCertificateArn(
              this,
              'ApiCertificate',
              apiCertificateArn,
            ),
          })
        : undefined;

    const httpApi = new HttpApi(this, 'HttpApi', {
      defaultIntegration: new HttpLambdaIntegration('ApiIntegration', apiLambda.function),
      ...(apiDomain ? { defaultDomainMapping: { domainName: apiDomain } } : {}),
    });

    // A finished build is the only way a release learns its image digest —
    // CodeBuild reports completion here, and the worker writes the digest to
    // releases.image_digest.
    new Rule(this, 'BuildStateRule', {
      eventPattern: {
        source: ['aws.codebuild'],
        detailType: ['CodeBuild Build State Change'],
        detail: {
          'project-name': [buildPipeline.project.projectName],
          'build-status': ['SUCCEEDED', 'FAILED', 'STOPPED', 'FAULT', 'TIMED_OUT'],
        },
      },
      targets: [new LambdaFunction(worker.function)],
    });

    // ── Stack outputs ────────────────────────────────────────────────────
    this.exportValue(dbInstance.instanceEndpoint.hostname, {
      name: `${this.stackName}-DbHost`,
    });
    this.exportValue(dbInstance.secret?.secretArn ?? '', {
      name: `${this.stackName}-DbSecretArn`,
    });
    this.exportValue(apiLambda.function.functionArn, {
      name: `${this.stackName}-ApiFunctionArn`,
    });
    this.exportValue(httpApi.apiEndpoint, {
      name: `${this.stackName}-ApiUrl`,
    });
    this.exportValue(jobQueue.queueArn, {
      name: `${this.stackName}-JobQueueArn`,
    });
    this.exportValue(templateBucket.bucketName, {
      name: `${this.stackName}-TemplateBucket`,
    });
    this.exportValue(sourceBucket.bucketName, {
      name: `${this.stackName}-BuildSourceBucket`,
    });

    if (apiDomain) {
      // This is the value that goes into Cloudflare: an `api` CNAME pointing
      // here, DNS-only (grey cloud). Proxying it would break TLS — Cloudflare
      // sends the origin hostname as SNI, API Gateway answers with the
      // certificate for the custom domain, and the mismatch surfaces as a 525.
      this.exportValue(apiDomain.regionalDomainName, {
        name: `${this.stackName}-ApiRegionalDomainName`,
      });
      this.exportValue(apiDomain.regionalHostedZoneId, {
        name: `${this.stackName}-ApiRegionalHostedZoneId`,
      });
    }
  }
}

/**
 * Collect credential env vars from process.env. The .env file is loaded by
 * bin/deployz.ts before the CDK app runs, so these are available here.
 * Only the vars that are actually set are included.
 *
 * Two things follow from "only the vars that are actually set":
 *  - A key missing from .env is REMOVED from the deployed function, not left
 *    at its previous value. Every key the API needs in production has to be
 *    present in the environment the deploy runs from.
 *  - GITHUB_FIXTURE_MODE is deliberately NOT here. It makes the GitHub routes
 *    serve the fixture org and repos, which is right for local dev and the
 *    e2e run (playwright.config.ts sets it for the API it starts) and is
 *    never right for a real tenant. Keeping it out of the allowlist means a
 *    developer's .env cannot ship it to production by accident.
 */
function collectEnvVars(): Record<string, string> {
  const keys = [
    'BETTER_AUTH_SECRET',
    'BETTER_AUTH_URL',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'GITHUB_APP_ID',
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_WEBHOOK_SECRET',
    'GITHUB_APP_INSTALL_URL',
    'EMAIL_FROM',
    'API_URL',
    'WEB_URL',
    'MARKETING_URL',
    'COOKIE_DOMAIN',
    'COOKIE_PREFIX',
    'AI_GATEWAY_BASE_URL',
    'AI_MODEL',
    'AI_PROVIDER_API_KEY',
    'AI_GATEWAY_TOKEN',
    'FIX_INSTRUCTIONS_AI_PROVIDER',
    'FIX_INSTRUCTIONS_AI_MODEL',
    'OPENROUTER_API_KEY',
    'OPENROUTER_BASE_URL',
    // Jev shadow client — its gateway token is the shared AI_GATEWAY_TOKEN
    // above (same Cloudflare AI Gateway), so no separate JEV token var exists.
    'JEV_ENABLED',
    'JEV_GATEWAY_URL',
    'JEV_API_KEY',
    'JEV_MODEL',
    'JEV_TIMEOUT_MS',
    'AWS_SES_ACCESS_KEY_ID',
    'AWS_SES_SECRET_ACCESS_KEY',
    'CLOUDFLARE_ZONE_ID',
    'CLOUDFLARE_ZONE_NAME',
    'DEPLOYZ_DEFAULT_HOSTNAME_PREFIX',
    'CLOUDFLARE_ZONE_EDIT_API_TOKEN',
    'PADDLE_API_KEY',
    'PADDLE_WEBHOOK_SECRET',
    'PADDLE_CLIENT_TOKEN',
    'PADDLE_PRICE_PLATFORM',
    'PADDLE_PRICE_DEPLOYMENT',
    'PADDLE_ENVIRONMENT',
    'BILLING_ENFORCEMENT',
  ];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== '') {
      env[key] = value;
    }
  }
  return env;
}
