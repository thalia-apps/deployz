import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEPLOYMENT_SORT,
  deploymentUpdatedAt,
  filterDeployments,
  hasActiveFilters,
  parseDeploymentQuery,
  sortDeployments,
  type DeploymentListQuery,
} from '../src/lib/deployment-list';
import type { FleetDeployment } from '../src/lib/deployments';
import { fleetDeployment } from './fixtures/fleet-deployment';

const NO_FILTERS: DeploymentListQuery = {
  search: '',
  status: null,
  application: null,
  region: null,
  sort: DEFAULT_DEPLOYMENT_SORT,
};

function row(
  id: string,
  state: string,
  overrides: Parameters<typeof fleetDeployment>[0] = {},
): FleetDeployment {
  return fleetDeployment({ id, state: state as FleetDeployment['state'], customerName: `Cust ${id}`, ...overrides });
}

const at = (iso: string) => ({ deploymentStatus: { updatedAt: iso } });

// One of everything the list can show, each with its own timestamp.
const FLEET: FleetDeployment[] = [
  row('healthy', 'HEALTHY', { ...at('2026-09-01T10:00:00Z'), region: 'ap-south-1', applicationName: 'Docs' }),
  row('healthy-new', 'HEALTHY', at('2026-09-05T10:00:00Z')),
  row('progress', 'INSTALLING', at('2026-09-02T10:00:00Z')),
  row('waiting', 'NOT_INSTALLED', at('2026-09-03T10:00:00Z')),
  row('update', 'UPDATE_AVAILABLE', at('2026-09-04T10:00:00Z')),
  row('failed', 'FAILED', at('2026-08-01T10:00:00Z')),
  row('lost', 'HEALTHY', { relayStatus: 'DISCONNECTED', ...at('2026-09-06T10:00:00Z') }),
  row('removed', 'DELETED', at('2026-09-07T10:00:00Z')),
];

const ids = (list: FleetDeployment[]) => list.map((d) => d.id);

describe('parseDeploymentQuery', () => {
  it('reads every part of the view from the URL', () => {
    const query = parseDeploymentQuery(
      new URLSearchParams('q=acme&status=attention&application=Docs&region=ap-south-1&sort=updated&dir=asc'),
    );
    expect(query).toEqual({
      search: 'acme',
      status: 'attention',
      application: 'Docs',
      region: 'ap-south-1',
      sort: { key: 'updated', dir: 'asc' },
    });
  });

  it('means "everything, default order" for an empty URL', () => {
    expect(parseDeploymentQuery(new URLSearchParams(''))).toEqual(NO_FILTERS);
  });

  it('ignores an unknown status, sort key or direction instead of hiding every row', () => {
    const query = parseDeploymentQuery(new URLSearchParams('status=BOGUS&sort=nope&dir=sideways'));
    expect(query.status).toBeNull();
    expect(query.sort).toEqual(DEFAULT_DEPLOYMENT_SORT);
    expect(parseDeploymentQuery(new URLSearchParams('sort=updated&dir=sideways')).sort).toEqual({
      key: 'updated',
      dir: 'desc',
    });
  });

  it('does not accept the raw lifecycle enum as a status', () => {
    expect(parseDeploymentQuery(new URLSearchParams('status=DELETED')).status).toBeNull();
  });
});

describe('hasActiveFilters', () => {
  it('is true for each narrowing part on its own, and false for sort or blank search', () => {
    expect(hasActiveFilters(NO_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...NO_FILTERS, search: '   ' })).toBe(false);
    expect(hasActiveFilters({ ...NO_FILTERS, sort: { key: 'customer', dir: 'desc' } })).toBe(false);
    expect(hasActiveFilters({ ...NO_FILTERS, search: 'a' })).toBe(true);
    expect(hasActiveFilters({ ...NO_FILTERS, status: 'healthy' })).toBe(true);
    expect(hasActiveFilters({ ...NO_FILTERS, application: 'Docs' })).toBe(true);
    expect(hasActiveFilters({ ...NO_FILTERS, region: 'us-east-1' })).toBe(true);
  });
});

