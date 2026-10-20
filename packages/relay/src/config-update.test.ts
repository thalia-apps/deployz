import { describe, expect, it } from 'vitest';

import {
  computeEnvChanges,
  computeSecretChanges,
  createConfigUpdateExecutor,
  createConfigUpdateResumer,
  findAppConfigSecretArn,
  generateSecretValue,
  unappliedConfigurationKeys,
  type ConfigSecretsWriter,
  type EffectiveConfigEntry,
} from './config-update.js';
import type { EcsDeployClient, EcsTaskDefinition } from './deploy.js';
import { memoryPendingStore, type PendingStore } from './pending.js';
import type { CloudFormationReader } from './verify.js';

const SERVICE_ARN = 'arn:aws:ecs:us-east-1:151955775369:service/app-cluster/app-service';
const CONFIG_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:151955775369:secret:AppConfigSecret-abc123';

function cfnWithService(options: { withConfigSecret?: boolean } = {}): CloudFormationReader {
  const resources = [
    {
      logicalId: 'Service',
      type: 'AWS::ECS::Service',
      status: 'CREATE_COMPLETE',
      physicalId: SERVICE_ARN,
    },
    {
      logicalId: 'TargetGroup',
      type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
      status: 'CREATE_COMPLETE',
      physicalId: 'arn:aws:elasticloadbalancing:us-east-1:151955775369:targetgroup/app/c1b2d3e4f5a6b7c8',
    },
  ];
  if (options.withConfigSecret) {
    // The logical id CloudFormation reports for a CDK L2 construct carries a
    // hash suffix — the shape every real application stack has (DEPLOY-010).
    resources.push({
      logicalId: 'AppConfigSecret251CAC1E',
      type: 'AWS::SecretsManager::Secret',
      status: 'CREATE_COMPLETE',
      physicalId: CONFIG_SECRET_ARN,
    });
  }
  return {
    async describeStack() {
      return { found: true, stack: { stackName: 'deployz-app', status: 'CREATE_COMPLETE', tags: {}, stackId: 'stack-id-deployz-app' } };
    },
    async describeStackResources() {
      return resources;
    },
    async listStackResources() {
      return { resources };
    },
  };
}

const CURRENT_DEF_ARN = 'arn:aws:ecs:us-east-1:151955775369:task-definition/app:7';
const NEXT_DEF_ARN = 'arn:aws:ecs:us-east-1:151955775369:task-definition/app:8';

/**
 * One ECS service. It starts at zero tasks (an install that waits for its
 * first start) unless `desiredCount` says otherwise. Every UpdateService
 * creates a new deployment id; `rollout` decides how that deployment ends.
 */
function ecsWith(options: {
  taskDefinition?: EcsTaskDefinition;
  registered?: unknown[];
  updates?: unknown[];
  desiredCount?: number;
  rollout?: { state: 'COMPLETED' | 'IN_PROGRESS' | 'ROLLED_BACK' };
}): EcsDeployClient {
  let current = CURRENT_DEF_ARN;
  let sequence = 1;
  let deploymentId = 'ecs-svc/1';
  let rolloutState = 'COMPLETED';
  let failed: { id: string; taskDefinition: string } | null = null;
  const desiredCount = options.desiredCount ?? 0;
  return {
    async describeServices() {
      return {
        services: [
          {
            desiredCount,
            runningCount: desiredCount,
            taskDefinition: current,
            deployments: [
              { id: deploymentId, status: 'PRIMARY', taskDefinition: current, rolloutState },
              ...(failed !== null
                ? [{ id: failed.id, status: 'ACTIVE', taskDefinition: failed.taskDefinition, rolloutState: 'FAILED' }]
                : []),
            ],
          },
        ],
      };
    },
    async describeTaskDefinition() {
      return {
        taskDefinition:
          options.taskDefinition ?? {
            family: 'app',
            cpu: '256',
            memory: '512',
            networkMode: 'awsvpc',
            requiresCompatibilities: ['FARGATE'],
            containerDefinitions: [
              {
                name: 'app',
                image: 'repo@sha256:aaa',
                environment: [{ name: 'LOG_LEVEL', value: 'info' }],
              },
            ],
          },
      };
    },
    async registerTaskDefinition(input) {
      options.registered?.push(input);
      return { taskDefinitionArn: NEXT_DEF_ARN };
    },
    async updateService(input) {
      options.updates?.push(input);
      sequence += 1;
      const ours = `ecs-svc/${sequence}`;
      const target = input.taskDefinition ?? current;
      if (desiredCount > 0 && options.rollout?.state === 'ROLLED_BACK') {
        // The circuit breaker restores the previous revision in a new deployment.
        failed = { id: ours, taskDefinition: target };
        sequence += 1;
        deploymentId = `ecs-svc/${sequence}`;
        rolloutState = 'COMPLETED';
        return;
      }
      current = target;
      deploymentId = ours;
      rolloutState = desiredCount > 0 ? (options.rollout?.state ?? 'COMPLETED') : 'COMPLETED';
    },
    async listTasks() {
      return { taskArns: [] };
    },
    async describeTasks() {
      return { tasks: [] };
    },
  };
}

/** The settle-gate readers: every ALB target healthy unless told otherwise, and a fresh marker store. */
function rolloutDeps(targetState: string | string[] = 'healthy') {
  return {
    elb: {
      async describeTargetHealth() {
        return { targets: [targetState].flat().map((state) => ({ state })) };
      },
    },
    pending: memoryPendingStore(),
  };
}

/** In-memory Secrets Manager fake over a single JSON secret. */
function fakeSecretsWriter(initial: Record<string, unknown> = {}): ConfigSecretsWriter & {
  current(): Record<string, unknown>;
  puts(): number;
} {
  let json: Record<string, unknown> = { ...initial };
  let puts = 0;
  return {
    current: () => json,
    puts: () => puts,
    async getSecretValue({ SecretId }) {
      if (SecretId !== CONFIG_SECRET_ARN) {
        throw new Error(`Unexpected secret id ${SecretId}`);
      }
      return { arn: CONFIG_SECRET_ARN, secretString: JSON.stringify(json) };
    },
    async putSecretValue({ secretString }) {
      puts += 1;
      json = JSON.parse(secretString) as Record<string, unknown>;
    },
  };
}

