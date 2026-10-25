// §22 release data access. A 404 from the API now means the application
// genuinely does not exist for the caller's organization — it is surfaced,
// never swallowed into look-alike placeholder data. §65: copy is jargon-free.

import { apiUrl } from '@/lib/api-url';
import { ApiRequestError, apiRequest, readSignal } from '@/lib/api-client';
import { formatDateTime } from '@/lib/list-view';

export type ReleaseStatus = 'BUILDING' | 'READY' | 'FAILED' | 'UNAVAILABLE';

export interface Release {
  id: string;
  version: string;
  status: ReleaseStatus;
  /** Why the build failed; null unless status is FAILED. */
  failureReason: string | null;
  /** The commit this release was built from (full 40-char SHA). */
  gitSha: string;
  createdAt: string;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    credentials: 'include',
    cache: 'no-store',
    signal: readSignal(),
  });
  if (!response.ok) {
    throw new Error(`Releases request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function fetchReleases(applicationId: string): Promise<Release[]> {
  const body = await getJson<{ releases?: Release[] }>(
    `/api/applications/${encodeURIComponent(applicationId)}/releases`,
  );
  return body.releases ?? [];
}

export interface CreateReleaseInput {
  version: string;
  gitSha: string;
}

/** Thrown when a release cannot build because a required build-stage
 *  environment value is missing (`BUILD_CONFIGURATION_MISSING`). Carries the
 *  offending keys so the caller can name them and link to Configuration. */
export class BuildConfigurationMissingError extends Error {
  readonly keys: string[];
  constructor(keys: string[]) {
    super(`Set these build values before you build a release: ${keys.join(', ')}.`);
    this.name = 'BuildConfigurationMissingError';
    this.keys = keys;
  }
}

/** §22 create release — POST /api/applications/:id/releases. */
export async function createRelease(
  applicationId: string,
  input: CreateReleaseInput,
): Promise<Release> {
  let row: {
    id: string;
    version: string;
    releaseStatus: ReleaseStatus;
    failureReason: string | null;
    gitSha: string;
    createdAt: string;
  };
  try {
    row = await apiRequest<typeof row>(`/api/applications/${encodeURIComponent(applicationId)}/releases`, {
      method: 'POST',
      body: { version: input.version, gitSha: input.gitSha },
    });
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === 'BUILD_CONFIGURATION_MISSING') {
      throw new BuildConfigurationMissingError((error.details as { keys?: string[] } | undefined)?.keys ?? []);
    }
    throw error;
  }
  return {
    id: row.id,
    version: row.version,
    status: row.releaseStatus,
    failureReason: row.failureReason ?? null,
    gitSha: row.gitSha,
    createdAt: row.createdAt,
  };
}

export const RELEASE_STATUS_BADGE: Record<ReleaseStatus, 'success' | 'info' | 'destructive' | 'secondary'> = {
  BUILDING: 'info',
  READY: 'success',
  FAILED: 'destructive',
  UNAVAILABLE: 'secondary',
};

export const RELEASE_STATUS_LABEL: Record<ReleaseStatus, string> = {
  BUILDING: 'Building',
  READY: 'Ready',
  // A release fails only while it is being built (fetching the commit,
  // building or storing the image) — never after it was READY.
  FAILED: 'Build failed',
  UNAVAILABLE: 'Unavailable',
};

/** Copy shown under an UNAVAILABLE release's status badge. */
export const RELEASE_UNAVAILABLE_COPY =
  'The build for this version is no longer available. Create a new release to deploy it again.';

export function releaseStatusLabel(status: string): string {
  return RELEASE_STATUS_LABEL[status as ReleaseStatus] ?? status;
}

/** "Sep 23, 2026, 10:52 PM GMT+5:30" — when a release was created, with the viewer's time zone. */
export function formatReleaseCreatedAt(iso: string): string {
  const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
    .formatToParts(new Date(iso))
    .find((part) => part.type === 'timeZoneName')?.value;
  return zone ? `${formatDateTime(iso)} ${zone}` : formatDateTime(iso);
}

/** Copy for the deploy picker when no release qualifies. */
export const NO_DEPLOYABLE_RELEASES_COPY =
  'No deployable releases yet. A release must build successfully first.';

/**
 * What a new deployment would install. An install runs the newest READY
 * release; without one the API refuses the deployment, so the create screen
 * says so up front: `building` while the newest release is still building,
 * `none` when nothing is built (or every build failed).
 */
export type InstallReleaseState =
  | { kind: 'ready'; release: Release }
  | { kind: 'building'; release: Release }
  | { kind: 'none' };

export function installReleaseState(releases: readonly Release[]): InstallReleaseState {
  const newestFirst = [...releases].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const ready = newestFirst.find((r) => r.status === 'READY');
  if (ready) return { kind: 'ready', release: ready };
  const building = newestFirst.find((r) => r.status === 'BUILDING');
  if (building) return { kind: 'building', release: building };
  return { kind: 'none' };
}

/**
 * The first release of an application, built from the commit its analysis
 * read — the same version scheme the public install link uses (the first 12
 * characters of the SHA). A version is unique per application, so after a
 * failed build of the same commit the retry gets a numbered suffix (`-2`,
 * `-3`, …) that avoids every version in `takenVersions`. Null when the
 * analysis recorded no commit.
 */
export function firstReleaseInput(
  detectedMetadata: Record<string, unknown> | null,
  takenVersions: readonly string[] = [],
): CreateReleaseInput | null {
  const sha = detectedMetadata?.analysisCommitSha;
  if (typeof sha !== 'string' || sha.length === 0) return null;
  const base = sha.slice(0, 12);
  let version = base;
  for (let attempt = 2; takenVersions.includes(version); attempt += 1) {
    version = `${base}-${attempt}`;
  }
  return { version, gitSha: sha };
}

/**
 * Releases the deploy picker may offer: READY only (BUILDING may still
 * fail, FAILED cannot run), excluding the release already running, newest
 * first.
 */
export function deployableReleases(
  releases: readonly Release[],
  currentReleaseId: string | null,
): Release[] {
  return releases
    .filter((r) => r.status === 'READY' && r.id !== currentReleaseId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * The newest READY release created after the running one — the release that
 * makes a deployment UPDATE_AVAILABLE (mirrors newerReadyReleaseExists in
 * apps/api/src/jobs.ts). Null when the running release is not in the list,
 * so the page never guesses a target version.
 */
export function updateTargetRelease(
  releases: readonly Release[],
  currentReleaseId: string | null,
): Release | null {
  const current = releases.find((r) => r.id === currentReleaseId);
  if (!current) return null;
  const since = Date.parse(current.createdAt);
  return (
    deployableReleases(releases, currentReleaseId).find((r) => Date.parse(r.createdAt) > since) ??
    null
  );
}

/**
 * The release ids currently deployed by any live deployment of the
 * application — the releases the Runtime column marks as Running.
 */
export function runningReleaseIds(
  deployments: readonly { currentReleaseId: string | null; state: string }[],
): Set<string> {
  return new Set(
    deployments
      .filter((d) => d.state !== 'DELETED' && d.currentReleaseId !== null)
      .map((d) => d.currentReleaseId!),
  );
}

/** Newest first — the order the Releases table and history render in. */
export function newestFirst(releases: readonly Release[]): Release[] {
  return [...releases].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** The first 7 characters of a commit SHA — the short form shown in tables. */
export function shortSha(gitSha: string): string {
  return gitSha.slice(0, 7);
}

export interface RunningOn {
  test: number;
  customer: number;
}

/**
 * How many live deployments run a release, split by deployment type — the
 * Releases table's "Running on" column. Deleted deployments never count,
 * mirroring runningReleaseIds.
 */
export function runningOn(
  deployments: readonly { currentReleaseId: string | null; state: string; deploymentType: 'TEST' | 'PRODUCTION' }[],
  releaseId: string,
): RunningOn {
  const live = deployments.filter((d) => d.state !== 'DELETED' && d.currentReleaseId === releaseId);
  return {
    test: live.filter((d) => d.deploymentType === 'TEST').length,
    customer: live.filter((d) => d.deploymentType === 'PRODUCTION').length,
  };
}

/** "Test deployment", "2 customer deployments", or null when nothing runs it. */
export function runningOnLabel(counts: RunningOn): string | null {
  const parts: string[] = [];
  if (counts.test > 0) {
    parts.push(counts.test === 1 ? 'Test deployment' : `${counts.test} test deployments`);
  }
  if (counts.customer > 0) {
    parts.push(counts.customer === 1 ? 'Customer deployment' : `${counts.customer} customer deployments`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Plain-English explanation for a build that is not FAILED or UNAVAILABLE
 *  (those have their own copy: releaseBuildFailureSummary and
 *  RELEASE_UNAVAILABLE_COPY). */
export const RELEASE_STATUS_EXPLANATION: Record<'BUILDING' | 'READY', string> = {
  BUILDING: 'Deployz is building this release from its commit.',
  READY: 'This build finished successfully and can be installed.',
};

/** The Releases page's summary line: what a new customer install runs now. */
export function installSummaryLine(releases: readonly Release[]): string {
  const install = installReleaseState(releases);
  if (install.kind === 'ready') {
    return `Customer installs get ${install.release.version} (commit ${shortSha(install.release.gitSha)}).`;
  }
  if (install.kind === 'building') {
    return `${install.release.version} is building — customers cannot install until it finishes.`;
  }
  return 'No release is ready yet — customers cannot install.';
}

const SEMVER_PATTERN = /^(v?)(\d+)\.(\d+)\.(\d+)$/;

/**
 * A default value for the New release form's Version field: the newest
 * release's version with its patch number incremented, keeping the `v`
 * prefix when the newest version has one. Returns v0.1.0 when there is no
 * release yet, and '' when its version is not plain semver — the field stays
 * editable either way.
 */
export function suggestNextVersion(
  releases: readonly Pick<Release, 'version' | 'createdAt'>[],
): string {
  if (releases.length === 0) return 'v0.1.0';
  const newest = releases.reduce((latest, release) =>
    Date.parse(release.createdAt) > Date.parse(latest.createdAt) ? release : latest,
  );
  const match = SEMVER_PATTERN.exec(newest.version);
  if (!match) return '';
  const [, prefix, major, minor, patch] = match;
  return `${prefix}${major}.${minor}.${Number(patch) + 1}`;
}

/**
 * Existing releases already built from `sha` (or from a commit `sha` is a
 * prefix/extension of, so a short manual SHA still matches a full stored
 * one) — shown as unobtrusive "Already released as vX" context under the
 * commit field. Never blocks submit.
 */
export function alreadyReleasedVersions(releases: readonly Release[], sha: string): string[] {
  const needle = sha.trim().toLowerCase();
  if (needle.length < 7) return [];
  return releases
    .filter((release) => {
      const gitSha = release.gitSha.toLowerCase();
      return gitSha.length >= 7 && (gitSha.startsWith(needle) || needle.startsWith(gitSha));
    })
    .map((release) => release.version);
}

