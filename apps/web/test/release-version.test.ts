import { describe, expect, it } from 'vitest';

import { formatReleaseVersion } from '../src/lib/release-version';

describe('formatReleaseVersion', () => {
  it('prefixes a bare version with v', () => {
    expect(formatReleaseVersion('1.3.0')).toBe('v1.3.0');
  });

  it('leaves a version that already starts with v unchanged', () => {
    expect(formatReleaseVersion('v0.2.2-e2e-0904')).toBe('v0.2.2-e2e-0904');
  });

  it('leaves a version that already starts with V unchanged', () => {
    expect(formatReleaseVersion('V2.0.0')).toBe('V2.0.0');
  });

  it('leaves a commit-named release unchanged', () => {
    expect(formatReleaseVersion('8b69e5d109cb')).toBe('8b69e5d109cb');
    expect(formatReleaseVersion('8b69e5d109cb-2')).toBe('8b69e5d109cb-2');
  });
});
