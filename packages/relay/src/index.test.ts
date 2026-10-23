import { describe, expect, it, vi } from 'vitest';

import type { ScheduledEvent } from 'aws-lambda';

import { type FetchFn, type SecretsClient } from './auth.js';
import { IdempotencyStore, type CommandExecutor } from './commands.js';
import {
  buildDbAzParameters,
  compactPendingInstallPayload,
  createInstallExecutor,
  createInstallResumer,
  createObserveHook,
  createRelayHandler,
  createVerifyingExecutor,
  discoverAvailabilityZones,
  fetchCommandAuthority,
  readDeploymentManifest,
  readDeploymentTagsFromPayload,
  readInstallParametersFromPayload,
  readTemplateParameterNames,
  readVerifyOptionsFromPayload,
  relayApplicationStackName,
  relayBootstrapStackName,
  type InstallExecutorDeps,
} from './index.js';
import { memoryPendingStore, PENDING_MARKER_MAX_LENGTH, type PendingStore } from './pending.js';
import type { ProvisioningSnapshot } from './provision-progress.js';
import {
  recoverFailedInstallStack,
  type PhysicalStackResource,
  type RecoveryCloudFormation,
  type RdsCleanupClient,
} from './recover.js';
import type { StackLookup, VerificationResult } from './verify.js';

// Fast stub for the §59 observe hook — the default falls back to a real
// CloudFormationReader, which would otherwise reach out to AWS on every
// poll cycle these integration tests run. No test in this file exercises
// `observe` behavior itself, so a fixed "verified" result is fine everywhere.
const stubObserve = async (): Promise<VerificationResult> => ({
  verified: true,
  checks: [],
});

// Same rule for the digest and health observation hooks: their defaults
// reach out to real AWS too, and no test here exercises them either.
const stubObserveImage = async (): Promise<string | null> => null;
const stubObserveHealth = async () => ({
  healthStatus: 'UNKNOWN' as const,
  components: { application: 'UNKNOWN' as const, loadBalancer: 'UNKNOWN' as const },
  desiredCount: null,
  runningCount: null,
  unhealthyTargetCount: null,
  pendingTargetCount: null,
  unknownTargetCount: null,
  deploymentRolloutState: null,
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeScheduledEvent(time?: string): ScheduledEvent {
  return {
    version: '0',
    id: 'event-id',
    'detail-type': 'Scheduled Event',
    source: 'aws.events',
    account: '123456789012',
    time: time ?? new Date().toISOString(),
    region: 'us-east-1',
    resources: ['arn:aws:events:us-east-1:123456789012:rule/relay-schedule'],
    detail: {},
  };
}

function makeSecretsClient(token: string): SecretsClient {
  return {
    async getSecretValue() {
      return { SecretString: JSON.stringify({ token }) };
    },
  };
}

function makeFetchFn(
  registerStatus = 200,
  commandsBody: unknown = { commands: [] },
): FetchFn {
  return async (url, init) => {
    void init;
    if (url.includes('/api/relay/register')) {
      return {
        status: registerStatus,
        headers: { get: () => null },
        json: async () => ({}),
      };
    }
    if (url.includes('/api/relay/commands')) {
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => commandsBody,
      };
    }
    if (url.includes('/result')) {
      return { status: 200, headers: { get: () => null }, json: async () => ({}) };
    }
    if (url.includes('/api/relay/health')) {
      return { status: 200, headers: { get: () => null }, json: async () => ({}) };
    }
    return { status: 404, headers: { get: () => null }, json: async () => ({}) };
  };
}

function setEnv(vars: Record<string, string | undefined>): () => void {
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key] of Object.entries(vars)) {
      if (prev[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev[key];
      }
    }
  };
}

// ── Handler integration tests ────────────────────────────────────────────────

describe('relay handler (integration)', () => {
  it('completes a full poll cycle: register → fetch → execute → report', async () => {
    const restore = setEnv({
      DEPLOYZ_INSTALLATION_ID: 'inst-int',
      DEPLOYZ_CREDENTIAL_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test',
      DEPLOYZ_CONTROL_PLANE_URL: 'https://api.deployz.dev',
      DEPLOYZ_ENROLLMENT_CODE: 'code-int',
    });

    try {
      const secretsClient = makeSecretsClient('tok-integration');
      const fetchFn = makeFetchFn(200, {
        commands: [
          {
            id: 'job-int-001',
            deploymentId: 'dep-int-001',
            type: 'INSTALL',
            idempotencyKey: 'ik-int-001',
            payload: { releaseId: 'rel-int-001' },
          },
        ],
      });

      // Inject a fake INSTALL executor so this test exercises the poll
      // cycle (register → fetch → execute → report) without reaching AWS —
      // the default executors call the real CloudFormationReader.
      const executors: Record<string, CommandExecutor> = {
        INSTALL: async (cmd) => ({
          commandId: cmd.id,
          idempotencyKey: cmd.idempotencyKey,
          success: true,
          output: { executed: true, type: cmd.type },
        }),
      };

      const handler = createRelayHandler({ secretsClient, fetchFn, executors, observe: stubObserve, observeImage: stubObserveImage, observeHealth: stubObserveHealth });
      const event = makeScheduledEvent();

      // Should not throw.
      await handler(event);
    } finally {
      restore();
    }
  });

  it('logs error when env vars are missing', async () => {
    const restore = setEnv({
      DEPLOYZ_INSTALLATION_ID: undefined,
      DEPLOYZ_CREDENTIAL_SECRET_ARN: undefined,
      DEPLOYZ_CONTROL_PLANE_URL: undefined,
      DEPLOYZ_ENROLLMENT_CODE: undefined,
    });

    try {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const secretsClient = makeSecretsClient('tok');
      const fetchFn = makeFetchFn(200);

      const handler = createRelayHandler({ secretsClient, fetchFn, observe: stubObserve, observeImage: stubObserveImage, observeHealth: stubObserveHealth });
      await handler(makeScheduledEvent());

      expect(consoleSpy).toHaveBeenCalled();
      const call = consoleSpy.mock.calls[0]?.[0];
      expect(call).toContain('relay:missing-config');

      consoleSpy.mockRestore();
    } finally {
      restore();
    }
  });

  it('logs error when credential read fails', async () => {
    const restore = setEnv({
      DEPLOYZ_INSTALLATION_ID: 'inst-err',
      DEPLOYZ_CREDENTIAL_SECRET_ARN: 'arn:...',
      DEPLOYZ_CONTROL_PLANE_URL: 'https://api.deployz.dev',
      DEPLOYZ_ENROLLMENT_CODE: 'code-int',
    });

    try {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const secretsClient: SecretsClient = {
        async getSecretValue() {
          throw new Error('AccessDenied');
        },
      };
      const fetchFn = makeFetchFn(200);

      const handler = createRelayHandler({ secretsClient, fetchFn, observe: stubObserve, observeImage: stubObserveImage, observeHealth: stubObserveHealth });
      await handler(makeScheduledEvent());

      expect(consoleSpy).toHaveBeenCalled();
      const call = consoleSpy.mock.calls[0]?.[0];
      expect(call).toContain('relay:credential-read-failed');

      consoleSpy.mockRestore();
    } finally {
      restore();
    }
  });

  it('reuses auth state across invocations (warm container)', async () => {
    const restore = setEnv({
      DEPLOYZ_INSTALLATION_ID: 'inst-warm',
      DEPLOYZ_CREDENTIAL_SECRET_ARN: 'arn:...',
      DEPLOYZ_CONTROL_PLANE_URL: 'https://api.deployz.dev',
      DEPLOYZ_ENROLLMENT_CODE: 'code-int',
    });

    try {
      let secretCallCount = 0;
      const secretsClient: SecretsClient = {
        async getSecretValue() {
          secretCallCount += 1;
          return { SecretString: JSON.stringify({ token: 'tok-warm' }) };
        },
      };

      const fetchFn = makeFetchFn(200, { commands: [] });

      const handler = createRelayHandler({ secretsClient, fetchFn, observe: stubObserve, observeImage: stubObserveImage, observeHealth: stubObserveHealth });

      // First invocation — should read the secret.
      await handler(makeScheduledEvent());
      expect(secretCallCount).toBe(1);

      // Second invocation — should reuse cached auth state.
      await handler(makeScheduledEvent());
      expect(secretCallCount).toBe(1); // still 1, not re-read
    } finally {
      restore();
    }
  });

  it('executes commands with idempotency across invocations', async () => {
    const restore = setEnv({
      DEPLOYZ_INSTALLATION_ID: 'inst-idem',
      DEPLOYZ_CREDENTIAL_SECRET_ARN: 'arn:...',
      DEPLOYZ_CONTROL_PLANE_URL: 'https://api.deployz.dev',
      DEPLOYZ_ENROLLMENT_CODE: 'code-int',
    });

    try {
      const secretsClient = makeSecretsClient('tok-idem');
      const idempotency = new IdempotencyStore();

      let callCount = 0;
      const executors: Record<string, CommandExecutor> = {
        INSTALL: async (cmd) => {
          callCount += 1;
          return {
            commandId: cmd.id,
            idempotencyKey: cmd.idempotencyKey,
            success: true,
          };
        },
        REPORT_HEALTH: async (cmd) => ({
          commandId: cmd.id,
          idempotencyKey: cmd.idempotencyKey,
          success: true,
        }),
        DEPLOY_RELEASE: async (cmd) => ({
          commandId: cmd.id,
          idempotencyKey: cmd.idempotencyKey,
          success: true,
        }),
        ROLLBACK: async (cmd) => ({
          commandId: cmd.id,
          idempotencyKey: cmd.idempotencyKey,
          success: true,
        }),
        CONFIG_UPDATE: async (cmd) => ({
          commandId: cmd.id,
          idempotencyKey: cmd.idempotencyKey,
          success: true,
        }),
        DESTROY: async (cmd) => ({
          commandId: cmd.id,
          idempotencyKey: cmd.idempotencyKey,
          success: true,
        }),
      };

      const command = {
        id: 'job-idem',
        deploymentId: 'dep-idem',
        type: 'INSTALL' as const,
        idempotencyKey: 'ik-idem',
        payload: {},
      };

      const fetchFn = makeFetchFn(200, { commands: [command] });

      const handler = createRelayHandler({ secretsClient, fetchFn, executors, idempotency, observe: stubObserve, observeImage: stubObserveImage, observeHealth: stubObserveHealth });

      // First invocation — executes the command.
      await handler(makeScheduledEvent());
      expect(callCount).toBe(1);

      // Second invocation with same command — idempotent, no re-execution.
      await handler(makeScheduledEvent());
      expect(callCount).toBe(1); // still 1
    } finally {
      restore();
    }
  });
});

describe('INSTALL verification gate', () => {
  const command = {
    id: 'cmd-1',
    deploymentId: 'dep-1',
    type: 'INSTALL' as const,
    idempotencyKey: 'dep-1:INSTALL',
    payload: {},
  };

  it('fails the install when the account cannot be verified', async () => {
    const executor = createVerifyingExecutor(async () => ({
      verified: false,
      checks: [{ name: 'stack-exists', passed: false, detail: 'No CloudFormation stack named "deployz-app"' }],
      reason: 'No CloudFormation stack named "deployz-app"',
    }));

    const result = await executor(command);

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_CREATE_FAILED');
    expect(result.error).toContain('deployz-app');
    expect(result.output).toMatchObject({ checks: expect.any(Array) });
  });

  it('succeeds when the account verifies', async () => {
    const executor = createVerifyingExecutor(async () => ({
      verified: true,
      checks: [{ name: 'stack-exists', passed: true, detail: 'Stack "deployz-app" found' }],
    }));

    const result = await executor(command);

    expect(result.success).toBe(true);
    expect(result.failureCode).toBeUndefined();
  });

  it('fails the install when verification itself throws', async () => {
    const executor = createVerifyingExecutor(async () => {
      throw new Error('boom');
    });

    const result = await executor(command);

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_CREATE_FAILED');
  });
});

