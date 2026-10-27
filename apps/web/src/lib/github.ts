import { apiUrl } from '@/lib/api-url';

export interface GithubInstallation {
  id: string;
  accountLogin: string;
  accountType: string;
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
