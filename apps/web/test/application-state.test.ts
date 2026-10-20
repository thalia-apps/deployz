import { describe, expect, it } from 'vitest';

import {
  ANALYSIS_POLL_MS,
  APPLICATION_STATES,
  STALE_NOTICE,
  TEST_DEPLOYMENT_POLL_MS,
  customerDeployments,
  deriveApplicationPresentation,
  latestTestDeployment,
  applicationListBadge,
  releaseReadiness,
  testDeploymentPhase,
  type ApplicationState,
  type ApplicationStateInput,
  type InstallLinkPlacement,
  type SetupLifecycleItem,
  type SetupLifecycleStepState,
} from '../src/lib/application-state';
import { requiredChangeLabel } from '../src/lib/application-configuration';
import { deploymentDisplayStatus } from '../src/lib/deployment-status-groups';
import type { FleetDeployment } from '../src/lib/deployments';
import type { PublicInstallLinkStatus, PublicInstallLinkView } from '../src/lib/public-install-links';
import type { ApplicationReadiness, ReadinessFinding } from '../src/lib/readiness';
import type { Release } from '../src/lib/releases';
import { fleetDeployment } from './fixtures/fleet-deployment';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** `environmentSetup` is added to `ApplicationReadiness` by a companion
 *  change; widen the fixture type locally so tests can set it without
 *  waiting for that change to land (see `application-state.ts`'s
 *  `environmentSetupOf` accessor). */
interface EnvironmentSetupCounts {
  needsDecision: number;
  missingValue: number;
  missingBuildValue: number;
  customer: number;
  total: number;
}
type ReadinessFixture = ApplicationReadiness & { environmentSetup?: EnvironmentSetupCounts | null };
type ReadinessOverrides = Partial<ReadinessFixture>;

function readiness(overrides: ReadinessOverrides = {}): ReadinessFixture {
  return {
    analysisStatus: 'COMPLETE',
    state: 'READY',
    requiredCount: 0,
    recommendedCount: 0,
    summary: null,
    failureReason: null,
    findings: [],
    passed: [{ id: 'docker', label: 'Docker container detected' }],
    analyzedCommitSha: 'abc1234',
    detected: null,
    requirements: null,
    deploymentRequirementDrift: [],
    environmentSetup: null,
    ...overrides,
  };
}

function environmentSetup(overrides: Partial<EnvironmentSetupCounts> = {}): EnvironmentSetupCounts {
  return { needsDecision: 0, missingValue: 0, missingBuildValue: 0, customer: 0, total: 0, ...overrides };
}

function requiredFinding(overrides: Partial<ReadinessFinding> = {}): ReadinessFinding {
  return {
    id: 'health-endpoint',
    category: 'health',
    title: 'Health endpoint missing',
    severity: 'required',
    blocking: true,
    plainEnglishExplanation: 'Deployz requires an HTTP health endpoint.',
    whyItMatters: 'Without it, Deployz cannot tell if your app is running.',
    technicalEvidence: 'No route responded on /health.',
    suggestedOutcome: 'Add a GET /health route that returns HTTP 200.',
    confidence: 'confirmed',
    ...overrides,
  };
}

function recommendedFinding(overrides: Partial<ReadinessFinding> = {}): ReadinessFinding {
  return {
    id: 'logging',
    category: 'observability',
    title: 'Structured logging recommended',
    severity: 'recommended',
    blocking: false,
    plainEnglishExplanation: 'Logs are not structured as JSON.',
    whyItMatters: 'Structured logs are easier to search.',
    technicalEvidence: 'Log lines are plain text.',
    suggestedOutcome: 'Emit logs as JSON.',
    confidence: 'likely',
    ...overrides,
  };
}

/** A TEST deployment (the vendor's own trial install). */
function deployment(overrides: Partial<FleetDeployment> = {}): FleetDeployment {
  return fleetDeployment({ deploymentType: 'TEST', state: 'NOT_INSTALLED', ...overrides });
}

/** A customer (PRODUCTION) deployment. */
function customer(overrides: Partial<FleetDeployment> = {}): FleetDeployment {
  return fleetDeployment({ deploymentType: 'PRODUCTION', state: 'HEALTHY', ...overrides });
}