// The gate closes the same hole for DEPLOY_RELEASE and ROLLBACK: both mapped
// to the stub `noop` executor before this fix, so a vendor clicking "Deploy
// Update" after a correctly-gated INSTALL failure could still walk straight
// past the gate to a billable Healthy state over an empty account.
describe('DEPLOY_RELEASE / ROLLBACK verification gate', () => {
  it.each(['DEPLOY_RELEASE', 'ROLLBACK'] as const)(
    'fails %s when the account cannot be verified',
    async (type) => {
      const command = {
        id: `cmd-${type}`,
        deploymentId: 'dep-1',
        type,
        idempotencyKey: `dep-1:${type}`,
        payload: {},
      };

      const executor = createVerifyingExecutor(async () => ({
        verified: false,
        checks: [{ name: 'stack-exists', passed: false, detail: 'No CloudFormation stack named "deployz-app"' }],
        reason: 'No CloudFormation stack named "deployz-app"',
      }));

      const result = await executor(command);

      expect(result.success).toBe(false);
      expect(result.failureCode).toBe('STACK_CREATE_FAILED');
    },
  );

  it.each(['DEPLOY_RELEASE', 'ROLLBACK'] as const)('succeeds %s when the account verifies', async (type) => {
    const command = {
      id: `cmd-${type}`,
      deploymentId: 'dep-1',
      type,
      idempotencyKey: `dep-1:${type}`,
      payload: {},
    };

    const executor = createVerifyingExecutor(async () => ({
      verified: true,
      checks: [{ name: 'stack-exists', passed: true, detail: 'Stack "deployz-app" found' }],
    }));

    const result = await executor(command);

    expect(result.success).toBe(true);
    expect(result.failureCode).toBeUndefined();
  });
});

// The relay has command.payload in hand and, before this fix, ignored it —
// verifyInstallation always defaulted redisRequired to false. That let a
// deployment which genuinely requires Redis pass the relay gate over an
// account with no ElastiCache cluster, disagreeing with the operator CLI's
// `--redis` flag about the same installation.
describe('createVerifyingExecutor passes the command through to verify()', () => {
  it('hands the full command to the verify callback, not just the installation id', async () => {
    const command = {
      id: 'cmd-payload',
      deploymentId: 'dep-1',
      type: 'INSTALL' as const,
      idempotencyKey: 'dep-1:INSTALL',
      payload: { redisRequired: true, stackName: 'custom-stack' },
    };

    let seenCommand: typeof command | undefined;
    const executor = createVerifyingExecutor(async (_installationId, cmd) => {
      seenCommand = cmd as typeof command;
      return { verified: true, checks: [] };
    });

    await executor(command);

    expect(seenCommand?.payload).toEqual({ redisRequired: true, stackName: 'custom-stack' });
  });
});

