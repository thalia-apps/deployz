import { describe, expect, it, vi } from 'vitest';

import { DEPLOYZ_INSTALLATION_TAG } from '@deployz/contracts';

import {
  buildInstallParametersFromManifest,
  CONTAINER_PORT_PARAMETER,
  describeStoppedTaskEvidence,
  firstFailureEvent,
  HEALTH_CHECK_PATH_PARAMETER,
  installApplicationStack,
  toInstaller,
  type StackFailureEvent,
  type StackInstaller,
  type StackState,
} from './install.js';

/**
 * A scripted installer. `states` is consumed one entry per `describeStack`
 * call, so a test spells out the exact CloudFormation progression it wants
 * ("not there, then creating, then complete") instead of mutating a fake.
 */
function scriptedInstaller(
  states: (StackState | null)[],
  overrides: Partial<StackInstaller> = {},
): StackInstaller & { createCalls: unknown[] } {
  const createCalls: unknown[] = [];
  let index = 0;
  return {
    createCalls,
    createStack: overrides.createStack
      ? overrides.createStack
      : async (input) => {
          createCalls.push(input);
          return { created: true, stackId: 'stack-id-1' };
        },
    describeStack: overrides.describeStack
      ? overrides.describeStack
      : async () => {
          const state = states[Math.min(index, states.length - 1)] ?? null;
          index += 1;
          return state;
        },
    ...(overrides.describeStackOutcome
      ? { describeStackOutcome: overrides.describeStackOutcome }
      : {}),
    describeStackEvents: overrides.describeStackEvents ? overrides.describeStackEvents : async () => [],
  };
}

const NEVER_SLEEP = { sleep: async () => {}, pollIntervalMs: 0 };

function complete(outputs: Record<string, string> = {}): StackState {
  return { status: 'CREATE_COMPLETE', outputs };
}

