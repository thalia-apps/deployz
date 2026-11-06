import { describe, expect, it } from 'vitest';

import { SELECTABLE_SIZE_TIERS } from '@deployz/contracts';

import { resolveSizeSelection, sizingBounds } from './deployment-size.js';
import { ApiError } from './errors.js';

describe('pilot size selection', () => {
  it('offers only Small', () => {
    expect(SELECTABLE_SIZE_TIERS).toEqual(['small']);
  });

  it('resolves to Small when nothing is requested', () => {
    const selection = resolveSizeSelection({ defaultSizeProfile: 'small', minimumSizeProfile: 'small' }, undefined);
    expect(selection.tier).toBe('small');
    expect(selection.profile.id).toBe('small');
  });

  it('refuses a requested Medium or Large with 422 SIZE_PROFILE_NOT_ALLOWED', () => {
    for (const tier of ['medium', 'large'] as const) {
      try {
        resolveSizeSelection({ defaultSizeProfile: 'small', minimumSizeProfile: 'small' }, tier);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect(error).toMatchObject({ statusCode: 422, code: 'SIZE_PROFILE_NOT_ALLOWED' });
      }
    }
  });

  it('resolves a stored Medium or Large application setting to Small', () => {
    const application = { defaultSizeProfile: 'large', minimumSizeProfile: 'medium' } as const;
    expect(sizingBounds(application)).toEqual({ recommended: 'small', minimum: 'small' });
    expect(resolveSizeSelection(application, undefined).tier).toBe('small');
  });
});
