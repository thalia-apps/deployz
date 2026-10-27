import type { BadgeVariant } from '@/components/ui/badge';
import { apiRequest } from '@/lib/api-client';
import { apiUrl } from '@/lib/api-url';

export type GithubConnectionStatus = 'active' | 'disconnected' | 'access_issue';

export interface GithubInstallation {
  id: string;
  accountLogin: string;
  accountType: string;
  status: GithubConnectionStatus;
  applicationCount: number;
  /** The installation's settings page on GitHub: repository access, uninstall. */
  manageUrl: string;
}

export interface GithubRepository {
  id: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
}

export interface GithubInstallationsResult {
  installations: GithubInstallation[];
  connectUrl: string | null;
  /** False for a plain member: only owners and admins connect GitHub. */
  canConnect?: boolean;
}

export interface GithubRepositoriesResult {
  repositories: GithubRepository[];
}

export type RepositoryConnectionStatus =
  | 'connected'
  | 'disconnected'
  | 'access_issue'
  | 'repository_inaccessible'
  | 'not_connected';

export interface ApplicationGithubStatus {
  status: RepositoryConnectionStatus;
  repoFullName: string;
  branch: string;
  accountLogin: string | null;
  installationId: string | null;
  manageUrl: string | null;
  connectUrl: string | null;
  canConnect: boolean;
}

export const GITHUB_CONNECTION_LABELS: Record<GithubConnectionStatus, { label: string; badge: BadgeVariant }> = {
  active: { label: 'Connected', badge: 'success' },
  disconnected: { label: 'Disconnected', badge: 'outline' },
  access_issue: { label: 'Access issue', badge: 'warning' },
};

export const REPOSITORY_CONNECTION_LABELS: Record<RepositoryConnectionStatus, { label: string; badge: BadgeVariant }> = {
  connected: GITHUB_CONNECTION_LABELS.active,
  disconnected: GITHUB_CONNECTION_LABELS.disconnected,
  access_issue: GITHUB_CONNECTION_LABELS.access_issue,
  repository_inaccessible: { label: 'Repository inaccessible', badge: 'warning' },
  not_connected: { label: 'Not connected', badge: 'outline' },
};

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export function fetchGithubInstallations(): Promise<GithubInstallationsResult> {
  return getJson<GithubInstallationsResult>('/api/github/installations');
}

export function fetchGithubRepositories(installationId: string): Promise<GithubRepositoriesResult> {
  return getJson<GithubRepositoriesResult>(
    `/api/github/repos?installationId=${encodeURIComponent(installationId)}`,
  );
}

export function fetchApplicationGithubStatus(applicationId: string): Promise<ApplicationGithubStatus> {
  return apiRequest<ApplicationGithubStatus>(`/api/applications/${encodeURIComponent(applicationId)}/github`);
}

export function disconnectGithubInstallation(installationId: string): Promise<GithubInstallation> {
  return apiRequest<GithubInstallation>(
    `/api/github/installations/${encodeURIComponent(installationId)}/disconnect`,
    { method: 'POST' },
  );
}

/** The install flow, returning to `returnTo` (a dashboard path) when GitHub is done. */
export function githubConnectHref(connectUrl: string, returnTo: string): string {
  return `${connectUrl}?returnTo=${encodeURIComponent(returnTo)}`;
}

// Reconnects an installation GitHub still has. When GitHub no longer has it
// (the App was uninstalled or suspended there), the only way back is the
// install flow, so the browser goes to GitHub and returns to `returnTo`.
export async function reconnectGithub(
  installationId: string,
  connectUrl: string | null,
  returnTo: string,
): Promise<'reconnected' | 'redirected'> {
  const result = await apiRequest<GithubInstallation>(
    `/api/github/installations/${encodeURIComponent(installationId)}/reconnect`,
    { method: 'POST' },
  );
  if (result.status === 'active') return 'reconnected';
  if (!connectUrl) {
    throw new Error('GitHub no longer has this installation, and GitHub is not configured for this workspace.');
  }
  window.location.assign(githubConnectHref(connectUrl, returnTo));
  return 'redirected';
}

// What the setup callback reports in `?github=` when it sends the vendor back.
export const GITHUB_RETURN_MESSAGES: Record<string, { ok: boolean; message: string }> = {
  connected: { ok: true, message: 'GitHub connected.' },
  disconnected: {
    ok: false,
    message: 'GitHub stays disconnected for this organization. An owner or admin can reconnect it in Settings.',
  },
  failed: {
    ok: false,
    message:
      'Deployz could not link the GitHub installation to this organization. An installation that another Deployz organization already uses cannot be linked here.',
  },
  missing_installation: { ok: false, message: 'GitHub did not return an installation. Try again.' },
  forbidden: { ok: false, message: 'Only an owner or admin can connect GitHub. Ask one of them to connect it.' },
};