describe('createObserveHook', () => {
  const MID_CREATE: VerificationResult = {
    verified: false,
    reason: 'Stack status CREATE_IN_PROGRESS is not a successful terminal state',
    checks: [
      { name: 'stack-exists', passed: true, detail: 'Stack "deployz-app" found' },
      { name: 'stack-complete', passed: false, detail: 'Stack status CREATE_IN_PROGRESS is not a successful terminal state' },
    ],
  };

  const COMPLETE: VerificationResult = {
    verified: true,
    checks: [
      { name: 'stack-exists', passed: true, detail: 'Stack "deployz-app" found' },
      { name: 'stack-complete', passed: true, detail: 'Stack status CREATE_COMPLETE' },
    ],
  };

  const SNAPSHOT: ProvisioningSnapshot = {
    stackStatus: 'CREATE_IN_PROGRESS',
    observedAt: '2026-01-01T00:05:00.000Z',
    categories: { network: { status: 'COMPLETE', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:01:00.000Z' } },
  };

  it('attaches the provisioning snapshot when the stack exists but is not yet complete', async () => {
    const hook = createObserveHook(
      async () => MID_CREATE,
      async () => SNAPSHOT,
    );

    const result = await hook();

    expect(result).toEqual({ ...MID_CREATE, provisioning: SNAPSHOT });
  });

  it('does not attach a provisioning field when the stack is already complete', async () => {
    let called = false;
    const hook = createObserveHook(
      async () => COMPLETE,
      async () => {
        called = true;
        return SNAPSHOT;
      },
    );

    const result = await hook();

    expect(result).toEqual(COMPLETE);
    expect(result).not.toHaveProperty('provisioning');
    // The snapshot fetch is pointless once the stack is complete — no
    // reason to spend the extra DescribeStackResources call.
    expect(called).toBe(false);
  });

  it('does not attach a provisioning field when the stack does not exist at all', async () => {
    const notFound: VerificationResult = {
      verified: false,
      reason: 'No CloudFormation stack named "deployz-app" in this account and region',
      checks: [{ name: 'stack-exists', passed: false, detail: 'No stack found' }],
    };

    const hook = createObserveHook(
      async () => notFound,
      async () => SNAPSHOT,
    );

    expect(await hook()).toEqual(notFound);
  });

  it('returns the plain verification when the snapshot builder resolves to null', async () => {
    const hook = createObserveHook(
      async () => MID_CREATE,
      async () => null,
    );

    expect(await hook()).toEqual(MID_CREATE);
  });

  it('returns the plain verification when the snapshot builder throws', async () => {
    const hook = createObserveHook(
      async () => MID_CREATE,
      async () => {
        throw new Error('DescribeStackResources threw despite its no-throw contract');
      },
    );

    expect(await hook()).toEqual(MID_CREATE);
  });

  it('returns the plain verification when verify() itself throws', async () => {
    const hook = createObserveHook(
      async () => {
        throw new Error('verification could not run');
      },
      async () => SNAPSHOT,
    );

    await expect(hook()).rejects.toThrow('verification could not run');
  });

  it('attaches the raw inventory when the inventory fetch succeeds', async () => {
    const inventory: VerificationResult['inventory'] = {
      stackId: 'arn:aws:cloudformation:us-east-1:1:stack/deployz-app/abc',
      resources: [{ logicalId: 'Database', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE' }],
      observedAt: '2026-01-01T00:05:00.000Z',
    };

    const hook = createObserveHook(
      async () => COMPLETE,
      async () => SNAPSHOT,
      async () => inventory,
    );

    expect(await hook()).toEqual({ ...COMPLETE, inventory });
  });

  it('attaches the inventory even during provisioning, alongside the snapshot', async () => {
    const inventory: VerificationResult['inventory'] = {
      stackId: 'arn:aws:cloudformation:us-east-1:1:stack/deployz-app/abc',
      resources: [],
      observedAt: '2026-01-01T00:05:00.000Z',
    };

    const hook = createObserveHook(
      async () => MID_CREATE,
      async () => SNAPSHOT,
      async () => inventory,
    );

    expect(await hook()).toEqual({ ...MID_CREATE, provisioning: SNAPSHOT, inventory });
  });

  it('omits the inventory when the inventory fetch returns null', async () => {
    const hook = createObserveHook(
      async () => COMPLETE,
      async () => SNAPSHOT,
      async () => null,
    );

    expect(await hook()).toEqual(COMPLETE);
  });

  it('omits the inventory when the inventory fetch throws', async () => {
    const hook = createObserveHook(
      async () => COMPLETE,
      async () => SNAPSHOT,
      async () => {
        throw new Error('ListStackResources threw despite its no-throw contract');
      },
    );

    const result = await hook();
    expect(result).toEqual(COMPLETE);
    expect(result).not.toHaveProperty('inventory');
  });
});

describe('readVerifyOptionsFromPayload', () => {
  it('reads redisRequired, databaseRequired, and stackName when present and well-typed', () => {
    expect(readVerifyOptionsFromPayload({ redisRequired: true, databaseRequired: false, stackName: 'deployz-app-custom' })).toEqual({
      redisRequired: true,
      databaseRequired: false,
      stackName: 'deployz-app-custom',
    });
  });

  it('returns an empty object when the payload has neither field', () => {
    expect(readVerifyOptionsFromPayload({})).toEqual({});
  });

  it('ignores a non-boolean redisRequired rather than trusting it', () => {
    expect(readVerifyOptionsFromPayload({ redisRequired: 'true' })).toEqual({});
    expect(readVerifyOptionsFromPayload({ redisRequired: 1 })).toEqual({});
  });

  it('ignores a non-boolean databaseRequired rather than trusting it', () => {
    expect(readVerifyOptionsFromPayload({ databaseRequired: 'false' })).toEqual({});
    expect(readVerifyOptionsFromPayload({ databaseRequired: 0 })).toEqual({});
  });

  it('ignores a non-string or empty stackName rather than trusting it', () => {
    expect(readVerifyOptionsFromPayload({ stackName: 42 })).toEqual({});
    expect(readVerifyOptionsFromPayload({ stackName: '' })).toEqual({});
  });

  it('reads redisRequired: false explicitly, not just truthy values', () => {
    expect(readVerifyOptionsFromPayload({ redisRequired: false })).toEqual({ redisRequired: false });
  });

  it('reads databaseRequired: false explicitly, not just truthy values', () => {
    expect(readVerifyOptionsFromPayload({ databaseRequired: false })).toEqual({ databaseRequired: false });
  });

  // Phase 2: the manifest, when present, is the ONLY source of these flags
  // — contradicting top-level flags never win. This is what keeps template
  // selection (settleInstall's `profile`) and verification in agreement.
  it('derives redisRequired/databaseRequired from the manifest, overriding contradicting top-level flags', () => {
    const manifest = manifestPayload({
      database: { postgres: false },
      redis: { required: true, envBindings: [] },
    });

    expect(
      readVerifyOptionsFromPayload({
        redisRequired: false,
        databaseRequired: true,
        manifest,
      }),
    ).toEqual({ redisRequired: true, databaseRequired: false });
  });
});

describe('relay stack-name resolution', () => {
  it('derives the application stack name from the installation id', () => {
    const restore = setEnv({
      DEPLOYZ_INSTALLATION_ID: '9f3ab2c1-1234-4abc-9def-0123456789ab',
      DEPLOYZ_BOOTSTRAP_STACK_NAME: 'deployz-bootstrap-acme-9f3ab2c1',
    });

    try {
      expect(relayApplicationStackName()).toBe('deployz-app-9f3ab2c1');
      expect(relayBootstrapStackName()).toBe('deployz-bootstrap-acme-9f3ab2c1');
    } finally {
      restore();
    }
  });

  it('falls back to the fixed defaults when the env is absent', () => {
    const restore = setEnv({
      DEPLOYZ_INSTALLATION_ID: undefined,
      DEPLOYZ_BOOTSTRAP_STACK_NAME: undefined,
    });

    try {
      expect(relayApplicationStackName()).toBe('deployz-app');
      expect(relayBootstrapStackName()).toBe('deployz-bootstrap');
    } finally {
      restore();
    }
  });

  it('keeps the bootstrap name in sync when the deployment is retried under a fresh stack name', () => {
    const restore = setEnv({
      DEPLOYZ_INSTALLATION_ID: 'deadbeef-0000-4abc-9def-0123456789ab',
      DEPLOYZ_BOOTSTRAP_STACK_NAME: 'deployz-bootstrap-acme-deadbeef-r1',
    });

    try {
      expect(relayBootstrapStackName()).toBe('deployz-bootstrap-acme-deadbeef-r1');
      expect(relayApplicationStackName()).not.toBe('deployz-app-9f3ab2c1');
    } finally {
      restore();
    }
  });
});

// ── The real INSTALL executor: provision, then prove it ──────────────────────

describe('createInstallExecutor', () => {
  // Phase 2: settleInstall requires a known infrastructure profile — these
  // top-level flags stand in for a manifest (the shape a resumed/compacted
  // marker carries) wherever a test below doesn't care about its content.
  // The template URL comes from the payload itself.
  const command = {
    id: 'cmd-1',
    deploymentId: 'dep-1',
    type: 'INSTALL' as const,
    idempotencyKey: 'dep-1:INSTALL',
    payload: {
      redisRequired: false,
      databaseRequired: true,
      templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/application-template-v1.json',
    },
  };

  const verified: VerificationResult = {
    verified: true,
    checks: [{ name: 'stack-exists', passed: true, detail: 'Stack "deployz-app" found' }],
  };

  function makeInstallDeps(overrides: Partial<InstallExecutorDeps> = {}): InstallExecutorDeps {
    return {
      installationId: 'inst-1',
      install: async () => ({ state: 'succeeded', status: 'CREATE_COMPLETE', outputs: {} }),
      verify: async () => verified,
      pending: memoryPendingStore(),
      now: () => '2026-08-26T12:00:00.000Z',
      ...overrides,
    };
  }

  it('creates the stack and reports success once verification agrees', async () => {
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: { 'deployz-app-PublicEndpoint': 'app.example.com' },
    }));

    const result = await createInstallExecutor(makeInstallDeps({ install }))(command);

    expect(install).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      stackStatus: 'CREATE_COMPLETE',
      outputs: { 'deployz-app-PublicEndpoint': 'app.example.com' },
      checks: expect.any(Array),
    });
  });

  it('passes the template URL, execution role and installation to the installer', async () => {
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    await createInstallExecutor(
      makeInstallDeps({ install, executionRoleArn: 'arn:aws:iam::1:role/deployz/exec' }),
    )(command);

    // The URL the installer receives is the payload's, not the deps' —
    // the executor no longer resolves a template of its own.
    expect(install.mock.calls[0]![0]).toMatchObject({
      installationId: 'inst-1',
      templateUrl: command.payload.templateUrl,
      executionRoleArn: 'arn:aws:iam::1:role/deployz/exec',
      stackName: 'deployz-app',
    });
  });

  it('reports the CloudFormation failure, and does not verify a stack that rolled back', async () => {
    const verify = vi.fn(async () => verified);
    const result = await createInstallExecutor(
      makeInstallDeps({
        verify,
        install: async () => ({
          state: 'failed',
          status: 'ROLLBACK_COMPLETE',
          reason: 'Stack "deployz-app" finished in ROLLBACK_COMPLETE - image pull failed',
          outputs: {},
        }),
      }),
    )(command);

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_CREATE_FAILED');
    expect(result.error).toContain('image pull failed');
    expect(verify).not.toHaveBeenCalled();
  });

  it('fails when CloudFormation says complete but verification disagrees', async () => {
    const result = await createInstallExecutor(
      makeInstallDeps({
        verify: async () => ({
          verified: false,
          checks: [{ name: 'compute', passed: false, detail: 'No complete ECS service' }],
          reason: 'No complete ECS service',
        }),
      }),
    )(command);

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_CREATE_FAILED');
    expect(result.error).toContain('ECS service');
  });

  // Phase 1: a CREATE_COMPLETE stack that failed verification still has
  // its service and stopped tasks, so the collector is wired there too —
  // not only on the stack-level failure branch, where the service is
  // often already deleted.
  it('attaches stopped-task evidence when CloudFormation says complete but verification disagrees', async () => {
    const stoppedTaskEvidence = vi.fn(async () => ({
      container: {
        exitCode: 1,
        stopCode: 'EssentialContainerExited',
        stoppedReason: 'connect ECONNREFUSED 10.0.1.5:5432',
        stoppedTaskCount: 2,
      },
    }));

    const result = await createInstallExecutor(
      makeInstallDeps({
        stoppedTaskEvidence,
        verify: async () => ({
          verified: false,
          checks: [{ name: 'compute', passed: false, detail: 'No complete ECS service' }],
          reason: 'No complete ECS service',
        }),
      }),
    )(command);

    expect(result.success).toBe(false);
    expect(stoppedTaskEvidence).toHaveBeenCalledExactlyOnceWith('deployz-app');
    expect(result.evidence).toEqual({
      container: {
        exitCode: 1,
        stopCode: 'EssentialContainerExited',
        stoppedReason: 'connect ECONNREFUSED 10.0.1.5:5432',
        stoppedTaskCount: 2,
      },
    });
  });

  it('omits verification-failure evidence when the collector throws — the failure itself is unchanged', async () => {
    const stoppedTaskEvidence = vi.fn(async () => {
      throw new Error('AccessDenied');
    });

    const result = await createInstallExecutor(
      makeInstallDeps({
        stoppedTaskEvidence,
        verify: async () => ({
          verified: false,
          checks: [{ name: 'compute', passed: false, detail: 'No complete ECS service' }],
          reason: 'No complete ECS service',
        }),
      }),
    )(command);

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_CREATE_FAILED');
    expect(result.error).toContain('ECS service');
    expect(stoppedTaskEvidence).toHaveBeenCalledOnce();
    expect(result.evidence).toBeUndefined();
  });

  it('defers - reporting nothing - while the stack is still creating', async () => {
    const result = await createInstallExecutor(
      makeInstallDeps({
        install: async () => ({ state: 'in-progress', status: 'CREATE_IN_PROGRESS' }),
      }),
    )(command);

    expect(result.deferred).toBe(true);
    expect(result.success).toBe(false);
    expect(result.failureCode).toBeUndefined();
  });

  it('records what it owes an answer to before deferring', async () => {
    const pending = memoryPendingStore();

    await createInstallExecutor(
      makeInstallDeps({
        pending,
        install: async () => ({ state: 'in-progress', status: 'CREATE_IN_PROGRESS' }),
      }),
    )({
      ...command,
      // No env bindings — keeps this test about the deferral marker itself,
      // not Stage B's binding-alias compaction (covered separately below).
      payload: {
        templateUrl: command.payload.templateUrl,
        manifest: manifestPayload({
          redis: { required: true, envBindings: [] },
          storage: { required: true, envBindings: [] },
        }),
      },
    });

    expect(await pending.read()).toEqual({
      commandId: 'cmd-1',
      idempotencyKey: 'dep-1:INSTALL',
      type: 'INSTALL',
      stackName: 'deployz-app',
      startedAt: '2026-08-26T12:00:00.000Z',
      // Phase 2: the manifest itself is dropped (SSM size limit) but its
      // derived parameters, the requirement flags, and the payload's
      // templateUrl all survive the compaction.
      payload: {
        templateUrl: command.payload.templateUrl,
        redisRequired: true,
        databaseRequired: true,
        parameters: { paramContainerPort: '8080', paramHealthCheckPath: '/api/health' },
      },
    });
  });

  it('fails rather than defers when the marker cannot be persisted', async () => {
    const pending = memoryPendingStore();
    pending.write = async () => false;

    const result = await createInstallExecutor(
      makeInstallDeps({
        pending,
        install: async () => ({ state: 'in-progress', status: 'CREATE_IN_PROGRESS' }),
      }),
    )(command);

    // Deferring without a durable marker would strand the job in RUNNING
    // forever - nothing would ever come back to report on it.
    expect(result.deferred).toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_CREATE_FAILED');
  });

  it('refuses a stack name that is not this installation\'s stack', async () => {
    const install = vi.fn();

    const result = await createInstallExecutor(makeInstallDeps({ install }))({
      ...command,
      payload: {
        stackName: 'deployz-app-staging',
        redisRequired: false,
        databaseRequired: true,
        templateUrl: command.payload.templateUrl,
      },
    });

    expect(install).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_CREATE_FAILED');
  });

  it('refuses a templateUrl that is not an https S3 URL', async () => {
    const install = vi.fn();

    for (const templateUrl of [
      'https://attacker.example.com/t.json',
      'http://bucket.s3.us-east-1.amazonaws.com/t.json',
      'https://s3.amazonaws.com.attacker.example.com/t.json',
    ]) {
      const result = await createInstallExecutor(makeInstallDeps({ install }))({
        ...command,
        payload: { redisRequired: false, databaseRequired: true, templateUrl },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/templateUrl/i);
    }

    expect(install).not.toHaveBeenCalled();
  });

  it('fails closed when the payload carries no templateUrl', async () => {
    const install = vi.fn();

    const missing = await createInstallExecutor(makeInstallDeps({ install }))({
      ...command,
      payload: { redisRequired: false, databaseRequired: true },
    });
    const empty = await createInstallExecutor(makeInstallDeps({ install }))({
      ...command,
      payload: { redisRequired: false, databaseRequired: true, templateUrl: '' },
    });

    expect(install).not.toHaveBeenCalled();
    expect(missing.success).toBe(false);
    expect(missing.failureCode).toBe('STACK_CREATE_FAILED');
    expect(missing.error).toMatch(/templateUrl/i);
    expect(empty.success).toBe(false);
    expect(empty.error).toMatch(/templateUrl/i);
  });

  it('works exactly as before when no stack-event collector factory is configured', async () => {
    const install = vi.fn(async (options: { onPoll?: unknown }) => {
      expect(options.onPoll).toBeUndefined();
      return { state: 'succeeded' as const, status: 'CREATE_COMPLETE', outputs: {} };
    });

    const result = await createInstallExecutor(makeInstallDeps({ install }))(command);

    expect(result.success).toBe(true);
  });

  it('builds a collector at command start and threads it into install as onPoll', async () => {
    const fakeCollector = { poll: vi.fn(async () => {}), lastEventAt: () => null };
    const createStackEventCollector = vi.fn(() => fakeCollector);
    const install = vi.fn(async (options: { onPoll?: (stackName: string) => Promise<void> }) => {
      await options.onPoll?.('deployz-app');
      return { state: 'succeeded' as const, status: 'CREATE_COMPLETE', outputs: {} };
    });

    await createInstallExecutor(
      makeInstallDeps({ install, createStackEventCollector }),
    )(command);

    expect(createStackEventCollector).toHaveBeenCalledWith({
      commandId: 'cmd-1',
      operationStartedAt: '2026-08-26T12:00:00.000Z',
      stackName: 'deployz-app',
    });
    expect(fakeCollector.poll).toHaveBeenCalledWith('deployz-app');
  });

  it('writes the stack-events cursor into the pending marker when deferring, if the collector reported anything', async () => {
    const pending = memoryPendingStore();
    const fakeCollector = { poll: async () => {}, lastEventAt: () => '2026-08-26T12:00:03.000Z' };

    await createInstallExecutor(
      makeInstallDeps({
        pending,
        createStackEventCollector: () => fakeCollector,
        install: async () => ({ state: 'in-progress', status: 'CREATE_IN_PROGRESS' }),
      }),
    )(command);

    expect(await pending.read()).toMatchObject({
      stackEventsCursor: { lastEventAt: '2026-08-26T12:00:03.000Z' },
    });
  });

  it('omits the stack-events cursor on defer when the collector reported nothing', async () => {
    const pending = memoryPendingStore();
    const fakeCollector = { poll: async () => {}, lastEventAt: () => null };

    await createInstallExecutor(
      makeInstallDeps({
        pending,
        createStackEventCollector: () => fakeCollector,
        install: async () => ({ state: 'in-progress', status: 'CREATE_IN_PROGRESS' }),
      }),
    )(command);

    expect(await pending.read()).not.toHaveProperty('stackEventsCursor');
  });
});