function release(overrides: Partial<Release> = {}): Release {
  return {
    id: 'release-1',
    version: 'v0.1.0',
    status: 'READY',
    failureReason: null,
    gitSha: 'b2806f9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function link(overrides: Partial<PublicInstallLinkView> = {}): PublicInstallLinkView {
  return {
    id: 'link-1',
    url: 'https://deployz.dev/i/abc123',
    status: 'active',
    createdAt: '2026-08-01T00:00:00.000Z',
    revokedAt: null,
    recommendedSizeProfile: null,
    minimumSizeProfile: null,
    ...overrides,
  };
}

function makeInput(
  opts: {
    readiness?: ReadinessOverrides;
    deployments?: FleetDeployment[];
    installLinks?: ApplicationStateInput['installLinks'];
    releases?: Release[] | 'error';
    stale?: boolean;
    analysisTakingLonger?: boolean;
    applicationId?: string;
    applicationName?: string;
  } = {},
): ApplicationStateInput {
  return {
    data: {
      application: { id: opts.applicationId ?? 'app-1', name: opts.applicationName ?? 'My App', defaultBranch: 'main' },
      readiness: readiness(opts.readiness),
      deployments: opts.deployments ?? [],
      releases: opts.releases !== undefined ? opts.releases : [],
    },
    installLinks: opts.installLinks !== undefined ? opts.installLinks : [],
    stale: opts.stale ?? false,
    analysisTakingLonger: opts.analysisTakingLonger ?? false,
  };
}

function lifecycleSteps(
  analyse: SetupLifecycleStepState,
  configure: SetupLifecycleStepState,
  test: SetupLifecycleStepState,
  share: SetupLifecycleStepState = 'pending',
): SetupLifecycleItem[] {
  return [
    { step: 'Analyse', state: analyse },
    { step: 'Configure', state: configure },
    { step: 'Test', state: test },
    { step: 'Share', state: share },
  ];
}

/** No output field may leak a raw enum value the UI does not know how to word. */
function assertNoRawLeak(result: ReturnType<typeof deriveApplicationPresentation>, raw: string) {
  const haystack = [
    result.heading,
    result.message,
    result.badge.label,
    result.readinessSummary ?? '',
    ...result.notices.map((n) => n.text),
  ].join(' ');
  expect(haystack).not.toContain(raw);
}

const CHECK_PASSED_PATTERN = /checks? passed/i;

// ── 1. Canonical state matrix ────────────────────────────────────────────────

interface StateCase {
  input: ApplicationStateInput;
  badgeLabel: string;
  heading: string;
  primaryActionId: string | null;
  polling: number | null;
  busy: boolean;
  lifecycle: SetupLifecycleItem[] | null;
  installLinkAvailable: boolean;
  installLinkPlacement: InstallLinkPlacement;
}

const STATE_CASES: Record<ApplicationState, StateCase> = {
  unavailable: {
    input: { data: null, installLinks: [], stale: false, analysisTakingLonger: false },
    badgeLabel: 'Unavailable',
    heading: 'Application unavailable',
    primaryActionId: 'retry-load',
    polling: null,
    busy: false,
    lifecycle: null,
    installLinkAvailable: false,
    installLinkPlacement: 'none',
  },
  analysing: {
    input: makeInput({ readiness: { analysisStatus: 'ANALYZING', state: 'ANALYSIS_INCOMPLETE' } }),
    badgeLabel: 'Analysing',
    heading: 'Analysing application',
    primaryActionId: null,
    polling: ANALYSIS_POLL_MS,
    busy: true,
    lifecycle: lifecycleSteps('current', 'pending', 'pending'),
    installLinkAvailable: false,
    installLinkPlacement: 'none',
  },
  'analysis-failed': {
    input: makeInput({
      readiness: { analysisStatus: 'FAILED', state: 'ANALYSIS_INCOMPLETE', failureReason: 'Boom' },
    }),
    badgeLabel: 'Analysis failed',
    heading: 'Analysis failed',
    primaryActionId: 'retry-analysis',
    polling: null,
    busy: false,
    lifecycle: lifecycleSteps('failed', 'pending', 'pending'),
    installLinkAvailable: false,
    installLinkPlacement: 'none',
  },
  'configuration-required': {
    input: makeInput({
      readiness: { state: 'NEEDS_CHANGES', findings: [requiredFinding()], requiredCount: 1 },
    }),
    badgeLabel: 'Needs input',
    heading: '1 change required before you can deploy',
    primaryActionId: 'review-configuration',
    polling: null,
    busy: false,
    lifecycle: lifecycleSteps('done', 'current', 'pending'),
    installLinkAvailable: false,
    installLinkPlacement: 'none',
  },
  'configuration-review': {
    input: makeInput({
      readiness: { environmentSetup: environmentSetup({ needsDecision: 2, total: 2 }) },
    }),
    badgeLabel: 'Needs input',
    heading: 'Configuration needs review',
    primaryActionId: 'review-configuration',
    polling: null,
    busy: false,
    lifecycle: lifecycleSteps('done', 'current', 'pending'),
    installLinkAvailable: false,
    installLinkPlacement: 'none',
  },
  'ready-to-test': {
    input: makeInput(),
    badgeLabel: 'Ready to test',
    heading: 'Ready for a test deployment',
    primaryActionId: 'start-test',
    polling: null,
    busy: false,
    lifecycle: lifecycleSteps('done', 'done', 'current'),
    installLinkAvailable: false,
    installLinkPlacement: 'none',
  },
  'test-queued': {
    input: makeInput({ deployments: [deployment({ state: 'NOT_INSTALLED' })] }),
    badgeLabel: 'Testing',
    heading: 'Test deployment not started',
    primaryActionId: 'continue-test',
    polling: TEST_DEPLOYMENT_POLL_MS,
    busy: false,
    lifecycle: lifecycleSteps('done', 'done', 'current'),
    installLinkAvailable: false,
    installLinkPlacement: 'none',
  },
  'test-deploying': {
    input: makeInput({ deployments: [deployment({ state: 'INSTALLING' })] }),
    badgeLabel: 'Testing',
    heading: 'Test deployment in progress',
    primaryActionId: 'view-progress',
    polling: TEST_DEPLOYMENT_POLL_MS,
    busy: true,
    lifecycle: lifecycleSteps('done', 'done', 'current'),
    installLinkAvailable: false,
    installLinkPlacement: 'none',
  },
  'test-removing': {
    input: makeInput({ deployments: [deployment({ state: 'DELETING' })] }),
    badgeLabel: 'Testing',
    heading: 'Removing test deployment',
    primaryActionId: 'view-progress',
    polling: TEST_DEPLOYMENT_POLL_MS,
    busy: true,
    lifecycle: lifecycleSteps('done', 'done', 'pending'),
    installLinkAvailable: false,
    installLinkPlacement: 'none',
  },
  'test-failed': {
    input: makeInput({ deployments: [deployment({ state: 'FAILED' })] }),
    badgeLabel: 'Test failed',
    heading: 'Test deployment failed',
    primaryActionId: 'review-failure',
    polling: null,
    busy: false,
    lifecycle: lifecycleSteps('done', 'done', 'failed'),
    installLinkAvailable: false,
    installLinkPlacement: 'none',
  },
  'ready-to-share': {
    input: makeInput({ deployments: [deployment({ state: 'HEALTHY' })] }),
    badgeLabel: 'Ready to share',
    heading: 'Ready to share',
    primaryActionId: 'create-install-link',
    polling: null,
    busy: false,
    lifecycle: null,
    installLinkAvailable: true,
    installLinkPlacement: 'primary',
  },
  'customers-active': {
    input: makeInput({ deployments: [customer({ state: 'HEALTHY' })] }),
    badgeLabel: 'Live',
    heading: '1 customer deployment',
    primaryActionId: 'view-customer-deployments',
    polling: null,
    busy: false,
    lifecycle: null,
    installLinkAvailable: true,
    installLinkPlacement: 'card',
  },
  unknown: {
    input: makeInput({
      readiness: { analysisStatus: 'QUEUED' as ApplicationReadiness['analysisStatus'] },
    }),
    badgeLabel: 'Status unknown',
    heading: 'Status unavailable',
    primaryActionId: 'analyse',
    polling: null,
    busy: false,
    lifecycle: null,
    installLinkAvailable: false,
    installLinkPlacement: 'none',
  },
};

describe('canonical state matrix', () => {
  it('has exactly one fixture per state in APPLICATION_STATES', () => {
    expect(Object.keys(STATE_CASES).sort()).toEqual([...APPLICATION_STATES].sort());
  });

  it.each(APPLICATION_STATES.map((state) => [state, STATE_CASES[state]] as const))(
    '%s renders the documented presentation',
    (state, expected) => {
      const result = deriveApplicationPresentation(expected.input);
      expect(result.state).toBe(state);
      expect(result.badge.label).toBe(expected.badgeLabel);
      expect(result.heading).toBe(expected.heading);
      expect(result.primaryAction?.id ?? null).toBe(expected.primaryActionId);
      expect(result.polling).toEqual(expected.polling === null ? null : { intervalMs: expected.polling });
      expect(result.busy).toBe(expected.busy);
      expect(result.lifecycle).toEqual(expected.lifecycle);
      expect(result.installLinkAvailable).toBe(expected.installLinkAvailable);
      expect(result.installLinkPlacement).toBe(expected.installLinkPlacement);
    },
  );
});

// ── 2. Unknown / legacy inputs ───────────────────────────────────────────────

describe('unknown and legacy inputs', () => {
  it('an unknown analysisStatus never throws and never leaks the raw value', () => {
    const input = makeInput({ readiness: { analysisStatus: 'QUEUED' as ApplicationReadiness['analysisStatus'] } });
    let result!: ReturnType<typeof deriveApplicationPresentation>;
    expect(() => {
      result = deriveApplicationPresentation(input);
    }).not.toThrow();
    expect(result.state).toBe('unknown');
    assertNoRawLeak(result, 'QUEUED');
  });

  it('an unknown deployment state never throws and never leaks the raw value', () => {
    const input = makeInput({ deployments: [deployment({ state: 'MIGRATING' as FleetDeployment['state'] })] });
    let result!: ReturnType<typeof deriveApplicationPresentation>;
    expect(() => {
      result = deriveApplicationPresentation(input);
    }).not.toThrow();
    expect(result.state).toBe('unknown');
    assertNoRawLeak(result, 'MIGRATING');
  });

  it('an install link with an unknown status never throws and never leaks the raw value', () => {
    const weirdLink = link({ status: 'pending_review' as PublicInstallLinkStatus });
    const input = makeInput({ deployments: [deployment({ state: 'HEALTHY' })], installLinks: [weirdLink] });
    let result!: ReturnType<typeof deriveApplicationPresentation>;
    expect(() => {
      result = deriveApplicationPresentation(input);
    }).not.toThrow();
    expect(result.installLink).toMatchObject({ kind: 'live', status: 'unknown' });
    assertNoRawLeak(result, 'pending_review');
  });

  it('observedState: null never throws and hides the open-application action', () => {
    const input = makeInput({ deployments: [deployment({ state: 'HEALTHY', observedState: null })] });
    const result = deriveApplicationPresentation(input);
    expect(result.secondaryActions.some((a) => a.id === 'open-application')).toBe(false);
  });

  it('a missing requirements field never throws', () => {
    const broken = { ...readiness(), requirements: undefined } as unknown as ApplicationReadiness;
    const input: ApplicationStateInput = {
      data: {
        application: { id: 'app-1', name: 'My App', defaultBranch: 'main' },
        readiness: broken,
        deployments: [],
        releases: [],
      },
      installLinks: [],
      stale: false,
      analysisTakingLonger: false,
    };
    expect(() => deriveApplicationPresentation(input)).not.toThrow();
  });
});

// ── 3. Conflicting / stale raw states ────────────────────────────────────────

describe('conflicting or stale raw states resolve to exactly one story', () => {
  it('READY readiness + NOT_INSTALLED test + an active install link → test-queued, link flagged, not "ready"', () => {
    const activeLink = link({ status: 'active' });
    const result = deriveApplicationPresentation(
      makeInput({
        readiness: { state: 'READY', requiredCount: 0, findings: [] },
        deployments: [deployment({ state: 'NOT_INSTALLED' })],
        installLinks: [activeLink],
      }),
    );
    expect(result.state).toBe('test-queued');
    expect(result.heading).not.toMatch(/ready/i);
    expect(result.installLinkAvailable).toBe(false);
    expect(result.installLink).toMatchObject({ kind: 'live', status: 'active' });
    expect((result.installLink as { warning: string | null }).warning).not.toBeNull();
    const haystack = [result.heading, result.message, result.readinessSummary ?? '', ...result.notices.map((n) => n.text)].join(
      ' ',
    );
    expect(haystack).not.toMatch(CHECK_PASSED_PATTERN);
  });

  it('READY readiness + INSTALLING test → test-deploying (an active operation beats readiness)', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        readiness: { state: 'READY', requiredCount: 0, findings: [] },
        deployments: [deployment({ state: 'INSTALLING' })],
      }),
    );
    expect(result.state).toBe('test-deploying');
  });

  it('ANALYZING + a verified test deployment → analysing (the running analysis wins)', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        readiness: { analysisStatus: 'ANALYZING', state: 'ANALYSIS_INCOMPLETE' },
        deployments: [deployment({ state: 'HEALTHY' })],
      }),
    );
    expect(result.state).toBe('analysing');
  });

  it('required changes + a verified test + customers → configuration-required, lifecycle null', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        readiness: { state: 'NEEDS_CHANGES', findings: [requiredFinding()], requiredCount: 1 },
        deployments: [deployment({ state: 'HEALTHY' }), customer({ state: 'HEALTHY' })],
      }),
    );
    expect(result.state).toBe('configuration-required');
    expect(result.lifecycle).toBeNull();
  });

  it('FAILED analysis + INSTALLING test → test-deploying (the active operation beats the failed analysis)', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        readiness: { analysisStatus: 'FAILED', state: 'ANALYSIS_INCOMPLETE', failureReason: 'x' },
        deployments: [deployment({ state: 'INSTALLING' })],
      }),
    );
    expect(result.state).toBe('test-deploying');
  });
});

