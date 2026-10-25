// The one place that says what state an application is in on the vendor's
// application page. The header badge, the primary card, the setup lifecycle,
// the install-link card and the poll loop all read the presentation this
// module derives — no section interprets `analysisStatus`, readiness findings
// or a deployment `state` for itself, so two sections cannot disagree.
//
// Nothing here is persisted and nothing is invented: the inputs are the API's
// own application, readiness, deployment and install-link responses.

import { requiredChangeLabel } from '@/lib/application-configuration';
import { deploymentDisplayStatus } from '@/lib/deployment-status-groups';
import type { FleetDeployment } from '@/lib/deployments';
import type { PublicInstallLinkView } from '@/lib/public-install-links';
import type { ApplicationReadiness, DeployabilityOutcome, FixClass, ReadinessFinding } from '@/lib/readiness';
import { installReleaseState, type Release } from '@/lib/releases';

// ── Canonical states ────────────────────────────────────────────────────────

export const APPLICATION_STATES = [
  'unavailable',
  'analysing',
  'analysis-failed',
  'configuration-required',
  'configuration-review',
  'ready-to-test',
  'test-queued',
  'test-deploying',
  'test-removing',
  'test-failed',
  'ready-to-share',
  'customers-active',
  'unknown',
] as const;

export type ApplicationState = (typeof APPLICATION_STATES)[number];

export type ApplicationBadgeVariant = 'success' | 'warning' | 'info' | 'secondary' | 'destructive';

/** How often the page re-fetches while a state can still change on its own. */
export const ANALYSIS_POLL_MS = 2000;
export const TEST_DEPLOYMENT_POLL_MS = 5000;

// ── Actions ─────────────────────────────────────────────────────────────────

/** Every action the primary card can offer. A component maps an `id` to its
 *  handler; `href` is set when the action is plain navigation. */
export type ApplicationActionId =
  | 'retry-load'
  | 'analyse'
  | 'restart-analysis'
  | 'retry-analysis'
  | 'review-configuration'
  | 'start-test'
  | 'continue-test'
  | 'view-progress'
  | 'review-failure'
  | 'open-application'
  | 'view-test-deployment'
  | 'create-install-link'
  | 'copy-install-link'
  | 'preview-install-link'
  | 'view-customer-deployments'
  | 'view-releases';

