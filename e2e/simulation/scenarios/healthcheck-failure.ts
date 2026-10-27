import type { ScenarioDefinition } from '../types.js';

/**
 * The stack reaches `CREATE_COMPLETE` — every required resource, including
 * the ECS service, is present and complete, so `verifyInstallation` passes
 * and the INSTALL job succeeds — but the load balancer reports every target
 * unhealthy. This is the scenario the task calls out to observe rather than
 * force: production's real, honest behaviour is "INSTALL succeeds
 * (deployment state HEALTHY) while the separately-tracked runtime
 * `healthStatus` comes back UNHEALTHY", which keeps the customer-facing
 * stage at VERIFYING ("Running health checks.") rather than FAILED — see
 * `apps/api/src/deployment-status.ts`'s `everInstalled` branch. The fixture
 * app has a migration, so the install starts no task and the first deploy
 * rolls the unhealthy targets.
 */
export const healthcheckFailure: ScenarioDefinition = {
  id: 'healthcheck-failure',
  description:
    'Stack reaches CREATE_COMPLETE and verify passes, but every ALB target is unhealthy — INSTALL succeeds with healthStatus UNHEALTHY.',
  finalStackStatus: 'CREATE_COMPLETE',
  outputs: {
    ExportDeployzApplicationPublicEndpoint: 'deployz-alb-healthcheck-failure.us-east-1.elb.amazonaws.com',
  },
  redisRequired: false,
  ecsBehavior: { kind: 'unhealthy-targets', desiredCount: 2, runningCount: 2, targetCount: 2, unhealthyTargetCount: 2 },
  timeline: [
    { afterMs: 20, atVirtualMs: 0, logicalResourceId: '__stack__', resourceType: 'AWS::CloudFormation::Stack', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 30, atVirtualMs: 0, logicalResourceId: 'ApplicationVpc', resourceType: 'AWS::EC2::VPC', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 50, atVirtualMs: 5_000, logicalResourceId: 'PublicSubnet1', resourceType: 'AWS::EC2::Subnet', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 55, atVirtualMs: 5_000, logicalResourceId: 'PrivateSubnet1', resourceType: 'AWS::EC2::Subnet', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 90, atVirtualMs: 45_000, logicalResourceId: 'ApplicationVpc', resourceType: 'AWS::EC2::VPC', status: 'CREATE_COMPLETE' },
    { afterMs: 100, atVirtualMs: 60_000, logicalResourceId: 'PublicSubnet1', resourceType: 'AWS::EC2::Subnet', status: 'CREATE_COMPLETE' },
    { afterMs: 105, atVirtualMs: 60_000, logicalResourceId: 'PrivateSubnet1', resourceType: 'AWS::EC2::Subnet', status: 'CREATE_COMPLETE' },
    { afterMs: 130, atVirtualMs: 75_000, logicalResourceId: 'ApplicationDatabase', resourceType: 'AWS::RDS::DBInstance', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 150, atVirtualMs: 90_000, logicalResourceId: 'ApplicationBucket', resourceType: 'AWS::S3::Bucket', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 180, atVirtualMs: 120_000, logicalResourceId: 'ApplicationBucket', resourceType: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE' },
    { afterMs: 260, atVirtualMs: 300_000, logicalResourceId: 'ApplicationDatabase', resourceType: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' },
    { afterMs: 280, atVirtualMs: 310_000, logicalResourceId: 'ApplicationLoadBalancer', resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 290, atVirtualMs: 315_000, logicalResourceId: 'ApplicationTargetGroup', resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 320, atVirtualMs: 340_000, logicalResourceId: 'ApplicationLoadBalancer', resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_COMPLETE' },
    { afterMs: 330, atVirtualMs: 345_000, logicalResourceId: 'ApplicationTargetGroup', resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup', status: 'CREATE_COMPLETE' },
    { afterMs: 350, atVirtualMs: 360_000, logicalResourceId: 'WebService', resourceType: 'AWS::ECS::Service', status: 'CREATE_IN_PROGRESS' },
    { afterMs: 420, atVirtualMs: 420_000, logicalResourceId: 'WebService', resourceType: 'AWS::ECS::Service', status: 'CREATE_COMPLETE' },
    { afterMs: 430, atVirtualMs: 425_000, logicalResourceId: '__stack__', resourceType: 'AWS::CloudFormation::Stack', status: 'CREATE_COMPLETE' },
  ],
};