describe('createInstallResumer', () => {
  // A resumed install's pending marker is always a COMPACTED payload
  // (compactPendingInstallPayload drops the manifest to fit SSM's size
  // limit) — so it carries the resolved `redisRequired`/`databaseRequired`
  // flags directly rather than a manifest object, matching production.
  const pendingRecord = {
    commandId: 'cmd-1',
    idempotencyKey: 'dep-1:INSTALL',
    type: 'INSTALL',
    stackName: 'deployz-app',
    startedAt: '2026-08-26T12:00:00.000Z',
    payload: {
      redisRequired: false,
      databaseRequired: true,
      templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/application-template-v1.json',
    },
  };

  function makeResumeDeps(overrides: Partial<InstallExecutorDeps> = {}): InstallExecutorDeps {
    return {
      installationId: 'inst-1',
      install: async () => ({ state: 'succeeded', status: 'CREATE_COMPLETE', outputs: {} }),
      verify: async () => ({ verified: true, checks: [] }),
      pending: memoryPendingStore(),
      now: () => '2026-08-26T12:05:00.000Z',
      ...overrides,
    };
  }

  it('reports nothing when no command is owed', async () => {
    await expect(createInstallResumer(makeResumeDeps())()).resolves.toEqual([]);
  });

  it('reports the finished result against the original command id', async () => {
    const pending = memoryPendingStore();
    await pending.write(pendingRecord);

    const results = await createInstallResumer(makeResumeDeps({ pending }))();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      commandId: 'cmd-1',
      idempotencyKey: 'dep-1:INSTALL',
      success: true,
    });
  });

  it('writes a settled marker once the result has been produced, and does not clear it', async () => {
    const pending = memoryPendingStore();
    await pending.write(pendingRecord);

    await createInstallResumer(makeResumeDeps({ pending }))();

    expect(await pending.read()).toMatchObject({
      commandId: 'cmd-1',
      phase: 'settled',
      result: { success: true },
    });
  });

  it('keeps waiting, and keeps the marker, while the stack is still creating', async () => {
    const pending = memoryPendingStore();
    await pending.write(pendingRecord);

    const results = await createInstallResumer(
      makeResumeDeps({
        pending,
        install: async () => ({ state: 'in-progress', status: 'CREATE_IN_PROGRESS' }),
      }),
    )();

    expect(results).toEqual([]);
    expect(await pending.read()).toEqual(pendingRecord);
  });

  it('resumes against the stack the original command targeted', async () => {
    const pending = memoryPendingStore();
    await pending.write({ ...pendingRecord, stackName: 'deployz-app-staging' });
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    await createInstallResumer(makeResumeDeps({ pending, install }))();

    expect(install.mock.calls[0]![0]).toMatchObject({ stackName: 'deployz-app-staging' });
  });

  it('carries the original payload into the resumed verification', async () => {
    const pending = memoryPendingStore();
    await pending.write({
      ...pendingRecord,
      payload: {
        redisRequired: true,
        databaseRequired: true,
        templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/application-template-v1.json',
      },
    });
    const verify = vi.fn(async () => ({ verified: true, checks: [] }));

    await createInstallResumer(makeResumeDeps({ pending, verify }))();

    expect(verify.mock.calls[0]![0]).toMatchObject({ redisRequired: true });
  });

  it('refuses cleanly, without any AWS call, when the compacted marker carries only redisRequired (no databaseRequired, no manifest)', async () => {
    const pending = memoryPendingStore();
    await pending.write({ ...pendingRecord, payload: { redisRequired: true } });
    const install = vi.fn();
    const verify = vi.fn();

    const results = await createInstallResumer(makeResumeDeps({ pending, install, verify }))();

    expect(install).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(await pending.read()).toMatchObject({
      commandId: 'cmd-1',
      phase: 'settled',
      result: { success: false, failureCode: 'STACK_CREATE_FAILED' },
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      commandId: 'cmd-1',
      idempotencyKey: 'dep-1:INSTALL',
      success: false,
      failureCode: 'STACK_CREATE_FAILED',
    });
    expect(results[0]!.error).toMatch(/manifest missing/i);
  });

  it('reports a failed stack against the original command id', async () => {
    const pending = memoryPendingStore();
    await pending.write(pendingRecord);

    const results = await createInstallResumer(
      makeResumeDeps({
        pending,
        install: async () => ({
          state: 'failed',
          status: 'ROLLBACK_COMPLETE',
          reason: 'rolled back',
          outputs: {},
        }),
      }),
    )();

    expect(results[0]).toMatchObject({
      commandId: 'cmd-1',
      success: false,
      failureCode: 'STACK_CREATE_FAILED',
    });
  });

  it('re-runs recovery on DELETE_FAILED for a recovery-arc install, keeping the pending record', async () => {
    const pending = memoryPendingStore();
    await pending.write({
      ...pendingRecord,
      payload: {
        recovery: { neverInstalled: true },
        redisRequired: false,
        databaseRequired: true,
        templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/application-template-v1.json',
      },
    });
    const recover = vi.fn(async () => ({
      phase: 'DELETE_IN_PROGRESS' as const,
      lastStackStatus: 'DELETE_IN_PROGRESS',
      orphansDeleted: ['db-1'],
    }));

    const results = await createInstallResumer(
      makeResumeDeps({
        pending,
        recover,
        install: async () => ({
          state: 'failed',
          status: 'DELETE_FAILED',
          reason: 'Stack "deployz-app" finished in DELETE_FAILED',
          outputs: {},
        }),
      }),
    )();

    // A DELETE_FAILED stack on a recovery arc is not the final answer — the
    // stuck delete this arc is driving needed another clearing pass.
    // Nothing is reported to the control plane yet, and the pending record
    // stays so the next poll can pick up from wherever recovery left off.
    expect(results).toEqual([]);
    expect(recover).toHaveBeenCalledWith('deployz-app');
    expect(await pending.read()).not.toBeNull();
  });

  it('writes a settled marker and reports failure when recovery itself gets stuck', async () => {
    const pending = memoryPendingStore();
    await pending.write({
      ...pendingRecord,
      payload: {
        recovery: { neverInstalled: true },
        redisRequired: false,
        databaseRequired: true,
        templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/application-template-v1.json',
      },
    });
    const recover = vi.fn(async () => ({
      phase: 'DELETE_STUCK' as const,
      lastStackStatus: 'DELETE_FAILED',
      orphansDeleted: [],
    }));

    const results = await createInstallResumer(
      makeResumeDeps({
        pending,
        recover,
        install: async () => ({
          state: 'failed',
          status: 'DELETE_FAILED',
          reason: 'Stack "deployz-app" finished in DELETE_FAILED',
          outputs: {},
        }),
      }),
    )();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      commandId: 'cmd-1',
      idempotencyKey: 'dep-1:INSTALL',
      success: false,
      failureCode: 'STACK_CREATE_FAILED',
    });
    expect(results[0]!.error).toContain('DELETE_FAILED');
    expect(await pending.read()).toMatchObject({
      commandId: 'cmd-1',
      phase: 'settled',
      result: { success: false, failureCode: 'STACK_CREATE_FAILED' },
    });
  });

  it('reports a DELETE_FAILED install as a plain failure when the install was not a recovery arc', async () => {
    const pending = memoryPendingStore();
    await pending.write(pendingRecord); // no `recovery.neverInstalled` flag on this payload
    const recover = vi.fn();

    const results = await createInstallResumer(
      makeResumeDeps({
        pending,
        recover,
        install: async () => ({
          state: 'failed',
          status: 'DELETE_FAILED',
          reason: 'Stack "deployz-app" finished in DELETE_FAILED',
          outputs: {},
        }),
      }),
    )();

    // Unchanged current behaviour: without a recovery arc to continue,
    // recover is never consulted and the stack's real status is reported.
    expect(recover).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      commandId: 'cmd-1',
      success: false,
      failureCode: 'STACK_CREATE_FAILED',
    });
    expect(await pending.read()).toMatchObject({
      commandId: 'cmd-1',
      phase: 'settled',
      result: { success: false, failureCode: 'STACK_CREATE_FAILED' },
    });
  });

  it('resumes the collector from the pending startedAt and cursor', async () => {
    const pending = memoryPendingStore();
    await pending.write({
      ...pendingRecord,
      stackEventsCursor: { lastEventAt: '2026-08-26T12:01:00.000Z' },
    });
    const createStackEventCollector = vi.fn(() => ({
      poll: async () => {},
      lastEventAt: () => null,
    }));

    await createInstallResumer(makeResumeDeps({ pending, createStackEventCollector }))();

    expect(createStackEventCollector).toHaveBeenCalledWith({
      commandId: 'cmd-1',
      operationStartedAt: pendingRecord.startedAt,
      stackName: pendingRecord.stackName,
      resumeAfter: '2026-08-26T12:01:00.000Z',
    });
  });

  it('resumes the collector with no resumeAfter when the pending marker predates the cursor field', async () => {
    const pending = memoryPendingStore();
    await pending.write(pendingRecord); // no stackEventsCursor — legacy marker
    const createStackEventCollector = vi.fn(() => ({
      poll: async () => {},
      lastEventAt: () => null,
    }));

    await createInstallResumer(makeResumeDeps({ pending, createStackEventCollector }))();

    expect(createStackEventCollector).toHaveBeenCalledWith({
      commandId: 'cmd-1',
      operationStartedAt: pendingRecord.startedAt,
      stackName: pendingRecord.stackName,
    });
  });

  it('resumes the collector against the overridden stack name the original command targeted', async () => {
    const pending = memoryPendingStore();
    await pending.write({ ...pendingRecord, stackName: 'deployz-app-staging' });
    const createStackEventCollector = vi.fn(() => ({
      poll: async () => {},
      lastEventAt: () => null,
    }));

    await createInstallResumer(makeResumeDeps({ pending, createStackEventCollector }))();

    expect(createStackEventCollector).toHaveBeenCalledWith({
      commandId: 'cmd-1',
      operationStartedAt: pendingRecord.startedAt,
      stackName: 'deployz-app-staging',
    });
  });

  it('rewrites the pending marker with the updated cursor when re-deferring', async () => {
    const pending = memoryPendingStore();
    await pending.write(pendingRecord);
    const createStackEventCollector = vi.fn(() => ({
      poll: async () => {},
      lastEventAt: () => '2026-08-26T12:07:00.000Z',
    }));

    await createInstallResumer(
      makeResumeDeps({
        pending,
        createStackEventCollector,
        install: async () => ({ state: 'in-progress', status: 'CREATE_IN_PROGRESS' }),
      }),
    )();

    expect(await pending.read()).toMatchObject({
      stackEventsCursor: { lastEventAt: '2026-08-26T12:07:00.000Z' },
    });
  });

  it('uses createMode resume for a normal resume and recovery for a recovery payload', async () => {
    const pending = memoryPendingStore();
    await pending.write(pendingRecord);
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    await createInstallResumer(makeResumeDeps({ pending, install }))();
    expect(install.mock.calls[0]![0]).toMatchObject({ createMode: 'resume' });

    const recoveryPending = memoryPendingStore();
    await recoveryPending.write({
      ...pendingRecord,
      payload: {
        recovery: { neverInstalled: true },
        redisRequired: false,
        databaseRequired: true,
        templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/application-template-v1.json',
      },
    });
    const recoveryInstall = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    await createInstallResumer(makeResumeDeps({ pending: recoveryPending, install: recoveryInstall }))();
    expect(recoveryInstall.mock.calls[0]![0]).toMatchObject({ createMode: 'recovery' });
  });

  it('clears the marker and never provisions when authority says the command is superseded', async () => {
    const pending = memoryPendingStore();
    await pending.write(pendingRecord);
    const install = vi.fn();
    const recover = vi.fn();
    const checkAuthority = vi.fn(async () => false);

    const results = await createInstallResumer(
      makeResumeDeps({ pending, install, recover, checkAuthority }),
    )();

    expect(results).toEqual([]);
    expect(checkAuthority).toHaveBeenCalledWith('cmd-1');
    expect(install).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(await pending.read()).toBeNull();
  });

  it('keeps the marker and never mutates when authority is unknown', async () => {
    const pending = memoryPendingStore();
    await pending.write(pendingRecord);
    const install = vi.fn();
    const checkAuthority = vi.fn(async () => null);
    const compareAndSet = vi.fn(pending.compareAndSet.bind(pending));

    const results = await createInstallResumer(
      makeResumeDeps({ pending: { ...pending, compareAndSet }, install, checkAuthority }),
    )();

    expect(results).toEqual([]);
    expect(install).not.toHaveBeenCalled();
    expect(compareAndSet).not.toHaveBeenCalled();
    expect(await pending.read()).toEqual(pendingRecord);
  });

  it('returns the stored settled result on a second resume without provisioning again', async () => {
    const pending = memoryPendingStore();
    await pending.write(pendingRecord);
    const firstInstall = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    const first = await createInstallResumer(makeResumeDeps({ pending, install: firstInstall }))();
    expect(first[0]).toMatchObject({ success: true });

    const secondInstall = vi.fn();
    const second = await createInstallResumer(makeResumeDeps({ pending, install: secondInstall }))();

    expect(secondInstall).not.toHaveBeenCalled();
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ commandId: 'cmd-1', success: true });
  });
});