export interface ApplicationAction {
  id: ApplicationActionId;
  label: string;
  href: string | null;
  /** True when `href` leaves Deployz (opens in a new tab). */
  external: boolean;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export const SETUP_LIFECYCLE_STEPS = ['Analyse', 'Configure', 'Test', 'Share'] as const;
export type SetupLifecycleStep = (typeof SETUP_LIFECYCLE_STEPS)[number];
export type SetupLifecycleStepState = 'pending' | 'current' | 'done' | 'failed';

export interface SetupLifecycleItem {
  step: SetupLifecycleStep;
  state: SetupLifecycleStepState;
}

// ── Install link ────────────────────────────────────────────────────────────

/** What the page knows about the application's public install links:
 *  `null` while the first fetch is in flight, `'error'` when it failed. */
export type InstallLinksInput = PublicInstallLinkView[] | 'error' | null;

export type InstallLinkStatus = 'active' | 'disabled' | 'unknown';

export type InstallLinkPresentation =
  /** Nothing to say yet (state unknown, or the page could not load). */
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  /** Not ready to share and no live link: say what has to happen first. */
  | { kind: 'unavailable'; reason: string }
  /** Ready to share, no live link. `note` explains a revoked predecessor. */
  | { kind: 'create'; note: string | null }
  /** A live (not revoked) link. `warning` is set when the link is live but
   *  the application is not ready to share — the link is never hidden or
   *  invalidated, the vendor is told and can disable it. */
  | { kind: 'live'; link: PublicInstallLinkView; status: InstallLinkStatus; warning: string | null };

/** Where the install-link controls render: inside the primary card (they ARE
 *  the next action), as their own compact card, or not at all. */
export type InstallLinkPlacement = 'primary' | 'card' | 'none';

// ── Presentation ────────────────────────────────────────────────────────────

export interface ApplicationNotice {
  tone: 'warning' | 'error';
  text: string;
}

export interface ApplicationBlocker {
  id: string;
  title: string;
  /** Where the vendor resolves it: in Deployz, in the repository, or not at all. */
  group: FixClass;
}

/** The deployability outcome with the build check applied. */
export interface ApplicationOutcome {
  outcome: DeployabilityOutcome;
  label: string;
  /** "Not yet confirmed by a build", or why a build moved the outcome. */
  detail: string | null;
  /** Opens the failed release's failure details. */
  action: ApplicationAction | null;
}

export interface ApplicationPresentation {
  state: ApplicationState;
  badge: { label: string; variant: ApplicationBadgeVariant };
  heading: string;
  message: string;
  /** True while a server-side operation runs: the card shows a spinner. */
  busy: boolean;
  primaryAction: ApplicationAction | null;
  secondaryActions: ApplicationAction[];
  /** Required changes, shown by the configuration-required card. */
  blockers: ApplicationBlocker[];
  /** Null when no completed analysis exists or setup is complete. */
  outcome: ApplicationOutcome | null;
  /** "No blocking issues" / "2 changes required" — never a
   *  passed-check count. Null while no completed analysis exists. */
  readinessSummary: string | null;
  recommendationCount: number;
  /** Null once setup is complete (a verified test or a customer exists). */
  lifecycle: SetupLifecycleItem[] | null;
  /** Null when the state is settled: the poll loop arms no timer. */
  polling: { intervalMs: number } | null;
  /** True only when the application is ready for customers. */
  installLinkAvailable: boolean;
  installLink: InstallLinkPresentation;
  installLinkPlacement: InstallLinkPlacement;
  notices: ApplicationNotice[];
}

export interface ApplicationStateInput {
  /** Null when the page has never loaded the application successfully. */
  data: {
    application: { id: string; name: string; defaultBranch: string };
    readiness: ApplicationReadiness;
    deployments: FleetDeployment[];
    /** 'error' when the releases fetch failed: the mapper says nothing about
     *  releases rather than guessing. */
    releases: Release[] | 'error';
  } | null;
  installLinks: InstallLinksInput;
  /** True after repeated failed refreshes: the data on screen may be old. */
  stale: boolean;
  /** True once an analysis has run past ANALYSIS_TAKING_LONGER_MS. */
  analysisTakingLonger: boolean;
}

// ── Test deployment ─────────────────────────────────────────────────────────

export type TestDeploymentPhase =
  | 'none'
  | 'queued'
  | 'deploying'
  | 'removing'
  | 'failed'
  | 'verified'
  | 'unknown';

/** The newest test deployment that still exists. */
export function latestTestDeployment(deployments: readonly FleetDeployment[]): FleetDeployment | null {
  const candidates = deployments
    .filter((d) => d.deploymentType === 'TEST' && d.deletedAt === null && d.state !== 'DELETED')
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return candidates[0] ?? null;
}

export function testDeploymentPhase(deployment: FleetDeployment | null): TestDeploymentPhase {
  if (!deployment) return 'none';
  switch (deployment.state as string) {
    case 'NOT_INSTALLED':
      return 'queued';
    case 'WAITING_FOR_RELAY':
    case 'INSTALLING':
    case 'UPDATING':
      return 'deploying';
    case 'DELETING':
      return 'removing';
    case 'FAILED':
    case 'DISCONNECTED':
      return 'failed';
    case 'HEALTHY':
    case 'UPDATE_AVAILABLE':
      return 'verified';
    default:
      return 'unknown';
  }
}

/** True when a test deployment that has since been removed ran its release
 *  live: the relay observed it, so that release was verified. */
function removedVerifiedTest(deployments: readonly FleetDeployment[]): boolean {
  return deployments.some(
    (d) =>
      d.deploymentType === 'TEST' &&
      (d.deletedAt !== null || d.state === 'DELETED') &&
      d.currentReleaseConfirmedAt !== null,
  );
}

/** Customer (non-test) deployments that still exist. */
export function customerDeployments(deployments: readonly FleetDeployment[]): FleetDeployment[] {
  return deployments.filter(
    (d) =>
      d.deploymentType === 'PRODUCTION' &&
      d.deletedAt === null &&
      d.state !== 'DELETED' &&
      d.state !== 'DELETING',
  );
}

/**
 * The badge the applications list shows for a completed analysis: the same
 * presentation the application page derives, so the two cannot disagree.
 * Releases and install links only change the page's message, never the badge.
 */
export function applicationListBadge(
  application: { id: string; name: string; defaultBranch: string },
  readiness: ApplicationReadiness,
  deployments: FleetDeployment[],
): ApplicationPresentation['badge'] {
  return deriveApplicationPresentation({
    data: { application, readiness, deployments, releases: 'error' },
    installLinks: null,
    stale: false,
    analysisTakingLonger: false,
  }).badge;
}

// ── Copy ────────────────────────────────────────────────────────────────────

const BADGES: Record<ApplicationState, { label: string; variant: ApplicationBadgeVariant }> = {
  unavailable: { label: 'Unavailable', variant: 'secondary' },
  analysing: { label: 'Analysing', variant: 'info' },
  'analysis-failed': { label: 'Analysis failed', variant: 'destructive' },
  'configuration-required': { label: 'Needs input', variant: 'warning' },
  'configuration-review': { label: 'Needs input', variant: 'warning' },
  // The analysis passed and no test deployment exists. Whether a release can
  // be deployed is folded into the message, not a second badge.
  'ready-to-test': { label: 'Ready to test', variant: 'info' },
  'test-queued': { label: 'Testing', variant: 'info' },
  'test-deploying': { label: 'Testing', variant: 'info' },
  'test-removing': { label: 'Testing', variant: 'info' },
  'test-failed': { label: 'Test failed', variant: 'destructive' },
  'ready-to-share': { label: 'Ready to share', variant: 'success' },
  'customers-active': { label: 'Live', variant: 'success' },
  unknown: { label: 'Status unknown', variant: 'warning' },
};

// "Live" would hide a customer deployment that is failing or lost contact.
const CUSTOMERS_NEED_ATTENTION_BADGE = { label: 'Needs attention', variant: 'warning' } as const;

export const STATUS_UNKNOWN_BADGE = BADGES.unknown;

const NOT_ANALYSED_BADGE = { label: 'Not analysed', variant: 'secondary' } as const;

export const STALE_NOTICE = 'Live updates paused. Retrying.';

const INSTALL_LINK_LOAD_ERROR = "Couldn't load the install link. Try again.";
const INSTALL_LINK_UNKNOWN_WARNING =
  "Unknown link status. Regenerate the link.";
const INSTALL_LINK_REVOKED_NOTE = 'The previous link was revoked. Create a new one to share.';

function changesRequired(count: number): string {
  return `${count} ${count === 1 ? 'change' : 'changes'} required`;
}

// ── Environment setup ────────────────────────────────────────────────────────

type EnvironmentSetupCounts = NonNullable<ApplicationReadiness['environmentSetup']>;

function environmentReviewMessage(counts: EnvironmentSetupCounts): string {
  const variables = (count: number) => `${count} ${count === 1 ? 'environment variable needs' : 'environment variables need'}`;
  if (counts.needsDecision === 0) return `Analysis finished. ${variables(counts.missingValue)} a value.`;
  const decision = `Analysis finished. ${variables(counts.needsDecision)} a decision.`;
  if (counts.missingValue === 0) return decision;
  return `${decision} ${counts.missingValue} ${counts.missingValue === 1 ? 'needs' : 'need'} a value.`;
}

// ── Release copy ─────────────────────────────────────────────────────────────

function releaseLabel(release: Release): string {
  return `${release.version} (commit ${release.gitSha.slice(0, 7)})`;
}

function newestReleaseOverall(releases: readonly Release[]): Release | null {
  if (releases.length === 0) return null;
  return releases.reduce((latest, r) => (Date.parse(r.createdAt) > Date.parse(latest.createdAt) ? r : latest));
}

/** What an active link tells the vendor it currently does — never a claim
 *  that a test must pass again, only what installs right now. */
function activeEarlyLinkWarning(releases: Release[] | 'error'): string {
  let outcome: string;
  if (releases === 'error') {
    outcome = 'Deployz cannot confirm which release customers get.';
  } else {
    const state = installReleaseState(releases);
    outcome =
      state.kind === 'ready'
        ? `Customers get release ${releaseLabel(state.release)}.`
        : 'Installs are refused: no built release yet.';
  }
  return `This link is live. ${outcome} Disable it to stop installs.`;
}

interface ShareReleaseInfo {
  /** Null when releases are 'error': the mapper says nothing rather than guessing. */
  message: string | null;
  notice: ApplicationNotice | null;
  action: ApplicationAction | null;
}

/** What customers get from the install link once the application is ready to
 *  share — the newest READY release, a warning when a newer release since
 *  failed to build, or a pointer to Releases when nothing is built yet. */
function describeReleaseForShare(releases: Release[] | 'error', applicationId: string): ShareReleaseInfo {
  if (releases === 'error') return { message: null, notice: null, action: null };
  const state = installReleaseState(releases);
  if (state.kind !== 'ready') {
    return {
      message: 'Customers cannot install: no built release.',
      notice: null,
      action: action('view-releases', 'View releases', `/dashboard/applications/${applicationId}/releases`),
    };
  }
  const newest = newestReleaseOverall(releases);
  const notice: ApplicationNotice | null =
    newest && newest.status === 'FAILED' && Date.parse(newest.createdAt) > Date.parse(state.release.createdAt)
      ? { tone: 'warning', text: `Release ${newest.version} failed to build. Customers get ${state.release.version}.` }
      : null;
  return { message: `Customers get release ${releaseLabel(state.release)}.`, notice, action: null };
}

/** A short note naming the release a test deployment installs — or, when
 *  none exists yet, that starting the test builds the first one from the
 *  exact commit the analysis read (`firstReleaseInput` in lib/releases.ts
 *  builds from that same `detectedMetadata.analysisCommitSha`). Empty string
 *  when there is nothing accurate to say (the releases fetch failed, or the
 *  analysed commit is unknown) so callers can append it without a conditional. */
function testReleaseNote(releases: Release[] | 'error', defaultBranch: string, analyzedCommitSha: string | null): string {
  if (releases === 'error') return '';
  if (releases.length === 0) {
    return analyzedCommitSha
      ? ` The test deployment builds the first release from ${defaultBranch}@${analyzedCommitSha.slice(0, 7)}.`
      : '';
  }
  const state = installReleaseState(releases);
  return state.kind === 'ready' ? ` The test deployment uses release ${releaseLabel(state.release)}.` : '';
}

// ── Release readiness ───────────────────────────────────────────────────────

/** What the releases say about deploying: an older READY release still
 *  counts even when a newer build failed. */
export type ReleaseReadiness = 'ready' | 'building' | 'failed' | 'unavailable' | 'none';

export function releaseReadiness(releases: readonly Release[]): ReleaseReadiness {
  if (releases.length === 0) return 'none';
  const install = installReleaseState(releases);
  if (install.kind !== 'none') return install.kind;
  return releases.some((r) => r.status === 'FAILED') ? 'failed' : 'unavailable';
}

// ── Deployability outcome ───────────────────────────────────────────────────

const OUTCOME_LABELS: Record<DeployabilityOutcome, string> = {
  DEPLOYABLE: 'Deployable with Deployz settings',
  DEPLOYABLE_WITH_CHANGES: 'Deployable after repository changes',
  NOT_DEPLOYABLE: 'Not deployable on Deployz',
};

/** A report stored before fix classes: a blocking finding was a capability gap. */
function findingFixClass(finding: ReadinessFinding): FixClass {
  return finding.fixClass ?? (finding.blocking ? 'CAPABILITY_GAP' : 'CODE_CHANGE');
}

/**
 * The analysis outcome, checked against the release builds: outcome 1 is not
 * confirmed until a release build passes, and a failed build with no passed
 * build moves it to outcome 2. Null for a report stored before the outcome.
 */
function deriveOutcome(
  readiness: ApplicationReadiness,
  release: ReleaseReadiness | null,
  releasesHref: string,
): ApplicationOutcome | null {
  const outcome = readiness.outcome;
  if (outcome === undefined) return null;
  if (outcome !== 'DEPLOYABLE' || release === 'ready') {
    return { outcome, label: OUTCOME_LABELS[outcome], detail: null, action: null };
  }
  if (release === 'failed') {
    return {
      outcome: 'DEPLOYABLE_WITH_CHANGES',
      label: OUTCOME_LABELS.DEPLOYABLE_WITH_CHANGES,
      detail: 'The release build failed.',
      action: action('view-releases', 'Review failure details', releasesHref),
    };
  }
  return { outcome, label: OUTCOME_LABELS.DEPLOYABLE, detail: 'Not yet confirmed by a build.', action: null };
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function action(
  id: ApplicationActionId,
  label: string,
  href: string | null = null,
  external = false,
): ApplicationAction {
  return { id, label, href, external };
}

function deploymentHref(deployment: FleetDeployment): string {
  return `/dashboard/deployments/${deployment.id}`;
}

function deploymentUrl(deployment: FleetDeployment): string | null {
  const url = deployment.observedState?.['url'];
  return typeof url === 'string' && url.length > 0 ? url : null;
}

// ── Install link derivation ─────────────────────────────────────────────────

function deriveInstallLink(
  links: InstallLinksInput,
  available: boolean,
  unavailableReason: string | null,
  releases: Release[] | 'error',
): InstallLinkPresentation {
  // A live link is always shown: customers can still use it, so the vendor
  // must be able to copy, disable or revoke it in every state.
  const live = Array.isArray(links) ? (links.find((link) => (link.status as string) !== 'revoked') ?? null) : null;
  if (unavailableReason === null && !available && live === null) return { kind: 'hidden' };
  if (links === null) return { kind: 'loading' };
  if (links === 'error') return { kind: 'error', message: INSTALL_LINK_LOAD_ERROR };

  if (live) {
    const status: InstallLinkStatus =
      live.status === 'active' || live.status === 'disabled' ? live.status : 'unknown';
    let warning: string | null = null;
    if (status === 'unknown') warning = INSTALL_LINK_UNKNOWN_WARNING;
    else if (!available && status === 'active') warning = activeEarlyLinkWarning(releases);
    return { kind: 'live', link: live, status, warning };
  }
  if (!available) return { kind: 'unavailable', reason: unavailableReason ?? '' };
  return { kind: 'create', note: links.length > 0 ? INSTALL_LINK_REVOKED_NOTE : null };
}

// ── Lifecycle derivation ────────────────────────────────────────────────────

function lifecycle(
  analyse: SetupLifecycleStepState,
  configure: SetupLifecycleStepState,
  test: SetupLifecycleStepState,
): SetupLifecycleItem[] {
  return [
    { step: 'Analyse', state: analyse },
    { step: 'Configure', state: configure },
    { step: 'Test', state: test },
    { step: 'Share', state: 'pending' },
  ];
}

// ── The mapper ──────────────────────────────────────────────────────────────

type Core = Pick<
  ApplicationPresentation,
  'state' | 'heading' | 'message' | 'busy' | 'primaryAction' | 'secondaryActions' | 'polling'
> & {
  lifecycle: SetupLifecycleItem[] | null;
  /** Why a customer cannot install yet; null when they can, or when the page
   *  has nothing to say about the link at all. */
  linkUnavailableReason: string | null;
  /** A newer release that failed to build after the one customers actually
   *  get — set only in the ready-to-share/customers-active states. */
  releaseNotice?: ApplicationNotice | null;
};

/**
 * Derive the single presentation of the application page.
 *
 * Precedence, first match wins:
 *  1. no data at all                       → unavailable
 *  2. an analysis is running or not started → analysing
 *  3. a test deployment operation is active → test-queued / -deploying / -removing
 *  4. the analysis failed                  → analysis-failed
 *  5. an analysis status this build does not know → unknown
 *  6. required changes are open            → configuration-required
 *  7. customer deployments exist           → customers-active
 *  8. the test deployment failed           → test-failed
 *  9. the test deployment is verified, or a removed one was → ready-to-share
 * 10. no test deployment                   → ready-to-test (the card waits on
 *                                            a release that built)
 * 11. a test deployment state this build does not know → unknown
 *
 * Active operations (2, 3) come before readiness (6) on purpose: readiness
 * data is only as new as the last analysis, the operation is happening now.
 */
export function deriveApplicationPresentation(input: ApplicationStateInput): ApplicationPresentation {
  if (input.data === null) {
    return {
      state: 'unavailable',
      badge: BADGES.unavailable,
      heading: 'Application unavailable',
      message: "Couldn't load this application. Your deployments are not affected.",
      busy: false,
      primaryAction: action('retry-load', 'Try again'),
      secondaryActions: [],
      blockers: [],
      outcome: null,
      readinessSummary: null,
      recommendationCount: 0,
      lifecycle: null,
      polling: null,
      installLinkAvailable: false,
      installLink: { kind: 'hidden' },
      installLinkPlacement: 'none',
      notices: [],
    };
  }

  const { application, readiness, deployments, releases } = input.data;
  const analysisStatus = readiness.analysisStatus as string;
  const analysed = analysisStatus === 'COMPLETE';
  const required = analysed ? readiness.findings.filter((f) => f.severity === 'required') : [];
  const recommended = analysed ? readiness.findings.filter((f) => f.severity === 'recommended') : [];
  const environmentSetup = analysed ? (readiness.environmentSetup ?? null) : null;
  const needsEnvReview =
    environmentSetup !== null && environmentSetup.needsDecision + environmentSetup.missingValue > 0;
  const test = latestTestDeployment(deployments);
  const phase = testDeploymentPhase(test);
  const customers = customerDeployments(deployments);
  const testedThenRemoved = test === null && removedVerifiedTest(deployments);
  const setupComplete = phase === 'verified' || testedThenRemoved || customers.length > 0;
  const configurationHref = `/dashboard/applications/${application.id}/config`;
  const startTestHref = `/dashboard/deployments/new?applicationId=${application.id}&test=true`;
  const configureStep: SetupLifecycleStepState = required.length > 0 ? 'current' : 'done';
  const release = releases === 'error' ? null : releaseReadiness(releases);
  const releasesHref = `/dashboard/applications/${application.id}/releases`;

  const core = ((): Core => {
    if (analysisStatus === 'PENDING' || analysisStatus === 'ANALYZING') {
      const running = analysisStatus === 'ANALYZING';
      const stuck = running && input.analysisTakingLonger;
      return {
        state: 'analysing',
        heading: running ? 'Analysing application' : 'Analysis not started',
        message: stuck
          ? 'Taking longer than usual. Wait, or restart the analysis.'
          : running
            ? 'Reading your repository. This usually takes a minute.'
            : 'Analyse the application to continue.',
        busy: running,
        primaryAction: stuck
          ? action('restart-analysis', 'Re-analyse application')
          : running
            ? null
            : action('analyse', 'Analyse application'),
        secondaryActions: [],
        polling: { intervalMs: ANALYSIS_POLL_MS },
        lifecycle: lifecycle('current', 'pending', 'pending'),
        linkUnavailableReason: 'Install link available after a successful test deployment.',
      };
    }

    if (test && phase === 'queued') {
      return {
        state: 'test-queued',
        heading: 'Test deployment not started',
        message: 'Created. The install has not started in your AWS account yet.',
        busy: false,
        primaryAction: action('continue-test', 'View test deployment', deploymentHref(test)),
        secondaryActions: [],
        polling: { intervalMs: TEST_DEPLOYMENT_POLL_MS },
        lifecycle: lifecycle('done', configureStep, 'current'),
        linkUnavailableReason: 'Install link available after a successful test deployment.',
      };
    }

    if (test && phase === 'deploying') {
      return {
        state: 'test-deploying',
        heading: 'Test deployment in progress',
        // The deployment's own sentence, not its status label: "Current
        // step: Setting up." reads badly once the label itself is a plain
        // present-tense word like "Setting up".
        message: test.deploymentStatus.currentActivity,
        busy: true,
        primaryAction: action('view-progress', 'View test deployment', deploymentHref(test)),
        secondaryActions: [],
        polling: { intervalMs: TEST_DEPLOYMENT_POLL_MS },
        lifecycle: lifecycle('done', configureStep, 'current'),
        linkUnavailableReason: 'Install link available after a successful test deployment.',
      };
    }

    if (test && phase === 'removing') {
      return {
        state: 'test-removing',
        heading: 'Removing test deployment',
        message: 'Start a new test deployment after removal completes.',
        busy: true,
        primaryAction: action('view-progress', 'View test deployment', deploymentHref(test)),
        secondaryActions: [],
        polling: { intervalMs: TEST_DEPLOYMENT_POLL_MS },
        lifecycle: lifecycle('done', configureStep, 'pending'),
        linkUnavailableReason: 'Install link available after a successful test deployment.',
      };
    }

    if (analysisStatus === 'FAILED') {
      return {
        state: 'analysis-failed',
        heading: 'Analysis failed',
        message: readiness.failureReason ?? 'Could not read your repository.',
        busy: false,
        primaryAction: action('retry-analysis', 'Re-analyse application'),
        secondaryActions: [],
        polling: null,
        lifecycle: lifecycle('failed', 'pending', 'pending'),
        linkUnavailableReason: 'Install link available after a successful test deployment.',
      };
    }

    if (!analysed) {
      return {
        state: 'unknown',
        heading: 'Status unavailable',
        message: 'Re-analyse the application to refresh its status.',
        busy: false,
        primaryAction: action('analyse', 'Re-analyse application'),
        secondaryActions: [],
        polling: null,
        lifecycle: null,
        linkUnavailableReason: null,
      };
    }

    if (required.length > 0) {
      return {
        state: 'configuration-required',
        heading: `${changesRequired(required.length)} before you can deploy`,
        message:
          customers.length > 0
            ? 'New deployments are blocked until resolved. Existing customer deployments are not affected.'
            : 'Make these changes before a test deployment.',
        busy: false,
        primaryAction: action('review-configuration', 'Review required changes', `${configurationHref}#required-changes`),
        secondaryActions: [],
        polling: null,
        lifecycle: lifecycle('done', 'current', 'pending'),
        linkUnavailableReason: 'Install link available after a successful test deployment.',
      };
    }

    if (needsEnvReview && customers.length === 0) {
      return {
        state: 'configuration-review',
        heading: 'Configuration needs review',
        message: environmentReviewMessage(environmentSetup!),
        busy: false,
        primaryAction: action(
          'review-configuration',
          'Review required changes',
          `${configurationHref}#environment-variables`,
        ),
        secondaryActions: [],
        polling: null,
        lifecycle: lifecycle('done', 'current', 'pending'),
        linkUnavailableReason: 'Install link available after a successful test deployment.',
      };
    }

    if (customers.length > 0) {
      const attention = customers.filter((d) => deploymentDisplayStatus(d).group === 'attention').length;
      const shareInfo = attention === 0 ? describeReleaseForShare(releases, application.id) : null;
      return {
        state: 'customers-active',
        heading: countLabel(customers.length, 'customer deployment', 'customer deployments'),
        message:
          attention > 0
            ? `${countLabel(attention, 'deployment needs', 'deployments need')} attention.`
            : (shareInfo?.message ?? 'Running in customer AWS accounts.'),
        busy: false,
        primaryAction: action(
          'view-customer-deployments',
          'View deployments',
          `/dashboard/deployments?application=${encodeURIComponent(application.name)}`,
        ),
        secondaryActions: shareInfo?.action ? [shareInfo.action] : [],
        polling: null,
        lifecycle: null,
        linkUnavailableReason: null,
        releaseNotice: shareInfo?.notice ?? null,
      };
    }

    if (test && phase === 'failed') {
      const disconnected = (test.state as string) === 'DISCONNECTED';
      return {
        state: 'test-failed',
        heading: disconnected ? 'The test deployment is disconnected' : 'Test deployment failed',
        message: disconnected
          ? 'Connection to the test deployment lost. Review it before sharing.'
          : 'The test deployment did not complete. Review the failure and try again.',
        busy: false,
        primaryAction: action('review-failure', 'Review failure', deploymentHref(test)),
        secondaryActions: [],
        polling: null,
        lifecycle: lifecycle('done', 'done', 'failed'),
        linkUnavailableReason: 'Install link available after a successful test deployment.',
      };
    }

    if (phase === 'verified' || testedThenRemoved) {
      const url = test ? deploymentUrl(test) : null;
      const shareInfo = describeReleaseForShare(releases, application.id);
      return {
        state: 'ready-to-share',
        heading: 'Ready to share',
        message: shareInfo.message
          ? `Your test deployment passed. ${shareInfo.message}`
          : 'Test passed. Send the install link to customers.',
        busy: false,
        // The install-link controls render in the card itself (placement
        // 'primary'); these actions name them for surfaces without the link.
        primaryAction: null,
        secondaryActions: [
          ...(url ? [action('open-application', 'Open test application', url, true)] : []),
          ...(test ? [action('view-test-deployment', 'View test deployment', deploymentHref(test))] : []),
          ...(shareInfo.action ? [shareInfo.action] : []),
        ],
        polling: null,
        lifecycle: null,
        linkUnavailableReason: null,
        releaseNotice: shareInfo.notice,
      };
    }

    // A test deployment installs the newest READY release, so the test step
    // waits on a release that built. No releases at all is still "ready":
    // the create page builds the first one.
    if (!test && release === 'building') {
      return {
        state: 'ready-to-test',
        heading: 'Building a release',
        message: 'Start a test deployment when the build finishes.',
        busy: true,
        primaryAction: action('view-releases', 'View releases', releasesHref),
        secondaryActions: [],
        polling: { intervalMs: TEST_DEPLOYMENT_POLL_MS },
        lifecycle: lifecycle('done', 'done', 'current'),
        linkUnavailableReason: 'Install link available after a successful test deployment.',
      };
    }

    if (!test && (release === 'failed' || release === 'unavailable')) {
      return {
        state: 'ready-to-test',
        heading: 'No release to test',
        message:
          release === 'failed'
            ? 'The release build failed. A test needs a built release.'
            : 'No release can be deployed. Create a release to test.',
        busy: false,
        primaryAction:
          release === 'failed'
            ? action('view-releases', 'Review failed build', releasesHref)
            : action('view-releases', 'View releases', releasesHref),
        secondaryActions: [],
        polling: null,
        lifecycle: lifecycle('done', 'done', 'current'),
        linkUnavailableReason: 'Install link available after a successful test deployment.',
      };
    }

    if (!test) {
      return {
        state: 'ready-to-test',
        heading: 'Ready for a test deployment',
        message: `Deploy to your own AWS account before customers install.${testReleaseNote(releases, application.defaultBranch, readiness.analyzedCommitSha)}`,
        busy: false,
        primaryAction: action('start-test', 'Start test deployment', startTestHref),
        secondaryActions: [],
        polling: null,
        lifecycle: lifecycle('done', 'done', 'current'),
        linkUnavailableReason: 'Install link available after a successful test deployment.',
      };
    }

    return {
      state: 'unknown',
      heading: 'Status unavailable',
      message: 'Open the test deployment for details.',
      busy: false,
      primaryAction: action('view-test-deployment', 'View test deployment', deploymentHref(test)),
      secondaryActions: [],
      polling: null,
      lifecycle: null,
      linkUnavailableReason: null,
    };
  })();

  const installLinkAvailable = core.state === 'ready-to-share' || core.state === 'customers-active';
  const installLink = deriveInstallLink(input.installLinks, installLinkAvailable, core.linkUnavailableReason, releases);
  const finalLifecycle = setupComplete ? null : core.lifecycle;

  let primaryAction = core.primaryAction;
  // A live link stays visible in every state except 'hidden' (unavailable/
  // unknown page states). An application that has never had an eligible
  // link ('unavailable', still inside the setup lifecycle) gets no separate
  // inactive card — the state card names the reason near Share instead.
  let installLinkPlacement: InstallLinkPlacement =
    installLink.kind === 'hidden' || (installLink.kind === 'unavailable' && finalLifecycle !== null) ? 'none' : 'card';
  if (core.state === 'ready-to-share') {
    installLinkPlacement = 'primary';
    if (installLink.kind === 'create') primaryAction = action('create-install-link', 'Create install link');
    if (installLink.kind === 'live') {
      primaryAction = action('copy-install-link', 'Copy install link');
    }
  }
  const secondaryActions =
    core.state === 'ready-to-share' && installLink.kind === 'live'
      ? [action('preview-install-link', 'Preview', installLink.link.url, true), ...core.secondaryActions]
      : core.secondaryActions;

  const notices: ApplicationNotice[] = [];
  if (input.stale) notices.push({ tone: 'warning', text: STALE_NOTICE });
  if (core.state === 'customers-active' && phase === 'failed') {
    notices.push({ tone: 'warning', text: 'Test deployment needs attention.' });
  }
  if (core.state === 'customers-active' && needsEnvReview) {
    notices.push({ tone: 'warning', text: environmentReviewMessage(environmentSetup!) });
  }
  if (core.releaseNotice) notices.push(core.releaseNotice);

  let readinessSummary: string | null = null;
  if (analysed) {
    readinessSummary = required.length > 0 ? changesRequired(required.length) : 'No blocking issues';
  }

  return {
    state: core.state,
    // PENDING shares the analysing state (same card, same poll) but nothing
    // is running yet, so the badge must not say "Analysing".
    badge:
      analysisStatus === 'PENDING'
        ? NOT_ANALYSED_BADGE
        : core.state === 'customers-active' && customers.some((d) => deploymentDisplayStatus(d).group === 'attention')
          ? CUSTOMERS_NEED_ATTENTION_BADGE
          : BADGES[core.state],
    heading: core.heading,
    message: core.message,
    busy: core.busy,
    primaryAction,
    secondaryActions,
    blockers:
      core.state === 'configuration-required'
        ? required.map((f) => ({ id: f.id, title: requiredChangeLabel(f), group: findingFixClass(f) }))
        : [],
    outcome: analysed && finalLifecycle !== null ? deriveOutcome(readiness, release, releasesHref) : null,
    readinessSummary,
    recommendationCount: recommended.length,
    lifecycle: finalLifecycle,
    polling: core.polling,
    installLinkAvailable,
    installLink,
    installLinkPlacement,
    notices,
  };
}
