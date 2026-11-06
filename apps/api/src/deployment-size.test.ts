import { describe, expect, it } from 'vitest';

import { SELECTABLE_SIZE_TIERS } from '@deployz/contracts';

import { resolveSizeSelection, sizingBounds } from './deployment-size.js';
import { ApiError } from './errors.js';

describe('size selection', () => {
  it('offers Small, Medium and Large', () => {
    expect(SELECTABLE_SIZE_TIERS).toEqual(['small', 'medium', 'large']);
  });

  it('resolves to Small when nothing is requested', () => {
    const selection = resolveSizeSelection({ defaultSizeProfile: 'small', minimumSizeProfile: 'small' }, undefined);
    expect(selection.tier).toBe('small');
    expect(selection.profile.id).toBe('small');
  });

  it('resolves a requested Medium or Large', () => {
    for (const tier of ['medium', 'large'] as const) {
      const selection = resolveSizeSelection({ defaultSizeProfile: 'small', minimumSizeProfile: 'small' }, tier);
      expect(selection.tier).toBe(tier);
      expect(selection.profile.id).toBe(tier);
    }
  });

  it('refuses a size below the minimum with 422 SIZE_PROFILE_NOT_ALLOWED', () => {
    try {
      resolveSizeSelection({ defaultSizeProfile: 'medium', minimumSizeProfile: 'medium' }, 'small');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ statusCode: 422, code: 'SIZE_PROFILE_NOT_ALLOWED' });
    }
  });

  it('keeps a stored Medium or Large application setting', () => {
    const application = { defaultSizeProfile: 'large', minimumSizeProfile: 'medium' } as const;
    expect(sizingBounds(application)).toEqual({ recommended: 'large', minimum: 'medium' });
    expect(resolveSizeSelection(application, undefined).tier).toBe('large');
  });
});
