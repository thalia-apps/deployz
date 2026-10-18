import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { resolveStage, stageNames } from '../src/stage.js';

describe('stageNames', () => {
  it('keeps production on the names its retained resources already carry', () => {
    expect(stageNames('production')).toEqual({
      stackId: 'Deployz',
      kmsAlias: 'alias/deployz-config-secrets',
      ecrRepositoryName: 'deployz-images',
      templateBucketPrefix: 'deployz-templates',
    });
  });

  it('gives staging its own account-unique names', () => {
    expect(stageNames('staging')).toEqual({
      stackId: 'DeployzStaging',
      kmsAlias: 'alias/deployz-staging-config-secrets',
      ecrRepositoryName: 'deployz-staging-images',
      templateBucketPrefix: 'deployz-staging-templates',
    });
  });

  // The API Lambda's S3 statement is a wildcard on `<prefix>-*`, so one
  // stage's bucket must never match the other stage's wildcard. A staging
  // prefix of `deployz-templates-staging` would stay inside production's
  // grant.
  it('gives each stage a bucket outside the other stage IAM wildcard', () => {
    const production = stageNames('production').templateBucketPrefix;
    const staging = stageNames('staging').templateBucketPrefix;

    expect(`${staging}-us-east-1`.startsWith(`${production}-`)).toBe(false);
    expect(`${production}-us-east-1`.startsWith(`${staging}-`)).toBe(false);
  });
});

describe('resolveStage', () => {
  it('accepts the two known stages', () => {
    expect(resolveStage('production')).toBe('production');
    expect(resolveStage('staging')).toBe('staging');
  });

  it('treats an absent or blank value as production', () => {
    expect(resolveStage(undefined)).toBe('production');
    expect(resolveStage('')).toBe('production');
    expect(resolveStage('   ')).toBe('production');
  });

  // Fails closed: a typo must never deploy production's names.
  it('throws on an unknown stage', () => {
    expect(() => resolveStage('stagin')).toThrow(/stagin/);
  });
});

describe('customer-reset protected inventory', () => {
  const declarations = readFileSync(
    new URL('../../../scripts/customer-reset/safety.ts', import.meta.url),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  // scripts/customer-reset cannot import this package, so it repeats these
  // names as literals and they can drift. This test reads the script as text
  // to catch the drift. It reads the declarations with the comments removed,
  // so a name that only a comment holds cannot satisfy it. `kmsAlias` is left
  // out on purpose: the tool has no KMS client and protects no alias.
  it('names every stage resource the operator tool must never delete', () => {
    for (const stage of ['production', 'staging'] as const) {
      const names = stageNames(stage);

      expect(declarations).toContain(names.stackId);
      expect(declarations).toContain(names.ecrRepositoryName);
      expect(declarations).toContain(names.templateBucketPrefix);
      // CloudFormation derives the stack's own bucket names from the stack id.
      expect(declarations).toContain(`^${names.stackId.toLowerCase()}-buildsourcebucket`);
      expect(declarations).toContain(`^${names.stackId.toLowerCase()}-templatebucket`);
    }
  });
});
