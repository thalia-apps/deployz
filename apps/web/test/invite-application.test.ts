import { describe, expect, it } from 'vitest';

import { defaultInviteApplication, inviteApplicationLabel } from '../src/lib/applications';

type Row = Parameters<typeof inviteApplicationLabel>[0];

const ready: Row = { name: 'ready-app', analysisStatus: 'COMPLETE', compatibilityStatus: 'READY' };
const changes: Row = { name: 'fix-app', analysisStatus: 'COMPLETE', compatibilityStatus: 'NEEDS_ATTENTION' };

describe('defaultInviteApplication', () => {
  it('prefers the first application that can be shared', () => {
    expect(defaultInviteApplication([changes, ready])).toBe(ready);
  });

  it('falls back to the first application, and to undefined for none', () => {
    expect(defaultInviteApplication([changes])).toBe(changes);
    expect(defaultInviteApplication([])).toBeUndefined();
  });
});

describe('inviteApplicationLabel', () => {
  it('names why an application cannot be shared yet', () => {
    expect(inviteApplicationLabel(ready)).toBe('ready-app');
    expect(inviteApplicationLabel(changes)).toBe('fix-app (needs input)');
    expect(
      inviteApplicationLabel({ name: 'x', analysisStatus: 'FAILED', compatibilityStatus: null }),
    ).toBe('x (analysis failed)');
    expect(
      inviteApplicationLabel({ name: 'y', analysisStatus: 'ANALYZING', compatibilityStatus: null }),
    ).toBe('y (not analysed yet)');
  });
});