describe('filterDeployments', () => {
  it('shows the live fleet by default and leaves removed deployments out', () => {
    expect(ids(filterDeployments(FLEET, NO_FILTERS))).not.toContain('removed');
    expect(filterDeployments(FLEET, NO_FILTERS)).toHaveLength(FLEET.length - 1);
  });

  it.each([
    ['healthy', ['healthy', 'healthy-new', 'update']],
    ['in-progress', ['progress']],
    ['attention', ['failed', 'lost']],
    ['waiting', ['waiting']],
    ['update-available', ['update']],
    ['removed', ['removed']],
  ] as const)('the %s status filter keeps its group', (status, expected) => {
    expect(ids(filterDeployments(FLEET, { ...NO_FILTERS, status })).sort()).toEqual([...expected].sort());
  });

  it('filters by application and by region', () => {
    expect(ids(filterDeployments(FLEET, { ...NO_FILTERS, application: 'Docs' }))).toEqual(['healthy']);
    expect(ids(filterDeployments(FLEET, { ...NO_FILTERS, region: 'ap-south-1' }))).toEqual(['healthy']);
    expect(filterDeployments(FLEET, { ...NO_FILTERS, region: 'eu-west-1' })).toEqual([]);
  });

  it('searches customer, application, version, deployment id, region code and name, and status label', () => {
    const search = (text: string) => ids(filterDeployments(FLEET, { ...NO_FILTERS, search: text }));
    expect(search('cust healthy-new')).toEqual(['healthy-new']);
    expect(search('docs')).toEqual(['healthy']);
    expect(search('1.4.2')).toHaveLength(FLEET.length - 1);
    expect(search('progress')).toEqual(['progress']);
    expect(search('ap-south-1')).toEqual(['healthy']);
    expect(search('mumbai')).toEqual(['healthy']);
    expect(search('lost contact')).toEqual(['lost']);
    expect(search('   ')).toHaveLength(FLEET.length - 1);
    expect(search('nothing-matches-this')).toEqual([]);
  });

  it('combines every filter with AND', () => {
    const query: DeploymentListQuery = {
      ...NO_FILTERS,
      search: 'healthy',
      status: 'healthy',
      application: 'Docs',
      region: 'ap-south-1',
    };
    expect(ids(filterDeployments(FLEET, query))).toEqual(['healthy']);
    expect(filterDeployments(FLEET, { ...query, status: 'attention' })).toEqual([]);
  });

  it('shows an unknown future status under Needs attention rather than dropping it', () => {
    const future = row('future', 'SOMETHING_NEW');
    expect(ids(filterDeployments([future], { ...NO_FILTERS, status: 'attention' }))).toEqual(['future']);
    expect(ids(filterDeployments([future], NO_FILTERS))).toEqual(['future']);
  });
});

describe('sortDeployments — default operational order', () => {
  it('goes attention → in progress → waiting → update available → healthy → removed', () => {
    const live = sortDeployments(filterDeployments(FLEET, NO_FILTERS), DEFAULT_DEPLOYMENT_SORT);
    expect(ids(live)).toEqual(['lost', 'failed', 'progress', 'waiting', 'update', 'healthy-new', 'healthy']);
    expect(ids(sortDeployments(FLEET, DEFAULT_DEPLOYMENT_SORT)).at(-1)).toBe('removed');
  });

  it('puts the latest change first within a group', () => {
    const list = sortDeployments(FLEET, DEFAULT_DEPLOYMENT_SORT);
    expect(ids(list).indexOf('lost')).toBeLessThan(ids(list).indexOf('failed'));
    expect(ids(list).indexOf('healthy-new')).toBeLessThan(ids(list).indexOf('healthy'));
  });

  it('reversing the status sort shows the calmest first', () => {
    const list = sortDeployments(FLEET, { key: 'status', dir: 'desc' });
    expect(ids(list)[0]).toBe('removed');
    expect(ids(list).at(-1)).toBe('lost');
  });
});