// ── 4. Active → terminal transitions ─────────────────────────────────────────

describe('test deployment: active states poll and are busy as documented, terminal states are not', () => {
  it.each([
    ['NOT_INSTALLED', TEST_DEPLOYMENT_POLL_MS, false],
    ['WAITING_FOR_RELAY', TEST_DEPLOYMENT_POLL_MS, true],
    ['INSTALLING', TEST_DEPLOYMENT_POLL_MS, true],
    ['DELETING', TEST_DEPLOYMENT_POLL_MS, true],
  ] as const)('%s is active: polling and busy', (state, polling, busy) => {
    const result = deriveApplicationPresentation(makeInput({ deployments: [deployment({ state })] }));
    expect(result.polling).toEqual({ intervalMs: polling });
    expect(result.busy).toBe(busy);
  });

  it.each(['HEALTHY', 'FAILED'] as const)('%s is terminal: no polling, not busy', (state) => {
    const result = deriveApplicationPresentation(makeInput({ deployments: [deployment({ state })] }));
    expect(result.polling).toBeNull();
    expect(result.busy).toBe(false);
  });

  it('DELETED is treated as no test deployment at all (terminal ready-to-test)', () => {
    const result = deriveApplicationPresentation(makeInput({ deployments: [deployment({ state: 'DELETED' })] }));
    expect(result.state).toBe('ready-to-test');
    expect(result.polling).toBeNull();
    expect(result.busy).toBe(false);
  });
});

