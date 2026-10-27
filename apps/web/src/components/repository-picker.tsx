'use client';

import { ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';

import { DocsLink } from '@/components/docs-link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api-client';
import { createApplication, triggerAnalysis, type Application } from '@/lib/applications';
import {
  fetchGithubInstallations,
  fetchGithubRepositories,
  type GithubInstallation,
  type GithubRepository,
} from '@/lib/github';
import { DOCS } from '@/lib/docs-links';
import { loadGithubState, type GithubState } from '@/lib/github-state';
import { connectedApplicationsByRepo, filterRepositories } from '@/lib/repository-picker';

// §42 steps 1-2: connect GitHub, choose a repository. Shared by the
// Applications page (first application, shown inline) and /applications/new
// (every one after that), so there is exactly one repository list. It is
// honest about GitHub state: no App installed -> Connect GitHub, never a
// fabricated repo list (§65).
export function RepositoryPicker({ applications }: { applications: Application[] }) {
  const [githubState, setGithubState] = useState<GithubState>({ status: 'loading' });
  // Bumped by "Try again" so the GitHub load re-runs. A GitHub outage is the
  // kind of thing that clears on its own, and a full page reload would throw
  // away everything else on the page with it.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setGithubState({ status: 'loading' });
    void loadGithubState({
      fetchInstallations: fetchGithubInstallations,
      fetchRepositories: fetchGithubRepositories,
    }).then((state) => {
      if (!cancelled) setGithubState(state);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (githubState.status === 'loading') {
    return (
      <div className="flex flex-col gap-3" data-testid="repository-picker-loading" aria-busy="true">
        <p role="status" className="sr-only">
          Loading repositories…
        </p>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (githubState.status === 'error') {
    return (
      <section
        aria-labelledby="github-error"
        data-testid="github-error"
        className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
      >
        <h2 id="github-error" className="text-lg font-semibold">
          Something went wrong
        </h2>
        <p className="text-sm text-muted-foreground">{githubState.message}</p>
        <Button
          variant="outline"
          data-testid="github-retry"
          onClick={() => setAttempt((current) => current + 1)}
        >
          Try again
        </Button>
      </section>
    );
  }

  if (githubState.status === 'empty') {
    return (
      <ConnectGitHubEmptyState
        connectUrl={githubState.connectUrl}
        canConnect={githubState.canConnect}
        inactive={githubState.inactive}
      />
    );
  }

  return (
    <RepositoryList
      installations={githubState.installations}
      repositories={githubState.repositories}
      unreachable={new Set(githubState.unreachable)}
      connectUrl={githubState.connectUrl}
      connectedRepos={connectedApplicationsByRepo(applications)}
    />
  );
}

function ConnectGitHubEmptyState({
  connectUrl,
  canConnect,
  inactive,
}: {
  connectUrl: string | null;
  canConnect: boolean;
  inactive: boolean;
}) {
  if (inactive) {
    return (
      <section
        aria-labelledby="connect-github"
        data-testid="github-inactive"
        className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
      >
        <h2 id="connect-github" className="text-lg font-semibold">
          GitHub is not connected
        </h2>
        <p className="max-w-md text-sm text-muted-foreground">
          This organization&apos;s GitHub connection is disconnected or has an access issue. Reconnect it to choose a
          repository.
        </p>
        <Button asChild>
          <Link href="/dashboard/settings#github">Open GitHub settings</Link>
        </Button>
      </section>
    );
  }
  return (
    <section
      aria-labelledby="connect-github"
      className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <h2 id="connect-github" className="text-lg font-semibold">
        Connect your code
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Link GitHub to choose a repository. Deployz requests read-only access to your code.
      </p>
      {connectUrl ? (
        <Button asChild>
          <a href={connectUrl}>Connect GitHub</a>
        </Button>
      ) : (
        <Button disabled>Connect GitHub</Button>
      )}
      {!connectUrl ? (
        <p className="text-xs text-muted-foreground">
          {canConnect
            ? "GitHub isn't configured for this workspace."
            : 'Ask an owner or admin of your organization to connect GitHub.'}
        </p>
      ) : null}
      <DocsLink href={DOCS.github}>How to connect GitHub</DocsLink>
    </section>
  );
}

function RepositoryList({
  installations,
  repositories,
  unreachable,
  connectUrl,
  connectedRepos,
}: {
  installations: GithubInstallation[];
  repositories: Record<string, GithubRepository[]>;
  /** Installation ids GitHub would not list repositories for — said out loud
   *  rather than shown as an account with no repositories. */
  unreachable: Set<string>;
  connectUrl: string | null;
  /** repoFullName -> the application already connected to it. */
  connectedRepos: Map<string, string>;
}) {
  const [query, setQuery] = useState('');
  const searchId = useId();

  const groups = installations.map((installation) => {
    const repos = repositories[installation.id] ?? [];
    return {
      installation,
      failed: unreachable.has(installation.id),
      repos,
      matches: filterRepositories(repos, query),
    };
  });
  const total = groups.reduce((sum, group) => sum + group.repos.length, 0);
  const matched = groups.reduce((sum, group) => sum + group.matches.length, 0);
  const searching = query.trim() !== '';

  // Nothing to search when GitHub listed no repositories at all: the only
  // useful thing on the page is the way to grant access.
  if (total === 0 && unreachable.size === 0) {
    return (
      <section
        aria-labelledby="no-repositories"
        className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center"
      >
        <h2 id="no-repositories" className="text-lg font-semibold">
          No repositories available
        </h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Grant Deployz access to a repository in GitHub.
        </p>
        <ManageGithubAccess connectUrl={connectUrl} />
        <DocsLink href={DOCS.github}>How to give Deployz access</DocsLink>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {total > 0 ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={searchId} className="sr-only">
            Search repositories
          </label>
          <Input
            id={searchId}
            type="search"
            placeholder="Search repositories..."
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            data-testid="repo-search"
          />
          <p role="status" className="sr-only">
            {searching ? `${matched} of ${total} repositories match` : `${total} repositories`}
          </p>
        </div>
      ) : null}

      <p className="text-xs font-medium text-muted-foreground">GitHub</p>

      {groups.map(({ installation, failed, repos, matches }) => {
        // A search that matches nothing in this account hides the account
        // rather than showing an empty heading; the shared "No repositories
        // found" state below speaks for all of them.
        if (searching && !failed && matches.length === 0) return null;
        const headingId = `github-account-${installation.id}`;
        return (
          <section key={installation.id} aria-labelledby={headingId} className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <h3 id={headingId} className="text-sm font-medium">
                {installation.accountLogin}
              </h3>
              <span className="text-xs text-muted-foreground">
                {failed
                  ? "Couldn't reach GitHub"
                  : `${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}`}
              </span>
            </div>
            {matches.length > 0 ? (
              <ul className="divide-y overflow-hidden rounded-lg border">
                {matches.map((repo) => (
                  <RepositoryRow
                    key={repo.id}
                    installationId={installation.id}
                    repo={repo}
                    connectedApplicationId={connectedRepos.get(repo.fullName) ?? null}
                  />
                ))}
              </ul>
            ) : null}
            {failed ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid={`repos-unavailable-${installation.id}`}
              >
                Couldn&apos;t load repositories for {installation.accountLogin}. Try again, or check
                that Deployz is still installed on GitHub.
              </p>
            ) : null}
            {!failed && repos.length === 0 ? (
              <p className="text-sm text-muted-foreground">No repositories to show.</p>
            ) : null}
          </section>
        );
      })}

      {searching && matched === 0 ? (
        <section
          aria-labelledby="no-search-results"
          data-testid="repo-search-empty"
          className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-12 text-center"
        >
          <h3 id="no-search-results" className="text-base font-semibold">
            No repositories found
          </h3>
          <p className="max-w-md text-sm text-muted-foreground">
            Try another search, or check Deployz has access in GitHub.
          </p>
          <ManageGithubAccess connectUrl={connectUrl} />
        </section>
      ) : (
        // Always reachable, even when every listing above failed: it is both
        // how you add another account and how you repair a broken one.
        <p className="text-sm text-muted-foreground">
          Don&apos;t see your repository? <ManageGithubAccess connectUrl={connectUrl} inline />
        </p>
      )}
    </div>
  );
}

// The GitHub App's install page is where a vendor grants Deployz access to
// more repositories (or another account). Rendered only when the workspace
// has the App configured — never a link to nowhere.
function ManageGithubAccess({
  connectUrl,
  inline = false,
}: {
  connectUrl: string | null;
  inline?: boolean;
}) {
  if (!connectUrl) return null;
  if (inline) {
    return (
      <a
        href={connectUrl}
        data-testid="github-manage"
        className="font-medium text-foreground underline underline-offset-4 hover:text-primary"
      >
        Manage GitHub access
      </a>
    );
  }
  return (
    <Button variant="outline" asChild data-testid="github-manage">
      <a href={connectUrl}>Manage GitHub access</a>
    </Button>
  );
}

const rowClass =
  'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset';

// §42 step 2 "Choose repository": creates the Application (POST
// /api/applications), kicks off analysis (POST .../analyse), and only then
// navigates to the real (UUID) application id. The whole row is the one
// control — a button to select, or a link to the application that already
// has this repository — so there is nothing nested to fight over focus.
function RepositoryRow({
  installationId,
  repo,
  connectedApplicationId,
}: {
  installationId: string;
  repo: GithubRepository;
  /** Set when this repository is already an application in this organization. */
  connectedApplicationId: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSelect(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const application = await createApplication({
        name: repo.name,
        githubInstallationId: installationId,
        repoFullName: repo.fullName,
        repoUrl: `https://github.com/${repo.fullName}`,
        defaultBranch: repo.defaultBranch,
      });
      await triggerAnalysis(application.id);
      router.push(`/dashboard/applications/${application.id}`);
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }

  const summary = (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium">{repo.name}</span>
      {repo.description ? (
        <span className="block truncate text-xs text-muted-foreground">{repo.description}</span>
      ) : null}
    </span>
  );

  return (
    <li data-testid={`repo-row-${repo.fullName}`}>
      {connectedApplicationId ? (
        <Link href={`/dashboard/applications/${connectedApplicationId}`} className={rowClass}>
          {summary}
          <span className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
            <Check className="size-4" aria-hidden />
            Added
          </span>
        </Link>
      ) : (
        <button
          type="button"
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={onSelect}
          className={`${rowClass} disabled:pointer-events-none disabled:opacity-60`}
        >
          {summary}
          <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-primary">
            {pending ? (
              <>
                <Spinner aria-hidden="true" className="size-3.5" />
                Setting up…
              </>
            ) : (
              <>
                Select
                <ArrowRight className="size-4" aria-hidden />
              </>
            )}
          </span>
        </button>
      )}
      {error ? (
        <p role="alert" className="px-3 pb-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}
