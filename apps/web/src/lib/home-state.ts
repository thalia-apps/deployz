// Homepage (Overview) state derivation. The homepage renders one of two
// states from the organization's real applications and deployments — there
// is no separate "homepage" endpoint, and nothing here invents data the
// backend does not have. Kept pure (no fetching, no React) so it is
// unit-testable.

import type { Application } from './applications';
import { deploymentDisplayStatus } from './deployment-status-groups';
import type { FleetDeployment } from './deployments';

// ── Deployments that need the vendor to act ────────────────────────────────

/**
 * Why this deployment needs attention, or null when it does not. Only the
 * §46 states and the relay/health columns the API actually returns are
 * classified — never a fabricated condition.
 */
export function attentionReason(deployment: FleetDeployment): string | null {
  if (deployment.state === 'FAILED') return 'Deployment failed';
  if (deployment.state === 'DISCONNECTED') return 'Deployment disconnected';
  // A deployment nobody has installed yet (launched or not), or one on its
  // way out, cannot be unhealthy in a way the vendor can act on.
  if (
    deployment.state === 'NOT_INSTALLED' ||
    deployment.state === 'WAITING_FOR_RELAY' ||
    deployment.state === 'DELETING' ||
    deployment.state === 'DELETED'
  ) {
    return null;
  }
  if (deployment.relayStatus === 'DISCONNECTED') return 'Lost contact with this deployment';
  // Every workload intentionally at zero tasks is not an outage.
  const notStarted = deployment.deploymentStatus?.health?.notStarted === true;
  if (!notStarted && deployment.healthStatus === 'UNHEALTHY') return 'Health check failing';
  if (!notStarted && deployment.healthStatus === 'DEGRADED') return 'Health check degraded';
  // The latest day-2 attempt failed while the previous release still serves
  // (the API only sets this while the most recent attempt is the failed one —
  // a later success clears it; see apps/api/src/deployment-status.ts).
  if (deployment.deploymentStatus?.failure) return 'Update failed';
  return null;
}

// ── Overview summary ───────────────────────────────────────────────────────

/**
 * The four Overview counts. Each is one status group of
 * lib/deployment-status-groups, so a count always equals the rows its
 * filtered Deployments view shows.
 */
export interface OverviewSummary {
  /** `status=healthy`: live, including live deployments with an update available. */
  live: number;
  /** `status=attention`: failed, unreachable, unhealthy or of unknown status. */
  attention: number;
  /** `status=in-progress`: setting up, updating or removing. */
  deploying: number;
  /** `status=waiting`: created, but the customer has not installed it yet. */
  awaiting: number;
}

/** Each Overview metric's filtered Deployments view. */
export const OVERVIEW_METRIC_HREFS: Record<keyof OverviewSummary, string> = {
  live: '/dashboard/deployments?status=healthy',
  attention: '/dashboard/deployments?status=attention',
  deploying: '/dashboard/deployments?status=in-progress',
  awaiting: '/dashboard/deployments?status=waiting',
};

/** Deployments the vendor still has: deleted ones leave the homepage. */
function activeDeployments(deployments: FleetDeployment[]): FleetDeployment[] {
  return deployments.filter(
    (deployment) => deployment.state !== 'DELETED' && deployment.deletedAt === null,
  );
}

export function summarise(deployments: FleetDeployment[]): OverviewSummary {
  const summary: OverviewSummary = { live: 0, attention: 0, deploying: 0, awaiting: 0 };
  for (const deployment of deployments) {
    const { group } = deploymentDisplayStatus(deployment);
    if (group === 'healthy' || group === 'update-available') summary.live += 1;
    else if (group === 'attention') summary.attention += 1;
    else if (group === 'in-progress') summary.deploying += 1;
    else if (group === 'waiting') summary.awaiting += 1;
  }
  return summary;
}

// ── Applications ───────────────────────────────────────────────────────────

/** An application is deployable once analysis finished and the verdict is READY. */
export function isApplicationReady(application: Application): boolean {
  return application.analysisStatus === 'COMPLETE' && application.compatibilityStatus === 'READY';
}

function isAnalysing(application: Application): boolean {
  return application.analysisStatus === 'PENDING' || application.analysisStatus === 'ANALYZING';
}

/**
 * The application the homepage speaks for. An organization can own several,
 * so a ready one wins (it is the one a customer can be deployed to); failing
 * that, the most recently created one is the one still being prepared.
 */
export function primaryApplication(applications: Application[]): Application | null {
  const ready = applications.filter(isApplicationReady);
  const pool = ready.length > 0 ? ready : applications;
  return [...pool].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
}

/** One link: the single action a step or task offers. */
export interface HomeAction {
  label: string;
  href: string;
}

/** Where the vendor fixes an application whose analysis did not pass. */
function configurationAction(application: Application): HomeAction {
  return application.analysisStatus === 'FAILED'
    ? { label: 'Review application', href: `/dashboard/applications/${application.id}` }
    : {
        label: 'Review configuration',
        href: `/dashboard/applications/${application.id}/config#required-changes`,
      };
}

// ── Onboarding checklist ───────────────────────────────────────────────────

export type OnboardingStepState = 'complete' | 'current' | 'upcoming';

export interface OnboardingStep {
  label: string;
  state: OnboardingStepState;
  /** One line about the step, shown only on the current step. */
  detail: string | null;
  /** Only the current step carries an action, and only when there is one. */
  action: HomeAction | null;
}