describe('analysis: PENDING/ANALYZING poll, COMPLETE/FAILED do not', () => {
  it.each([
    ['PENDING', false],
    ['ANALYZING', true],
  ] as const)('%s is active', (status, busy) => {
    const result = deriveApplicationPresentation(
      makeInput({ readiness: { analysisStatus: status, state: 'ANALYSIS_INCOMPLETE' } }),
    );
    expect(result.polling).toEqual({ intervalMs: ANALYSIS_POLL_MS });
    expect(result.busy).toBe(busy);
  });

  it('COMPLETE is terminal', () => {
    const result = deriveApplicationPresentation(makeInput());
    expect(result.polling).toBeNull();
    expect(result.busy).toBe(false);
  });

  it('FAILED is terminal', () => {
    const result = deriveApplicationPresentation(
      makeInput({ readiness: { analysisStatus: 'FAILED', state: 'ANALYSIS_INCOMPLETE', failureReason: 'x' } }),
    );
    expect(result.polling).toBeNull();
    expect(result.busy).toBe(false);
  });

  it('analysisTakingLonger swaps the primary action to restart-analysis only while ANALYZING', () => {
    const pendingStuck = deriveApplicationPresentation(
      makeInput({ readiness: { analysisStatus: 'PENDING', state: 'ANALYSIS_INCOMPLETE' }, analysisTakingLonger: true }),
    );
    expect(pendingStuck.primaryAction?.id).toBe('analyse');

    const analyzingNotStuck = deriveApplicationPresentation(
      makeInput({ readiness: { analysisStatus: 'ANALYZING', state: 'ANALYSIS_INCOMPLETE' }, analysisTakingLonger: false }),
    );
    expect(analyzingNotStuck.primaryAction).toBeNull();

    const analyzingStuck = deriveApplicationPresentation(
      makeInput({ readiness: { analysisStatus: 'ANALYZING', state: 'ANALYSIS_INCOMPLETE' }, analysisTakingLonger: true }),
    );
    expect(analyzingStuck.primaryAction?.id).toBe('restart-analysis');
  });
});

// ── 5. Readiness summary, blockers, recommendations ──────────────────────────

describe('readiness summary, blockers and recommendations', () => {
  it.each([
    [1, '1 change required'],
    [3, '3 changes required'],
  ])('summarises %d required finding(s) as "%s"', (count, expected) => {
    const findings = Array.from({ length: count }, (_, i) => requiredFinding({ id: `f-${i}`, title: `Fix ${i}` }));
    const result = deriveApplicationPresentation(
      makeInput({ readiness: { state: 'NEEDS_CHANGES', findings, requiredCount: count } }),
    );
    expect(result.state).toBe('configuration-required');
    expect(result.readinessSummary).toBe(expected);
    // A finding stored before fix classes: a blocking finding is a capability gap.
    expect(result.blockers).toEqual(findings.map((f) => ({ id: f.id, title: f.title, group: 'CAPABILITY_GAP' })));
  });

  it('reads "No blocking issues" in ready-to-test — the analysis result, not release readiness', () => {
    const result = deriveApplicationPresentation(makeInput());
    expect(result.state).toBe('ready-to-test');
    expect(result.readinessSummary).toBe('No blocking issues');
  });

  it('reads "No blocking issues" after analysis once there is no blocking finding and the card is not ready-to-test', () => {
    const result = deriveApplicationPresentation(makeInput({ deployments: [deployment({ state: 'NOT_INSTALLED' })] }));
    expect(result.state).toBe('test-queued');
    expect(result.readinessSummary).toBe('No blocking issues');
  });

  it('is null before a completed analysis', () => {
    for (const status of ['PENDING', 'ANALYZING', 'FAILED'] as const) {
      const result = deriveApplicationPresentation(
        makeInput({
          readiness: { analysisStatus: status, state: 'ANALYSIS_INCOMPLETE', failureReason: status === 'FAILED' ? 'x' : null },
        }),
      );
      expect(result.readinessSummary, status).toBeNull();
    }
  });

  it('blockers are populated only in configuration-required, even when an active test op takes precedence', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        readiness: { state: 'NEEDS_CHANGES', findings: [requiredFinding()], requiredCount: 1 },
        deployments: [deployment({ state: 'NOT_INSTALLED' })],
      }),
    );
    expect(result.state).toBe('test-queued');
    expect(result.blockers).toEqual([]);
    // The readiness truth still shows through even though the card tells the test-deployment story.
    expect(result.readinessSummary).toBe('1 change required');
  });

  it('recommendationCount counts recommended findings regardless of state', () => {
    const result = deriveApplicationPresentation(
      makeInput({ readiness: { findings: [recommendedFinding(), recommendedFinding({ id: 'r2' })] } }),
    );
    expect(result.recommendationCount).toBe(2);
  });

  it('never renders a passed-check count anywhere, across the whole state matrix', () => {
    for (const [state, testCase] of Object.entries(STATE_CASES)) {
      const result = deriveApplicationPresentation(testCase.input);
      const haystack = [
        result.heading,
        result.message,
        result.badge.label,
        result.readinessSummary ?? '',
        ...result.notices.map((n) => n.text),
      ].join(' ');
      expect(haystack, state).not.toMatch(CHECK_PASSED_PATTERN);
    }
  });
});

