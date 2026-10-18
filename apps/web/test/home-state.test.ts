import { describe, expect, it } from 'vitest';

import type { Application } from '../src/lib/applications';
import { filterDeployments, parseDeploymentQuery } from '../src/lib/deployment-list';
import { DEPLOYMENT_STATES } from '../src/lib/deployment-vocabulary';
import type { FleetDeployment } from '../src/lib/deployments';
import {
  attentionReason,
  deriveHomeState,
  isApplicationReady,
  nextSteps,
  onboardingSteps,
  OVERVIEW_METRIC_HREFS,
  primaryApplication,
  summarise,
  type HomeState,
  type OverviewSummary,
} from '../src/lib/home-state';

function application(overrides: Partial<Application> = {}): Application {
  return {
    id: 'app-1',
    organizationId: 'org-1',
    name: 'MyApp',
    githubInstallationId: 'install-1',
    repoFullName: 'acme/myapp',
    repoUrl: 'https://github.com/acme/myapp',
    defaultBranch: 'main',
    containerPort: 3000,
    healthPath: '/healthz',
    migrationCommand: null,
    workerCommand: null,
    databaseRequired: true,
    storageRequired: false,
    redisRequired: false,
    defaultSizeProfile: 'small',
    minimumSizeProfile: 'small',
    analysisStatus: 'COMPLETE',
    compatibilityStatus: 'READY',
    compatibilityReason: null,
    detectedMetadata: { hasDockerfile: true },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function deployment(overrides: Partial<FleetDeployment> = {}): FleetDeployment {
  return {
    id: 'dep-1',
    customerId: 'cus-1',
    applicationId: 'app-1',
    organizationId: 'org-1',
    region: 'us-east-1',
    state: 'HEALTHY',
    awsAccountId: '1234••••••',
    currentReleaseId: null,
    previousReleaseId: null,
    relayStatus: 'CONNECTED',
    healthStatus: 'HEALTHY',
    desiredState: {},
    observedState: null,
    infraVersion: 'runtime-v1',
    installationId: 'inst-1',
    deploymentType: 'PRODUCTION',
    billingState: 'NOT_STARTED',
    billingStartedAt: null,
    billingStoppedAt: null,
    lastHealthAt: null,
    deletedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    createdBy: null,
    updatedBy: null,
    customerName: 'Acme Corp',
    applicationName: 'MyApp',
    version: '1.4.2',
    attemptNumber: 1,
    bootstrapStackName: null,
    installStartedAt: null,
    ...overrides,
  };
}

describe('attentionReason', () => {
  it('flags failed and disconnected deployments', () => {
    expect(attentionReason(deployment({ state: 'FAILED' }))).toBe('Deployment failed');
    expect(attentionReason(deployment({ state: 'DISCONNECTED' }))).toBe('Deployment disconnected');
  });

  it('flags a healthy-state deployment whose health or relay says otherwise', () => {
    expect(attentionReason(deployment({ relayStatus: 'DISCONNECTED' }))).toBe(
      'Lost contact with this deployment',
    );
    expect(attentionReason(deployment({ healthStatus: 'UNHEALTHY' }))).toBe('Health check failing');
    expect(attentionReason(deployment({ healthStatus: 'DEGRADED' }))).toBe('Health check degraded');
  });

  it('leaves healthy, in-flight and not-yet-installed deployments alone', () => {
    expect(attentionReason(deployment())).toBeNull();
    expect(attentionReason(deployment({ state: 'INSTALLING' }))).toBeNull();
    expect(attentionReason(deployment({ state: 'UPDATE_AVAILABLE' }))).toBeNull();
    // Nobody has installed it yet, so its default health is not a problem.
    expect(attentionReason(deployment({ state: 'NOT_INSTALLED', relayStatus: 'UNKNOWN' }))).toBeNull();
    expect(attentionReason(deployment({ state: 'WAITING_FOR_RELAY', relayStatus: 'UNKNOWN' }))).toBeNull();
    expect(attentionReason(deployment({ state: 'DELETING', healthStatus: 'UNHEALTHY' }))).toBeNull();
  });

  it('flags a failed day-2 attempt while the previous release still serves', () => {
    const withDayTwoFailure = deployment({
      deploymentStatus: { failure: { message: 'The new release failed its health checks.' } },
    } as never);
    expect(attentionReason(withDayTwoFailure)).toBe('Update failed');
  });
});

describe('isApplicationReady / primaryApplication', () => {
  it('requires both a finished analysis and a READY verdict', () => {
    expect(isApplicationReady(application())).toBe(true);
    expect(isApplicationReady(application({ analysisStatus: 'ANALYZING' }))).toBe(false);
    expect(isApplicationReady(application({ compatibilityStatus: 'NEEDS_ATTENTION' }))).toBe(false);
  });

  it('prefers a ready application over a newer unready one', () => {
    const ready = application({ id: 'ready', createdAt: '2026-08-01T00:00:00.000Z' });
    const analysing = application({
      id: 'analysing',
      analysisStatus: 'ANALYZING',
      compatibilityStatus: null,
      createdAt: '2026-08-05T00:00:00.000Z',
    });
    expect(primaryApplication([ready, analysing])?.id).toBe('ready');
  });

  it('falls back to the newest application when none is ready', () => {
    const older = application({ id: 'older', analysisStatus: 'PENDING', compatibilityStatus: null });
    const newer = application({
      id: 'newer',
      analysisStatus: 'PENDING',
      compatibilityStatus: null,
      createdAt: '2026-08-09T00:00:00.000Z',
    });
    expect(primaryApplication([older, newer])?.id).toBe('newer');
    expect(primaryApplication([])).toBeNull();
  });
});

describe('summarise', () => {
  it('counts each deployment exactly once, in the four Overview metrics', () => {
    const summary = summarise([
      deployment({ id: 'a' }),
      deployment({ id: 'b', state: 'UPDATE_AVAILABLE' }),
      deployment({ id: 'c', state: 'FAILED' }),
      deployment({ id: 'd', state: 'INSTALLING' }),
      deployment({ id: 'e', state: 'NOT_INSTALLED' }),
      deployment({ id: 'g', state: 'WAITING_FOR_RELAY' }),
      // Unhealthy but still in the HEALTHY state: counted as attention, not live.
      deployment({ id: 'f', healthStatus: 'UNHEALTHY' }),
    ]);
    // A live deployment with an update available is still live; WAITING_FOR_RELAY
    // is deploying — the customer already approved the connector.
    expect(summary).toEqual({ live: 2, attention: 2, deploying: 2, awaiting: 1 });
  });

  it('counts a recovered deployment as live: an earlier failed attempt is history', () => {
    // The API clears `failure` once a later attempt succeeds; only the
    // current state and health decide.
    const recovered = deployment({ attemptNumber: 3, deploymentStatus: { failure: null } } as never);
    expect(summarise([recovered])).toEqual({ live: 1, attention: 0, deploying: 0, awaiting: 0 });
  });

  it('counts a state this build does not know as attention, never as live', () => {
    const unknown = deployment({ state: 'SOMETHING_NEW' as FleetDeployment['state'] });
    expect(summarise([unknown]).attention).toBe(1);
  });
});

// Every metric links to a filtered Deployments view. The count must equal the
// rows that view shows, for every state and attention overlay.
describe('Overview metrics agree with their filtered Deployments views', () => {
  const fleet: FleetDeployment[] = [
    ...DEPLOYMENT_STATES.filter((state) => state !== 'DELETED').map((state) =>
      deployment({ id: `state-${state}`, state }),
    ),
    deployment({ id: 'lost', relayStatus: 'DISCONNECTED' }),
    deployment({ id: 'degraded', state: 'UPDATE_AVAILABLE', healthStatus: 'DEGRADED' }),
    deployment({ id: 'unknown-health', healthStatus: 'UNKNOWN' }),
    deployment({ id: 'day-two', deploymentStatus: { failure: { message: 'x' } } } as never),
  ];
  const summary = summarise(fleet);

  it.each(Object.keys(OVERVIEW_METRIC_HREFS) as (keyof OverviewSummary)[])('%s', (metric) => {
    const query = parseDeploymentQuery(new URL(OVERVIEW_METRIC_HREFS[metric], 'https://x').searchParams);
    expect(query.status).not.toBeNull();
    expect(filterDeployments(fleet, query)).toHaveLength(summary[metric]);
  });

  it('covers the whole active fleet', () => {
    const total = summary.live + summary.attention + summary.deploying + summary.awaiting;
    expect(total).toBe(fleet.length);
  });
});

describe('onboardingSteps', () => {
  const states = (app: Application | null) => onboardingSteps(app).map((step) => step.state);
  const actions = (app: Application | null) =>
    onboardingSteps(app).flatMap((step) => (step.action === null ? [] : [step.action]));

  it('a new workspace starts at Add application, with only that action', () => {
    expect(states(null)).toEqual(['current', 'upcoming', 'upcoming']);
    expect(actions(null)).toEqual([{ label: 'Add application', href: '/dashboard/applications' }]);
  });

  it('never reports configuration as done while the analysis is running', () => {
    const analysing = application({ analysisStatus: 'ANALYZING', compatibilityStatus: null });
    expect(states(analysing)).toEqual(['complete', 'current', 'upcoming']);
    expect(onboardingSteps(analysing)[1]?.detail).toBe('Analyzing MyApp…');
    expect(actions(analysing)).toEqual([{ label: 'View application', href: '/dashboard/applications/app-1' }]);
  });

  it('routes required changes to the configuration and a failed analysis to the application', () => {
    expect(actions(application({ compatibilityStatus: 'NEEDS_ATTENTION' }))).toEqual([
      { label: 'Review configuration', href: '/dashboard/applications/app-1/config#required-changes' },
    ]);
    expect(actions(application({ analysisStatus: 'FAILED', compatibilityStatus: null }))).toEqual([
      { label: 'Review application', href: '/dashboard/applications/app-1' },
    ]);
  });

  it('a ready application guides the vendor to the first deployment', () => {
    expect(states(application())).toEqual(['complete', 'complete', 'current']);
    expect(actions(application())).toEqual([
      { label: 'Create deployment', href: '/dashboard/deployments/new?applicationId=app-1' },
    ]);
  });
});

describe('nextSteps', () => {
  function steps(deployments: FleetDeployment[], applications: Application[] = [application()]) {
    return nextSteps({ deployments, applications, summary: summarise(deployments) });
  }

  it('is empty when everything is live, and hides zero counts', () => {
    expect(steps([deployment({ id: 'a' }), deployment({ id: 'b' })])).toEqual([]);
  });

  it('does not treat normal in-progress deployments as tasks', () => {
    expect(
      steps([deployment({ id: 'a', state: 'INSTALLING' }), deployment({ id: 'b', state: 'UPDATING' })]),
    ).toEqual([]);
  });

  it('groups every deployment that needs attention into one row', () => {
    const fleet = Array.from({ length: 6 }, (_, i) => deployment({ id: `f-${i}`, state: 'FAILED' }));
    expect(steps(fleet)).toEqual([
      {
        id: 'attention',
        title: '6 deployments need attention',
        action: { label: 'Review deployments', href: '/dashboard/deployments?status=attention' },
      },
    ]);
    expect(steps(fleet.slice(0, 1))[0]?.title).toBe('1 deployment needs attention');
  });

  it('counts customers, not deployments, that have not completed setup', () => {
    const result = steps([
      deployment({ id: 'a', customerId: 'c-1', state: 'NOT_INSTALLED' }),
      deployment({ id: 'b', customerId: 'c-1', state: 'NOT_INSTALLED' }),
    ]);
    expect(result).toEqual([
      {
        id: 'awaiting-customer',
        title: '1 customer hasn’t completed setup',
        action: { label: 'View pending setups', href: '/dashboard/deployments?status=waiting' },
      },
    ]);
  });

  it('adds an application task only when no application can be deployed', () => {
    const fleet = [deployment()];
    const blocked = application({ compatibilityStatus: 'NEEDS_ATTENTION' });
    expect(steps(fleet, [blocked]).map((step) => step.id)).toEqual(['configuration']);
    expect(steps(fleet, [blocked, application({ id: 'ok' })])).toEqual([]);
    // A running analysis is not a task yet.
    expect(steps(fleet, [application({ analysisStatus: 'ANALYZING', compatibilityStatus: null })])).toEqual([]);
  });

  it('orders the rows by urgency and shows at most three', () => {
    const result = steps(
      [
        deployment({ id: 'a', state: 'NOT_INSTALLED', customerId: 'c-2' }),
        deployment({ id: 'b', state: 'FAILED' }),
      ],
      [application({ compatibilityStatus: 'NOT_COMPATIBLE' })],
    );
    expect(result.map((step) => step.id)).toEqual(['attention', 'awaiting-customer', 'configuration']);
  });
});

describe('deriveHomeState', () => {
  function overview(home: HomeState) {
    if (home.kind !== 'overview') throw new Error(`expected overview, got ${home.kind}`);
    return home;
  }

  it('shows the onboarding checklist until a customer deployment exists', () => {
    expect(deriveHomeState({ applications: [], deployments: [] }).kind).toBe('onboarding');
    expect(deriveHomeState({ applications: [application()], deployments: [] }).kind).toBe('onboarding');
  });

  it('ignores deleted deployments entirely', () => {
    const home = deriveHomeState({
      applications: [application()],
      deployments: [
        deployment({ id: 'gone', state: 'DELETED' }),
        deployment({ id: 'also-gone', deletedAt: '2026-08-03T00:00:00.000Z' }),
      ],
    });
    expect(home.kind).toBe('onboarding');
  });

  it('switches to the overview at the first deployment, whatever its state', () => {
    for (const state of ['NOT_INSTALLED', 'INSTALLING', 'HEALTHY'] as const) {
      expect(deriveHomeState({ applications: [application()], deployments: [deployment({ state })] }).kind).toBe(
        'overview',
      );
    }
  });

  it('claims all healthy only when every deployment is live and reports HEALTHY', () => {
    const healthy = overview(
      deriveHomeState({
        applications: [application()],
        deployments: [deployment({ id: 'a' }), deployment({ id: 'b', state: 'UPDATE_AVAILABLE' })],
      }),
    );
    expect(healthy.allHealthy).toBe(true);
    expect(healthy.nextSteps).toEqual([]);

    const installing = overview(
      deriveHomeState({
        applications: [application()],
        deployments: [deployment({ id: 'a' }), deployment({ id: 'b', state: 'INSTALLING' })],
      }),
    );
    expect(installing.allHealthy).toBe(false);
    expect(installing.nextSteps).toEqual([]);
  });

  it('never claims health a deployment has not reported', () => {
    const home = overview(
      deriveHomeState({
        applications: [application()],
        deployments: [deployment({ id: 'a' }), deployment({ id: 'b', healthStatus: 'UNKNOWN' })],
      }),
    );
    expect(home.summary.live).toBe(2);
    expect(home.healthUnknown).toBe(1);
    expect(home.allHealthy).toBe(false);
  });

  it('keeps checking back quickly only while something is being set up', () => {
    const analysing = deriveHomeState({
      applications: [application({ analysisStatus: 'ANALYZING', compatibilityStatus: null })],
      deployments: [],
    });
    expect(analysing.settled).toBe(false);
    expect(deriveHomeState({ applications: [application()], deployments: [] }).settled).toBe(true);
    expect(
      deriveHomeState({ applications: [application()], deployments: [deployment({ state: 'INSTALLING' })] })
        .settled,
    ).toBe(false);
    expect(
      deriveHomeState({
        applications: [application()],
        deployments: [deployment({ id: 'a', state: 'INSTALLING' }), deployment({ id: 'b' })],
      }).settled,
    ).toBe(true);
  });
});