describe('createInstallExecutor — authority and settled markers', () => {
  const command = {
    id: 'cmd-1',
    deploymentId: 'dep-1',
    type: 'INSTALL' as const,
    idempotencyKey: 'dep-1:INSTALL',
    payload: {
      redisRequired: false,
      databaseRequired: true,
      templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/application-template-v1.json',
    },
  };

  function makeDeps(overrides: Partial<InstallExecutorDeps> = {}): InstallExecutorDeps {
    return {
      installationId: 'inst-1',
      install: async () => ({ state: 'succeeded', status: 'CREATE_COMPLETE', outputs: {} }),
      verify: async () => ({ verified: true, checks: [] }),
      pending: memoryPendingStore(),
      now: () => '2026-08-26T12:00:00.000Z',
      ...overrides,
    };
  }

  it('returns the stored settled result for the same command without provisioning', async () => {
    const pending = memoryPendingStore();
    await pending.write({
      commandId: 'cmd-1',
      idempotencyKey: 'dep-1:INSTALL',
      type: 'INSTALL',
      stackName: 'deployz-app',
      startedAt: '2026-08-26T12:00:00.000Z',
      payload: command.payload,
      phase: 'settled',
      result: { success: true, output: { executed: true, type: 'INSTALL' } },
      settledAt: '2026-08-26T12:05:00.000Z',
    });
    const install = vi.fn();

    const result = await createInstallExecutor(makeDeps({ pending, install }))(command);

    expect(install).not.toHaveBeenCalled();
    expect(result).toMatchObject({ commandId: 'cmd-1', success: true, output: { executed: true } });
  });

  it('does not provision and fails when authority says the command is no longer active', async () => {
    const install = vi.fn();
    const checkAuthority = vi.fn(async () => false);

    const result = await createInstallExecutor(makeDeps({ install, checkAuthority }))(command);

    expect(install).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, failureCode: 'STACK_CREATE_FAILED' });
    expect(result.error).toContain('no longer active');
  });

  it('defers without provisioning when authority is unknown, recording the marker', async () => {
    const pending = memoryPendingStore();
    const install = vi.fn();
    const checkAuthority = vi.fn(async () => null);

    const result = await createInstallExecutor(makeDeps({ pending, install, checkAuthority }))(command);

    expect(install).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, deferred: true });
    expect(await pending.read()).toMatchObject({ commandId: 'cmd-1' });
  });

  it('passes createMode fresh for a normal create and recovery for a recovery payload', async () => {
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    await createInstallExecutor(makeDeps({ install }))(command);
    expect(install.mock.calls[0]![0]).toMatchObject({ createMode: 'fresh' });

    const recoveryInstall = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));
    await createInstallExecutor(makeDeps({ install: recoveryInstall }))({
      ...command,
      payload: { ...command.payload, recovery: { neverInstalled: true } },
    });
    expect(recoveryInstall.mock.calls[0]![0]).toMatchObject({ createMode: 'recovery' });
  });
});

describe('fetchCommandAuthority', () => {
  function respond(status: number, body: unknown): FetchFn {
    return async () => ({ status, headers: { get: () => null }, json: async () => body });
  }

  it('maps a 200 active body to true', async () => {
    await expect(
      fetchCommandAuthority(respond(200, { active: true, jobState: 'RUNNING' }), 'https://cp', {}, 'cmd-1'),
    ).resolves.toBe(true);
  });

  it('maps a 200 inactive body to false', async () => {
    await expect(
      fetchCommandAuthority(respond(200, { active: false, jobState: 'CANCELLED' }), 'https://cp', {}, 'cmd-1'),
    ).resolves.toBe(false);
  });

  it('maps a 404 to null', async () => {
    await expect(fetchCommandAuthority(respond(404, {}), 'https://cp', {}, 'cmd-1')).resolves.toBeNull();
  });

  it('maps a 500 to null', async () => {
    await expect(fetchCommandAuthority(respond(500, {}), 'https://cp', {}, 'cmd-1')).resolves.toBeNull();
  });

  it('maps a network failure to null', async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error('ECONNRESET');
    };

    await expect(fetchCommandAuthority(fetchFn, 'https://cp', {}, 'cmd-1')).resolves.toBeNull();
  });

  it('maps an unparseable 200 body to null', async () => {
    const fetchFn: FetchFn = async () => ({
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new Error('bad json');
      },
    });

    await expect(fetchCommandAuthority(fetchFn, 'https://cp', {}, 'cmd-1')).resolves.toBeNull();
  });

  it('builds the authority URL and passes the auth headers', async () => {
    const requests: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetchFn: FetchFn = async (url, init) => {
      requests.push({ url, headers: init?.headers });
      return { status: 200, headers: { get: () => null }, json: async () => ({ active: true }) };
    };

    await fetchCommandAuthority(fetchFn, 'https://api.deployz.dev', { Authorization: 'Bearer t' }, 'cmd-1');

    expect(requests[0]?.url).toBe('https://api.deployz.dev/api/relay/commands/cmd-1/authority');
    expect(requests[0]?.headers).toMatchObject({ Authorization: 'Bearer t' });
  });
});

// The control plane compiles the application template (compiler-v2) and
// sends the frozen artifact's URL in the INSTALL payload. `settleInstall` —
// shared by `createInstallExecutor` and `createInstallResumer` — must execute
// exactly that URL: no profile-based variant resolution, no env fallback,
// and the same URL on retries and resumed installs.
describe('settleInstall executes exactly the templateUrl the payload carries', () => {
  const command = {
    id: 'cmd-1',
    deploymentId: 'dep-1',
    type: 'INSTALL' as const,
    idempotencyKey: 'dep-1:INSTALL',
    payload: {},
  };

  const ARTIFACT_URL =
    'https://bucket.s3.us-east-1.amazonaws.com/application/v1/compiled-template.json';

  function makeInstallDeps(overrides: Partial<InstallExecutorDeps> = {}): InstallExecutorDeps {
    return {
      installationId: 'inst-1',
      install: async () => ({ state: 'succeeded', status: 'CREATE_COMPLETE', outputs: {} }),
      verify: async () => ({ verified: true, checks: [] }),
      pending: memoryPendingStore(),
      now: () => '2026-08-26T12:00:00.000Z',
      ...overrides,
    };
  }

  // Phase 2: infrastructure requirements are never guessed. A payload with
  // neither a manifest nor pre-resolved requirement flags must refuse to
  // provision rather than silently default to postgres-only (the removed
  // legacy behavior).
  it('fails fast, without installing, when neither a manifest nor requirement flags are present', async () => {
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));
    const pending = memoryPendingStore();

    const result = await createInstallExecutor(makeInstallDeps({ install, pending }))(command);

    expect(install).not.toHaveBeenCalled();
    expect(await pending.read()).toMatchObject({ phase: 'settled' });
    expect(result.success).toBe(false);
    expect(result.deferred).toBeUndefined();
    expect(result.error).toMatch(/manifest missing/i);
  });

  // A RESUMED install's compacted pending marker (compactPendingInstallPayload)
  // carries these flags without a manifest object — `createInstallExecutor`
  // and `createInstallResumer` share `settleInstall`, so a fresh payload
  // shaped the same way exercises the identical, still-supported path.
  it('installs the payload artifact for a flags-only payload (resumed-marker shape)', async () => {
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    await createInstallExecutor(makeInstallDeps({ install }))({
      ...command,
      payload: {
        redisRequired: true,
        databaseRequired: true,
        templateUrl: ARTIFACT_URL,
        parameters: { paramAppApiKey: 'k' },
      },
    });

    expect(install.mock.calls[0]![0]).toMatchObject({
      templateUrl: ARTIFACT_URL,
      parameters: { paramAppApiKey: 'k' },
      stackName: 'deployz-app',
    });
  });

  // Even with a manifest that once selected a profile variant, the payload's
  // artifact URL wins — template selection now happens in the control
  // plane's compiler, never in the relay.
  it('installs the payload artifact even when a manifest is present', async () => {
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    await createInstallExecutor(makeInstallDeps({ install }))({
      ...command,
      payload: {
        templateUrl: ARTIFACT_URL,
        manifest: manifestPayload({ redis: { required: true, envBindings: [] } }),
      },
    });

    expect(install.mock.calls[0]![0]).toMatchObject({ templateUrl: ARTIFACT_URL });
  });

  it('fails fast when the manifest is present but invalid', async () => {
    const install = vi.fn();
    const pending = memoryPendingStore();

    const result = await createInstallExecutor(
      makeInstallDeps({ install, pending }),
    )({
      ...command,
      payload: { manifest: { database: { postgres: 'yes' }, redis: { required: false } } },
    });

    expect(install).not.toHaveBeenCalled();
    expect(await pending.read()).toMatchObject({ phase: 'settled' });
    expect(result.success).toBe(false);
    expect(result.deferred).toBeUndefined();
    expect(result.error).toMatch(/invalid deployment manifest/i);
  });

  it('re-creates the stack with the same templateUrl when a deferred install resumes', async () => {
    const pending = memoryPendingStore();
    await pending.write({
      commandId: 'cmd-1',
      idempotencyKey: 'dep-1:INSTALL',
      type: 'INSTALL',
      stackName: 'deployz-app',
      startedAt: '2026-08-26T12:00:00.000Z',
      payload: {
        redisRequired: true,
        databaseRequired: true,
        templateUrl: ARTIFACT_URL,
      },
    });
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    const results = await createInstallResumer(makeInstallDeps({ pending, install }))();

    expect(install.mock.calls[0]![0]).toMatchObject({ templateUrl: ARTIFACT_URL });
    expect(results[0]).toMatchObject({ commandId: 'cmd-1', success: true });
  });
});

describe('readInstallParametersFromPayload', () => {
  it('forwards string parameters the control plane supplied', () => {
    expect(
      readInstallParametersFromPayload({
        parameters: { paramAppApiKey: 'k', paramAppSigningSecret: 's' },
      }),
    ).toEqual({ paramAppApiKey: 'k', paramAppSigningSecret: 's' });
  });

  it('is empty when the payload carries no parameters', () => {
    expect(readInstallParametersFromPayload({})).toEqual({});
  });

  it('drops non-string values rather than sending them to CloudFormation', () => {
    // Every CloudFormation parameter value is a string. A number or an
    // object here is a control-plane bug, and passing it through would
    // surface as an opaque ValidationError mid-install.
    expect(
      readInstallParametersFromPayload({ parameters: { a: 'ok', b: 7, c: null } }),
    ).toEqual({ a: 'ok' });
  });

  it('ignores a parameters field that is not an object', () => {
    expect(readInstallParametersFromPayload({ parameters: 'nope' })).toEqual({});
  });
});

describe('readDeploymentTagsFromPayload', () => {
  it('forwards the control plane string tags', () => {
    expect(
      readDeploymentTagsFromPayload({
        tags: { 'deployz:managed-by': 'deployz', 'deployz:deployment-id': 'dep-1' },
      }),
    ).toEqual({ 'deployz:managed-by': 'deployz', 'deployz:deployment-id': 'dep-1' });
  });

  it('is undefined when the payload carries no tags (older control planes)', () => {
    expect(readDeploymentTagsFromPayload({})).toBeUndefined();
  });

  it('drops empty-string keys and values and non-string entries', () => {
    expect(
      readDeploymentTagsFromPayload({ tags: { 'deployz:environment': 'production', '': 'x', empty: '', n: 7 } }),
    ).toEqual({ 'deployz:environment': 'production' });
  });

  it('is undefined for a tags field that is not a plain object', () => {
    expect(readDeploymentTagsFromPayload({ tags: 'nope' })).toBeUndefined();
    expect(readDeploymentTagsFromPayload({ tags: ['nope'] })).toBeUndefined();
  });
});

// ── Phase 2: the canonical manifest rides the INSTALL payload ───────────────