describe('installApplicationStack', () => {
  it('creates the stack when the account has none', async () => {
    const installer = scriptedInstaller([null, { status: 'CREATE_IN_PROGRESS', outputs: {} }, complete()]);

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('succeeded');
    expect(installer.createCalls).toHaveLength(1);
  });

  it('defaults the stack name to the shared application stack name', async () => {
    const installer = scriptedInstaller([null, complete()]);

    await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(installer.createCalls[0]).toMatchObject({ stackName: 'deployz-app' });
  });

  it('passes the installation as a stack-level CreateStack tag', async () => {
    const installer = scriptedInstaller([null, complete()]);

    await installApplicationStack({
      installer,
      installationId: 'inst-42',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(installer.createCalls[0]).toMatchObject({
      tags: { [DEPLOYZ_INSTALLATION_TAG]: 'inst-42' },
    });
  });

  it('merges the control plane deployment tags under the installation tag', async () => {
    const installer = scriptedInstaller([null, complete()]);

    await installApplicationStack({
      installer,
      installationId: 'inst-42',
      templateUrl: 'https://example.com/app.json',
      deploymentTags: {
        'deployz:managed-by': 'deployz',
        'deployz:deployment-id': 'dep-9',
        'deployz:environment': 'production',
      },
      ...NEVER_SLEEP,
    });

    expect(installer.createCalls[0]).toMatchObject({
      tags: {
        'deployz:managed-by': 'deployz',
        'deployz:deployment-id': 'dep-9',
        'deployz:environment': 'production',
        [DEPLOYZ_INSTALLATION_TAG]: 'inst-42',
      },
    });
  });

  it('requests IAM capabilities — the stack creates roles', async () => {
    const installer = scriptedInstaller([null, complete()]);

    await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(installer.createCalls[0]).toMatchObject({
      capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
    });
  });

  it('passes the CloudFormation execution role when one is configured', async () => {
    const installer = scriptedInstaller([null, complete()]);

    await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      executionRoleArn: 'arn:aws:iam::1:role/deployz/exec',
      ...NEVER_SLEEP,
    });

    expect(installer.createCalls[0]).toMatchObject({
      roleArn: 'arn:aws:iam::1:role/deployz/exec',
    });
  });

  it('reports the stack outputs on success', async () => {
    const installer = scriptedInstaller([
      null,
      complete({ 'deployz-app-PublicEndpoint': 'app.example.com' }),
    ]);

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(outcome).toMatchObject({
      state: 'succeeded',
      outputs: { 'deployz-app-PublicEndpoint': 'app.example.com' },
    });
  });

  it('reports failure with the CloudFormation reason when the stack rolls back', async () => {
    const installer = scriptedInstaller([
      null,
      { status: 'ROLLBACK_COMPLETE', statusReason: 'Resource creation cancelled', outputs: {} },
    ]);

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('failed');
    expect(outcome.state === 'failed' && outcome.reason).toContain('ROLLBACK_COMPLETE');
    expect(outcome.state === 'failed' && outcome.reason).toContain('Resource creation cancelled');
  });

  it('appends the first CREATE_FAILED resource reason — the actual cause — to the failure', async () => {
    const installer = scriptedInstaller(
      [null, { status: 'ROLLBACK_COMPLETE', statusReason: 'Resource creation cancelled', outputs: {} }],
      {
        describeStackEvents: async () => [
          {
            logicalResourceId: 'CpuAlarm',
            resourceType: 'AWS::CloudWatch::Alarm',
            resourceStatusReason: 'Resource creation cancelled',
            timestamp: '2026-08-30T10:00:03.000Z',
          },
          {
            logicalResourceId: 'WebServerService',
            resourceType: 'AWS::ECS::Service',
            resourceStatusReason: 'AccessDenied on cloudwatch:PutMetricAlarm',
            timestamp: '2026-08-30T10:00:01.000Z',
          },
        ],
      },
    );

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('failed');
    expect(outcome.state === 'failed' && outcome.reason).toBe(
      'Stack "deployz-app" finished in ROLLBACK_COMPLETE — Resource creation cancelled — ' +
        'WebServerService (AWS::ECS::Service): AccessDenied on cloudwatch:PutMetricAlarm',
    );
  });

  it('skips boilerplate-cancelled events and falls back to the stack-level reason alone', async () => {
    const installer = scriptedInstaller(
      [null, { status: 'ROLLBACK_COMPLETE', statusReason: 'Resource creation cancelled', outputs: {} }],
      {
        describeStackEvents: async () => [
          {
            logicalResourceId: 'CpuAlarm',
            resourceType: 'AWS::CloudWatch::Alarm',
            resourceStatusReason: 'Resource creation cancelled',
            timestamp: '2026-08-30T10:00:01.000Z',
          },
          {
            logicalResourceId: 'Nat',
            resourceType: 'AWS::EC2::NatGateway',
            resourceStatusReason: 'Resource update cancelled',
            timestamp: '2026-08-30T10:00:02.000Z',
          },
        ],
      },
    );

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('failed');
    expect(outcome.state === 'failed' && outcome.reason).toBe(
      'Stack "deployz-app" finished in ROLLBACK_COMPLETE — Resource creation cancelled',
    );
  });

  it('falls back to the stack-level reason when the events API fails', async () => {
    const installer = scriptedInstaller(
      [null, { status: 'ROLLBACK_COMPLETE', statusReason: 'Resource creation cancelled', outputs: {} }],
      {
        describeStackEvents: async () => {
          throw new Error('Throttling');
        },
      },
    );

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('failed');
    expect(outcome.state === 'failed' && outcome.reason).toBe(
      'Stack "deployz-app" finished in ROLLBACK_COMPLETE — Resource creation cancelled',
    );
  });

  it('keeps the failure reason bounded even with a very long resource reason', async () => {
    const installer = scriptedInstaller(
      [null, { status: 'ROLLBACK_COMPLETE', outputs: {} }],
      {
        describeStackEvents: async () => [
          {
            logicalResourceId: 'WebServerService',
            resourceType: 'AWS::ECS::Service',
            resourceStatusReason: 'x'.repeat(1000),
            timestamp: '2026-08-30T10:00:01.000Z',
          },
        ],
      },
    );

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('failed');
    const reason = outcome.state === 'failed' ? outcome.reason : '';
    expect(reason.length).toBeLessThanOrEqual(500);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('does not create a second stack when one is already in flight', async () => {
    const installer = scriptedInstaller([
      { status: 'CREATE_IN_PROGRESS', outputs: {} },
      complete(),
    ]);

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(installer.createCalls).toHaveLength(0);
    expect(outcome.state).toBe('succeeded');
  });

  it('is idempotent against an already-complete stack', async () => {
    const installer = scriptedInstaller([complete({ a: 'b' })]);

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(installer.createCalls).toHaveLength(0);
    expect(outcome).toMatchObject({ state: 'succeeded', outputs: { a: 'b' } });
  });

  it('treats an AlreadyExists race as an in-flight create, not a failure', async () => {
    const describeStack = vi
      .fn<StackInstaller['describeStack']>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(complete());

    const outcome = await installApplicationStack({
      installer: {
        createStack: async () => ({ created: false, alreadyExists: true }),
        describeStack,
        describeStackEvents: async () => [],
      },
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('succeeded');
  });

  it('reports failure when CreateStack itself is refused', async () => {
    const outcome = await installApplicationStack({
      installer: {
        createStack: async () => ({
          created: false,
          alreadyExists: false,
          errorCode: 'AccessDenied',
          message: 'not authorized to perform cloudformation:CreateStack',
        }),
        describeStack: async () => null,
        describeStackEvents: async () => [],
      },
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('failed');
    expect(outcome.state === 'failed' && outcome.reason).toContain('AccessDenied');
  });

  it('defaults the poll interval to 5 seconds', async () => {
    const installer = scriptedInstaller([{ status: 'CREATE_IN_PROGRESS', outputs: {} }, complete()]);
    let clock = 0;
    const sleeps: number[] = [];

    await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });

    expect(sleeps[0]).toBe(5_000);
  });

  it('reports in-progress rather than a verdict when the time budget runs out', async () => {
    let clock = 0;
    const outcome = await installApplicationStack({
      installer: scriptedInstaller([null, { status: 'CREATE_IN_PROGRESS', outputs: {} }]),
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      budgetMs: 30_000,
      pollIntervalMs: 10_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    expect(outcome).toMatchObject({ state: 'in-progress', status: 'CREATE_IN_PROGRESS' });
  });

  it('stops polling once the budget is spent instead of looping forever', async () => {
    let clock = 0;
    const describeStack = vi
      .fn<StackInstaller['describeStack']>()
      .mockResolvedValue({ status: 'CREATE_IN_PROGRESS', outputs: {} });

    await installApplicationStack({
      installer: {
        createStack: async () => ({ created: true, stackId: 's' }),
        describeStack,
        describeStackEvents: async () => [],
      },
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      budgetMs: 25_000,
      pollIntervalMs: 10_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    // 0ms, 10s, 20s — the 30s attempt is past the budget.
    expect(describeStack.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('rides out a single unreadable poll rather than failing a live install', async () => {
    // `describeStack` maps every error to null, throttling included. One
    // unreadable answer during a twenty-minute watch is not evidence the
    // stack is gone, and treating it as such would fail an install that is
    // going fine.
    const installer = scriptedInstaller([
      { status: 'CREATE_IN_PROGRESS', outputs: {} },
      null,
      complete(),
    ]);

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('succeeded');
  });

  it('creates the fresh stack when an adopted deletion finishes (first-install recovery)', async () => {
    // Recovery deletes the failed previous stack; the same INSTALL then owns
    // creating the new one. Observed live: the watcher instead failed itself
    // on the empty reads after the delete completed.
    const installer = scriptedInstaller([
      { status: 'DELETE_IN_PROGRESS', outputs: {} },
      { status: 'DELETE_IN_PROGRESS', outputs: {} },
      null, // deletion finished — the install must now create, not fail
      { status: 'CREATE_IN_PROGRESS', outputs: {} },
      complete(),
    ]);

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      createMode: 'recovery',
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('succeeded');
    expect(installer.createCalls).toHaveLength(1);
  });

  it('does not recreate after an adopted deletion unless the mode is recovery', async () => {
    for (const createMode of ['resume', 'fresh'] as const) {
      const installer = scriptedInstaller([
        { status: 'DELETE_IN_PROGRESS', outputs: {} },
        { status: 'DELETE_IN_PROGRESS', outputs: {} },
        null,
        null,
        null,
      ]);

      const outcome = await installApplicationStack({
        installer,
        installationId: 'inst-1',
        templateUrl: 'https://example.com/app.json',
        createMode,
        ...NEVER_SLEEP,
      });

      expect(installer.createCalls).toHaveLength(0);
      expect(outcome.state).toBe('failed');
    }
  });

  it('does not create in resume mode when the stack is absent at the first describe', async () => {
    const installer = scriptedInstaller([null, complete()]);

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      createMode: 'resume',
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('failed');
    expect(installer.createCalls).toHaveLength(0);
    expect(outcome.state === 'failed' && outcome.reason).toContain('no longer exists');
  });

  it('creates in recovery mode when the stack is absent at the first describe', async () => {
    const installer = scriptedInstaller([
      null,
      { status: 'CREATE_IN_PROGRESS', outputs: {} },
      complete(),
    ]);

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      createMode: 'recovery',
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('succeeded');
    expect(installer.createCalls).toHaveLength(1);
  });

  it('does not create in recovery mode when recovery is no longer authorized', async () => {
    const installer = scriptedInstaller([null, complete()]);
    const authorizeRecoveryCreate = vi.fn().mockResolvedValue(false);

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      createMode: 'recovery',
      authorizeRecoveryCreate,
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('failed');
    expect(installer.createCalls).toHaveLength(0);
    expect(outcome.state === 'failed' && outcome.reason).toContain('no longer authorized');
  });

  it('rechecks recovery authorization immediately before recreating after a completed deletion', async () => {
    const order: string[] = [];
    const installer = scriptedInstaller(
      [
        { status: 'DELETE_IN_PROGRESS', outputs: {} },
        { status: 'DELETE_IN_PROGRESS', outputs: {} },
        null,
        { status: 'CREATE_IN_PROGRESS', outputs: {} },
        complete(),
      ],
      {
        createStack: async () => {
          order.push('createStack');
          return { created: true, stackId: 'stack-id-1' };
        },
      },
    );
    const authorizeRecoveryCreate = vi.fn(async () => {
      order.push('authorizeRecoveryCreate');
      return true;
    });

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      createMode: 'recovery',
      authorizeRecoveryCreate,
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('succeeded');
    expect(authorizeRecoveryCreate).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['authorizeRecoveryCreate', 'createStack']);
  });

  it('does not recreate after a completed deletion when recovery authorization is refused', async () => {
    const installer = scriptedInstaller([
      { status: 'DELETE_IN_PROGRESS', outputs: {} },
      { status: 'DELETE_IN_PROGRESS', outputs: {} },
      null,
      { status: 'CREATE_IN_PROGRESS', outputs: {} },
      complete(),
    ]);
    const authorizeRecoveryCreate = vi.fn().mockResolvedValue(false);

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      createMode: 'recovery',
      authorizeRecoveryCreate,
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('failed');
    expect(installer.createCalls).toHaveLength(0);
    expect(outcome.state === 'failed' && outcome.reason).toContain('no longer authorized');
  });

  it('fails after repeated unreadable reads without creating and names the error code', async () => {
    const installer = scriptedInstaller([], {
      describeStackOutcome: async () => ({ found: false, absent: false, errorCode: 'Throttling' }),
    });

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('failed');
    expect(installer.createCalls).toHaveLength(0);
    expect(outcome.state === 'failed' && outcome.reason).toContain('Throttling');
    expect(outcome.state === 'failed' && outcome.reason).not.toMatch(/deleted/i);
  });

  it('creates on a fresh install when the stack is outside the tag-scoped read grant (not created yet)', async () => {
    // Real AWS, 2026-10-02: the relay's DescribeStacks grant is scoped to its
    // installation tag, so a stack that does not exist yet answers
    // AccessDenied, never "does not exist".
    const describeStackOutcome = vi
      .fn<NonNullable<StackInstaller['describeStackOutcome']>>()
      .mockResolvedValueOnce({ found: false, absent: false, errorCode: 'AccessDenied' })
      .mockResolvedValue({ found: true, stack: complete() });
    const installer = scriptedInstaller([], { describeStackOutcome });

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(installer.createCalls).toHaveLength(1);
    expect(outcome.state).toBe('succeeded');
  });

  it('creates in recovery mode when the stack deleted by recovery answers AccessDenied at the first describe', async () => {
    // Real AWS, 2026-11-02 (staging): recovery deleted the failed stack, and
    // the tag-scoped read of the now-missing stack answered AccessDenied.
    const describeStackOutcome = vi
      .fn<NonNullable<StackInstaller['describeStackOutcome']>>()
      .mockResolvedValueOnce({ found: false, absent: false, errorCode: 'AccessDenied' })
      .mockResolvedValue({ found: true, stack: complete() });
    const installer = scriptedInstaller([], { describeStackOutcome });

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      createMode: 'recovery',
      ...NEVER_SLEEP,
    });

    expect(installer.createCalls).toHaveLength(1);
    expect(outcome.state).toBe('succeeded');
  });

  it('does not create in recovery mode on AccessDenied when recovery is no longer authorized', async () => {
    const installer = scriptedInstaller([], {
      describeStackOutcome: async () => ({ found: false, absent: false, errorCode: 'AccessDenied' }),
    });

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      createMode: 'recovery',
      authorizeRecoveryCreate: vi.fn().mockResolvedValue(false),
      ...NEVER_SLEEP,
    });

    expect(installer.createCalls).toHaveLength(0);
    expect(outcome.state === 'failed' && outcome.reason).toContain('no longer authorized');
  });

  it('creates in recovery mode when an adopted deletion finishes and the read answers AccessDenied', async () => {
    const describeStackOutcome = vi
      .fn<NonNullable<StackInstaller['describeStackOutcome']>>()
      .mockResolvedValueOnce({ found: true, stack: { status: 'DELETE_IN_PROGRESS', outputs: {} } })
      .mockResolvedValueOnce({ found: true, stack: { status: 'DELETE_IN_PROGRESS', outputs: {} } })
      .mockResolvedValueOnce({ found: false, absent: false, errorCode: 'AccessDenied' }) // deletion finished
      .mockResolvedValueOnce({ found: true, stack: { status: 'CREATE_IN_PROGRESS', outputs: {} } })
      .mockResolvedValue({ found: true, stack: complete() });
    const installer = scriptedInstaller([], { describeStackOutcome });

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      createMode: 'recovery',
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('succeeded');
    expect(installer.createCalls).toHaveLength(1);
  });

  it('does not recreate after an adopted deletion answers AccessDenied unless the mode is recovery', async () => {
    for (const createMode of ['resume', 'fresh'] as const) {
      const describeStackOutcome = vi
        .fn<NonNullable<StackInstaller['describeStackOutcome']>>()
        .mockResolvedValueOnce({ found: true, stack: { status: 'DELETE_IN_PROGRESS', outputs: {} } })
        .mockResolvedValue({ found: false, absent: false, errorCode: 'AccessDenied' });
      const installer = scriptedInstaller([], { describeStackOutcome });

      const outcome = await installApplicationStack({
        installer,
        installationId: 'inst-1',
        templateUrl: 'https://example.com/app.json',
        createMode,
        ...NEVER_SLEEP,
      });

      expect(installer.createCalls, createMode).toHaveLength(0);
      expect(outcome.state, createMode).toBe('failed');
    }
  });

  it('never creates on AccessDenied when resuming an install', async () => {
    const installer = scriptedInstaller([], {
      describeStackOutcome: async () => ({ found: false, absent: false, errorCode: 'AccessDenied' }),
    });

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      createMode: 'resume',
      ...NEVER_SLEEP,
    });

    expect(installer.createCalls).toHaveLength(0);
    expect(outcome.state).toBe('failed');
  });

  it('rides out a single unreadable read and succeeds when the stack becomes readable', async () => {
    const describeStackOutcome = vi
      .fn<NonNullable<StackInstaller['describeStackOutcome']>>()
      .mockResolvedValueOnce({ found: false, absent: false, errorCode: 'Throttling' })
      .mockResolvedValue({ found: true, stack: complete() });
    const installer = scriptedInstaller([], { describeStackOutcome });

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('succeeded');
    expect(installer.createCalls).toHaveLength(0);
  });

  it('fails when the stack disappears mid-create', async () => {
    const installer = scriptedInstaller([
      { status: 'CREATE_IN_PROGRESS', outputs: {} },
      null,
      null,
      null,
      null,
    ]);

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('failed');
    expect(outcome.state === 'failed' && outcome.reason).toMatch(/deleted/i);
  });

  it('never lets an installer exception escape', async () => {
    const outcome = await installApplicationStack({
      installer: {
        createStack: async () => {
          throw new Error('socket hang up');
        },
        describeStack: async () => null,
        describeStackEvents: async () => [],
      },
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('failed');
    expect(outcome.state === 'failed' && outcome.reason).toContain('socket hang up');
  });

  it('polls onPoll once per wait-loop tick, plus once more after the terminal state', async () => {
    const installer = scriptedInstaller([null, { status: 'CREATE_IN_PROGRESS', outputs: {} }, complete()]);
    const calls: string[] = [];

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      onPoll: async (stackName) => {
        calls.push(stackName);
      },
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('succeeded');
    // 2 wait-loop ticks (CREATE_IN_PROGRESS, then CREATE_COMPLETE) + 1 final
    // flush once the stack settles.
    expect(calls).toEqual(['deployz-app', 'deployz-app', 'deployz-app']);
  });

  it('never lets a rejecting onPoll change the install outcome', async () => {
    const installer = scriptedInstaller([null, { status: 'CREATE_IN_PROGRESS', outputs: {} }, complete()]);

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      onPoll: async () => {
        throw new Error('control plane unreachable');
      },
      ...NEVER_SLEEP,
    });

    expect(outcome.state).toBe('succeeded');
  });

  it('forwards template parameters as CreateStack parameters', async () => {
    const installer = scriptedInstaller([null, complete()]);

    await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      parameters: { param_AppApiKey: 'k' },
      ...NEVER_SLEEP,
    });

    expect(installer.createCalls[0]).toMatchObject({
      parameters: { param_AppApiKey: 'k' },
    });
  });
});

function failureEvent(overrides: Partial<StackFailureEvent> = {}): StackFailureEvent {
  return {
    logicalResourceId: 'WebServerService',
    resourceType: 'AWS::ECS::Service',
    resourceStatusReason: 'AccessDenied on cloudwatch:PutMetricAlarm',
    timestamp: '2026-08-30T10:00:00.000Z',
    ...overrides,
  };
}

// ── buildInstallParametersFromManifest ───────────────────────────────────────

function manifestFixture(): Parameters<typeof buildInstallParametersFromManifest>[0] {
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
  };
}

describe('buildInstallParametersFromManifest', () => {
  it('maps the manifest web.port and health.path to the template parameters', () => {
    expect(buildInstallParametersFromManifest(manifestFixture())).toEqual({
      [CONTAINER_PORT_PARAMETER]: '8080',
      [HEALTH_CHECK_PATH_PARAMETER]: '/api/health',
    });
  });

  it('emits the port parameter even when it matches the template default — CFN accepts it harmlessly', () => {
    const manifest = manifestFixture();
    manifest.web.port = 3000;
    expect(buildInstallParametersFromManifest(manifest)[CONTAINER_PORT_PARAMETER]).toBe('3000');
  });

  it('omits the port parameter when the manifest did not detect one', () => {
    const manifest = manifestFixture();
    manifest.web.port = null;
    expect(buildInstallParametersFromManifest(manifest)).toEqual({
      [HEALTH_CHECK_PATH_PARAMETER]: '/api/health',
    });
  });

  it('ignores fields the template cannot parameterize (build context, dependency requirements)', () => {
    const manifest = manifestFixture();
    manifest.application.root = 'apps/web';
    manifest.redis.envBindings = [{ name: 'CELERY_BROKER_URL', kind: 'url' }];
    expect(buildInstallParametersFromManifest(manifest)).toEqual({
      [CONTAINER_PORT_PARAMETER]: '8080',
      [HEALTH_CHECK_PATH_PARAMETER]: '/api/health',
    });
  });
});

describe('firstFailureEvent', () => {
  it('returns null with no events', () => {
    expect(firstFailureEvent([])).toBeNull();
  });

  it('skips boilerplate cancellation reasons', () => {
    expect(
      firstFailureEvent([
        failureEvent({ resourceStatusReason: 'Resource creation cancelled' }),
        failureEvent({ resourceStatusReason: 'Resource update cancelled' }),
      ]),
    ).toBeNull();
  });

  it('picks the chronologically earliest genuine failure, regardless of array order', () => {
    const earlier = failureEvent({
      logicalResourceId: 'Database',
      timestamp: '2026-08-30T10:00:01.000Z',
    });
    const later = failureEvent({
      logicalResourceId: 'WebServerService',
      timestamp: '2026-08-30T10:00:05.000Z',
    });

    expect(firstFailureEvent([later, earlier])).toEqual(earlier);
  });
});

describe('toInstaller', () => {
  it('sends the installation as the CreateStack Tags parameter', async () => {
    const send = vi.fn().mockResolvedValue({ StackId: 'arn:stack/deployz-app' });

    await toInstaller({ send }).createStack({
      stackName: 'deployz-app',
      templateUrl: 'https://example.com/app.json',
      parameters: { param_AppApiKey: 'k' },
      tags: { 'deployz:installation': 'inst-7' },
      capabilities: ['CAPABILITY_IAM'],
      roleArn: 'arn:aws:iam::1:role/deployz/exec',
    });

    const input = (send.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({
      StackName: 'deployz-app',
      TemplateURL: 'https://example.com/app.json',
      Tags: [{ Key: 'deployz:installation', Value: 'inst-7' }],
      Parameters: [{ ParameterKey: 'param_AppApiKey', ParameterValue: 'k' }],
      RoleARN: 'arn:aws:iam::1:role/deployz/exec',
    });
  });

  it('omits RoleARN entirely when no execution role is configured', async () => {
    const send = vi.fn().mockResolvedValue({ StackId: 's' });

    await toInstaller({ send }).createStack({
      stackName: 'deployz-app',
      templateUrl: 'https://example.com/app.json',
      parameters: {},
      tags: {},
      capabilities: [],
    });

    const input = (send.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input).not.toHaveProperty('RoleARN');
  });

  it('maps AlreadyExistsException to the race outcome, not a failure', async () => {
    const error = new Error('Stack already exists');
    error.name = 'AlreadyExistsException';
    const send = vi.fn().mockRejectedValue(error);

    const outcome = await toInstaller({ send }).createStack({
      stackName: 'deployz-app',
      templateUrl: 'https://example.com/app.json',
      parameters: {},
      tags: {},
      capabilities: [],
    });

    expect(outcome).toEqual({ created: false, alreadyExists: true });
  });

  it('maps any other refusal to a failure carrying the AWS error code', async () => {
    const error = new Error('not authorized');
    error.name = 'AccessDenied';
    const send = vi.fn().mockRejectedValue(error);

    const outcome = await toInstaller({ send }).createStack({
      stackName: 'deployz-app',
      templateUrl: 'https://example.com/app.json',
      parameters: {},
      tags: {},
      capabilities: [],
    });

    expect(outcome).toMatchObject({
      created: false,
      alreadyExists: false,
      errorCode: 'AccessDenied',
      message: 'not authorized',
    });
  });

  it('reads status, reason and outputs off the described stack', async () => {
    const send = vi.fn().mockResolvedValue({
      Stacks: [
        {
          StackStatus: 'CREATE_COMPLETE',
          StackStatusReason: 'all good',
          Outputs: [{ OutputKey: 'PublicEndpoint', OutputValue: 'app.example.com' }],
        },
      ],
    });

    const state = await toInstaller({ send }).describeStack('deployz-app');

    expect(state).toEqual({
      status: 'CREATE_COMPLETE',
      statusReason: 'all good',
      outputs: { PublicEndpoint: 'app.example.com' },
    });
  });

  it('returns null — never throws — when the stack cannot be described', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ValidationError'));

    await expect(toInstaller({ send }).describeStack('deployz-app')).resolves.toBeNull();
  });

  it('reports a described stack as found through describeStackOutcome', async () => {
    const send = vi.fn().mockResolvedValue({
      Stacks: [
        {
          StackStatus: 'CREATE_COMPLETE',
          StackStatusReason: 'all good',
          Outputs: [{ OutputKey: 'PublicEndpoint', OutputValue: 'app.example.com' }],
        },
      ],
    });

    await expect(toInstaller({ send }).describeStackOutcome!('deployz-app')).resolves.toEqual({
      found: true,
      stack: {
        status: 'CREATE_COMPLETE',
        statusReason: 'all good',
        outputs: { PublicEndpoint: 'app.example.com' },
      },
    });
  });

  it('maps a missing-stack ValidationError to a confirmed absence', async () => {
    const error = new Error('Stack with id deployz-app does not exist');
    error.name = 'ValidationError';
    const send = vi.fn().mockRejectedValue(error);

    await expect(toInstaller({ send }).describeStackOutcome!('deployz-app')).resolves.toEqual({
      found: false,
      absent: true,
    });
  });

  it('maps an AccessDeniedException to an unreadable outcome, while describeStack still returns null', async () => {
    const error = new Error('not authorized');
    error.name = 'AccessDeniedException';
    const send = vi.fn().mockRejectedValue(error);
    const installer = toInstaller({ send });

    await expect(installer.describeStackOutcome!('deployz-app')).resolves.toEqual({
      found: false,
      absent: false,
      errorCode: 'AccessDeniedException',
    });
    await expect(installer.describeStack('deployz-app')).resolves.toBeNull();
  });

  it('reads CREATE_FAILED resource events, ignoring other statuses', async () => {
    const send = vi.fn().mockResolvedValue({
      StackEvents: [
        {
          LogicalResourceId: 'WebServerService',
          ResourceType: 'AWS::ECS::Service',
          ResourceStatus: 'CREATE_FAILED',
          ResourceStatusReason: 'AccessDenied on cloudwatch:PutMetricAlarm',
          Timestamp: new Date('2026-08-30T10:00:01.000Z'),
        },
        {
          LogicalResourceId: 'Stack',
          ResourceType: 'AWS::CloudFormation::Stack',
          ResourceStatus: 'ROLLBACK_IN_PROGRESS',
          ResourceStatusReason: 'The following resource(s) failed to create',
          Timestamp: new Date('2026-08-30T10:00:02.000Z'),
        },
      ],
    });

    const events = await toInstaller({ send }).describeStackEvents('deployz-app');

    expect(events).toEqual([
      {
        logicalResourceId: 'WebServerService',
        resourceType: 'AWS::ECS::Service',
        resourceStatusReason: 'AccessDenied on cloudwatch:PutMetricAlarm',
        timestamp: '2026-08-30T10:00:01.000Z',
      },
    ]);
  });

  it('follows NextToken up to the page cap', async () => {
    const send = vi.fn().mockImplementation((command: { input: { NextToken?: string } }) => {
      const page = command.input.NextToken ? Number(command.input.NextToken) : 0;
      return Promise.resolve({
        StackEvents: [
          {
            LogicalResourceId: `Resource${page}`,
            ResourceType: 'AWS::ECS::Service',
            ResourceStatus: 'CREATE_FAILED',
            ResourceStatusReason: `failure ${page}`,
            Timestamp: new Date('2026-08-30T10:00:00.000Z'),
          },
        ],
        NextToken: String(page + 1),
      });
    });

    const events = await toInstaller({ send }).describeStackEvents('deployz-app');

    expect(send).toHaveBeenCalledTimes(5);
    expect(events).toHaveLength(5);
  });

  it('returns an empty array — never throws — when events cannot be read', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Throttling'));

    await expect(toInstaller({ send }).describeStackEvents('deployz-app')).resolves.toEqual([]);
  });
});

