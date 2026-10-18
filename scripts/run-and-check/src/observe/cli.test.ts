import { describe, expect, it } from 'vitest';

import { parseArgs } from './cli.js';

describe('parseArgs', () => {
  it('reads repeated and comma separated repositories and the force flag', () => {
    expect(parseArgs(['--repo', 'repo-001,repo-002', '--repo', 'F1', '--force'])).toEqual({
      repos: ['repo-001', 'repo-002', 'F1'],
      force: true,
    });
  });

  it('defaults to all repositories without force', () => {
    expect(parseArgs([])).toEqual({ repos: [], force: false });
  });

  it('refuses unknown arguments and a missing value', () => {
    expect(() => parseArgs(['--nope'])).toThrow('unknown argument');
    expect(() => parseArgs(['--repo'])).toThrow('--repo needs');
  });
});