function manifestPayload(overrides: Record<string, unknown> = {}) {
  return {
    application: { root: '.', runtime: 'node', framework: 'express', dockerfilePath: 'Dockerfile' },
    build: { command: 'npm run build', context: '.' },
    web: { command: 'node server.js', port: 8080 },
    health: { path: '/api/health' },
    database: { postgres: true },
    redis: {
      required: true,
      envBindings: [
        { name: 'REDIS_URL', kind: 'url' },
        { name: 'REDIS_HOST', kind: 'host' },
        { name: 'REDIS_PORT', kind: 'port' },
      ],
    },
    storage: { required: true, envBindings: [{ name: 'AWS_S3_BUCKET', kind: 'bucket' }] },
    migration: { command: 'npm run migrate' },
    worker: { command: null },
    environment: { variables: [{ key: 'LOG_LEVEL', required: false, secret: false, source: [] }] },
    externalServices: [],
    unsupported: [],
    ...overrides,
  };
}

describe('readDeploymentManifest', () => {
  it('returns the validated manifest from the payload', () => {
    const manifest = readDeploymentManifest({ manifest: manifestPayload() });
    expect(manifest?.web.port).toBe(8080);
    expect(manifest?.health.path).toBe('/api/health');
  });

  it('returns null when the payload carries no manifest', () => {
    expect(readDeploymentManifest({})).toBeNull();
  });

  it('rejects a manifest that violates the contracts schema', () => {
    expect(readDeploymentManifest({ manifest: { application: {} } })).toBeNull();
  });
});

describe('settleInstall derives parameters from the manifest', () => {
  const command = {
    id: 'cmd-manifest',
    deploymentId: 'dep-1',
    type: 'INSTALL' as const,
    idempotencyKey: 'dep-1:INSTALL:manifest',
    payload: {},
  };

  const ARTIFACT_URL =
    'https://bucket.s3.us-east-1.amazonaws.com/application/v1/compiled-template.json';

  function makeInstallDeps(install: ReturnType<typeof vi.fn>): InstallExecutorDeps {
    return {
      installationId: 'inst-1',
      install,
      verify: async () => ({ verified: true, checks: [] }),
      pending: memoryPendingStore(),
      now: () => '2026-08-26T12:00:00.000Z',
    };
  }

  it('sends manifest-derived port/health parameters, with manifest winning over the ad-hoc control-plane value', async () => {
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    await createInstallExecutor(makeInstallDeps(install))({
      ...command,
      payload: {
        templateUrl: ARTIFACT_URL,
        // The legacy path still sent a health path resolved from the ad-hoc
        // column — the manifest's canonical path must win over it.
        parameters: { paramHealthCheckPath: '/legacy', paramAppApiKey: 'k' },
        manifest: manifestPayload(),
      },
    });

    expect(install.mock.calls[0]![0]).toMatchObject({
      templateUrl: ARTIFACT_URL,
      parameters: {
        paramHealthCheckPath: '/api/health',
        paramContainerPort: '8080',
        paramAppApiKey: 'k',
      },
    });
  });

  it('passes the payload deployment tags through to the install call', async () => {
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    await createInstallExecutor(makeInstallDeps(install))({
      ...command,
      payload: {
        templateUrl: ARTIFACT_URL,
        manifest: manifestPayload(),
        tags: { 'deployz:managed-by': 'deployz', 'deployz:deployment-id': 'dep-1' },
      },
    });

    expect(install.mock.calls[0]![0]).toMatchObject({
      deploymentTags: { 'deployz:managed-by': 'deployz', 'deployz:deployment-id': 'dep-1' },
    });
  });

  it('falls back to the top-level redisRequired/databaseRequired flags when the payload has no manifest', async () => {
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    await createInstallExecutor(makeInstallDeps(install))({
      ...command,
      payload: {
        redisRequired: true,
        databaseRequired: true,
        templateUrl: ARTIFACT_URL,
      },
    });

    expect(install.mock.calls[0]![0]).toMatchObject({
      templateUrl: ARTIFACT_URL,
      parameters: {},
    });
  });

  // The control plane sends the Documenso-preset secrets on every install
  // (install-parameters.ts) because it does not know which template the
  // relay will use; a template that does not declare them makes
  // CloudFormation refuse the whole CreateStack. The relay is the one that
  // knows the template, so it drops what the template does not declare.
  it('drops parameters the application template does not declare, and keeps the ones it does', async () => {
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));
    const readTemplateParameters = vi.fn(
      async () => new Set(['paramContainerPort', 'paramHealthCheckPath', 'paramAppApiKey']),
    );

    await createInstallExecutor({ ...makeInstallDeps(install), readTemplateParameters })({
      ...command,
      payload: {
        templateUrl: ARTIFACT_URL,
        parameters: {
          paramAppApiKey: 'k',
          paramNextauthSecret: 'documenso-only',
          paramEncryptionKey: 'documenso-only',
        },
        manifest: manifestPayload(),
      },
    });

    // Read from the artifact URL CloudFormation will actually fetch.
    expect(readTemplateParameters).toHaveBeenCalledWith(ARTIFACT_URL);
    expect(install.mock.calls[0]![0]!.parameters).toEqual({
      paramAppApiKey: 'k',
      paramContainerPort: '8080',
      paramHealthCheckPath: '/api/health',
    });
  });

  it('passes every parameter through unchanged when the template cannot be read', async () => {
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    await createInstallExecutor({ ...makeInstallDeps(install), readTemplateParameters: async () => null })({
      ...command,
      payload: {
        templateUrl: ARTIFACT_URL,
        parameters: { paramAppApiKey: 'k', paramNextauthSecret: 's' },
        redisRequired: false,
        databaseRequired: true,
      },
    });

    expect(install.mock.calls[0]![0]!.parameters).toEqual({ paramAppApiKey: 'k', paramNextauthSecret: 's' });
  });

  // The connector's execution role refuses an IAM role without the
  // application role boundary, so the relay passes it to every template.
  it("passes the connector's role boundary to a template that declares it", async () => {
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    await createInstallExecutor({
      ...makeInstallDeps(install),
      roleBoundaryArn: 'arn:aws:iam::123456789012:policy/deployz/Boundary',
      readTemplateParameters: async () => new Set(['paramAppApiKey', 'paramRoleBoundaryArn']),
    })({
      ...command,
      payload: {
        templateUrl: ARTIFACT_URL,
        parameters: { paramAppApiKey: 'k' },
        redisRequired: false,
        databaseRequired: false,
      },
    });

    expect(install.mock.calls[0]![0]!.parameters).toEqual({
      paramAppApiKey: 'k',
      paramRoleBoundaryArn: 'arn:aws:iam::123456789012:policy/deployz/Boundary',
    });
  });

  it('refuses, before CreateStack, a template compiled before the role boundary', async () => {
    const install = vi.fn();

    const result = await createInstallExecutor({
      ...makeInstallDeps(install),
      roleBoundaryArn: 'arn:aws:iam::123456789012:policy/deployz/Boundary',
      readTemplateParameters: async () => new Set(['paramAppApiKey']),
    })({
      ...command,
      payload: {
        templateUrl: ARTIFACT_URL,
        parameters: { paramAppApiKey: 'k' },
        redisRequired: false,
        databaseRequired: false,
      },
    });

    expect(install).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false });
    expect(String((result as { error?: unknown }).error)).toContain('predates the IAM role boundary');
  });
});

describe('readTemplateParameterNames', () => {
  const fetchTemplate = (status: number, body: unknown) => async () => ({
    status,
    headers: { get: () => null },
    json: async () => body,
  });

  it('reads the declared parameter names from the published template', async () => {
    const names = await readTemplateParameterNames(
      fetchTemplate(200, { Parameters: { paramContainerPort: { Type: 'String' }, BootstrapVersion: {} } }),
      'https://bucket.s3.us-east-1.amazonaws.com/t.json',
    );
    expect([...(names ?? [])].sort()).toEqual(['BootstrapVersion', 'paramContainerPort']);
  });

  it('is null — keep the pass-through — when the template is unreachable, not JSON, or has no Parameters', async () => {
    expect(await readTemplateParameterNames(fetchTemplate(403, {}), 'u')).toBeNull();
    expect(await readTemplateParameterNames(fetchTemplate(200, { Resources: {} }), 'u')).toBeNull();
    expect(await readTemplateParameterNames(fetchTemplate(200, { Parameters: ['x'] }), 'u')).toBeNull();
    expect(
      await readTemplateParameterNames(async () => {
        throw new Error('ECONNRESET');
      }, 'u'),
    ).toBeNull();
  });
});

// A payload built with a manifest of production size (CANARY-005): the
// canonical manifest measured 15,946 characters on a real AWS install, well
// past SSM's 4096-character Standard-tier limit. `environment.variables` is
// the field that scales with the app, so that is what is padded here.
function bigManifestPayload() {
  return manifestPayload({
    environment: {
      variables: Array.from({ length: 141 }, (_, i) => ({
        key: `ENV_VARIABLE_NUMBER_${i}`,
        required: false,
        secret: false,
        source: [`app/src/config/settings-${i}.ts`],
      })),
    },
  });
}

describe('compactPendingInstallPayload', () => {
  it('drops the manifest, merges the manifest-derived parameters, and resolves redisRequired/databaseRequired from the manifest', () => {
    const manifest = bigManifestPayload();
    const payload = {
      parameters: { paramHealthCheckPath: '/legacy', paramAppApiKey: 'k' },
      redisRequired: undefined,
      manifest,
    };
    expect(JSON.stringify(payload).length).toBeGreaterThan(4096);

    const compacted = compactPendingInstallPayload(payload);

    expect(compacted).not.toHaveProperty('manifest');
    expect(compacted['parameters']).toMatchObject({
      paramAppApiKey: 'k',
      paramContainerPort: '8080',
      paramHealthCheckPath: '/api/health', // the manifest wins over the ad-hoc value
    });
    expect(compacted['redisRequired']).toBe(true);
    expect(compacted['databaseRequired']).toBe(true); // manifest has postgres: true

    const marker = {
      commandId: 'cmd-1',
      idempotencyKey: 'dep-1:INSTALL',
      type: 'INSTALL',
      stackName: 'deployz-app',
      startedAt: '2026-09-02T12:00:00.000Z',
      payload: compacted,
    };
    expect(JSON.stringify(marker).length).toBeLessThan(4096);
  });

  it('keeps every other payload field as-is', () => {
    const compacted = compactPendingInstallPayload({
      stackName: 'deployz-app-staging',
      templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/application/v1/compiled-template.json',
      recovery: { neverInstalled: true },
    });

    expect(compacted).toMatchObject({
      stackName: 'deployz-app-staging',
      templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/application/v1/compiled-template.json',
      recovery: { neverInstalled: true },
    });
  });
});

describe('createInstallExecutor / createInstallResumer with a production-size manifest payload', () => {
  const command = {
    id: 'cmd-manifest-defer',
    deploymentId: 'dep-1',
    type: 'INSTALL' as const,
    idempotencyKey: 'dep-1:INSTALL',
    payload: {},
  };

  function makeInstallDeps(overrides: Partial<InstallExecutorDeps> = {}): InstallExecutorDeps {
    return {
      installationId: 'inst-1',
      install: async () => ({ state: 'succeeded', status: 'CREATE_COMPLETE', outputs: {} }),
      verify: async () => ({ verified: true, checks: [] }),
      pending: memoryPendingStore(),
      now: () => '2026-09-02T12:00:00.000Z',
      ...overrides,
    };
  }

  it('defers past the watch budget without writing the manifest into the pending marker, then resumes to the same template and parameters', async () => {
    const pending = memoryPendingStore();
    const manifest = bigManifestPayload();
    const bigPayload = {
      templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/application/v1/compiled-template.json',
      parameters: { paramAppApiKey: 'k' },
      manifest,
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // First attempt: CloudFormation is still creating when the invocation's
    // watch budget runs out — the fake installer stands in for that budget.
    const install = vi.fn(async () => ({ state: 'in-progress' as const, status: 'CREATE_IN_PROGRESS' }));
    const deferResult = await createInstallExecutor(makeInstallDeps({ pending, install }))({
      ...command,
      payload: bigPayload,
    });

    expect(deferResult.deferred).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"relay:command-deferred"'),
    );

    const marker = await pending.read();
    expect(marker?.payload).not.toHaveProperty('manifest');
    expect(JSON.stringify(marker).length).toBeLessThan(4096);

    // Resume: the marker alone (no manifest) must carry the same
    // templateUrl, the same merged parameters, and the same
    // databaseRequired that the first attempt resolved.
    const resumeInstall = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));
    await createInstallResumer(makeInstallDeps({ pending, install: resumeInstall }))();

    expect(resumeInstall.mock.calls[0]![0]).toMatchObject({
      templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/application/v1/compiled-template.json',
      parameters: {
        paramAppApiKey: 'k',
        paramContainerPort: '8080',
        paramHealthCheckPath: '/api/health',
      },
    });

    logSpy.mockRestore();
  });

  it('preserves databaseRequired:false in the compacted payload when the manifest has postgres:false', async () => {
    const manifest = manifestPayload({ database: { postgres: false }, redis: { required: false, envBindings: [] } });
    const compacted = compactPendingInstallPayload({
      parameters: { paramAppApiKey: 'k' },
      manifest,
    });

    expect(compacted['databaseRequired']).toBe(false);
    expect(compacted['redisRequired']).toBe(false);
  });
});