/**
 * Add application → Review configuration → Create deployment, from the
 * application's real analysis state. A step is complete only when the data
 * says so; nothing is reported as configured while analysis is still running.
 */
export function onboardingSteps(application: Application | null): OnboardingStep[] {
  const steps: OnboardingStep[] = [
    { label: 'Add application', state: 'upcoming', detail: null, action: null },
    { label: 'Review configuration', state: 'upcoming', detail: null, action: null },
    { label: 'Create deployment', state: 'upcoming', detail: null, action: null },
  ];
  let current: number;
  if (application === null) {
    current = 0;
    steps[0] = {
      ...steps[0]!,
      detail: 'Connect the GitHub repository you want to deploy.',
      action: { label: 'Add application', href: '/dashboard/applications' },
    };
  } else if (!isApplicationReady(application)) {
    current = 1;
    steps[1] = {
      ...steps[1]!,
      ...(isAnalysing(application)
        ? {
            detail: `Analyzing ${application.name}…`,
            action: { label: 'View application', href: `/dashboard/applications/${application.id}` },
          }
        : {
            detail:
              application.analysisStatus === 'FAILED'
                ? `The analysis of ${application.name} failed.`
                : `${application.name} needs changes before it can be deployed.`,
            action: configurationAction(application),
          }),
    };
  } else {
    current = 2;
    steps[2] = {
      ...steps[2]!,
      detail: `Deploy ${application.name} into a customer's AWS account.`,
      action: {
        label: 'Create deployment',
        href: `/dashboard/deployments/new?applicationId=${application.id}`,
      },
    };
  }
  return steps.map((step, index) => ({
    ...step,
    state: index < current ? 'complete' : index === current ? 'current' : 'upcoming',
  }));
}

// ── Next steps ─────────────────────────────────────────────────────────────

export interface NextStep {
  id: 'attention' | 'awaiting-customer' | 'configuration';
  title: string;
  action: HomeAction;
}

/**
 * At most three actionable rows, most urgent first. Zero counts are hidden,
 * and normal in-progress deployments are not tasks. An application task
 * appears only when it blocks onboarding: no application can be deployed and
 * none is still being analysed.
 */
export function nextSteps(input: {
  deployments: FleetDeployment[];
  applications: Application[];
  summary: OverviewSummary;
}): NextStep[] {
  const steps: NextStep[] = [];
  const { attention } = input.summary;
  if (attention > 0) {
    steps.push({
      id: 'attention',
      title: attention === 1 ? '1 deployment needs attention' : `${attention} deployments need attention`,
      action: { label: 'Review deployments', href: OVERVIEW_METRIC_HREFS.attention },
    });
  }

  const awaitingCustomers = new Set(
    input.deployments
      .filter((deployment) => deploymentDisplayStatus(deployment).group === 'waiting')
      .map((deployment) => deployment.customerId),
  ).size;
  if (awaitingCustomers > 0) {
    steps.push({
      id: 'awaiting-customer',
      title:
        awaitingCustomers === 1
          ? '1 customer hasn’t completed setup'
          : `${awaitingCustomers} customers haven’t completed setup`,
      action: { label: 'View pending setups', href: OVERVIEW_METRIC_HREFS.awaiting },
    });
  }

  const blocked =
    input.applications.length > 0 &&
    !input.applications.some((application) => isApplicationReady(application) || isAnalysing(application));
  const application = blocked ? primaryApplication(input.applications) : null;
  if (application !== null) {
    steps.push({
      id: 'configuration',
      title: `${application.name} can’t be deployed to new customers`,
      action: configurationAction(application),
    });
  }

  return steps.slice(0, 3);
}

// ── The homepage state ─────────────────────────────────────────────────────

export type HomeState =
  /** No customer deployment yet: the onboarding checklist. */
  | {
      kind: 'onboarding';
      steps: OnboardingStep[];
      /** False while an analysis is running, so the page checks back sooner. */
      settled: boolean;
    }
  /** At least one customer deployment: the summary and next steps. */
  | {
      kind: 'overview';
      summary: OverviewSummary;
      nextSteps: NextStep[];
      /** Live deployments whose health has not been reported yet. */
      healthUnknown: number;
      /** True only when every deployment is live and reports HEALTHY. */
      allHealthy: boolean;
      /** False while the organization's only deployment is still being set up. */
      settled: boolean;
    };

export function deriveHomeState(input: {
  applications: Application[];
  deployments: FleetDeployment[];
}): HomeState {
  const deployments = activeDeployments(input.deployments);

  if (deployments.length === 0) {
    const application = primaryApplication(input.applications);
    return {
      kind: 'onboarding',
      steps: onboardingSteps(application),
      settled: application === null || !isAnalysing(application),
    };
  }

  const summary = summarise(deployments);
  const healthUnknown = deployments.filter((deployment) => {
    const { group } = deploymentDisplayStatus(deployment);
    return (group === 'healthy' || group === 'update-available') && deployment.healthStatus !== 'HEALTHY';
  }).length;
  const only = deployments.length === 1 ? deployments[0]! : null;

  return {
    kind: 'overview',
    summary,
    nextSteps: nextSteps({ deployments, applications: input.applications, summary }),
    healthUnknown,
    allHealthy: summary.live === deployments.length && healthUnknown === 0,
    settled: !(
      only !== null &&
      (only.state === 'NOT_INSTALLED' ||
        only.state === 'WAITING_FOR_RELAY' ||
        only.state === 'INSTALLING')
    ),
  };
}
