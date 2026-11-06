import { describe, expect, it } from 'vitest';

import {
  allowedSizeTiers,
  currentInfrastructureSizeProfile,
  defaultInfrastructureSizeProfile,
  INFRASTRUCTURE_SIZE_PROFILES,
  LARGE_PROFILE,
  MEDIUM_PROFILE,
  SELECTABLE_SIZE_TIERS,
  profileKey,
  resolveInfrastructureSizeProfile,
  resolveStoredInfrastructureSizeProfile,
  SMALL_PROFILE,
  SMALL_V2_PROFILE,
  sizeTierMeetsMinimum,
} from './profile.js';

describe('infrastructure-size profile registry', () => {
  it('publishes four immutable profiles: small-v1, small-v2, medium-v1 and large-v1', () => {
    expect(INFRASTRUCTURE_SIZE_PROFILES.map(profileKey)).toEqual(['small-v1', 'small-v2', 'medium-v1', 'large-v1']);
    expect(SMALL_PROFILE.id).toBe('small');
    expect(SMALL_PROFILE.version).toBe(1);
    expect(profileKey(SMALL_PROFILE)).toBe('small-v1');
    expect(SMALL_V2_PROFILE.id).toBe('small');
    expect(SMALL_V2_PROFILE.version).toBe(2);
    expect(profileKey(SMALL_V2_PROFILE)).toBe('small-v2');
  });

  it('small-v1 preserves the pre-registry AWS sizing exactly', () => {
    expect(SMALL_PROFILE.workload).toEqual({ cpuUnits: 256, memoryMiB: 512, desiredCount: 1 });
    expect(SMALL_PROFILE.database).toEqual({
      instanceClass: 'db.t4g.micro',
      storageGb: 20,
      maxStorageGb: 100,
      storageType: 'gp2',
    });
    expect(SMALL_PROFILE.cache).toEqual({ nodeType: 'cache.t4g.micro', nodeCount: 1 });
    expect(SMALL_PROFILE.label).toBe('Small');
  });

  it('small-v2 uses db.t3.micro and gp3 for portability', () => {
    expect(SMALL_V2_PROFILE.workload).toEqual({ cpuUnits: 256, memoryMiB: 512, desiredCount: 1 });
    expect(SMALL_V2_PROFILE.database).toEqual({
      instanceClass: 'db.t3.micro',
      storageGb: 20,
      maxStorageGb: 100,
      storageType: 'gp3',
    });
    expect(SMALL_V2_PROFILE.cache).toEqual({ nodeType: 'cache.t4g.micro', nodeCount: 1 });
    expect(SMALL_V2_PROFILE.label).toBe('Small');
  });

  it('medium-v1 and large-v1 change capacity only', () => {
    expect(MEDIUM_PROFILE.workload).toEqual({ cpuUnits: 1024, memoryMiB: 2048, desiredCount: 1 });
    expect(MEDIUM_PROFILE.database).toEqual({ instanceClass: 'db.t3.medium', storageGb: 20, maxStorageGb: 100, storageType: 'gp3' });
    expect(MEDIUM_PROFILE.cache).toEqual({ nodeType: 'cache.t4g.small', nodeCount: 1 });
    expect(LARGE_PROFILE.workload).toEqual({ cpuUnits: 2048, memoryMiB: 4096, desiredCount: 1 });
    expect(LARGE_PROFILE.database).toEqual({ instanceClass: 'db.t3.large', storageGb: 20, maxStorageGb: 100, storageType: 'gp3' });
    expect(LARGE_PROFILE.cache).toEqual({ nodeType: 'cache.t4g.medium', nodeCount: 1 });
  });

  it('resolves published profiles by id + version and fails closed on unknown', () => {
    expect(resolveInfrastructureSizeProfile('small', 1)).toBe(SMALL_PROFILE);
    expect(resolveInfrastructureSizeProfile('small', 2)).toBe(SMALL_V2_PROFILE);
    expect(resolveInfrastructureSizeProfile('medium', 1)).toBe(MEDIUM_PROFILE);
    expect(resolveInfrastructureSizeProfile('large', 1)).toBe(LARGE_PROFILE);
    expect(resolveInfrastructureSizeProfile('small', 3)).toBeUndefined();
    expect(resolveInfrastructureSizeProfile('large', 2)).toBeUndefined();
    expect(resolveInfrastructureSizeProfile('xlarge', 1)).toBeUndefined();
  });

  it('maps each tier to the version new deployments freeze', () => {
    expect(currentInfrastructureSizeProfile('small')).toBe(SMALL_V2_PROFILE);
    expect(currentInfrastructureSizeProfile('medium')).toBe(MEDIUM_PROFILE);
    expect(currentInfrastructureSizeProfile('large')).toBe(LARGE_PROFILE);
  });

  it('orders tiers for the minimum-size rule', () => {
    expect(sizeTierMeetsMinimum('small', 'small')).toBe(true);
    expect(sizeTierMeetsMinimum('small', 'medium')).toBe(false);
    expect(sizeTierMeetsMinimum('large', 'medium')).toBe(true);
    expect(allowedSizeTiers('small')).toEqual(['small', 'medium', 'large']);
    expect(allowedSizeTiers('medium')).toEqual(['medium', 'large']);
    expect(allowedSizeTiers('large')).toEqual(['large']);
  });

  it('offers every tier for new selections', () => {
    expect(SELECTABLE_SIZE_TIERS).toEqual(['small', 'medium', 'large']);
  });

  it('defaults to small-v2 for newly created deployments', () => {
    expect(defaultInfrastructureSizeProfile()).toBe(SMALL_V2_PROFILE);
  });

  it('resolves a frozen deployment to its stored profile, defaulting legacy deployments to small-v2', () => {
    expect(resolveStoredInfrastructureSizeProfile(null)).toBe(SMALL_V2_PROFILE);
    expect(resolveStoredInfrastructureSizeProfile({})).toBe(SMALL_V2_PROFILE);
    expect(
      resolveStoredInfrastructureSizeProfile({ infrastructureProfile: { id: 'small', version: 1 } }),
    ).toBe(SMALL_PROFILE);
    expect(
      resolveStoredInfrastructureSizeProfile({ infrastructureProfile: { id: 'small', version: 2 } }),
    ).toBe(SMALL_V2_PROFILE);
    expect(
      resolveStoredInfrastructureSizeProfile({ infrastructureProfile: { id: 'large', version: 1 } }),
    ).toBe(LARGE_PROFILE);
    // A stored reference to an unpublished profile is undefined, not a guess.
    expect(
      resolveStoredInfrastructureSizeProfile({ infrastructureProfile: { id: 'large', version: 2 } }),
    ).toBeUndefined();
    expect(
      resolveStoredInfrastructureSizeProfile({ infrastructureProfile: { id: 'small', version: 99 } }),
    ).toBeUndefined();
  });
});