describe('sortDeployments — user-chosen columns', () => {
  it('sorts by updated, newest or oldest first', () => {
    const newest = sortDeployments(FLEET, { key: 'updated', dir: 'desc' });
    expect(ids(newest).slice(0, 2)).toEqual(['removed', 'lost']);
    expect(ids(sortDeployments(FLEET, { key: 'updated', dir: 'asc' }))[0]).toBe('failed');
  });

  it('sorts by customer, application and region in both directions', () => {
    const people = [
      row('a', 'HEALTHY', { customerName: 'beta', applicationName: 'Zed', region: 'us-east-1' }),
      row('b', 'HEALTHY', { customerName: 'Alpha', applicationName: 'Yak', region: 'ap-south-1' }),
      row('c', 'HEALTHY', { customerName: 'gamma', applicationName: 'Xen', region: 'unknown-9' }),
    ];
    expect(ids(sortDeployments(people, { key: 'customer', dir: 'asc' }))).toEqual(['b', 'a', 'c']);
    expect(ids(sortDeployments(people, { key: 'customer', dir: 'desc' }))).toEqual(['c', 'a', 'b']);
    expect(ids(sortDeployments(people, { key: 'application', dir: 'asc' }))).toEqual(['c', 'b', 'a']);
    // Friendly names order the region column: Mumbai, N. Virginia, then the raw code.
    expect(ids(sortDeployments(people, { key: 'region', dir: 'asc' }))).toEqual(['b', 'a', 'c']);
  });

  it('is stable: rows that tie keep the same order in both directions of a refresh', () => {
    const tied = [row('b', 'HEALTHY', { customerName: 'Same' }), row('a', 'HEALTHY', { customerName: 'Same' })];
    expect(ids(sortDeployments(tied, { key: 'customer', dir: 'asc' }))).toEqual(['a', 'b']);
    expect(ids(sortDeployments([...tied].reverse(), { key: 'customer', dir: 'asc' }))).toEqual(['a', 'b']);
  });

  it('applies a sort on top of a filter', () => {
    const filtered = filterDeployments(FLEET, { ...NO_FILTERS, status: 'healthy' });
    expect(ids(sortDeployments(filtered, { key: 'updated', dir: 'asc' }))).toEqual(['healthy', 'update', 'healthy-new']);
  });

  it('does not mutate its input', () => {
    const copy = [...FLEET];
    sortDeployments(FLEET, { key: 'customer', dir: 'desc' });
    expect(FLEET).toEqual(copy);
  });
});

describe('deploymentUpdatedAt', () => {
  it('prefers the derived status time and falls back to the row time', () => {
    expect(deploymentUpdatedAt(fleetDeployment({ ...at('2026-09-01T10:00:00Z') }))).toBe('2026-09-01T10:00:00Z');
    expect(deploymentUpdatedAt(fleetDeployment({ updatedAt: '2026-05-05T05:05:05Z', ...at('garbage') }))).toBe(
      '2026-05-05T05:05:05Z',
    );
  });

  it('is null when no timestamp parses, and such rows sort as oldest', () => {
    const broken = row('broken', 'HEALTHY', { updatedAt: 'nope', ...at('also nope') });
    expect(deploymentUpdatedAt(broken)).toBeNull();
    const list = sortDeployments([broken, row('ok', 'HEALTHY', at('2026-09-01T10:00:00Z'))], {
      key: 'updated',
      dir: 'desc',
    });
    expect(ids(list)).toEqual(['ok', 'broken']);
  });

  it('copes with a row that has no version and an older API without a status projection', () => {
    const bare = { ...row('bare', 'HEALTHY', { version: null }), deploymentStatus: undefined } as unknown as FleetDeployment;
    expect(deploymentUpdatedAt(bare)).toBe('2026-08-01T00:00:00.000Z');
    expect(filterDeployments([bare], { ...NO_FILTERS, search: 'cust bare' })).toHaveLength(1);
  });
});
