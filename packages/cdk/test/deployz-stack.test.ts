import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DeployzStack } from '../src/deployz-stack.js';

// The first synth in this worker esbuild-bundles the API and worker Lambdas,
// which blocks the process for a minute on a slow CI runner. Doing it here,
// while the file is collected, keeps that stretch away from vitest's
// per-test RPC (60-second "Timeout calling onTaskUpdate"); every later synth
// reuses CDK's in-process asset cache and takes seconds.
const baseline = Template.fromStack(new DeployzStack(new App(), 'DeployzTest'));
// Synthesized here for the same reason as the baseline above, not inside the
// staging tests below.
const staging = Template.fromStack(
  new DeployzStack(new App(), 'DeployzStagingTest', { stage: 'staging' }),
);

describe('DeployzStack', () => {
  it('synthesizes without errors', () => {
    // The template should be valid JSON (Template.fromStack throws on
    // invalid templates, so reaching here means synthesis succeeded).
    expect(baseline).toBeDefined();
  });

  // The Docker Hub credential is wired into the build pipeline only when a
  // secret name is actually given. CodeBuild resolves a SECRETS_MANAGER
  // variable when a build STARTS, so a name it cannot resolve — an empty one
  // above all — fails every release build before a command runs. An unset
  // GitHub Actions variable reaches the app as an empty string, not as an
  // absent one, which is why empty has to count as unset.
  describe('Docker Hub credential wiring', () => {
    it('is off when no secret name is given', () => {
      const template = Template.fromStack(new DeployzStack(new App(), 'DeployzTest'));
      expect(JSON.stringify(template.toJSON())).not.toContain('DOCKERHUB_ACCESS_TOKEN');
    });

    it('is off when the name is present but empty', () => {
      const app = new App({ context: { dockerHubSecretName: '  ' } });
      const template = Template.fromStack(new DeployzStack(app, 'DeployzTest'));
      expect(JSON.stringify(template.toJSON())).not.toContain('DOCKERHUB_ACCESS_TOKEN');
    });

    it('is on when a name is given', () => {
      const app = new App({ context: { dockerHubSecretName: 'deployz-codebuild' } });
      const template = Template.fromStack(new DeployzStack(app, 'DeployzTest'));
      template.hasResourceProperties('AWS::CodeBuild::Project', {
        Environment: {
          EnvironmentVariables: Match.arrayWith([
            {
              Name: 'DOCKERHUB_ACCESS_TOKEN',
              Type: 'SECRETS_MANAGER',
              Value: 'deployz-codebuild:accessToken',
            },
          ]),
        },
      });
    });
  });

  it('creates a VPC with 2 AZs', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.hasResourceProperties('AWS::EC2::VPC', {});
  });

  it('creates an RDS PostgreSQL instance', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      DBInstanceClass: 'db.t4g.micro',
    });
  });

  it('enables deletion protection and retains automated backups on the RDS instance', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::RDS::DBInstance', {
      DeletionProtection: true,
      DeleteAutomatedBackups: false,
    });
  });

  it('creates a Lambda function for the API', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    // API + worker + log retention custom resource
    template.resourceCountIs('AWS::Lambda::Function', 3);
  });

  it('creates the job queue with a dead-letter queue', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  // Phase 4 — DZ-AUDIT-012: SSE-SQS on both queues, DLQ retention 3 days.
  // SQS_MANAGED encryption synthesises to SqsManagedSseEnabled: true on each
  // queue resource (the CDK default is unencrypted, which omits the key).
  it('enables SSE-SQS on both queues and shortens DLQ retention to 3 days', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    const queues = template.findResources('AWS::SQS::Queue');
    const entries = Object.values(queues);
    expect(entries.length).toBe(2);

    // Both queues must have SSE-SQS enabled
    for (const q of entries) {
      expect(q.Properties).toMatchObject({ SqsManagedSseEnabled: true });
    }

    // DLQ has no RedrivePolicy; the main queue does
    const dlq = entries.find((q) => !q.Properties.RedrivePolicy);
    expect(dlq).toBeDefined();
    // DLQ retention: 3 days = 259200 seconds
    expect(dlq!.Properties).toMatchObject({ MessageRetentionPeriod: 259200 });
  });

  // A queue with no consumer is the failure this wiring exists to prevent:
  // messages accumulate, jobs never run, and nothing reports an error.
  it('subscribes the worker to the job queue', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  it('routes CodeBuild completion back to the worker', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Events::Rule', 2);
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.codebuild'],
        'detail-type': ['CodeBuild Build State Change'],
      }),
    });
  });

  it('creates the release build pipeline', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::CodeBuild::Project', 1);
    template.resourceCountIs('AWS::ECR::Repository', 1);
  });

  // Documenso's monorepo image build exceeds the default SMALL (3 GB)
  // builder and could brush the default 30-minute timeout.
  it('sizes the build pipeline for larger monorepo images', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: Match.objectLike({ ComputeType: 'BUILD_GENERAL1_LARGE' }),
      TimeoutInMinutes: 60,
    });
  });

  // CloudFormation in the CUSTOMER's account fetches the bootstrap template
  // with none of our credentials, so this bucket has to allow public reads —
  // while the build-source bucket must not.
  it('creates a public template bucket and a private source bucket', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::S3::Bucket', 2);
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false,
      }),
    });
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      }),
    });
  });

  // Without a published template the API must hand out no install link at
  // all; a link to a template AWS cannot fetch fails in the customer's
  // console with nothing to act on.
  it('passes the bootstrap template URL to the API only when one is set', () => {
    const withoutUrl = Template.fromStack(new DeployzStack(new App(), 'DeployzTest'));
    const environments = Object.values(withoutUrl.findResources('AWS::Lambda::Function')).map(
      (resource) => (resource.Properties as { Environment?: { Variables?: Record<string, unknown> } })
        .Environment?.Variables ?? {},
    );
    expect(environments.some((env) => 'BOOTSTRAP_TEMPLATE_URL' in env)).toBe(false);

    const url = 'https://bucket.s3.us-east-1.amazonaws.com/bootstrap/v1/bootstrap-template-v1.json';
    const withUrl = Template.fromStack(
      new DeployzStack(new App({ context: { bootstrapTemplateUrl: url } }), 'DeployzTest'),
    );
    withUrl.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({ BOOTSTRAP_TEMPLATE_URL: url }),
      }),
    });
  });

  it('passes the connector build id to the API only when one is set', () => {
    const lambdaEnvironments = (template: Template) =>
      Object.values(template.findResources('AWS::Lambda::Function')).map(
        (resource) => (resource.Properties as { Environment?: { Variables?: Record<string, unknown> } })
          .Environment?.Variables ?? {},
      );
    const without = Template.fromStack(new DeployzStack(new App(), 'DeployzTest'));
    expect(lambdaEnvironments(without).some((env) => 'BOOTSTRAP_BUILD_ID' in env)).toBe(false);

    const withId = Template.fromStack(
      new DeployzStack(new App({ context: { bootstrapBuildId: 'abc123def456' } }), 'DeployzTest'),
    );
    expect(lambdaEnvironments(withId).some((env) => env['BOOTSTRAP_BUILD_ID'] === 'abc123def456')).toBe(true);
  });

  // Failed-release evidence: the API reads the release build project's log
  // group, and only that group, and only GetLogEvents.
  it('lets the API read only the release build log group', () => {
    const policies = Object.values(baseline.findResources('AWS::IAM::Policy'));
    const logStatements = policies.flatMap((policy) =>
      ((policy.Properties as { PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> } })
        .PolicyDocument.Statement).filter((statement) => JSON.stringify(statement.Action).includes('logs:Get')),
    );
    expect(logStatements).toHaveLength(1);
    expect(logStatements[0]!.Action).toBe('logs:GetLogEvents');
    expect(JSON.stringify(logStatements[0]!.Resource)).toContain(':log-group:/aws/codebuild/');
    expect(JSON.stringify(logStatements[0]!.Resource)).toContain(':log-stream:*');

    baseline.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          BUILD_LOG_GROUP_NAME: Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith(['/aws/codebuild/'])]) }),
        }),
      }),
    });
  });

  describe('config-secret KMS key', () => {
    it('is a retained, rotating, symmetric customer-managed key', () => {
      baseline.resourceCountIs('AWS::KMS::Key', 1);
      baseline.hasResource('AWS::KMS::Key', {
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
        Properties: Match.objectLike({ EnableKeyRotation: true }),
      });
      const [key] = Object.values(baseline.findResources('AWS::KMS::Key'));
      expect((key!.Properties as { KeySpec?: string }).KeySpec ?? 'SYMMETRIC_DEFAULT').toBe('SYMMETRIC_DEFAULT');
      baseline.hasResourceProperties('AWS::KMS::Alias', { AliasName: 'alias/deployz-config-secrets' });
      expect(Object.keys(baseline.findOutputs('ConfigSecretsKeyArn'))).toHaveLength(1);
    });

    it('passes the key ARN to both the API and the worker Lambda', () => {
      const functions = Object.values(baseline.findResources('AWS::Lambda::Function')).filter((resource) =>
        JSON.stringify(resource.Properties).includes('DB_SECRET_ARN'),
      );
      expect(functions).toHaveLength(2);
      for (const resource of functions) {
        const variables = (resource.Properties as { Environment: { Variables: Record<string, unknown> } }).Environment
          .Variables;
        expect(JSON.stringify(variables.DEPLOYZ_KMS_KEY_ARN)).toContain('ConfigSecretsKey');
      }
    });

    it('grants the API Encrypt/Decrypt and the worker only Decrypt on that key, bound to the purpose context', () => {
      const statements = Object.values(baseline.findResources('AWS::IAM::Policy')).flatMap(
        (policy) =>
          (policy.Properties as { PolicyDocument: { Statement: { Action: string | string[]; Condition?: unknown; Resource: unknown }[] } })
            .PolicyDocument.Statement,
      );
      const kms = statements.filter((statement) =>
        [statement.Action].flat().some((action) => action.startsWith('kms:')),
      );
      expect(kms).toHaveLength(2);
      expect(kms.map((statement) => [statement.Action].flat().sort().join(',')).sort()).toEqual([
        'kms:Decrypt',
        'kms:Decrypt,kms:Encrypt',
      ]);
      for (const statement of kms) {
        expect(JSON.stringify(statement.Resource)).toContain('ConfigSecretsKey');
        expect(statement.Condition).toEqual({
          StringEquals: { 'kms:EncryptionContext:purpose': 'deployz-config-secret' },
          'ForAllValues:StringEquals': {
            'kms:EncryptionContextKeys': [
              'purpose',
              'scope',
              'organizationId',
              'applicationId',
              'customerId',
              'deploymentId',
              'key',
            ],
          },
        });
      }
    });
  });

  it('exports stack outputs', () => {
    const app = new App();
    const stack = new DeployzStack(app, 'DeployzTest');
    const template = Template.fromStack(stack);

    const outputs = template.findOutputs('*');
    const outputKeys = Object.keys(outputs);
    expect(outputKeys).toContain('ExportDeployzTestDbHost');
    expect(outputKeys).toContain('ExportDeployzTestApiFunctionArn');
    expect(outputKeys).toContain('ExportDeployzTestJobQueueArn');
    expect(outputKeys).toContain('ExportDeployzTestTemplateBucket');
    expect(outputKeys).toContain('ExportDeployzTestBuildSourceBucket');
  });

  // The custom domain is opt-in. Everything above synthesises without it, and
  // that is load-bearing: DNS lives on Cloudflare, so CDK cannot create or
  // validate the certificate itself and a plain `cdk deploy` must not need one.
  describe('API custom domain', () => {
    const CERT_ARN =
      'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555';

    function synth(context: Record<string, string> = {}) {
      const app = new App({ context });
      return Template.fromStack(new DeployzStack(app, 'DeployzTest'));
    }

    it('creates no domain resources by default', () => {
      const template = synth();

      template.resourceCountIs('AWS::ApiGatewayV2::DomainName', 0);
      template.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 0);
    });

    it('creates no domain resources when only the domain name is given', () => {
      const template = synth({ apiDomainName: 'api.deployz.dev' });

      template.resourceCountIs('AWS::ApiGatewayV2::DomainName', 0);
    });

    it('maps the API onto the domain when both values are given', () => {
      const template = synth({
        apiDomainName: 'api.deployz.dev',
        apiCertificateArn: CERT_ARN,
      });

      template.resourceCountIs('AWS::ApiGatewayV2::DomainName', 1);
      template.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 1);
      template.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
        DomainName: 'api.deployz.dev',
        DomainNameConfigurations: [
          Match.objectLike({ CertificateArn: CERT_ARN, EndpointType: 'REGIONAL' }),
        ],
      });
    });

    // The CNAME target the operator needs in Cloudflare. Without an output it
    // is only discoverable by digging through the console.
    it('exports the regional domain name to point DNS at', () => {
      const template = synth({
        apiDomainName: 'api.deployz.dev',
        apiCertificateArn: CERT_ARN,
      });

      expect(Object.keys(template.findOutputs('*'))).toContain(
        'ExportDeployzTestApiRegionalDomainName',
      );
    });
  });

  // The fix-instructions model settings, including the rollback switch, must
  // reach the API Lambda or production silently keeps its previous model.
  describe('fix-instructions model env keys', () => {
    const KEYS = ['FIX_INSTRUCTIONS_AI_PROVIDER', 'FIX_INSTRUCTIONS_AI_MODEL', 'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL'];

    it('passes every fix-instructions model key into the API Lambda environment when set', () => {
      for (const key of KEYS) process.env[key] = `test-value-${key}`;
      try {
        const template = Template.fromStack(new DeployzStack(new App(), 'DeployzTest'));
        const expected = Object.fromEntries(KEYS.map((key) => [key, `test-value-${key}`]));
        template.hasResourceProperties('AWS::Lambda::Function', {
          Environment: Match.objectLike({ Variables: Match.objectLike(expected) }),
        });
      } finally {
        for (const key of KEYS) delete process.env[key];
      }
    });
  });

  // Phase 15 — static verification that the control plane's Lambda
  // environment allowlist (collectEnvVars in deployz-stack.ts) carries the
  // four Cloudflare config keys the default-HTTPS flow needs in production.
  // Each is passed through only when set; the deploy-api.yml completeness gate
  // is what refuses a missing one at deploy time.
  describe('Phase 15 — Cloudflare runtime env keys', () => {
    const KEYS = [
      'CLOUDFLARE_ZONE_ID',
      'CLOUDFLARE_ZONE_NAME',
      'DEPLOYZ_DEFAULT_HOSTNAME_PREFIX',
      'CLOUDFLARE_ZONE_EDIT_API_TOKEN',
    ];

    it('passes all four Cloudflare keys into the API Lambda environment when set', () => {
      for (const key of KEYS) process.env[key] = `test-value-${key}`;
      try {
        const template = Template.fromStack(new DeployzStack(new App(), 'DeployzTest'));
        const expected = Object.fromEntries(KEYS.map((key) => [key, `test-value-${key}`]));
        template.hasResourceProperties('AWS::Lambda::Function', {
          Environment: Match.objectLike({ Variables: Match.objectLike(expected) }),
        });
      } finally {
        for (const key of KEYS) delete process.env[key];
      }
    });

    it('omits the Cloudflare keys when unset (absent = flow off, not stale)', () => {
      const previous = new Map<string, string | undefined>();
      for (const key of KEYS) {
        previous.set(key, process.env[key]);
        delete process.env[key];
      }
      try {
        const template = Template.fromStack(new DeployzStack(new App(), 'DeployzTest'));
        const environments = Object.values(template.findResources('AWS::Lambda::Function')).map(
          (resource) =>
            (resource.Properties as { Environment?: { Variables?: Record<string, unknown> } })
              .Environment?.Variables ?? {},
        );
        expect(environments.some((env) => KEYS.some((key) => key in env))).toBe(false);
      } finally {
        for (const key of KEYS) {
          const value = previous.get(key);
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });

  // The BILLING_ENFORCEMENT kill switch (apps/api/src/billing-entitlements.ts)
  // is only useful if it reaches the deployed API Lambda, so the allowlist
  // must carry it. Unset means enforce, so an absent key must stay absent.
  describe('BILLING_ENFORCEMENT kill switch', () => {
    const KEY = 'BILLING_ENFORCEMENT';

    it('passes BILLING_ENFORCEMENT into the API Lambda environment when set', () => {
      process.env[KEY] = 'off';
      try {
        const template = Template.fromStack(new DeployzStack(new App(), 'DeployzTest'));
        template.hasResourceProperties('AWS::Lambda::Function', {
          Environment: Match.objectLike({ Variables: Match.objectLike({ [KEY]: 'off' }) }),
        });
      } finally {
        delete process.env[KEY];
      }
    });

    it('omits BILLING_ENFORCEMENT when unset (absent = enforced)', () => {
      const previous = process.env[KEY];
      delete process.env[KEY];
      try {
        const template = Template.fromStack(new DeployzStack(new App(), 'DeployzTest'));
        const environments = Object.values(template.findResources('AWS::Lambda::Function')).map(
          (resource) =>
            (resource.Properties as { Environment?: { Variables?: Record<string, unknown> } })
              .Environment?.Variables ?? {},
        );
        expect(environments.some((env) => KEY in env)).toBe(false);
      } finally {
        if (previous === undefined) delete process.env[KEY];
        else process.env[KEY] = previous;
      }
    });
  });

  // A staging control plane stands in the SAME account and Region as
  // production, so every account-unique name has to differ (src/stage.ts).
  describe('stage-derived names', () => {
    it('gives staging its own KMS alias and ECR repository', () => {
      staging.hasResourceProperties('AWS::KMS::Alias', {
        AliasName: 'alias/deployz-staging-config-secrets',
      });
      staging.hasResourceProperties('AWS::ECR::Repository', {
        RepositoryName: 'deployz-staging-images',
      });
    });

    it('scopes the compiled-artifact grant to the staging template buckets', () => {
      staging.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 's3:PutObject',
              Resource: 'arn:aws:s3:::deployz-staging-templates-*/compiler-v2/*',
            }),
          ]),
        }),
      });
    });

    it('tells the staging API Lambda which template buckets to publish into', () => {
      staging.hasResourceProperties('AWS::Lambda::Function', {
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            DEPLOYZ_TEMPLATE_BUCKET_PREFIX: 'deployz-staging-templates',
          }),
        }),
      });
    });

    // Absent on the default stack on purpose: env.ts defaults the key to
    // `deployz-templates`, which keeps production's template unchanged.
    it('omits the prefix variable on the production default', () => {
      const environments = Object.values(baseline.findResources('AWS::Lambda::Function')).map(
        (resource) =>
          (resource.Properties as { Environment?: { Variables?: Record<string, unknown> } })
            .Environment?.Variables ?? {},
      );
      expect(environments.some((env) => 'DEPLOYZ_TEMPLATE_BUCKET_PREFIX' in env)).toBe(false);
    });
  });

  // COOKIE_PREFIX (apps/api/src/env.ts) renames the session cookie, which is
  // the only thing that keeps a staging control plane out of production's
  // session while both share the '.deployz.dev' cookie domain. Unset must stay
  // absent, because production keeps Better Auth's default cookie name.
  describe('COOKIE_PREFIX session isolation', () => {
    const KEY = 'COOKIE_PREFIX';

    it('passes COOKIE_PREFIX into the API Lambda environment when set', () => {
      process.env[KEY] = 'deployz-staging';
      try {
        const template = Template.fromStack(new DeployzStack(new App(), 'DeployzTest'));
        template.hasResourceProperties('AWS::Lambda::Function', {
          Environment: Match.objectLike({
            Variables: Match.objectLike({ [KEY]: 'deployz-staging' }),
          }),
        });
      } finally {
        delete process.env[KEY];
      }
    });

    it('omits COOKIE_PREFIX when unset (absent = the default cookie name)', () => {
      const previous = process.env[KEY];
      delete process.env[KEY];
      try {
        const template = Template.fromStack(new DeployzStack(new App(), 'DeployzTest'));
        const environments = Object.values(template.findResources('AWS::Lambda::Function')).map(
          (resource) =>
            (resource.Properties as { Environment?: { Variables?: Record<string, unknown> } })
              .Environment?.Variables ?? {},
        );
        expect(environments.some((env) => KEY in env)).toBe(false);
      } finally {
        if (previous === undefined) delete process.env[KEY];
        else process.env[KEY] = previous;
      }
    });
  });
});
