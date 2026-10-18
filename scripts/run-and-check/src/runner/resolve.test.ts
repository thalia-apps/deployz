import { describe, expect, it } from 'vitest';

import { UnresolvedReferenceError, resolveSecretValueFrom, resolveValue, type ResolveContext } from './resolve.js';

const context: ResolveContext = {
  ref(name) {
    if (name === 'Queue') throw new UnresolvedReferenceError(name);
    return name === 'AWS::Region' ? 'us-east-1' : name;
  },
  getAtt: (name, attribute) => `att:${name}.${attribute}`,
  secretField: (secretId, field) => `secret:${secretId}.${field}`,
};

describe('resolveValue', () => {
  it('keeps plain values', () => {
    expect(resolveValue('abc', context)).toBe('abc');
    expect(resolveValue(5432, context)).toBe('5432');
  });

  it('resolves Ref, Fn::GetAtt and Fn::Join', () => {
    expect(resolveValue({ Ref: 'AWS::Region' }, context)).toBe('us-east-1');
    expect(resolveValue({ 'Fn::GetAtt': ['Db', 'Endpoint.Address'] }, context)).toBe('att:Db.Endpoint.Address');
    expect(
      resolveValue({ 'Fn::Join': ['', ['redis://', { 'Fn::GetAtt': ['Cache', 'PrimaryEndPoint.Address'] }, ':6379']] }, context),
    ).toBe('redis://att:Cache.PrimaryEndPoint.Address:6379');
  });

  it('resolves secretsmanager dynamic references inside a joined string', () => {
    const node = { 'Fn::Join': ['', ['postgresql://u:{{resolve:secretsmanager:', { Ref: 'Master' }, ':SecretString:password::}}@host']] };
    expect(resolveValue(node, context)).toBe('postgresql://u:secret:Master.password@host');
  });

  it('fails on an unknown intrinsic or a malformed node', () => {
    expect(() => resolveValue({ 'Fn::If': ['c', 'a', 'b'] }, context)).toThrow('unsupported intrinsic Fn::If');
    expect(() => resolveValue({ Ref: 'A', Other: 'B' }, context)).toThrow('cannot resolve');
    expect(() => resolveValue(null, context)).toThrow('cannot resolve');
  });

  it('passes an unresolved resource error through', () => {
    expect(() => resolveValue({ Ref: 'Queue' }, context)).toThrow(UnresolvedReferenceError);
  });
});

describe('resolveSecretValueFrom', () => {
  const secretValue = (secretId: string, field: string | null) => `${secretId}/${field}`;

  it('reads one field or the whole secret', () => {
    expect(resolveSecretValueFrom({ 'Fn::Join': ['', [{ Ref: 'Db' }, ':password::']] }, context, secretValue)).toBe('Db/password');
    expect(resolveSecretValueFrom({ Ref: 'UrlSecret' }, context, secretValue)).toBe('UrlSecret/null');
  });

  it('refuses an unsupported ValueFrom', () => {
    expect(() => resolveSecretValueFrom('arn:aws:secretsmanager:x:y:secret:z:key:stage:version', context, secretValue)).toThrow(
      'unsupported secret ValueFrom',
    );
  });
});
