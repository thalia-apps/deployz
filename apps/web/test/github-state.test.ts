import { describe, expect, it } from 'vitest';

import type { GithubInstallation, GithubRepository } from '../src/lib/github';
import { loadGithubState } from '../src/lib/github-state';

function installation(overrides: Partial<GithubInstallation> = {}): GithubInstallation {
  return {
    id: 'install-1',
    accountLogin: 'acme',
    accountType: 'Organization',
    status: 'active',
    applicationCount: 0,
    manageUrl: 'https://github.com/organizations/acme/settings/installations/install-1',
    ...overrides,
  };
}

function repository(overrides: Partial<GithubRepository> = {}): GithubRepository {
  return {
    id: 'repo-1',
    name: 'myapp',
    fullName: 'acme/myapp',
    description: null,
    private: false,
    defaultBranch: 'main',
    ...overrides,
  };
}

const CONNECT_URL = 'https://github.com/apps/deployz/installations/new';

describe('loadGithubState', () => {
  it('reports an empty state, keeping the connect link, when nothing is installed', async () => {
    const state = await loadGithubState({
      fetchInstallations: async () => ({ installations: [], connectUrl: CONNECT_URL, canConnect: true }),
      fetchRepositories: async () => {
        throw new Error('should not be called');
      },
    });

    expect(state).toEqual({ status: 'empty', connectUrl: CONNECT_URL, canConnect: true, inactive: false });
  });

  it('tells a member they cannot connect GitHub', async () => {
    const state = await loadGithubState({
      fetchInstallations: async () => ({ installations: [], connectUrl: null, canConnect: false }),
      fetchRepositories: async () => {
        throw new Error('should not be called');
      },
    });

    expect(state).toEqual({ status: 'empty', connectUrl: null, canConnect: false, inactive: false });
  });

  // A disconnected connection lists no repositories and backs no new
  // application, but the page says the connection exists.
  it('offers no repositories from a connection that is not active', async () => {
    const state = await loadGithubState({
      fetchInstallations: async () => ({
        installations: [installation({ status: 'disconnected' }), installation({ id: 'install-2', status: 'access_issue' })],
        connectUrl: CONNECT_URL,
        canConnect: true,
      }),
      fetchRepositories: async () => {
        throw new Error('should not be called');
      },
    });

    expect(state).toEqual({ status: 'empty', connectUrl: CONNECT_URL, canConnect: true, inactive: true });
  });

  it('lists each installation with its repositories', async () => {
    const state = await loadGithubState({
      fetchInstallations: async () => ({
        installations: [installation()],
        connectUrl: CONNECT_URL,
        canConnect: true,
      }),
      fetchRepositories: async () => ({ repositories: [repository()] }),
    });

    expect(state).toEqual({
      status: 'loaded',
      connectUrl: CONNECT_URL,
      installations: [installation()],
      repositories: { 'install-1': [repository()] },
      unreachable: [],
    });
  });

  // The bug: one installation GitHub can't answer for used to collapse the
  // whole panel into "Something went wrong", taking the connect button with
  // it — leaving no way to add an application at all.
  it('keeps the installations GitHub did answer for when another one fails', async () => {
    const state = await loadGithubState({
      fetchInstallations: async () => ({
        installations: [installation(), installation({ id: 'install-2', accountLogin: 'beta' })],
        connectUrl: CONNECT_URL,
        canConnect: true,
      }),
      fetchRepositories: async (id) => {
        if (id === 'install-2') throw new Error('GitHub request failed (502)');
        return { repositories: [repository()] };
      },
    });

    expect(state).toEqual({
      status: 'loaded',
      connectUrl: CONNECT_URL,
      installations: [installation(), installation({ id: 'install-2', accountLogin: 'beta' })],
      repositories: { 'install-1': [repository()] },
      unreachable: ['install-2'],
    });
  });

  // An installation GitHub cannot answer for is never reported as an empty
  // repository list — that would read as "this account has no repositories".
  it('still offers the connect link when every repository listing fails', async () => {
    const state = await loadGithubState({
      fetchInstallations: async () => ({
        installations: [installation()],
        connectUrl: CONNECT_URL,
        canConnect: true,
      }),
      fetchRepositories: async () => {
        throw new Error('GitHub request failed (502)');
      },
    });

    expect(state).toEqual({
      status: 'loaded',
      connectUrl: CONNECT_URL,
      installations: [installation()],
      repositories: {},
      unreachable: ['install-1'],
    });
  });

  it('reports an error only when the installation list itself is unreachable', async () => {
    const state = await loadGithubState({
      fetchInstallations: async () => {
        throw new Error('GitHub request failed (500)');
      },
      fetchRepositories: async () => ({ repositories: [] }),
    });

    expect(state).toEqual({
      status: 'error',
      message: "We couldn't reach GitHub. Try again in a moment.",
    });
  });
});