describe('install failure evidence (Phase 1)', () => {
  const SERVICE_ARN = 'arn:aws:ecs:us-east-1:151955775369:service/app-cluster/app-service';

  function cfnWithService() {
    return {
      async describeStackResources() {
        return [
          { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE', physicalId: SERVICE_ARN },
        ];
      },
    };
  }

  const REVISION = 'arn:aws:ecs:us-east-1:151955775369:task-definition/DeployzAppWeb:4';

  function ecsWithStoppedTasks(
    tasks: {
      exitCode?: number;
      stopCode?: string;
      stoppedReason?: string;
      containers?: { name?: string; exitCode?: number }[];
    }[],
    failDescribe = false,
  ) {
    return {
      async listTasks() {
        return { taskArns: tasks.map((_, index) => `stopped-${index}`) };
      },
      async describeTasks() {
        if (failDescribe) throw new Error('AccessDenied');
        // Runtime containers as ECS reports them: named, no `essential` field.
        return {
          tasks: tasks.map((task) => ({
            lastStatus: 'STOPPED',
            stopCode: task.stopCode,
            stoppedReason: task.stoppedReason,
            taskDefinitionArn: REVISION,
            containers: task.containers ?? [{ name: 'App', exitCode: task.exitCode }],
          })),
        };
      },
      async describeTaskDefinition() {
        return {
          taskDefinition: {
            containerDefinitions: [
              { name: 'App', image: 'repo@sha256:abc', essential: true },
              { name: 'RdsCaBundle', image: 'public.ecr.aws/amazonlinux/amazonlinux:2023-minimal', essential: false },
            ],
          },
        };
      },
    };
  }

  it("attaches the collector's evidence to a failed install", async () => {
    const installer = scriptedInstaller([null, { status: 'ROLLBACK_COMPLETE', statusReason: 'rolled back', outputs: {} }]);

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
      stoppedTaskEvidence: async () => ({
        container: {
          exitCode: 1,
          stopCode: 'EssentialContainerExited',
          stoppedReason: 'connect ECONNREFUSED 127.0.0.1:5432',
          stoppedTaskCount: 3,
        },
      }),
    });

    expect(outcome.state).toBe('failed');
    expect(outcome.state === 'failed' && outcome.evidence).toEqual({
      container: {
        exitCode: 1,
        stopCode: 'EssentialContainerExited',
        stoppedReason: 'connect ECONNREFUSED 127.0.0.1:5432',
        stoppedTaskCount: 3,
      },
    });
  });

  it('omits evidence when the collector throws — the failure itself is unchanged', async () => {
    const installer = scriptedInstaller([null, { status: 'ROLLBACK_COMPLETE', statusReason: 'rolled back', outputs: {} }]);

    const outcome = await installApplicationStack({
      installer,
      installationId: 'inst-1',
      templateUrl: 'https://example.com/app.json',
      ...NEVER_SLEEP,
      stoppedTaskEvidence: async () => {
        throw new Error('AccessDenied');
      },
    });

    expect(outcome.state).toBe('failed');
    expect(outcome.state === 'failed' && outcome.reason).toContain('ROLLBACK_COMPLETE');
    expect(outcome.state === 'failed' && outcome.evidence).toBeUndefined();
  });

  it('describeStoppedTaskEvidence takes the most common stopped task', async () => {
    const evidence = await describeStoppedTaskEvidence(
      {
        cfn: cfnWithService(),
        ecs: ecsWithStoppedTasks([
          { exitCode: 1, stopCode: 'EssentialContainerExited', stoppedReason: 'connect ECONNREFUSED 127.0.0.1:5432' },
          { exitCode: 1, stopCode: 'EssentialContainerExited', stoppedReason: 'connect ECONNREFUSED 127.0.0.1:5432' },
          { exitCode: 137, stopCode: 'ServiceSchedulerInitiated', stoppedReason: 'task scaled down' },
        ]),
      },
      'deployz-app',
    );

    expect(evidence).toEqual({
      container: {
        exitCode: 1,
        stopCode: 'EssentialContainerExited',
        stoppedReason: 'connect ECONNREFUSED 127.0.0.1:5432',
        stoppedTaskCount: 2,
      },
    });
  });

  it("describeStoppedTaskEvidence reports the application's exit code, never a helper's, in either container order", async () => {
    for (const containers of [
      [{ name: 'RdsCaBundle', exitCode: 1 }, { name: 'App', exitCode: 127 }],
      [{ name: 'App', exitCode: 127 }, { name: 'RdsCaBundle', exitCode: 1 }],
    ]) {
      const evidence = await describeStoppedTaskEvidence(
        { cfn: cfnWithService(), ecs: ecsWithStoppedTasks([{ stopCode: 'EssentialContainerExited', containers }]) },
        'deployz-app',
      );
      expect(evidence?.container?.exitCode).toBe(127);
    }

    // The application never reported an exit code: the helper's 1 is not it.
    const evidence = await describeStoppedTaskEvidence(
      {
        cfn: cfnWithService(),
        ecs: ecsWithStoppedTasks([
          { stopCode: 'TaskFailedToStart', containers: [{ name: 'RdsCaBundle', exitCode: 1 }, { name: 'App' }] },
        ]),
      },
      'deployz-app',
    );
    expect(evidence?.container?.exitCode).toBeNull();
  });

  it('describeStoppedTaskEvidence returns null on any error or when nothing stopped', async () => {
    await expect(
      describeStoppedTaskEvidence({ cfn: cfnWithService(), ecs: ecsWithStoppedTasks([], true) }, 'deployz-app'),
    ).resolves.toBeNull();
    await expect(
      describeStoppedTaskEvidence({ cfn: cfnWithService(), ecs: ecsWithStoppedTasks([]) }, 'deployz-app'),
    ).resolves.toBeNull();
    await expect(
      describeStoppedTaskEvidence(
        { cfn: { async describeStackResources() { return []; } }, ecs: ecsWithStoppedTasks([]) },
        'deployz-app',
      ),
    ).resolves.toBeNull();
  });
});
