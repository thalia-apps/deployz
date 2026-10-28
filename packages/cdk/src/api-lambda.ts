import { Duration, SecretValue } from 'aws-cdk-lib';
import type { ISecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { join } from 'node:path';

export interface ApiLambdaProps {
  readonly vpc: IVpc;
  readonly dbSecurityGroup: ISecurityGroup;
  /** ARN of the RDS master secret in Secrets Manager. The Lambda fetches
   * credentials at runtime — never hardcoded in the env. */
  readonly dbSecretArn: string;
  /** Extra environment variables passed from the repo-root .env. */
  readonly environment?: Record<string, string>;
}

/**
 * Lambda function wrapping the Fastify API.
 *
 * Uses esbuild (NodejsFunction) to bundle apps/api into a single Lambda
 * handler. The handler lives in src/lambda/api-handler.ts and imports
 * @deployz/api's buildServer to create the Fastify instance.
 *
 * Bundles as CJS (not ESM) because node-postgres (pg) uses dynamic
 * require() calls that break ESM bundling.
 *
 * The Lambda runs inside the VPC so it can reach RDS; the security group
 * on the Lambda is granted ingress to the DB security group by the caller.
 * DB credentials are fetched from Secrets Manager at runtime via
 * DB_SECRET_ARN — never inline.
 */
export class ApiLambda extends Construct {
  public readonly function: NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiLambdaProps) {
    super(scope, id);

    // Lambda refuses an environment over 4 KB, and the GitHub App key is
    // about 1.7 KB of it. The key goes into a secret instead, which
    // api-handler.ts reads before it loads the API.
    const { GITHUB_APP_PRIVATE_KEY: githubAppPrivateKey, ...environment } = props.environment ?? {};
    const githubAppPrivateKeySecret =
      githubAppPrivateKey === undefined
        ? undefined
        : new Secret(this, 'GithubAppPrivateKey', {
            secretStringValue: SecretValue.unsafePlainText(githubAppPrivateKey),
          });

    this.function = new NodejsFunction(this, 'Function', {
      runtime: Runtime.NODEJS_22_X,
      entry: join(import.meta.dirname, '..', 'src', 'lambda', 'api-handler.ts'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      memorySize: 512,
      logRetention: RetentionDays.ONE_WEEK,
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.dbSecurityGroup],
      environment: {
        DB_SECRET_ARN: props.dbSecretArn,
        NODE_ENV: 'production',
        ...environment,
        ...(githubAppPrivateKeySecret
          ? { GITHUB_APP_PRIVATE_KEY_SECRET_ARN: githubAppPrivateKeySecret.secretArn }
          : {}),
      },
      bundling: {
        // pg uses dynamic require(); CJS bundling avoids ESM loader errors.
        externalModules: ['@electric-sql/pglite'],
        format: OutputFormat.CJS,
        target: 'node22',
        sourceMap: true,
        // Bundle drizzle .sql migrations as text strings at build time.
        loader: { '.sql': 'text' },
      },
    });

    // Grant Lambda read access to the RDS secret in Secrets Manager.
    const dbSecret = Secret.fromSecretCompleteArn(this, 'DbSecret', props.dbSecretArn);
    dbSecret.grantRead(this.function);
    githubAppPrivateKeySecret?.grantRead(this.function);
  }
}