describe('computeEnvChanges', () => {
  const desired: EffectiveConfigEntry[] = [
    { key: 'LOG_LEVEL', isSecret: false, value: 'debug', source: 'vendor' },
    { key: 'FEATURE_FLAG', isSecret: false, value: 'on', source: 'vendor' },
    { key: 'API_KEY', isSecret: true, source: 'customer' },
  ];

  it('returns null when every plain value already matches', () => {
    const current = [
      { name: 'LOG_LEVEL', value: 'debug' },
      { name: 'FEATURE_FLAG', value: 'on' },
    ];
    expect(computeEnvChanges(desired, current)).toBeNull();
  });

  it('returns only changed entries, ignoring secrets', () => {
    const current = [
      { name: 'LOG_LEVEL', value: 'info' },
      { name: 'FEATURE_FLAG', value: 'on' },
    ];
    const delta = computeEnvChanges(desired, current);
    expect(delta).toEqual({ changes: [{ name: 'LOG_LEVEL', value: 'debug' }], removals: [] });
  });

  it('returns new entries the task definition does not have yet', () => {
    const current = [{ name: 'LOG_LEVEL', value: 'info' }];
    const delta = computeEnvChanges(desired, current);
    expect(delta).toEqual({
      changes: [
        { name: 'LOG_LEVEL', value: 'debug' },
        { name: 'FEATURE_FLAG', value: 'on' },
      ],
      removals: [],
    });
  });

  it('ignores secret entries entirely — they are not environment variables', () => {
    const secretsOnly: EffectiveConfigEntry[] = [
      { key: 'DB_PASSWORD', isSecret: true, source: 'vendor' },
    ];
    expect(computeEnvChanges(secretsOnly, [])).toBeNull();
  });

  it('strips only the explicitly removed keys, never install-time values', () => {
    const current = [
      { name: 'LOG_LEVEL', value: 'debug' },
      { name: 'FEATURE_FLAG', value: 'on' },
      { name: 'NODE_ENV', value: 'production' },
    ];
    const delta = computeEnvChanges(desired, current, ['FEATURE_FLAG', 'NEVER_EXISTED']);
    expect(delta).toEqual({ changes: [], removals: ['FEATURE_FLAG'] });
  });
});

describe('computeSecretChanges', () => {
  const desired: EffectiveConfigEntry[] = [
    { key: 'API_KEY', isSecret: true, source: 'customer' },
    { key: 'DATABASE_URL', isSecret: true, source: 'vendor' },
    { key: 'LOG_LEVEL', isSecret: false, value: 'info', source: 'vendor' },
  ];

  it('returns null when every secret is already bound to the config secret', () => {
    const current = [
      { name: 'API_KEY', valueFrom: `${CONFIG_SECRET_ARN}:API_KEY::` },
      { name: 'DATABASE_URL', valueFrom: `${CONFIG_SECRET_ARN}:DATABASE_URL::` },
    ];
    expect(computeSecretChanges(desired, current, CONFIG_SECRET_ARN)).toBeNull();
  });

  it('returns bindings for secrets missing from the task definition, ignoring plain entries', () => {
    const current = [{ name: 'API_KEY', valueFrom: `${CONFIG_SECRET_ARN}:API_KEY::` }];
    const delta = computeSecretChanges(desired, current, CONFIG_SECRET_ARN);
    expect(delta).toEqual({
      bindings: [{ name: 'DATABASE_URL', valueFrom: `${CONFIG_SECRET_ARN}:DATABASE_URL::` }],
      removals: [],
    });
  });

  it('re-binds when the secret ARN changed (secret re-created)', () => {
    const current = [{ name: 'API_KEY', valueFrom: `${CONFIG_SECRET_ARN}OLD:API_KEY::` }];
    const delta = computeSecretChanges(desired, current, CONFIG_SECRET_ARN);
    expect(delta).toEqual({
      bindings: [
        { name: 'API_KEY', valueFrom: `${CONFIG_SECRET_ARN}:API_KEY::` },
        { name: 'DATABASE_URL', valueFrom: `${CONFIG_SECRET_ARN}:DATABASE_URL::` },
      ],
      removals: [],
    });
  });

  it('strips only the explicitly removed keys that are actually bound', () => {
    const current = [
      { name: 'API_KEY', valueFrom: `${CONFIG_SECRET_ARN}:API_KEY::` },
      { name: 'NODE_ENV', valueFrom: 'arn:aws:secretsmanager:other' },
    ];
    const delta = computeSecretChanges(desired, current, CONFIG_SECRET_ARN, ['API_KEY', 'NEVER_EXISTED']);
    expect(delta).toEqual({
      bindings: [{ name: 'DATABASE_URL', valueFrom: `${CONFIG_SECRET_ARN}:DATABASE_URL::` }],
      removals: ['API_KEY'],
    });
  });
});