// ── 6. Install link derivation ───────────────────────────────────────────────

describe('install link derivation', () => {
  const readyToShareInput = (installLinks: ApplicationStateInput['installLinks']) =>
    makeInput({ deployments: [deployment({ state: 'HEALTHY' })], installLinks });

  it('ready-to-share, no links → create with no note, primary create-install-link', () => {
    const result = deriveApplicationPresentation(readyToShareInput([]));
    expect(result.installLink).toEqual({ kind: 'create', note: null });
    expect(result.primaryAction?.id).toBe('create-install-link');
  });

  it('ready-to-share, only revoked links → create with a note', () => {
    const result = deriveApplicationPresentation(readyToShareInput([link({ status: 'revoked' })]));
    expect(result.installLink).toEqual({
      kind: 'create',
      note: 'The previous link was revoked. Create a new one to share.',
    });
  });

  it('ready-to-share, an active link → live/active, copy action, preview secondary', () => {
    const activeLink = link({ status: 'active' });
    const result = deriveApplicationPresentation(readyToShareInput([activeLink]));
    expect(result.installLink).toEqual({ kind: 'live', link: activeLink, status: 'active', warning: null });
    expect(result.primaryAction?.id).toBe('copy-install-link');
    expect(result.secondaryActions[0]).toMatchObject({
      id: 'preview-install-link',
      external: true,
      href: activeLink.url,
    });
  });

  it('ready-to-share, a disabled link → live/disabled, no warning', () => {
    const result = deriveApplicationPresentation(readyToShareInput([link({ status: 'disabled' })]));
    expect(result.installLink).toMatchObject({ kind: 'live', status: 'disabled', warning: null });
  });

  it('installLinks: null → loading', () => {
    const result = deriveApplicationPresentation(readyToShareInput(null));
    expect(result.installLink).toEqual({ kind: 'loading' });
  });

  it("installLinks: 'error' → error", () => {
    const result = deriveApplicationPresentation(readyToShareInput('error'));
    expect(result.installLink).toEqual({
      kind: 'error',
      message: "Couldn't load the install link. Try again.",
    });
  });

  it('not ready + no link → unavailable with a non-empty reason', () => {
    const result = deriveApplicationPresentation(makeInput({ installLinks: [] }));
    expect(result.state).toBe('ready-to-test');
    expect(result.installLink).toMatchObject({ kind: 'unavailable' });
    expect((result.installLink as { reason: string }).reason).toBeTruthy();
  });

  it('not ready + a disabled link → live with no warning', () => {
    const result = deriveApplicationPresentation(makeInput({ installLinks: [link({ status: 'disabled' })] }));
    expect(result.state).toBe('ready-to-test');
    expect(result.installLink).toMatchObject({ kind: 'live', status: 'disabled', warning: null });
  });

  it('the unavailable application state hides the install link entirely, placement none', () => {
    const result = deriveApplicationPresentation({
      data: null,
      installLinks: [link()],
      stale: false,
      analysisTakingLonger: false,
    });
    expect(result.installLink).toEqual({ kind: 'hidden' });
    expect(result.installLinkPlacement).toBe('none');
  });

  it('the unknown state also hides the install link, ignoring whatever links exist', () => {
    const result = deriveApplicationPresentation(
      makeInput({ readiness: { analysisStatus: 'QUEUED' as ApplicationReadiness['analysisStatus'] }, installLinks: [link()] }),
    );
    expect(result.state).toBe('unknown');
    expect(result.installLink).toEqual({ kind: 'hidden' });
    expect(result.installLinkPlacement).toBe('none');
  });

  it('customers-active places the install link as its own card, not primary', () => {
    const result = deriveApplicationPresentation(
      makeInput({ deployments: [customer({ state: 'HEALTHY' })], installLinks: [link({ status: 'active' })] }),
    );
    expect(result.installLinkAvailable).toBe(true);
    expect(result.installLinkPlacement).toBe('card');
  });

  it("an application that has never had an eligible link ('unavailable', lifecycle shown) gets no separate card", () => {
    for (const input of [
      makeInput({ readiness: { analysisStatus: 'ANALYZING', state: 'ANALYSIS_INCOMPLETE' } }),
      makeInput({ readiness: { state: 'NEEDS_CHANGES', findings: [requiredFinding()], requiredCount: 1 } }),
      makeInput(),
      makeInput({ deployments: [deployment({ state: 'NOT_INSTALLED' })] }),
    ]) {
      const result = deriveApplicationPresentation(input);
      expect(result.lifecycle, result.state).not.toBeNull();
      expect(result.installLink.kind, result.state).toBe('unavailable');
      expect(result.installLinkPlacement, result.state).toBe('none');
    }
  });
});

// ── Releases ──────────────────────────────────────────────────────────────────