// ── Retried INSTALL: failure → cleanup → retry → successful install ─────────

/**
 * State-machine actor for the recovery arc: starts at `initial`; the first
 * delete leaves DELETE_FAILED (the retained DB blocks it); the second delete
 * lands on `secondDelete` (DELETE_COMPLETE means the stack is GONE — lookups
 * stop finding it).
 */
function arcActor(
  initial: string,
  secondDelete: 'DELETE_COMPLETE' | 'DELETE_FAILED' = 'DELETE_COMPLETE',
): RecoveryCloudFormation & { deleteCalls: string[] } {
  const deleteCalls: string[] = [];
  let status = initial;

  return {
    deleteCalls,
    async describeStack(): Promise<StackLookup> {
      if (status === 'DELETE_COMPLETE') {
        return { found: false, errorCode: 'ValidationError' };
      }
      return {
        found: true,
        stack: { stackName: 'deployz-app', status, tags: { 'deployz:installation': 'inst-1' } },
      };
    },
    async describeStackResources(): Promise<PhysicalStackResource[]> {
      return [
        {
          logicalId: 'Database',
          type: 'AWS::RDS::DBInstance',
          status: 'CREATE_COMPLETE',
          physicalId: 'arc-db',
        },
      ];
    },
    async deleteStack(stackName) {
      deleteCalls.push(stackName);
      status = deleteCalls.length === 1 ? 'DELETE_FAILED' : secondDelete;
    },
  };
}

function makeRdsFake(): RdsCleanupClient & { unprotected: string[]; deleted: string[] } {
  const unprotected: string[] = [];
  const deleted: string[] = [];
  return {
    unprotected,
    deleted,
    async disableDeletionProtection(id) {
      unprotected.push(id);
    },
    async deleteInstance(id) {
      deleted.push(id);
    },
  };
}

const ARC_NO_SLEEP = { pollIntervalMs: 0, maxAttempts: 3, sleep: async () => {} };

function makeRecoveryDeps(
  installDeps: Partial<InstallExecutorDeps>,
  recoverDeps: { actor: RecoveryCloudFormation; rds?: RdsCleanupClient },
): InstallExecutorDeps {
  return {
    installationId: 'inst-1',
    install: async () => ({ state: 'succeeded', status: 'CREATE_COMPLETE', outputs: {} }),
    verify: async () => ({ verified: true, checks: [] }),
    pending: memoryPendingStore(),
    ...(recoverDeps.rds
      ? {
          recover: (stackName: string) =>
            recoverFailedInstallStack(
              {
                cfn: recoverDeps.actor,
                rds: recoverDeps.rds,
                wait: ARC_NO_SLEEP,
              },
              { stackName },
            ),
        }
      : {}),
    ...installDeps,
  };
}

describe('createInstallExecutor — recovery arc', () => {
  // The real retry-install route always attaches a manifest (buildInstallPayload,
  // apps/api/src/install-config.ts) — the flags stand in for it here, the
  // same shape a resumed/compacted marker would carry.
  const retryCommand = {
    id: 'job-retry-1',
    deploymentId: 'dep-retry',
    type: 'INSTALL' as const,
    idempotencyKey: 'dep-retry:INSTALL:RETRY:1',
    payload: {
      recovery: { neverInstalled: true },
      redisRequired: false,
      databaseRequired: true,
      templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/application-template-v1.json',
    },
  };

  it('recovers a bricked stack, recreates it, and verifies: failure → cleanup → retry → healthy', async () => {
    const actor = arcActor('ROLLBACK_COMPLETE');
    const rds = makeRdsFake();
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    const result = await createInstallExecutor(
      makeRecoveryDeps({ install }, { actor, rds }),
    )(retryCommand);

    expect(result.success).toBe(true);
    expect(actor.deleteCalls).toEqual(['deployz-app', 'deployz-app']);
    // Orphans are cleared proactively before the first delete attempt, and
    // again (harmlessly, on this fake) as the fallback retry once that
    // first attempt still lands on DELETE_FAILED — two clearing passes.
    expect(rds.unprotected).toEqual(['arc-db', 'arc-db']);
    expect(rds.deleted).toEqual(['arc-db', 'arc-db']);
    expect(install).toHaveBeenCalledOnce();
    // The report itself de-duplicates: one orphan, cleared, reported once.
    expect(result.output).toMatchObject({
      recovery: { phase: 'BLOCKERS_CLEARED_STACK_GONE', orphansDeleted: ['arc-db'] },
    });
  });

  it('reports an honest failure and deletes nothing when no recovery is requested', async () => {
    const actor = arcActor('ROLLBACK_COMPLETE');
    const rds = makeRdsFake();

    const result = await createInstallExecutor(
      makeRecoveryDeps(
        {
          install: async () => ({
            state: 'failed' as const,
            status: 'ROLLBACK_COMPLETE',
            reason: 'Stack "deployz-app" finished in ROLLBACK_COMPLETE',
            outputs: {},
          }),
        },
        { actor, rds },
      ),
    )({ ...retryCommand, payload: {
      redisRequired: false,
      databaseRequired: true,
      templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/application-template-v1.json',
    } });

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_CREATE_FAILED');
    expect(result.error).toContain('ROLLBACK_COMPLETE');
    expect(actor.deleteCalls).toHaveLength(0);
    expect(rds.deleted).toHaveLength(0);
    expect(result.output).not.toHaveProperty('recovery');
  });

  it('falls through honestly when recovery refuses a live stack', async () => {
    const actor = arcActor('CREATE_COMPLETE');
    const rds = makeRdsFake();

    const result = await createInstallExecutor(
      makeRecoveryDeps(
        {
          install: async () => ({
            state: 'succeeded' as const,
            status: 'CREATE_COMPLETE',
            outputs: {},
          }),
        },
        { actor, rds },
      ),
    )(retryCommand);

    expect(result.success).toBe(true);
    expect(actor.deleteCalls).toHaveLength(0);
    expect(rds.deleted).toHaveLength(0);
    expect(result.output).toMatchObject({ recovery: { phase: 'REFUSED_LIVE_STACK' } });
  });

  it('returns the recovery report when the stack stays stuck after cleanup', async () => {
    const actor = arcActor('DELETE_FAILED', 'DELETE_FAILED');
    const rds = makeRdsFake();

    const result = await createInstallExecutor(
      makeRecoveryDeps(
        {
          install: async () => ({
            state: 'failed' as const,
            status: 'DELETE_FAILED',
            reason: 'Stack "deployz-app" finished in DELETE_FAILED',
            outputs: {},
          }),
        },
        { actor, rds },
      ),
    )(retryCommand);

    expect(result.success).toBe(false);
    expect(result.output).toMatchObject({ recovery: { phase: 'DELETE_STUCK' } });
  });

  it('skips recovery entirely when no recover seam is wired', async () => {
    const actor = arcActor('ROLLBACK_COMPLETE');

    const result = await createInstallExecutor(
      makeRecoveryDeps(
        {
          install: async () => ({
            state: 'failed' as const,
            status: 'ROLLBACK_COMPLETE',
            reason: 'Stack "deployz-app" finished in ROLLBACK_COMPLETE',
            outputs: {},
          }),
        },
        { actor },
      ),
    )(retryCommand);

    expect(result.success).toBe(false);
    expect(actor.deleteCalls).toHaveLength(0);
    expect(result.output).not.toHaveProperty('recovery');
  });
});

describe('Stage B phase 2 — post-install binding-alias registration', () => {
  const command = {
    id: 'cmd-alias',
    deploymentId: 'dep-1',
    type: 'INSTALL' as const,
    idempotencyKey: 'dep-1:INSTALL',
    payload: {},
  };

  function makeAliasDeps(overrides: Partial<InstallExecutorDeps> = {}): InstallExecutorDeps {
    return {
      installationId: 'inst-1',
      install: async () => ({ state: 'succeeded', status: 'CREATE_COMPLETE', outputs: {} }),
      verify: async () => ({ verified: true, checks: [] }),
      pending: memoryPendingStore(),
      now: () => '2026-09-04T12:00:00.000Z',
      ...overrides,
    };
  }

  const aliasManifest = manifestPayload({
    database: {
      postgres: true,
      envBindings: [
        { name: 'DATABASE_URL', kind: 'url' },
        { name: 'MEMOS_DSN', kind: 'url' },
        { name: 'PAPERLESS_DBHOST', kind: 'host' },
        { name: 'PAPERLESS_DBPORT', kind: 'port' },
        { name: 'PAPERLESS_DBPASS', kind: 'password' },
      ],
    },
  });

  it('registers the manifest binding aliases after a verified install', async () => {
    const applyBindingAliases = vi.fn(async () => ({ state: 'applied' }));

    const result = await createInstallExecutor(makeAliasDeps({ applyBindingAliases }))({
      ...command,
      payload: {
        templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/application-template-v1.json',
        manifest: aliasManifest,
      },
    });

    expect(result.success).toBe(true);
    expect(applyBindingAliases).toHaveBeenCalledWith(
      expect.objectContaining({
        aliases: expect.arrayContaining([
          { resource: 'postgres', name: 'MEMOS_DSN', kind: 'url' },
          { resource: 'postgres', name: 'PAPERLESS_DBHOST', kind: 'host' },
          { resource: 'postgres', name: 'PAPERLESS_DBPASS', kind: 'password' },
        ]),
      }),
    );
  });

  it('re-applies the persisted alias list when a deferred install resumes', async () => {
    const pending = memoryPendingStore();
    const firstInstall = vi.fn(async () => ({
      state: 'in-progress' as const,
      status: 'CREATE_IN_PROGRESS',
    }));

    const first = await createInstallExecutor(makeAliasDeps({ pending, install: firstInstall }))({
      ...command,
      payload: {
        templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/application-template-v1.json',
        manifest: aliasManifest,
      },
    });
    expect(first.deferred).toBe(true);

    // The marker carries the compact alias list, never the full manifest.
    const marker = await pending.read();
    expect(marker?.payload).not.toHaveProperty('manifest');
    const compactedAliases = (marker?.payload as Record<string, unknown>)?.['bindingAliases'] as
      | Array<Record<string, unknown>>
      | undefined;
    expect(compactedAliases).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'MEMOS_DSN', kind: 'url' })]),
    );

    const applyBindingAliases = vi.fn(async () => ({ state: 'applied' }));
    const resumeInstall = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));
    const resumed = await createInstallResumer(
      makeAliasDeps({ pending, install: resumeInstall, applyBindingAliases }),
    )();

    expect(resumed[0]?.success).toBe(true);
    expect(applyBindingAliases).toHaveBeenCalledWith(
      expect.objectContaining({
        aliases: expect.arrayContaining([
          { resource: 'postgres', name: 'MEMOS_DSN', kind: 'url' },
          { resource: 'postgres', name: 'PAPERLESS_DBHOST', kind: 'host' },
        ]),
      }),
    );
  });

  it('fails the install honestly when alias registration fails', async () => {
    const applyBindingAliases = vi.fn(async () => ({
      state: 'failed',
      reason: 'register denied',
    }));

    const result = await createInstallExecutor(makeAliasDeps({ applyBindingAliases }))({
      ...command,
      payload: {
        templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/application-template-v1.json',
        manifest: aliasManifest,
      },
    });

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('register denied');
  });
});