describe('createConfigUpdateExecutor', () => {
  function configCommand(payload: Record<string, unknown> = { changedKeys: ['LOG_LEVEL'] }) {
    return {
      id: 'job-config',
      deploymentId: 'dep-1',
      type: 'CONFIG_UPDATE' as const,
      idempotencyKey: 'dep-1:CONFIG_UPDATE:msg-1',
      payload,
    };
  }

  function deps(
    entries: EffectiveConfigEntry[],
    ecsOptions: Parameters<typeof ecsWith>[0] = {},
    secrets: ConfigSecretsWriter = fakeSecretsWriter(),
  ) {
    return {
      cfn: cfnWithService({ withConfigSecret: true }),
      ecs: ecsWith(ecsOptions),
      secrets,
      fetchEffectiveConfig: async () => entries,
      stackName: 'deployz-app',
      installationId: 'inst-test',
      ...rolloutDeps(),
    };
  }

  it('reports success without registering when the config already matches', async () => {
    const registered: unknown[] = [];
    const entries: EffectiveConfigEntry[] = [
      { key: 'LOG_LEVEL', isSecret: false, value: 'info', source: 'vendor' },
    ];
    const result = await createConfigUpdateExecutor(deps(entries, { registered }))(configCommand());
    expect(result.success).toBe(true);
    expect((result.output as { alreadyApplied: boolean }).alreadyApplied).toBe(true);
    expect(registered).toHaveLength(0);
  });

  it('registers a new task definition with the changed environment', async () => {
    const registered: unknown[] = [];
    const updates: unknown[] = [];
    const entries: EffectiveConfigEntry[] = [
      { key: 'LOG_LEVEL', isSecret: false, value: 'debug', source: 'vendor' },
    ];
    const result = await createConfigUpdateExecutor(
      deps(entries, { registered, updates }),
    )(configCommand());
    expect(result.success).toBe(true);
    expect(registered).toHaveLength(1);
    expect(updates).toHaveLength(1);
    const input = registered[0] as {
      containerDefinitions: { environment: { name: string; value: string }[] }[];
    };
    expect(input.containerDefinitions[0]!.environment).toContainEqual({
      name: 'LOG_LEVEL',
      value: 'debug',
    });
    // The relay's register grant is request-tag scoped — an untagged
    // register is AccessDenied (verified live).
    expect((registered[0] as { tags?: unknown }).tags).toEqual([
      { key: 'deployz:installation', value: 'inst-test' },
    ]);
  });

  it('fails when the fetch itself errors', async () => {
    const d = {
      cfn: cfnWithService(),
      ecs: ecsWith({}),
      secrets: fakeSecretsWriter(),
      fetchEffectiveConfig: async () => {
        throw new Error('HTTP 502');
      },
      stackName: 'deployz-app',
      installationId: 'inst-test',
      ...rolloutDeps(),
    };
    const result = await createConfigUpdateExecutor(d)(configCommand());
    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP 502');
  });

  // ── Real secret delivery (#10 phase 1.2): entry → customer Secrets
  // ── Manager → task-definition binding → running application.

  it('persists the entered secret into customer Secrets Manager and binds it in the task definition', async () => {
    const registered: unknown[] = [];
    const secrets = fakeSecretsWriter();
    const entries: EffectiveConfigEntry[] = [
      { key: 'API_KEY', isSecret: true, source: 'customer' },
      { key: 'LOG_LEVEL', isSecret: false, value: 'info', source: 'vendor' },
    ];
    const result = await createConfigUpdateExecutor(deps(entries, { registered }, secrets))(
      configCommand({ changedKeys: ['API_KEY'], secrets: [{ key: 'API_KEY', value: 'v-12345' }] }),
    );
    expect(result.success).toBe(true);
    // The value landed in the customer's secret store.
    expect(secrets.current()).toEqual({ API_KEY: 'v-12345' });
    // The task definition now carries the secret as an ECS secret reference.
    const input = registered[0] as {
      containerDefinitions: { secrets: { name: string; valueFrom: string }[] }[];
    };
    expect(input.containerDefinitions[0]!.secrets).toContainEqual({
      name: 'API_KEY',
      valueFrom: `${CONFIG_SECRET_ARN}:API_KEY::`,
    });
  });

  it('merges a new key without clobbering an earlier one, and stays idempotent on re-run', async () => {
    const registered: unknown[] = [];
    const secrets = fakeSecretsWriter({ API_KEY: 'v-12345' });
    const entries: EffectiveConfigEntry[] = [
      { key: 'API_KEY', isSecret: true, source: 'customer' },
      { key: 'DATABASE_URL', isSecret: true, source: 'vendor' },
    ];

    const first = await createConfigUpdateExecutor(deps(entries, { registered }, secrets))(
      configCommand({ changedKeys: ['DATABASE_URL'], secrets: [{ key: 'DATABASE_URL', value: 'postgres://x' }] }),
    );
    expect(first.success).toBe(true);
    expect(secrets.current()).toEqual({ API_KEY: 'v-12345', DATABASE_URL: 'postgres://x' });

    // A re-run against the definition the first run registered changes
    // nothing and registers nothing: both secrets are already bound.
    const boundDefinition: EcsTaskDefinition = {
      family: 'app',
      cpu: '256',
      memory: '512',
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      containerDefinitions: [
        {
          name: 'app',
          image: 'repo@sha256:aaa',
          environment: [],
          secrets: [
            { name: 'API_KEY', valueFrom: `${CONFIG_SECRET_ARN}:API_KEY::` },
            { name: 'DATABASE_URL', valueFrom: `${CONFIG_SECRET_ARN}:DATABASE_URL::` },
          ],
        },
      ],
    };
    const beforePuts = secrets.puts();
    const second = await createConfigUpdateExecutor(
      deps(entries, { registered, taskDefinition: boundDefinition }, secrets),
    )(configCommand({ changedKeys: [] }));
    expect(second.success).toBe(true);
    expect((second.output as { alreadyApplied: boolean }).alreadyApplied).toBe(true);
    expect(secrets.puts()).toBe(beforePuts);
    expect(registered).toHaveLength(1);
  });

  it('removes a deleted secret key from both the customer store and the task definition', async () => {
    const registered: unknown[] = [];
    const boundedTaskDefinition: EcsTaskDefinition = {
      family: 'app',
      cpu: '256',
      memory: '512',
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      containerDefinitions: [
        {
          name: 'app',
          image: 'repo@sha256:aaa',
          environment: [],
          secrets: [{ name: 'API_KEY', valueFrom: `${CONFIG_SECRET_ARN}:API_KEY::` }],
        },
      ],
    };
    const secrets = fakeSecretsWriter({ API_KEY: 'v-12345' });
    const noDesiredSecrets: EffectiveConfigEntry[] = [
      { key: 'LOG_LEVEL', isSecret: false, value: 'info', source: 'vendor' },
    ];
    const result = await createConfigUpdateExecutor(
      deps(noDesiredSecrets, { registered, taskDefinition: boundedTaskDefinition }, secrets),
    )(configCommand({ changedKeys: [], removedKeys: ['API_KEY'] }));
    expect(result.success).toBe(true);
    expect(secrets.current()).toEqual({});
    const input = registered[0] as {
      containerDefinitions: { secrets?: { name: string }[] }[];
    };
    expect(input.containerDefinitions[0]!.secrets).not.toContainEqual({ name: 'API_KEY' });
  });

  it('makes no Secrets Manager call when the config has no secrets at all', async () => {
    const secrets = fakeSecretsWriter();
    const putsBefore = secrets.puts();
    const entries: EffectiveConfigEntry[] = [
      { key: 'LOG_LEVEL', isSecret: false, value: 'info', source: 'vendor' },
    ];
    const result = await createConfigUpdateExecutor(deps(entries, {}, secrets))(
      configCommand({ changedKeys: ['LOG_LEVEL'] }),
    );
    expect(result.success).toBe(true);
    expect(secrets.puts()).toBe(putsBefore);
  });

  it('finds the config secret by its construct-id prefix, never by exact logical id, and skips the other secrets (DEPLOY-010)', () => {
    const resources = [
      { logicalId: 'DatabaseSecret86DBB7B3', type: 'AWS::SecretsManager::Secret', status: 'CREATE_COMPLETE', physicalId: 'arn:db' },
      { logicalId: 'DatabaseUrlSecretFA7DE062', type: 'AWS::SecretsManager::Secret', status: 'CREATE_COMPLETE', physicalId: 'arn:url' },
      { logicalId: 'AppConfigSecret251CAC1E', type: 'AWS::SecretsManager::Secret', status: 'CREATE_COMPLETE', physicalId: CONFIG_SECRET_ARN },
    ];
    expect(findAppConfigSecretArn(resources)).toBe(CONFIG_SECRET_ARN);
    expect(findAppConfigSecretArn(resources.slice(0, 2))).toBeNull();
  });

  it('finds the compiler-v2 config secret by its stable logical id, next to the database secrets', () => {
    const resources = [
      { logicalId: 'PrimaryDbMasterSecret', type: 'AWS::SecretsManager::Secret', status: 'CREATE_COMPLETE', physicalId: 'arn:db' },
      { logicalId: 'PrimaryDbUrlSecret', type: 'AWS::SecretsManager::Secret', status: 'CREATE_COMPLETE', physicalId: 'arn:url' },
      { logicalId: 'ApplicationConfigSecret', type: 'AWS::SecretsManager::Secret', status: 'CREATE_COMPLETE', physicalId: CONFIG_SECRET_ARN },
    ];
    expect(findAppConfigSecretArn(resources)).toBe(CONFIG_SECRET_ARN);
    expect(findAppConfigSecretArn(resources.slice(0, 2))).toBeNull();
  });

  it('fails honestly when the stack has no AppConfigSecret resource', async () => {
    // `cfn` variant without the secret resource is built in-line: the
    // executor must not silently report a secret as persisted.
    const noSecretCfn: CloudFormationReader = {
      async describeStack() {
        return { found: true, stack: { stackName: 'deployz-app', status: 'CREATE_COMPLETE', tags: {} } };
      },
      async describeStackResources() {
        return [
          {
            logicalId: 'Service',
            type: 'AWS::ECS::Service',
            status: 'CREATE_COMPLETE',
            physicalId: SERVICE_ARN,
          },
        ];
      },
    };
    const result = await createConfigUpdateExecutor({
      cfn: noSecretCfn,
      ecs: ecsWith({}),
      secrets: fakeSecretsWriter(),
      fetchEffectiveConfig: async () =>
        [{ key: 'API_KEY', isSecret: true, source: 'customer' } satisfies EffectiveConfigEntry],
      stackName: 'deployz-app',
      installationId: 'inst-test',
      ...rolloutDeps(),
    })(configCommand({ changedKeys: ['API_KEY'], secrets: [{ key: 'API_KEY', value: 'v' }] }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('AppConfigSecret');
  });

  it('keeps Stage B binding-alias entries across a later config update (stack-managed, never removed or duplicated)', async () => {
    // The running definition carries the alias entries the install registered:
    // S3_ATTACHMENTS_BUCKET as plain env, MEMOS_DSN as a DB-url secret.
    const aliasTaskDefinition: EcsTaskDefinition = {
      family: 'app',
      cpu: '256',
      memory: '512',
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      containerDefinitions: [
        {
          name: 'app',
          image: 'repo@sha256:aaa',
          environment: [
            { name: 'LOG_LEVEL', value: 'info' },
            { name: 'S3_ATTACHMENTS_BUCKET', value: 'deployz-app-storage' },
          ],
          secrets: [
            { name: 'MEMOS_DSN', valueFrom: 'arn:aws:secretsmanager:us-east-1:1:secret:DatabaseUrl-XYZ' },
          ],
        },
      ],
    };
    const registered: unknown[] = [];
    const entries: EffectiveConfigEntry[] = [
      { key: 'LOG_LEVEL', isSecret: false, value: 'debug', source: 'vendor' },
    ];

    const result = await createConfigUpdateExecutor(
      deps(entries, { taskDefinition: aliasTaskDefinition, registered }),
    )(configCommand({ changedKeys: ['LOG_LEVEL'] }));
    expect(result.success).toBe(true);

    const input = registered[0] as {
      containerDefinitions: {
        environment: { name: string; value: string }[];
        secrets: { name: string; valueFrom: string }[];
      }[];
    };
    const env = input.containerDefinitions[0]!.environment;
    const secrets = input.containerDefinitions[0]!.secrets;
    expect(env).toContainEqual({ name: 'S3_ATTACHMENTS_BUCKET', value: 'deployz-app-storage' });
    expect(secrets).toContainEqual({
      name: 'MEMOS_DSN',
      valueFrom: 'arn:aws:secretsmanager:us-east-1:1:secret:DatabaseUrl-XYZ',
    });
    // Exactly one of each — the config delta never duplicates stack-managed entries.
    expect(env.filter((entry) => entry.name === 'S3_ATTACHMENTS_BUCKET')).toHaveLength(1);
    expect(secrets.filter((entry) => entry.name === 'MEMOS_DSN')).toHaveLength(1);
  });
});

describe('createConfigUpdateExecutor — generated secrets (Phase 4)', () => {
  function configCommand(payload: Record<string, unknown> = { reason: 'install' }) {
    return {
      id: 'job-config-gen',
      deploymentId: 'dep-1',
      type: 'CONFIG_UPDATE' as const,
      idempotencyKey: 'dep-1:CONFIG_UPDATE:install:job-install',
      payload,
    };
  }

  function deps(
    entries: EffectiveConfigEntry[],
    ecsOptions: Parameters<typeof ecsWith>[0] = {},
    secrets: ConfigSecretsWriter = fakeSecretsWriter(),
    generateSecret: () => string = () => 'minted-value',
  ) {
    return {
      cfn: cfnWithService({ withConfigSecret: true }),
      ecs: ecsWith(ecsOptions),
      secrets,
      fetchEffectiveConfig: async () => entries,
      stackName: 'deployz-app',
      installationId: 'inst-test',
      generateSecret,
      ...rolloutDeps(),
    };
  }

  const bindingsOf = (registered: unknown[]) =>
    (registered[0] as { containerDefinitions: { secrets?: { name: string }[] }[] }).containerDefinitions[0]!.secrets ?? [];

  it('mints a generated secret once, binds it, and reports the key name only', async () => {
    const registered: unknown[] = [];
    const secrets = fakeSecretsWriter();
    const entries: EffectiveConfigEntry[] = [{ key: 'SESSION_SECRET', isSecret: true, source: 'generated', generated: true }];

    const result = await createConfigUpdateExecutor(deps(entries, { registered }, secrets))(configCommand());
    expect(result.success).toBe(true);
    expect(secrets.current()).toEqual({ SESSION_SECRET: 'minted-value' });
    expect(bindingsOf(registered).map((b) => b.name)).toEqual(['SESSION_SECRET']);
    expect(result.output).toMatchObject({ generatedKeys: ['SESSION_SECRET'], unboundSecretKeys: [] });
    expect(JSON.stringify(result)).not.toContain('minted-value');
  });

  it('keeps an existing value instead of minting again (a second install pass, or a vendor-chosen value)', async () => {
    const registered: unknown[] = [];
    const secrets = fakeSecretsWriter({ SESSION_SECRET: 'kept' });
    const entries: EffectiveConfigEntry[] = [{ key: 'SESSION_SECRET', isSecret: true, source: 'generated', generated: true }];

    const result = await createConfigUpdateExecutor(deps(entries, { registered }, secrets))(configCommand());
    expect(result.success).toBe(true);
    expect(secrets.current()).toEqual({ SESSION_SECRET: 'kept' });
    expect(secrets.puts()).toBe(0);
    expect(result.output).toMatchObject({ generatedKeys: [] });
  });

  it('never binds a secret key whose value never reached the store, and reports it', async () => {
    const registered: unknown[] = [];
    const secrets = fakeSecretsWriter();
    const entries: EffectiveConfigEntry[] = [
      { key: 'STRIPE_SECRET_KEY', isSecret: true, source: 'vendor' },
      { key: 'SESSION_SECRET', isSecret: true, source: 'generated', generated: true },
      { key: 'LOG_LEVEL', isSecret: false, value: 'info', source: 'vendor' },
    ];

    const result = await createConfigUpdateExecutor(deps(entries, { registered }, secrets))(configCommand());
    expect(result.success).toBe(true);
    expect(bindingsOf(registered).map((b) => b.name)).toEqual(['SESSION_SECRET']);
    expect(result.output).toMatchObject({ generatedKeys: ['SESSION_SECRET'], unboundSecretKeys: ['STRIPE_SECRET_KEY'] });
    const env = (registered[0] as { containerDefinitions: { environment: { name: string; value: string }[] }[] })
      .containerDefinitions[0]!.environment;
    expect(env).toContainEqual({ name: 'LOG_LEVEL', value: 'info' });
  });

  it('uses 256 bits of URL-safe randomness by default', () => {
    const a = generateSecretValue();
    const b = generateSecretValue();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('gives Laravel APP_KEY the base64: form of exactly 32 bytes', () => {
    const key = generateSecretValue('APP_KEY');
    expect(key).toMatch(/^base64:[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(key.slice('base64:'.length), 'base64')).toHaveLength(32);
    expect(generateSecretValue('SESSION_SECRET')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('CONFIG_UPDATE settlement — success only after every rollout completes', () => {
  const command = (id = 'job-config', payload: Record<string, unknown> = { changedKeys: ['LOG_LEVEL'] }) => ({
    id,
    deploymentId: 'dep-1',
    type: 'CONFIG_UPDATE' as const,
    idempotencyKey: `dep-1:CONFIG_UPDATE:${id}`,
    payload,
  });
  const debug: EffectiveConfigEntry[] = [{ key: 'LOG_LEVEL', isSecret: false, value: 'debug', source: 'vendor' }];

  function running(
    entries: EffectiveConfigEntry[],
    ecsOptions: Parameters<typeof ecsWith>[0] = {},
    secrets: ConfigSecretsWriter = fakeSecretsWriter(),
    targetState: string | string[] = 'healthy',
  ) {
    return {
      cfn: cfnWithService({ withConfigSecret: true }),
      ecs: ecsWith({ desiredCount: 2, ...ecsOptions }),
      secrets,
      fetchEffectiveConfig: async () => entries,
      stackName: 'deployz-app',
      installationId: 'inst-test',
      ...rolloutDeps(targetState),
    };
  }

  it('defers a running rollout and records its target revision and deployment, never a secret value', async () => {
    const d = running(debug, { rollout: { state: 'IN_PROGRESS' } });
    const result = await createConfigUpdateExecutor(d)(
      command('job-config', { changedKeys: ['LOG_LEVEL'], secrets: [{ key: 'API_KEY', value: 'plaintext-value' }] }),
    );
    expect(result.deferred).toBe(true);
    const marker = await d.pending.read();
    expect(marker?.type).toBe('CONFIG_UPDATE');
    expect(marker?.payload['configRollouts']).toEqual({
      [SERVICE_ARN]: { taskDefinition: NEXT_DEF_ARN, deploymentId: 'ecs-svc/2', newRevision: true },
    });
    expect(JSON.stringify(marker)).not.toContain('plaintext-value');

    // Still rolling: the resumer reports nothing and keeps the marker.
    expect(await createConfigUpdateResumer(d)()).toEqual([]);
    expect(await d.pending.read()).not.toBeNull();
  });

  it('reports success once the rollout completed with its task count and healthy targets', async () => {
    const d = running(debug);
    expect((await createConfigUpdateExecutor(d)(command())).deferred).toBe(true);
    const [result] = await createConfigUpdateResumer(d)();
    expect(result).toMatchObject({ commandId: 'job-config', success: true, output: { alreadyApplied: false } });
    expect(await d.pending.read()).toMatchObject({ phase: 'settled' });
  });

  it('waits while an ALB target is not healthy yet', async () => {
    const d = running(debug, {}, fakeSecretsWriter(), 'initial');
    await createConfigUpdateExecutor(d)(command());
    expect(await createConfigUpdateResumer(d)()).toEqual([]);
  });

  it('settles without waiting for a draining target', async () => {
    const d = running(debug, {}, fakeSecretsWriter(), ['healthy', 'draining']);
    await createConfigUpdateExecutor(d)(command());
    const [result] = await createConfigUpdateResumer(d)();
    expect(result).toMatchObject({ commandId: 'job-config', success: true });
  });

  it('still waits for a registering target next to a draining one', async () => {
    const d = running(debug, {}, fakeSecretsWriter(), ['initial', 'draining']);
    await createConfigUpdateExecutor(d)(command());
    expect(await createConfigUpdateResumer(d)()).toEqual([]);
  });

  it('fails when the circuit breaker rolled back to the previous revision, and never claims secrets were restored', async () => {
    const d = running(debug, { rollout: { state: 'ROLLED_BACK' } });
    await createConfigUpdateExecutor(d)(command());
    const [result] = await createConfigUpdateResumer(d)();
    expect(result?.success).toBe(false);
    expect(result?.failureCode).toBe('ECS_DEPLOYMENT_FAILED');
    expect(result?.error).toContain(CURRENT_DEF_ARN);
    expect(result?.error).toContain('were not restored');
    expect(await d.pending.read()).toMatchObject({ phase: 'settled' });
  });

  it('forces fresh tasks for a secret-only change on the same revision', async () => {
    const updates: { forceNewDeployment?: boolean; taskDefinition?: string }[] = [];
    const registered: unknown[] = [];
    const bound: EcsTaskDefinition = {
      family: 'app',
      containerDefinitions: [
        { name: 'app', image: 'repo@sha256:aaa', environment: [], secrets: [{ name: 'API_KEY', valueFrom: `${CONFIG_SECRET_ARN}:API_KEY::` }] },
      ],
    };
    const d = running(
      [{ key: 'API_KEY', isSecret: true, source: 'customer' }],
      { taskDefinition: bound, updates, registered },
      fakeSecretsWriter({ API_KEY: 'old' }),
    );
    const result = await createConfigUpdateExecutor(d)(
      command('job-config', { changedKeys: ['API_KEY'], secrets: [{ key: 'API_KEY', value: 'new' }] }),
    );
    expect(result.deferred).toBe(true);
    expect(registered).toHaveLength(0);
    expect(updates).toEqual([{ cluster: 'app-cluster', service: SERVICE_ARN, forceNewDeployment: true }]);
    expect((await d.pending.read())?.payload['configRollouts']).toEqual({
      [SERVICE_ARN]: { taskDefinition: CURRENT_DEF_ARN, deploymentId: 'ecs-svc/2', newRevision: false },
    });
  });

  it('delivers to a service at zero tasks at once: the definition is re-pointed, nothing waits', async () => {
    const updates: unknown[] = [];
    const d = running(debug, { desiredCount: 0, updates });
    const result = await createConfigUpdateExecutor(d)(command());
    expect(result.success).toBe(true);
    expect(updates).toEqual([{ cluster: 'app-cluster', service: SERVICE_ARN, taskDefinition: NEXT_DEF_ARN }]);
    expect(await d.pending.read()).toMatchObject({ phase: 'settled' });
  });

  it('a re-offered command with its own marker only waits — it never applies the configuration twice', async () => {
    const registered: unknown[] = [];
    const d = running(debug, { registered, rollout: { state: 'IN_PROGRESS' } });
    const executor = createConfigUpdateExecutor(d);
    expect((await executor(command())).deferred).toBe(true);
    expect((await executor(command())).deferred).toBe(true);
    expect(registered).toHaveLength(1);
  });
});

describe('CONFIG_UPDATE — superseded task-definition revision cleanup', () => {
  const FAMILY_PREFIX = 'arn:aws:ecs:us-east-1:151955775369:task-definition/DeployzAppWebinsttest';
  const command = {
    id: 'job-config',
    deploymentId: 'dep-1',
    type: 'CONFIG_UPDATE' as const,
    idempotencyKey: 'dep-1:CONFIG_UPDATE:job-config',
    payload: { changedKeys: ['LOG_LEVEL'] },
  };
  const entries: EffectiveConfigEntry[] = [{ key: 'LOG_LEVEL', isSecret: false, value: 'debug', source: 'vendor' }];

  function stack(rollout: 'COMPLETED' | 'ROLLED_BACK') {
    const base = cfnWithService({ withConfigSecret: true });
    const owned = {
      logicalId: 'WebTaskDefinition',
      type: 'AWS::ECS::TaskDefinition',
      status: 'CREATE_COMPLETE',
      physicalId: `${FAMILY_PREFIX}:1`,
    };
    const deregistered: string[] = [];
    const ecs = {
      ...ecsWith({ desiredCount: 2, rollout: { state: rollout } }),
      async listTaskDefinitions() {
        return { taskDefinitionArns: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${FAMILY_PREFIX}:${n}`) };
      },
      async deregisterTaskDefinition(input: { taskDefinition: string }) {
        deregistered.push(input.taskDefinition);
      },
    };
    return {
      deregistered,
      deps: {
        cfn: {
          ...base,
          async describeStack() {
            return {
              found: true as const,
              stack: {
                stackName: 'deployz-app',
                status: 'CREATE_COMPLETE',
                tags: { 'deployz:installation': 'inst-test' },
                stackId: 'stack-id-deployz-app',
              },
            };
          },
          async listStackResources(name: string, token?: string) {
            const page = await base.listStackResources!(name, token);
            return page === null ? null : { resources: [...page.resources, owned] };
          },
        },
        ecs,
        secrets: fakeSecretsWriter(),
        fetchEffectiveConfig: async () => entries,
        stackName: 'deployz-app',
        installationId: 'inst-test',
        ...rolloutDeps(),
      },
    };
  }

  it('deregisters only eligible old revisions once the rollout settled successfully', async () => {
    const { deps, deregistered } = stack('COMPLETED');
    await createConfigUpdateExecutor(deps)(command);
    const [result] = await createConfigUpdateResumer(deps)();
    expect(result?.success).toBe(true);
    expect(deregistered).toEqual([2, 3, 4, 5].map((n) => `${FAMILY_PREFIX}:${n}`));
  });

  it('deregisters nothing when the rollout failed', async () => {
    const { deps, deregistered } = stack('ROLLED_BACK');
    await createConfigUpdateExecutor(deps)(command);
    const [result] = await createConfigUpdateResumer(deps)();
    expect(result?.success).toBe(false);
    expect(deregistered).toEqual([]);
  });
});

describe('unappliedConfigurationKeys', () => {
  function definition(
    environment: { name: string; value: string }[],
    secretBindings: { name: string; valueFrom: string }[] = [],
  ): EcsTaskDefinition {
    return {
      family: 'app',
      containerDefinitions: [{ name: 'app', image: 'repo@sha256:aaa', environment, secrets: secretBindings }],
    };
  }

  function keysFor(
    entries: EffectiveConfigEntry[],
    taskDefinition: EcsTaskDefinition,
    secrets: ReturnType<typeof fakeSecretsWriter> = fakeSecretsWriter(),
  ) {
    return unappliedConfigurationKeys(
      {
        cfn: cfnWithService({ withConfigSecret: true }),
        secrets,
        fetchEffectiveConfig: async () => entries,
        stackName: 'deployz-app',
      },
      taskDefinition,
    );
  }

  const plain: EffectiveConfigEntry[] = [{ key: 'LOG_LEVEL', isSecret: false, value: 'debug', source: 'vendor' }];

  it('reports a plain value the definition lacks (DEPLOY-009)', async () => {
    expect(await keysFor(plain, definition([{ name: 'LOG_LEVEL', value: 'info' }]))).toEqual(['LOG_LEVEL']);
    expect(await keysFor(plain, definition([]))).toEqual(['LOG_LEVEL']);
  });

  it('reports nothing when every value already matches (DEPLOY-009)', async () => {
    expect(await keysFor(plain, definition([{ name: 'LOG_LEVEL', value: 'debug' }]))).toEqual([]);
  });

  it('reports a generated secret the definition does not bind yet, without minting it (DEPLOY-009)', async () => {
    const secrets = fakeSecretsWriter();
    const entries: EffectiveConfigEntry[] = [
      { key: 'AUTH_SECRET', isSecret: true, generated: true, source: 'vendor' },
    ];
    expect(await keysFor(entries, definition([{ name: 'LOG_LEVEL', value: 'info' }]), secrets)).toEqual(['AUTH_SECRET']);
    expect(secrets.puts()).toBe(0);
    expect(secrets.current()).toEqual({});
  });

  it('reports a secret that has a stored or delivered value and no binding (DEPLOY-009)', async () => {
    const entries: EffectiveConfigEntry[] = [
      { key: 'API_KEY', isSecret: true, source: 'customer' },
      { key: 'DB_PASSWORD', isSecret: true, value: 'delivered', source: 'customer' },
    ];
    expect(await keysFor(entries, definition([]), fakeSecretsWriter({ API_KEY: 'stored' }))).toEqual([
      'API_KEY',
      'DB_PASSWORD',
    ]);
  });

  it('reports nothing for a secret that is already bound (DEPLOY-009)', async () => {
    const entries: EffectiveConfigEntry[] = [{ key: 'API_KEY', isSecret: true, source: 'customer' }];
    const bound = definition([], [{ name: 'API_KEY', valueFrom: `${CONFIG_SECRET_ARN}:API_KEY::` }]);
    expect(await keysFor(entries, bound, fakeSecretsWriter({ API_KEY: 'stored' }))).toEqual([]);
  });

  it('does not report a secret no pass could bind: no value anywhere and not generated (DEPLOY-009)', async () => {
    const entries: EffectiveConfigEntry[] = [{ key: 'API_KEY', isSecret: true, source: 'customer' }];
    expect(await keysFor(entries, definition([]))).toEqual([]);
  });

  it('reports nothing for an empty effective configuration (DEPLOY-009)', async () => {
    expect(await keysFor([], definition([]))).toEqual([]);
  });
});

describe('CONFIG_UPDATE durable results', () => {
  const command = (id = 'job-config', payload: Record<string, unknown> = { changedKeys: ['LOG_LEVEL'] }) => ({
    id,
    deploymentId: 'dep-1',
    type: 'CONFIG_UPDATE' as const,
    idempotencyKey: `dep-1:CONFIG_UPDATE:${id}`,
    payload,
  });
  const debug: EffectiveConfigEntry[] = [{ key: 'LOG_LEVEL', isSecret: false, value: 'debug', source: 'vendor' }];
  const generated: EffectiveConfigEntry[] = [
    { key: 'SESSION_SECRET', isSecret: true, source: 'generated', generated: true },
  ];

  function running(
    entries: EffectiveConfigEntry[],
    ecsOptions: Parameters<typeof ecsWith>[0] = {},
    secrets: ConfigSecretsWriter = fakeSecretsWriter(),
  ) {
    return {
      cfn: cfnWithService({ withConfigSecret: true }),
      ecs: ecsWith(ecsOptions),
      secrets,
      fetchEffectiveConfig: async () => entries,
      stackName: 'deployz-app',
      installationId: 'inst-test',
      generateSecret: () => 'minted-value',
      ...rolloutDeps(),
    };
  }

  it('re-reports a lost immediate result, generated key names included, without applying again', async () => {
    const registered: unknown[] = [];
    const updates: unknown[] = [];
    const secrets = fakeSecretsWriter();
    const d = running(generated, { registered, updates }, secrets);
    const first = await createConfigUpdateExecutor(d)(command());
    expect(first.output).toMatchObject({ generatedKeys: ['SESSION_SECRET'] });

    // The POST failed; the control plane offers the same command to a new process.
    const replay = await createConfigUpdateExecutor({ ...d })(command());
    expect(replay).toEqual(first);
    expect(await createConfigUpdateResumer(d)()).toEqual([first]);
    expect(registered).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(secrets.puts()).toBe(1);
    expect(JSON.stringify(await d.pending.read())).not.toContain('minted-value');

    expect(await d.pending.compareAndSet('job-config', null)).toBe(true);
    expect(await d.pending.read()).toBeNull();
  });

  it('re-reports a lost rollout failure from the marker', async () => {
    const registered: unknown[] = [];
    const d = running(debug, { desiredCount: 2, registered, rollout: { state: 'ROLLED_BACK' } });
    await createConfigUpdateExecutor(d)(command());
    const [failed] = await createConfigUpdateResumer(d)();
    expect(failed?.success).toBe(false);

    expect(await createConfigUpdateResumer(d)()).toEqual([failed]);
    expect(await createConfigUpdateExecutor(d)(command())).toEqual(failed);
    expect(registered).toHaveLength(1);
  });

  it('re-reports a lost failure that needed no rollout', async () => {
    const d = { ...running(debug), fetchEffectiveConfig: async () => { throw new Error('Config fetch returned HTTP 503'); } };
    const first = await createConfigUpdateExecutor(d)(command());
    expect(first.success).toBe(false);

    let fetches = 0;
    const replay = await createConfigUpdateExecutor({
      ...d,
      fetchEffectiveConfig: async () => {
        fetches += 1;
        return debug;
      },
    })(command());
    expect(replay).toEqual(first);
    expect(fetches).toBe(0);
  });

  it('keeps a newer command marker when this command settles', async () => {
    const d = running(debug, { desiredCount: 2 });
    await createConfigUpdateExecutor(d)(command());
    const store = d.pending;
    const newer = {
      commandId: 'job-newer',
      idempotencyKey: 'dep-1:RESTART',
      type: 'RESTART',
      stackName: 'deployz-app',
      startedAt: '2026-10-13T00:00:00.000Z',
      payload: {},
    };
    let first = true;
    const racing: PendingStore = {
      ...store,
      inspect: async () => {
        const seen = await store.inspect();
        if (first) {
          first = false;
          await store.write(newer);
        }
        return seen;
      },
    };

    expect(await createConfigUpdateResumer({ ...d, pending: racing })()).toEqual([]);
    expect(await store.read()).toMatchObject({ commandId: 'job-newer', type: 'RESTART' });
  });

  it('applies nothing while the pending marker is unreadable', async () => {
    const registered: unknown[] = [];
    const secrets = fakeSecretsWriter();
    const d = running(generated, { registered }, secrets);
    const blind: typeof d = {
      ...d,
      pending: {
        ...d.pending,
        read: async () => null,
        inspect: async () => ({ state: 'unreadable', errorCode: 'AccessDeniedException' }),
      },
    };

    expect(await createConfigUpdateExecutor(blind)(command())).toMatchObject({ success: false, deferred: true });
    expect(await createConfigUpdateResumer(blind)()).toEqual([]);
    expect(registered).toHaveLength(0);
    expect(secrets.puts()).toBe(0);
  });

  it('applies nothing for a command the control plane no longer owns, and defers when it is unknown', async () => {
    const registered: unknown[] = [];
    const secrets = fakeSecretsWriter();
    const d = running(generated, { registered }, secrets);

    const inactive = await createConfigUpdateExecutor({ ...d, checkAuthority: async () => false })(command());
    expect(inactive).toMatchObject({ success: false });
    expect(inactive.deferred).toBeUndefined();
    expect(await createConfigUpdateExecutor({ ...d, checkAuthority: async () => null })(command())).toMatchObject({
      success: false,
      deferred: true,
    });
    expect(registered).toHaveLength(0);
    expect(secrets.puts()).toBe(0);
    expect(await d.pending.read()).toBeNull();
  });
});
