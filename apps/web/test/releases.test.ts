import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../src/lib/api-client';
import {
  BuildConfigurationMissingError,
  createRelease,
  deployableReleases,
  firstReleaseInput,
  installReleaseState,
  installSummaryLine,
  newestFirst,
  runningOn,
  runningOnLabel,
  shortSha,
  suggestNextVersion,
  type Release,
} from '../src/lib/releases';

function makeRelease(overrides: Partial<Release>): Release {
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

describe('deployableReleases', () => {
  it('offers only READY releases, excluding UNAVAILABLE', () => {
    const releases: Release[] = [
      makeRelease({ id: 'ready-1', status: 'READY' }),
      makeRelease({ id: 'unavailable-1', status: 'UNAVAILABLE' }),
      makeRelease({ id: 'failed-1', status: 'FAILED' }),
      makeRelease({ id: 'building-1', status: 'BUILDING' }),
    ];
    const result = deployableReleases(releases, null);
    expect(result.map((r) => r.id)).toEqual(['ready-1']);
  });
});

describe('suggestNextVersion', () => {
  it('increments the patch of the newest release, keeping the v prefix', () => {
    const versions = [
      { version: 'v0.1.0', createdAt: '2026-09-01T00:00:00.000Z' },
      { version: 'v0.1.1', createdAt: '2026-09-10T00:00:00.000Z' },
    ];
    expect(suggestNextVersion(versions)).toBe('v0.1.2');
  });

  it('increments the patch of a bare (non-prefixed) semver version', () => {
    expect(suggestNextVersion([{ version: '1.0.9', createdAt: '2026-09-01T00:00:00.000Z' }])).toBe(
      '1.0.10',
    );
  });

  it('returns an empty string when the newest version is not plain semver', () => {
    expect(
      suggestNextVersion([{ version: 'sha-1.0.0', createdAt: '2026-09-01T00:00:00.000Z' }]),
    ).toBe('');
  });

  it('suggests v0.1.0 for the first release', () => {
    expect(suggestNextVersion([])).toBe('v0.1.0');
  });
});

describe('installReleaseState', () => {
  it('names the newest READY release as the one an install runs', () => {
    const state = installReleaseState([
      makeRelease({ id: 'old', createdAt: '2026-09-01T00:00:00.000Z' }),
      makeRelease({ id: 'new', createdAt: '2026-09-02T00:00:00.000Z' }),
      makeRelease({ id: 'building', status: 'BUILDING', createdAt: '2026-09-03T00:00:00.000Z' }),
    ]);
    expect(state).toMatchObject({ kind: 'ready', release: { id: 'new' } });
  });

  it('is building when no release is READY but one is still building', () => {
    const state = installReleaseState([
      makeRelease({ id: 'failed', status: 'FAILED' }),
      makeRelease({ id: 'building', status: 'BUILDING' }),
    ]);
    expect(state).toMatchObject({ kind: 'building', release: { id: 'building' } });
  });

  it('is none without releases, or when every build failed or is unavailable', () => {
    expect(installReleaseState([])).toEqual({ kind: 'none' });
    expect(
      installReleaseState([
        makeRelease({ status: 'FAILED' }),
        makeRelease({ status: 'UNAVAILABLE' }),
      ]),
    ).toEqual({ kind: 'none' });
  });
});

describe('newestFirst', () => {
  it('sorts releases by createdAt descending', () => {
    const releases: Release[] = [
      makeRelease({ id: 'old', createdAt: '2026-09-01T00:00:00.000Z' }),
      makeRelease({ id: 'newest', createdAt: '2026-09-10T00:00:00.000Z' }),
      makeRelease({ id: 'middle', createdAt: '2026-09-05T00:00:00.000Z' }),
    ];
    expect(newestFirst(releases).map((r) => r.id)).toEqual(['newest', 'middle', 'old']);
  });
});

describe('shortSha', () => {
  it('takes the first 7 characters of a full SHA', () => {
    expect(shortSha('b2806f9010820a5659899cd0ce0b98d31561041')).toBe('b2806f9');
  });
});

describe('runningOn', () => {
  it('counts live test and customer deployments separately, excluding deleted ones', () => {
    const result = runningOn(
      [
        { currentReleaseId: 'rel-1', state: 'HEALTHY', deploymentType: 'TEST' },
        { currentReleaseId: 'rel-1', state: 'HEALTHY', deploymentType: 'PRODUCTION' },
        { currentReleaseId: 'rel-1', state: 'HEALTHY', deploymentType: 'PRODUCTION' },
        { currentReleaseId: 'rel-1', state: 'DELETED', deploymentType: 'PRODUCTION' },
        { currentReleaseId: 'rel-2', state: 'HEALTHY', deploymentType: 'PRODUCTION' },
      ],
      'rel-1',
    );
    expect(result).toEqual({ test: 1, customer: 2 });
  });
});

describe('runningOnLabel', () => {
  it('describes test and customer counts together, pluralizing as needed', () => {
    expect(runningOnLabel({ test: 0, customer: 0 })).toBeNull();
    expect(runningOnLabel({ test: 1, customer: 0 })).toBe('Test deployment');
    expect(runningOnLabel({ test: 0, customer: 2 })).toBe('2 customer deployments');
    expect(runningOnLabel({ test: 1, customer: 2 })).toBe('Test deployment · 2 customer deployments');
  });
});

describe('installSummaryLine', () => {
  it('names the newest READY release as what customers install', () => {
    const releases = [
      makeRelease({ version: 'v0.1.0', gitSha: 'b2806f9010820a5659899cd0ce0b98d31561041', createdAt: '2026-09-01T00:00:00.000Z' }),
    ];
    expect(installSummaryLine(releases)).toBe('Customer installs get v0.1.0 (commit b2806f9).');
  });

  it('still names the older READY release when a newer one failed', () => {
    const releases = [
      makeRelease({ id: 'ready', version: 'v0.1.0', status: 'READY', createdAt: '2026-09-01T00:00:00.000Z' }),
      makeRelease({ id: 'failed', version: 'v0.1.1', status: 'FAILED', createdAt: '2026-09-10T00:00:00.000Z' }),
    ];
    expect(installSummaryLine(releases)).toContain('v0.1.0');
  });

  it('says a release is building when nothing is ready yet', () => {
    expect(installSummaryLine([makeRelease({ version: 'v0.1.0', status: 'BUILDING' })])).toBe(
      'v0.1.0 is building — customers cannot install until it finishes.',
    );
  });

  it('says no release is ready when there is none', () => {
    expect(installSummaryLine([])).toBe('No release is ready yet — customers cannot install.');
    expect(installSummaryLine([makeRelease({ status: 'FAILED' })])).toBe(
      'No release is ready yet — customers cannot install.',
    );
  });
});

describe('firstReleaseInput', () => {
  it('builds from the analysed commit, versioned by its first 12 characters', () => {
    const sha = 'b2806f9010820a5659899cd0ce0b98d31561041d';
    expect(firstReleaseInput({ analysisCommitSha: sha })).toEqual({ version: 'b2806f901082', gitSha: sha });
  });

  it('is null when the analysis recorded no commit', () => {
    expect(firstReleaseInput(null)).toBeNull();
    expect(firstReleaseInput({})).toBeNull();
  });

  it('numbers the version when an earlier build of the same commit holds it', () => {
    const sha = 'b2806f9010820a5659899cd0ce0b98d31561041d';
    expect(firstReleaseInput({ analysisCommitSha: sha }, ['other', 'b2806f901082'])?.version).toBe('b2806f901082-2');
    expect(firstReleaseInput({ analysisCommitSha: sha }, ['b2806f901082', 'b2806f901082-2'])?.version).toBe(
      'b2806f901082-3',
    );
  });
});

describe('createRelease errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubResponse(status: number, body: unknown): void {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
  }

  it('carries the API message for a duplicate version', async () => {
    const message = 'Version v1 already exists for this application. Use a different version number.';
    stubResponse(409, { error: { code: 'RELEASE_VERSION_EXISTS', message } });
    const error = await createRelease('app-1', { version: 'v1', gitSha: 'a'.repeat(40) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ code: 'RELEASE_VERSION_EXISTS', message });
  });

  it('still names the missing build values', async () => {
    stubResponse(422, { error: { code: 'BUILD_CONFIGURATION_MISSING', message: 'x', details: { keys: ['A', 'B'] } } });
    const error = await createRelease('app-1', { version: 'v1', gitSha: 'a'.repeat(40) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BuildConfigurationMissingError);
    expect((error as BuildConfigurationMissingError).keys).toEqual(['A', 'B']);
  });
});