describe('release naming', () => {
  it('configuration-required: blockers use requiredChangeLabel, one action to #required-changes', () => {
    const findings = [
      requiredFinding({ id: 'container-setup', title: 'Container detection failed', fixClass: 'CODE_CHANGE' }),
      requiredFinding({ id: 'health-check', title: 'No health check', fixClass: 'SETTING' }),
    ];
    const result = deriveApplicationPresentation(
      makeInput({ readiness: { state: 'NEEDS_CHANGES', findings, requiredCount: 2 } }),
    );
    expect(result.state).toBe('configuration-required');
    expect(result.heading).toBe('2 changes required before you can deploy');
    expect(result.blockers).toEqual([
      { id: 'container-setup', title: requiredChangeLabel(findings[0]!), group: 'CODE_CHANGE' },
      { id: 'health-check', title: requiredChangeLabel(findings[1]!), group: 'SETTING' },
    ]);
    expect(result.blockers.map((b) => b.title)).toEqual([
      'Add container build instructions (Dockerfile)',
      'Add a health check route',
    ]);
    expect(result.primaryAction).toEqual({
      id: 'review-configuration',
      label: 'Review required changes',
      href: '/dashboard/applications/app-1/config#required-changes',
      external: false,
    });
  });

  it('ready-to-test: names the release the test will use when one is ready', () => {
    const ready = release();
    const result = deriveApplicationPresentation(makeInput({ releases: [ready] }));
    expect(result.state).toBe('ready-to-test');
    expect(result.message).toContain('v0.1.0 (commit b2806f9)');
  });

  it('ready-to-test: says nothing about releases when the fetch failed', () => {
    const result = deriveApplicationPresentation(makeInput({ releases: 'error' }));
    expect(result.state).toBe('ready-to-test');
    expect(result.message).not.toMatch(/release/i);
  });

  it('first verified test, no install link: create, and the message names the installable release', () => {
    const ready = release({ version: 'v0.1.0', gitSha: 'b2806f9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e' });
    const result = deriveApplicationPresentation(
      makeInput({ deployments: [deployment({ state: 'HEALTHY' })], installLinks: [], releases: [ready] }),
    );
    expect(result.state).toBe('ready-to-share');
    expect(result.installLink).toEqual({ kind: 'create', note: null });
    expect(result.message).toContain('v0.1.0 (commit b2806f9)');
  });

  it('ready-to-share: no READY release points at Releases and says installs are refused', () => {
    const building = release({ status: 'BUILDING' });
    const result = deriveApplicationPresentation(
      makeInput({ deployments: [deployment({ state: 'HEALTHY' })], releases: [building] }),
    );
    expect(result.state).toBe('ready-to-share');
    expect(result.message).toMatch(/cannot install/i);
    expect(result.secondaryActions).toContainEqual({
      id: 'view-releases',
      label: 'View releases',
      href: '/dashboard/applications/app-1/releases',
      external: false,
    });
  });

  it('ready-to-share: releases "error" says nothing about releases', () => {
    const result = deriveApplicationPresentation(
      makeInput({ deployments: [deployment({ state: 'HEALTHY' })], releases: 'error' }),
    );
    expect(result.state).toBe('ready-to-share');
    expect(result.message).toBe('Test passed. Send the install link to customers.');
    expect(result.notices).toEqual([]);
  });

  it('existing active link + a newer FAILED release: Copy link stays primary, the older ready release is named, a separate failure notice appears', () => {
    const older = release({ id: 'r1', version: 'v0.1.0', createdAt: '2026-09-01T00:00:00.000Z' });
    const newerFailed = release({
      id: 'r2',
      version: 'v0.1.1',
      status: 'FAILED',
      createdAt: '2026-09-05T00:00:00.000Z',
    });
    const activeLink = link({ status: 'active' });
    const result = deriveApplicationPresentation(
      makeInput({
        deployments: [deployment({ state: 'HEALTHY' })],
        installLinks: [activeLink],
        releases: [older, newerFailed],
      }),
    );
    expect(result.state).toBe('ready-to-share');
    expect(result.primaryAction?.id).toBe('copy-install-link');
    expect(result.message).toContain('v0.1.0 (commit b2806f9)');
    expect(result.message).not.toContain('v0.1.1');
    expect(result.notices).toContainEqual({
      tone: 'warning',
      text: 'Release v0.1.1 failed to build. Customers get v0.1.0.',
    });
  });

  it('an active link while not ready to share describes what customers get now, not a warning to re-test', () => {
    const ready = release();
    const result = deriveApplicationPresentation(
      makeInput({ deployments: [deployment({ state: 'NOT_INSTALLED' })], installLinks: [link({ status: 'active' })], releases: [ready] }),
    );
    expect(result.state).toBe('test-queued');
    const warning = (result.installLink as { warning: string | null }).warning;
    expect(warning).toContain('v0.1.0 (commit b2806f9)');
    expect(warning).not.toMatch(/test.*pass(es)? again/i);
  });
});

// ── 7. Lifecycle ──────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  it('shows 4 steps, Analyse/Configure/Test/Share, in order during initial setup', () => {
    const result = deriveApplicationPresentation(makeInput());
    expect(result.lifecycle?.map((s) => s.step)).toEqual(['Analyse', 'Configure', 'Test', 'Share']);
    expect(result.lifecycle).toHaveLength(4);
  });

  it('is null once a verified test deployment exists', () => {
    const result = deriveApplicationPresentation(makeInput({ deployments: [deployment({ state: 'HEALTHY' })] }));
    expect(result.lifecycle).toBeNull();
  });

  it('is null once any customer deployment exists', () => {
    const result = deriveApplicationPresentation(makeInput({ deployments: [customer({ state: 'HEALTHY' })] }));
    expect(result.lifecycle).toBeNull();
  });

  it('stays null while re-analysing after setup is already complete', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        readiness: { analysisStatus: 'ANALYZING', state: 'ANALYSIS_INCOMPLETE' },
        deployments: [deployment({ state: 'HEALTHY' })],
      }),
    );
    expect(result.state).toBe('analysing');
    expect(result.lifecycle).toBeNull();
  });
});

// ── 8. attention notice while a customer-active card covers the test story ────

describe('customers-active test-deployment attention notice', () => {
  it('raises the attention notice when the test deployment failed, in place of the removed recentEvent line', () => {
    const test = deployment({ state: 'FAILED' });
    const result = deriveApplicationPresentation(makeInput({ deployments: [test, customer({ state: 'HEALTHY' })] }));
    expect(result.state).toBe('customers-active');
    expect(result.notices).toContainEqual({ tone: 'warning', text: 'Test deployment needs attention.' });
  });
});

describe('stale', () => {
  it('adds the stale notice without changing state', () => {
    const fresh = deriveApplicationPresentation(makeInput());
    const stale = deriveApplicationPresentation(makeInput({ stale: true }));
    expect(stale.state).toBe(fresh.state);
    expect(fresh.notices).toEqual([]);
    expect(stale.notices).toContainEqual({ tone: 'warning', text: STALE_NOTICE });
  });
});

// ── 9. customers-active ───────────────────────────────────────────────────────