// ── AZ discovery ─────────────────────────────────────────────────────────────

describe('discoverAvailabilityZones', () => {
  function makeEc2Client(zones: { ZoneName?: string; State?: string; ZoneType?: string }[]) {
    return {
      send: vi.fn().mockResolvedValue({ AvailabilityZones: zones }),
    };
  }

  it('returns only available standard zones, sorted', async () => {
    const ec2 = makeEc2Client([
      { ZoneName: 'us-east-1c', State: 'available', ZoneType: 'availability-zone' },
      { ZoneName: 'us-east-1a', State: 'available', ZoneType: 'availability-zone' },
      { ZoneName: 'us-east-1b', State: 'available', ZoneType: 'local' },
      { ZoneName: 'us-east-1d', State: 'available', ZoneType: 'wavelength' },
      { ZoneName: 'us-east-1e', State: 'unavailable', ZoneType: 'availability-zone' },
    ]);

    const zones = await discoverAvailabilityZones(ec2 as never);

    expect(zones).toEqual(['us-east-1a', 'us-east-1c']);
  });

  it('succeeds with exactly two available zones', async () => {
    const ec2 = makeEc2Client([
      { ZoneName: 'us-east-1a', State: 'available', ZoneType: 'availability-zone' },
      { ZoneName: 'us-east-1b', State: 'available', ZoneType: 'availability-zone' },
    ]);

    const zones = await discoverAvailabilityZones(ec2 as never);

    expect(zones).toEqual(['us-east-1a', 'us-east-1b']);
  });

  it('returns null when fewer than two usable zones remain', async () => {
    const ec2 = makeEc2Client([
      { ZoneName: 'us-east-1a', State: 'available', ZoneType: 'availability-zone' },
    ]);

    expect(await discoverAvailabilityZones(ec2 as never)).toBeNull();
  });

  it('returns null when all zones are local', async () => {
    const ec2 = makeEc2Client([
      { ZoneName: 'us-east-1a', State: 'available', ZoneType: 'local' },
      { ZoneName: 'us-east-1b', State: 'available', ZoneType: 'local' },
    ]);

    expect(await discoverAvailabilityZones(ec2 as never)).toBeNull();
  });

  it('returns null when the EC2 send throws', async () => {
    const ec2 = {
      send: vi.fn().mockRejectedValue(new Error('Throttling')),
    };

    expect(await discoverAvailabilityZones(ec2 as never)).toBeNull();
  });
});

describe('buildDbAzParameters', () => {
  it('returns null when more than 8 zones are available', () => {
    const zones = Array.from({ length: 9 }, (_, i) => `us-east-1${String.fromCharCode(97 + i)}`);
    expect(buildDbAzParameters(zones)).toBeNull();
  });

  it('returns null when fewer than 2 zones are available', () => {
    expect(buildDbAzParameters([])).toBeNull();
    expect(buildDbAzParameters(['us-east-1a'])).toBeNull();
  });

  it('maps exactly 2 zones to paramDbAz1 and paramDbAz2', () => {
    expect(buildDbAzParameters(['us-east-1a', 'us-east-1b'])).toEqual({
      paramDbAz1: 'us-east-1a',
      paramDbAz2: 'us-east-1b',
    });
  });

  it('maps exactly 8 zones to paramDbAz1 through paramDbAz8', () => {
    const zones = Array.from({ length: 8 }, (_, i) => `us-east-1${String.fromCharCode(97 + i)}`);
    const params = buildDbAzParameters(zones);
    expect(params).not.toBeNull();
    expect(Object.keys(params!)).toHaveLength(8);
    expect(params!['paramDbAz1']).toBe('us-east-1a');
    expect(params!['paramDbAz8']).toBe('us-east-1h');
  });
});

describe('settleInstall AZ wiring', () => {
  const command = {
    id: 'cmd-az',
    deploymentId: 'dep-1',
    type: 'INSTALL' as const,
    idempotencyKey: 'dep-1:INSTALL',
    payload: {
      redisRequired: false,
      databaseRequired: true,
      templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/application-template-v1.json',
    },
  };

  function makeInstallDeps(overrides: Partial<InstallExecutorDeps> = {}): InstallExecutorDeps {
    return {
      installationId: 'inst-1',
      install: async () => ({ state: 'succeeded', status: 'CREATE_COMPLETE', outputs: {} }),
      verify: async () => ({ verified: true, checks: [] }),
      pending: memoryPendingStore(),
      now: () => '2026-08-26T12:00:00.000Z',
      ...overrides,
    };
  }

  it('injects the discovered AZ parameters when creating the stack', async () => {
    const ec2 = {
      send: vi.fn().mockResolvedValue({
        AvailabilityZones: [
          { ZoneName: 'us-east-1b', State: 'available', ZoneType: 'availability-zone' },
          { ZoneName: 'us-east-1a', State: 'available', ZoneType: 'availability-zone' },
        ],
      }),
    };
    const install = vi.fn(async () => ({
      state: 'succeeded' as const,
      status: 'CREATE_COMPLETE',
      outputs: {},
    }));

    await createInstallExecutor(makeInstallDeps({ install, ec2: ec2 as never }))(command);

    expect(install.mock.calls[0]![0]).toMatchObject({
      parameters: {
        paramDbAz1: 'us-east-1a',
        paramDbAz2: 'us-east-1b',
      },
    });
  });

  it('fails explicitly when AZ discovery is required but unsuccessful', async () => {
    const ec2 = {
      send: vi.fn().mockRejectedValue(new Error('Throttling')),
    };
    const install = vi.fn();

    const result = await createInstallExecutor(makeInstallDeps({ install, ec2: ec2 as never }))(command);

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_CREATE_FAILED');
    expect(result.error).toMatch(/AZ discovery failed/i);
    expect(install).not.toHaveBeenCalled();
  });

  it('fails explicitly when more than 8 AZs are discovered', async () => {
    const ec2 = {
      send: vi.fn().mockResolvedValue({
        AvailabilityZones: Array.from({ length: 9 }, (_, i) => ({
          ZoneName: `us-east-1${String.fromCharCode(97 + i)}`,
          State: 'available',
          ZoneType: 'availability-zone',
        })),
      }),
    };
    const install = vi.fn();

    const result = await createInstallExecutor(makeInstallDeps({ install, ec2: ec2 as never }))(command);

    expect(result.success).toBe(false);
    expect(result.failureCode).toBe('STACK_CREATE_FAILED');
    expect(result.error).toMatch(/at most 8/i);
    expect(install).not.toHaveBeenCalled();
  });
});

describe('INSTALL settled markers — bounded and honest about an unreadable store', () => {
  const pendingRecord = {
    commandId: 'cmd-1',
    idempotencyKey: 'dep-1:INSTALL',
    type: 'INSTALL',
    stackName: 'deployz-app',
    startedAt: '2026-08-26T12:00:00.000Z',
    payload: {
      redisRequired: false,
      databaseRequired: true,
      templateUrl: 'https://bucket.s3.us-east-1.amazonaws.com/application-template-v1.json',
    },
  };

  function makeDeps(overrides: Partial<InstallExecutorDeps> = {}): InstallExecutorDeps {
    return {
      installationId: 'inst-1',
      install: async () => ({ state: 'succeeded', status: 'CREATE_COMPLETE', outputs: {} }),
      verify: async () => ({ verified: true, checks: [] }),
      pending: memoryPendingStore(),
      now: () => '2026-08-26T12:05:00.000Z',
      ...overrides,
    };
  }

  /** Behaves like SSM: a value over the Standard-tier limit is refused. */
  function limitedStore(): PendingStore {
    const store = memoryPendingStore();
    return {
      ...store,
      write: async (next) => (JSON.stringify(next).length > PENDING_MARKER_MAX_LENGTH ? false : store.write(next)),
    };
  }

  const unreadable = (store: PendingStore): PendingStore => ({
    ...store,
    read: async () => null,
    inspect: async () => ({ state: 'unreadable', errorCode: 'AccessDeniedException' }),
  });

  it('stores a truncated answer for an oversized failure and still reports the full one', async () => {
    const pending = limitedStore();
    await pending.write(pendingRecord);
    const reason = 'CREATE_FAILED: '.concat('r'.repeat(PENDING_MARKER_MAX_LENGTH * 2));

    const results = await createInstallResumer(
      makeDeps({ pending, install: async () => ({ state: 'failed', status: 'CREATE_FAILED', reason, outputs: {} }) }),
    )();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ commandId: 'cmd-1', success: false, failureCode: 'STACK_CREATE_FAILED' });
    expect(results[0]!.error!.length).toBeGreaterThan(PENDING_MARKER_MAX_LENGTH);

    const stored = (await pending.read())!;
    expect(stored.phase).toBe('settled');
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(PENDING_MARKER_MAX_LENGTH);

    // A lost report is retried from the truncated marker, never by provisioning again.
    const install = vi.fn();
    const again = await createInstallResumer(makeDeps({ pending, install }))();
    expect(install).not.toHaveBeenCalled();
    expect(again[0]).toMatchObject({ commandId: 'cmd-1', success: false, failureCode: 'STACK_CREATE_FAILED' });
  });

  it.each([
    ['success', async () => ({ state: 'succeeded' as const, status: 'CREATE_COMPLETE', outputs: {} }), true],
    [
      'failure',
      async () => ({ state: 'failed' as const, status: 'CREATE_FAILED', reason: 'boom', outputs: {} }),
      false,
    ],
  ])('settles an immediate %s before returning it, so a lost report is repeated without provisioning', async (_n, outcome, success) => {
    const pending = memoryPendingStore();
    const install = vi.fn(outcome);
    const command = {
      id: 'cmd-1',
      deploymentId: 'dep-1',
      type: 'INSTALL' as const,
      idempotencyKey: 'dep-1:INSTALL',
      payload: pendingRecord.payload,
    };

    const first = await createInstallExecutor(makeDeps({ pending, install }))(command);
    expect(first.success).toBe(success);
    expect(await pending.read()).toMatchObject({ commandId: 'cmd-1', phase: 'settled', result: { success } });

    const again = await createInstallResumer(makeDeps({ pending, install }))();
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ commandId: 'cmd-1', success });
    expect(await createInstallExecutor(makeDeps({ pending, install }))(command)).toMatchObject({ success });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('does not settle a deferred install', async () => {
    const pending = memoryPendingStore();
    await createInstallExecutor(
      makeDeps({ pending, install: async () => ({ state: 'in-progress', status: 'CREATE_IN_PROGRESS' }) }),
    )({
      id: 'cmd-1',
      deploymentId: 'dep-1',
      type: 'INSTALL' as const,
      idempotencyKey: 'dep-1:INSTALL',
      payload: pendingRecord.payload,
    });
    expect((await pending.read())?.phase).toBeUndefined();
  });

  it('keeps no install payload in the settled marker', async () => {
    const pending = memoryPendingStore();
    await pending.write({ ...pendingRecord, payload: { ...pendingRecord.payload, parameters: { DbPassword: 'hunter2' } } });

    await createInstallResumer(makeDeps({ pending }))();

    expect(JSON.stringify(await pending.read())).not.toContain('hunter2');
  });

  it('provisions nothing and defers while the pending marker is unreadable', async () => {
    const pending = unreadable(memoryPendingStore());
    const install = vi.fn();
    const command = {
      id: 'cmd-1',
      deploymentId: 'dep-1',
      type: 'INSTALL' as const,
      idempotencyKey: 'dep-1:INSTALL',
      payload: pendingRecord.payload,
    };

    expect(await createInstallExecutor(makeDeps({ pending, install }))(command)).toMatchObject({
      success: false,
      deferred: true,
    });
    expect(await createInstallResumer(makeDeps({ pending, install }))()).toEqual([]);
    expect(install).not.toHaveBeenCalled();
  });
});
