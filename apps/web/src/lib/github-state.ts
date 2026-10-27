// What the applications page knows about GitHub, derived in one place so the
// page only renders it.
//
// The panel used to be all-or-nothing: `Promise.all` over the installations
// meant one repository listing GitHub couldn't answer for (an App uninstalled
// on GitHub's side, a token GitHub refuses to mint) rejected the lot, and the
// catch threw away `connectUrl` along with it. The result was a dead end --
// "Something went wrong" with no Connect GitHub button, so there was no way
// to add an application and no way to repair the connection either.
//
// Now only an unreachable *installation list* is an error. A repository
// listing that fails costs that one account and nothing else: the rest of the
// accounts still render, and the connect link always survives.

import type {
  GithubInstallation,
  GithubInstallationsResult,
  GithubRepositoriesResult,
  GithubRepository,
} from '@/lib/github';

export type GithubState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty'; connectUrl: string | null; canConnect: boolean }
  | {
      status: 'loaded';
      connectUrl: string | null;
      installations: GithubInstallation[];
      repositories: Record<string, GithubRepository[]>;
      /** Installation ids GitHub would not list repositories for. Kept apart
       *  from "no repositories" so the UI never reads a failure as an empty
       *  account (§65: be honest about GitHub state). */
      unreachable: string[];
    };

interface GithubStateSources {
  fetchInstallations: () => Promise<GithubInstallationsResult>;
  fetchRepositories: (installationId: string) => Promise<GithubRepositoriesResult>;
}

export async function loadGithubState(sources: GithubStateSources): Promise<GithubState> {
  let installations: GithubInstallation[];
  let connectUrl: string | null;
  let canConnect: boolean | undefined;
  try {
    ({ installations, connectUrl, canConnect } = await sources.fetchInstallations());
  } catch {
    return { status: 'error', message: "We couldn't reach GitHub. Try again in a moment." };
  }

  if (installations.length === 0) {
    return { status: 'empty', connectUrl, canConnect: canConnect !== false };
  }

  const repositories: Record<string, GithubRepository[]> = {};
  const unreachable: string[] = [];
  const settled = await Promise.all(
    installations.map(async (installation) => {
      try {
        const { repositories: repos } = await sources.fetchRepositories(installation.id);
        return { id: installation.id, repos };
      } catch {
        return { id: installation.id, repos: null };
      }
    }),
  );
  for (const entry of settled) {
    if (entry.repos === null) {
      unreachable.push(entry.id);
    } else {
      repositories[entry.id] = entry.repos;
    }
  }

  return { status: 'loaded', connectUrl, installations, repositories, unreachable };
}