describe('customers-active', () => {
  it('pluralises the heading', () => {
    const one = deriveApplicationPresentation(makeInput({ deployments: [customer({ id: 'c1' })] }));
    expect(one.heading).toBe('1 customer deployment');

    const two = deriveApplicationPresentation(
      makeInput({ deployments: [customer({ id: 'c1' }), customer({ id: 'c2' })] }),
    );
    expect(two.heading).toBe('2 customer deployments');
  });

  it('shows an attention message when a customer deployment failed', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        deployments: [customer({ id: 'c1', state: 'FAILED' }), customer({ id: 'c2', state: 'HEALTHY' })],
      }),
    );
    expect(result.message).toBe('1 deployment needs attention.');
    expect(result.badge).toEqual({ label: 'Needs attention', variant: 'warning' });
  });

  it('keeps the Live badge when every customer deployment is healthy', () => {
    const result = deriveApplicationPresentation(
      makeInput({ deployments: [customer({ id: 'c1', state: 'HEALTHY' })] }),
    );
    expect(result.badge).toEqual({ label: 'Live', variant: 'success' });
  });

  it('does not count DELETING, DELETED or soft-deleted customer deployments', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        deployments: [
          customer({ id: 'c1', state: 'HEALTHY' }),
          customer({ id: 'c2', state: 'DELETING' }),
          customer({ id: 'c3', state: 'DELETED' }),
          customer({ id: 'c4', state: 'HEALTHY', deletedAt: '2026-09-01T00:00:00.000Z' }),
        ],
      }),
    );
    expect(result.heading).toBe('1 customer deployment');
  });

  it('does not count TEST deployments toward the customer total', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        deployments: [customer({ id: 'c1', state: 'HEALTHY' }), deployment({ id: 't1', state: 'HEALTHY' })],
      }),
    );
    expect(result.heading).toBe('1 customer deployment');
  });

  it('URL-encodes the application name in the view-deployments href', () => {
    const result = deriveApplicationPresentation(
      makeInput({ deployments: [customer()], applicationName: 'Acme & Co' }),
    );
    expect(result.primaryAction).toMatchObject({
      id: 'view-customer-deployments',
      href: '/dashboard/deployments?application=Acme%20%26%20Co',
    });
  });
});

// ── Environment setup review ──────────────────────────────────────────────────

describe('configuration-review (environment setup)', () => {
  it('COMPLETE analysis + needsDecision > 0 → configuration-review, with the missing-value count named', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        readiness: { environmentSetup: environmentSetup({ needsDecision: 2, missingValue: 1, total: 3 }) },
      }),
    );
    expect(result.state).toBe('configuration-review');
    expect(result.badge.label).toBe('Needs input');
    expect(result.heading).toBe('Configuration needs review');
    expect(result.message).toBe(
      'Analysis finished. 2 environment variables need a decision. 1 needs a value.',
    );
    expect(result.primaryAction).toMatchObject({
      id: 'review-configuration',
      label: 'Review required changes',
      href: '/dashboard/applications/app-1/config#environment-variables',
    });
  });

  it('a missing vendor value alone → configuration-review', () => {
    const result = deriveApplicationPresentation(
      makeInput({ readiness: { environmentSetup: environmentSetup({ missingValue: 2, total: 2 }) } }),
    );
    expect(result.state).toBe('configuration-review');
    expect(result.message).toBe('Analysis finished. 2 environment variables need a value.');
  });

  it('a genuine analysis FAILED is unaffected by environmentSetup', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        readiness: {
          analysisStatus: 'FAILED',
          state: 'ANALYSIS_INCOMPLETE',
          failureReason: 'Boom',
          environmentSetup: environmentSetup({ needsDecision: 5, total: 5 }),
        },
      }),
    );
    expect(result.state).toBe('analysis-failed');
    expect(result.heading).toBe('Analysis failed');
  });

  it('needsDecision === 0 leaves existing ready states untouched', () => {
    const result = deriveApplicationPresentation(
      makeInput({ readiness: { environmentSetup: environmentSetup({ needsDecision: 0, total: 3 }) } }),
    );
    expect(result.state).toBe('ready-to-test');
  });

  it('null environmentSetup (not yet on the response) never throws and behaves like today', () => {
    const result = deriveApplicationPresentation(makeInput({ readiness: { environmentSetup: null } }));
    expect(result.state).toBe('ready-to-test');
  });

  it('with customer deployments present, the state stays customers-active and a notice is added instead', () => {
    const result = deriveApplicationPresentation(
      makeInput({
        deployments: [customer({ state: 'HEALTHY' })],
        readiness: { environmentSetup: environmentSetup({ needsDecision: 1, total: 1 }) },
      }),
    );
    expect(result.state).toBe('customers-active');
    expect(result.notices).toContainEqual({
      tone: 'warning',
      text: 'Analysis finished. 1 environment variable needs a decision.',
    });
  });
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('latestTestDeployment', () => {
  it('returns null when there are no TEST deployments', () => {
    expect(latestTestDeployment([customer()])).toBeNull();
  });

  it('ignores DELETED and soft-deleted TEST deployments', () => {
    const list = [
      deployment({ id: 't1', state: 'DELETED' }),
      deployment({ id: 't2', state: 'HEALTHY', deletedAt: '2026-09-01T00:00:00.000Z' }),
    ];
    expect(latestTestDeployment(list)).toBeNull();
  });

  it('returns the newest surviving TEST deployment by createdAt, in either input order', () => {
    const older = deployment({ id: 't1', state: 'FAILED', createdAt: '2026-08-01T00:00:00.000Z' });
    const newer = deployment({ id: 't2', state: 'HEALTHY', createdAt: '2026-09-01T00:00:00.000Z' });
    expect(latestTestDeployment([older, newer])?.id).toBe('t2');
    expect(latestTestDeployment([newer, older])?.id).toBe('t2');
  });
});

describe('testDeploymentPhase', () => {
  it('is "none" for null', () => {
    expect(testDeploymentPhase(null)).toBe('none');
  });

  it.each([
    ['NOT_INSTALLED', 'queued'],
    ['WAITING_FOR_RELAY', 'deploying'],
    ['INSTALLING', 'deploying'],
    ['UPDATING', 'deploying'],
    ['DELETING', 'removing'],
    ['FAILED', 'failed'],
    ['DISCONNECTED', 'failed'],
    ['HEALTHY', 'verified'],
    ['UPDATE_AVAILABLE', 'verified'],
    ['MIGRATING', 'unknown'],
  ] as const)('%s → %s', (state, phase) => {
    expect(testDeploymentPhase(deployment({ state: state as FleetDeployment['state'] }))).toBe(phase);
  });
});

describe('customerDeployments', () => {
  it('keeps only live PRODUCTION deployments', () => {
    const list = [
      customer({ id: 'c1', state: 'HEALTHY' }),
      customer({ id: 'c2', state: 'DELETING' }),
      customer({ id: 'c3', state: 'DELETED' }),
      customer({ id: 'c4', deletedAt: '2026-09-01T00:00:00.000Z' }),
      deployment({ id: 't1', state: 'HEALTHY' }),
    ];
    expect(customerDeployments(list).map((d) => d.id)).toEqual(['c1']);
  });
});

describe('release readiness is shown apart from the analysis state', () => {
  function release(overrides: Partial<Release> = {}): Release {
    return {
      id: 'rel-1',
      version: 'v1.0.0',
      status: 'READY',
      failureReason: null,
      gitSha: 'a'.repeat(40),
      createdAt: '2026-09-01T00:00:00.000Z',
      ...overrides,
    };
  }
  function withReleases(releases: Release[] | 'error', deployments: FleetDeployment[] = []) {
    const input = makeInput({ deployments });
    return deriveApplicationPresentation({ ...input, data: { ...input.data!, releases } });
  }

  it('does not offer a test deployment when the only release failed', () => {
    const result = withReleases([release({ status: 'FAILED' })]);
    expect(result.state).toBe('ready-to-test');
    expect(result.badge.label).toBe('Ready to test');
    expect(result.heading).toBe('No release to test');
    expect(result.primaryAction).toMatchObject({ id: 'view-releases', href: '/dashboard/applications/app-1/releases' });
  });

  it('keeps an older READY release deployable when a newer build failed', () => {
    const result = withReleases([
      release({ id: 'old', status: 'READY', createdAt: '2026-09-01T00:00:00.000Z' }),
      release({ id: 'new', status: 'FAILED', createdAt: '2026-09-02T00:00:00.000Z' }),
    ]);
    expect(result.primaryAction?.id).toBe('start-test');
  });

  it('waits and polls while the release builds', () => {
    const result = withReleases([release({ status: 'BUILDING' })]);
    expect(result.heading).toBe('Building a release');
    expect(result.polling).toEqual({ intervalMs: TEST_DEPLOYMENT_POLL_MS });
  });

  it('keeps the create-page path when there is no release yet, and when releases are unknown', () => {
    expect(withReleases([]).primaryAction?.id).toBe('start-test');
    expect(withReleases('error').primaryAction?.id).toBe('start-test');
  });

  it('never changes a later state because a release failed', () => {
    const result = withReleases([release({ status: 'FAILED' })], [deployment({ state: 'INSTALLING' })]);
    expect(result.state).toBe('test-deploying');
  });

  it('maps every release mix to one readiness', () => {
    expect(releaseReadiness([])).toBe('none');
    expect(releaseReadiness([release({ status: 'UNAVAILABLE' })])).toBe('unavailable');
    expect(releaseReadiness([release({ status: 'UNAVAILABLE' }), release({ id: 'f', status: 'FAILED' })])).toBe('failed');
  });
});

describe('applicationListBadge', () => {
  const app = { id: 'a1', name: 'App', defaultBranch: 'main' };

  it('reads Ready to test for a clean analysis with no deployments', () => {
    expect(applicationListBadge(app, readiness(), []).label).toBe('Ready to test');
  });

  it('reads Needs input for a required change or an env decision', () => {
    expect(applicationListBadge(app, readiness({ findings: [requiredFinding()] }), []).label).toBe('Needs input');
    expect(
      applicationListBadge(app, readiness({ environmentSetup: environmentSetup({ needsDecision: 3 }) }), []).label,
    ).toBe('Needs input');
  });

  it('reads Test failed and Needs attention from the deployments, as the page does', () => {
    expect(
      applicationListBadge(app, readiness(), [deployment({ state: 'FAILED' })]).label,
    ).toBe('Test failed');
    expect(
      applicationListBadge(app, readiness(), [customer({ id: 'c1', state: 'FAILED' })]).label,
    ).toBe('Needs attention');
  });
});

describe('deployability outcome and build check', () => {
  const settingOnly = {
    state: 'ALMOST_READY' as const,
    outcome: 'DEPLOYABLE' as const,
    findings: [requiredFinding({ id: 'health-check', blocking: false, fixClass: 'SETTING' })],
    requiredCount: 1,
  };

  it('DEPLOYABLE is not yet confirmed until a release build passes', () => {
    const result = deriveApplicationPresentation(makeInput({ readiness: settingOnly, releases: [] }));
    expect(result.outcome).toEqual({
      outcome: 'DEPLOYABLE',
      label: 'Deployable with Deployz settings',
      detail: 'Not yet confirmed by a build.',
      action: null,
    });
  });

  it('DEPLOYABLE is confirmed by a passed release build', () => {
    const result = deriveApplicationPresentation(makeInput({ readiness: settingOnly, releases: [release()] }));
    expect(result.outcome).toMatchObject({ outcome: 'DEPLOYABLE', detail: null });
  });

  it('a failed release build with no passed build moves DEPLOYABLE to DEPLOYABLE_WITH_CHANGES', () => {
    const result = deriveApplicationPresentation(
      makeInput({ readiness: settingOnly, releases: [release({ status: 'FAILED', failureReason: 'build failed' })] }),
    );
    expect(result.outcome).toEqual({
      outcome: 'DEPLOYABLE_WITH_CHANGES',
      label: 'Deployable after repository changes',
      detail: 'The release build failed.',
      action: { id: 'view-releases', label: 'Review failure details', href: '/dashboard/applications/app-1/releases', external: false },
    });
  });

  it('groups the required items by fix class', () => {
    const findings = [
      requiredFinding({ id: 'health-check', blocking: false, fixClass: 'SETTING' }),
      requiredFinding({ id: 'local-file-storage', blocking: false, fixClass: 'CODE_CHANGE' }),
      requiredFinding({ id: 'unsupported-database-mongo', blocking: true, fixClass: 'CAPABILITY_GAP' }),
    ];
    const result = deriveApplicationPresentation(
      makeInput({ readiness: { state: 'NEEDS_CHANGES', outcome: 'NOT_DEPLOYABLE', findings, requiredCount: 3 } }),
    );
    expect(result.blockers.map((b) => b.group)).toEqual(['SETTING', 'CODE_CHANGE', 'CAPABILITY_GAP']);
    expect(result.outcome).toMatchObject({ outcome: 'NOT_DEPLOYABLE', label: 'Not deployable on Deployz', detail: null });
  });

  it('shows no outcome for a report stored before it', () => {
    expect(deriveApplicationPresentation(makeInput()).outcome).toBeNull();
  });
});
