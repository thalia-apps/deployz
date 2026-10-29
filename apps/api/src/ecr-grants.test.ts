import { describe, expect, it } from 'vitest';

import {
  ECR_POLICY_MAX_CHARS,
  ECR_PULL_ACTIONS,
  PULL_GRANT_SID,
  buildPullStatement,
  buildRepoPolicyDocument,
  replacePullStatements,
  syncPullPolicy,
  type EcrClient,
  type EcrGrantStatement,
} from './ecr-grants.js';

// ── ECR Grants Tests (moved from @deployz/cdk with the module in Phase 1.1) ─

function legacyStatement(installationId: string, accountId: string): EcrGrantStatement {
  return {
    Sid: `deployz-pull-${installationId}`,
    Effect: 'Allow',
    Principal: { AWS: `arn:aws:iam::${accountId}:root` },
    Action: [...ECR_PULL_ACTIONS],
  };
}

function createMockEcrClient(
  statements: EcrGrantStatement[] = [],
): EcrClient & {
  _getLog: () => string[];
  _statements: () => EcrGrantStatement[];
} {
  const log: string[] = [];
  let current: Record<string, unknown> | null =
    statements.length > 0
      ? (buildRepoPolicyDocument(statements) as unknown as Record<string, unknown>)
      : null;

  return {
    _getLog: () => log,
    _statements: () =>
      ((current as { Statement?: EcrGrantStatement[] } | null)?.Statement ?? []) as EcrGrantStatement[],
    async getRepositoryPolicy(): Promise<{ policyText: Record<string, unknown> } | null> {
      log.push('getRepositoryPolicy');
      return current ? { policyText: current } : null;
    },
    async setRepositoryPolicy(
      _repoName: string,
      policyText: Record<string, unknown>,
    ): Promise<void> {
      log.push('setRepositoryPolicy');
      current = policyText;
    },
    async deleteRepositoryPolicy(_repoName: string): Promise<void> {
      log.push('deleteRepositoryPolicy');
      current = null;
    },
  };
}

describe('ecr-grants', () => {
  describe('buildPullStatement', () => {
    it('grants the three pull actions to the account roots, sorted and de-duplicated', () => {
      const stmt = buildPullStatement(['222222222222', '111111111111', '222222222222']);
      expect(stmt.Sid).toBe(PULL_GRANT_SID);
      expect(stmt.Effect).toBe('Allow');
      expect(stmt.Principal.AWS).toEqual([
        'arn:aws:iam::111111111111:root',
        'arn:aws:iam::222222222222:root',
      ]);
      expect([...stmt.Action]).toEqual([...ECR_PULL_ACTIONS]);
    });
  });

  describe('buildRepoPolicyDocument', () => {
    it('returns null for an empty statement list', () => {
      expect(buildRepoPolicyDocument([])).toBeNull();
    });

    it('wraps statements in a 2012-10-17 policy', () => {
      const doc = buildRepoPolicyDocument([buildPullStatement(['123456789012'])]);
      expect(doc?.Version).toBe('2012-10-17');
      expect(doc?.Statement).toHaveLength(1);
    });
  });

  describe('replacePullStatements', () => {
    it('absorbs legacy per-installation statements into the one statement and keeps others', () => {
      const other: EcrGrantStatement = {
        Sid: 'other-team',
        Effect: 'Allow',
        Principal: { AWS: 'arn:aws:iam::999999999999:root' },
        Action: ['ecr:BatchGetImage'],
      };
      const next = replacePullStatements(
        [legacyStatement('inst-1', '111111111111'), other, legacyStatement('inst-2', '222222222222')],
        ['111111111111', '222222222222'],
      );
      expect(next.map((s) => s.Sid)).toEqual(['other-team', PULL_GRANT_SID]);
      expect(next[1]?.Principal.AWS).toEqual([
        'arn:aws:iam::111111111111:root',
        'arn:aws:iam::222222222222:root',
      ]);
    });

    it('replaces the one statement when it already exists', () => {
      const next = replacePullStatements([buildPullStatement(['111111111111'])], ['222222222222']);
      expect(next).toHaveLength(1);
      expect(next[0]?.Principal.AWS).toEqual(['arn:aws:iam::222222222222:root']);
    });

    it('leaves no pull statement when no account remains', () => {
      expect(replacePullStatements([buildPullStatement(['111111111111'])], [])).toEqual([]);
    });
  });

  describe('syncPullPolicy', () => {
    it('creates the policy when none exists', async () => {
      const client = createMockEcrClient();
      const result = await syncPullPolicy(client, 'deployz-images', ['123456789012']);
      expect(result).toEqual({ changed: true, accountCount: 1, policyDeleted: false });
      expect(client._statements()).toHaveLength(1);
      expect(client._statements()[0]?.Principal.AWS).toEqual(['arn:aws:iam::123456789012:root']);
    });

    it('merges a new account into the one statement', async () => {
      const client = createMockEcrClient([buildPullStatement(['111111111111'])]);
      await syncPullPolicy(client, 'deployz-images', ['111111111111', '222222222222']);
      expect(client._statements()).toHaveLength(1);
      expect(client._statements()[0]?.Principal.AWS).toEqual([
        'arn:aws:iam::111111111111:root',
        'arn:aws:iam::222222222222:root',
      ]);
    });

    it('de-duplicates accounts that appear more than once', async () => {
      const client = createMockEcrClient();
      await syncPullPolicy(client, 'deployz-images', ['111111111111', '111111111111']);
      expect(client._statements()[0]?.Principal.AWS).toEqual(['arn:aws:iam::111111111111:root']);
    });

    it('writes nothing when the policy already matches', async () => {
      const client = createMockEcrClient([buildPullStatement(['111111111111'])]);
      const result = await syncPullPolicy(client, 'deployz-images', ['111111111111']);
      expect(result.changed).toBe(false);
      expect(client._getLog()).toEqual(['getRepositoryPolicy']);
    });

    it('absorbs legacy statements, including the deployz-pull-<uuid> ones', async () => {
      const uuid = '7b1d2f0a-aaaa-4bbb-8ccc-0123456789ab';
      const client = createMockEcrClient([
        legacyStatement('inst-1', '111111111111'),
        legacyStatement(uuid, '222222222222'),
      ]);
      await syncPullPolicy(client, 'deployz-images', ['111111111111', '222222222222', '333333333333']);
      expect(client._statements().map((s) => s.Sid)).toEqual([PULL_GRANT_SID]);
      expect(client._statements()[0]?.Principal.AWS).toHaveLength(3);
    });

    it('drops an account that has no live deployment left', async () => {
      const client = createMockEcrClient([buildPullStatement(['111111111111', '222222222222'])]);
      const result = await syncPullPolicy(client, 'deployz-images', ['222222222222']);
      expect(result.changed).toBe(true);
      expect(client._statements()[0]?.Principal.AWS).toEqual(['arn:aws:iam::222222222222:root']);
    });

    it('deletes the policy when the last account is revoked', async () => {
      const client = createMockEcrClient([buildPullStatement(['111111111111'])]);
      const result = await syncPullPolicy(client, 'deployz-images', []);
      expect(result).toEqual({ changed: true, accountCount: 0, policyDeleted: true });
      expect(client._getLog()).toContain('deleteRepositoryPolicy');
    });

    it('does nothing when there is no policy and no account', async () => {
      const client = createMockEcrClient();
      const result = await syncPullPolicy(client, 'deployz-images', []);
      expect(result.changed).toBe(false);
      expect(client._getLog()).toEqual(['getRepositoryPolicy']);
    });

    it('keeps many accounts in one statement below the ECR size limit', async () => {
      const accounts = Array.from({ length: 200 }, (_, i) => String(100000000000 + i));
      const client = createMockEcrClient();
      await syncPullPolicy(client, 'deployz-images', accounts);
      expect(client._statements()).toHaveLength(1);
      const doc = buildRepoPolicyDocument(client._statements());
      expect(JSON.stringify(doc).length).toBeLessThan(ECR_POLICY_MAX_CHARS);
    });

    it('refuses a policy over the ECR size limit before it writes', async () => {
      const accounts = Array.from({ length: 400 }, (_, i) => String(100000000000 + i));
      const client = createMockEcrClient();
      await expect(syncPullPolicy(client, 'deployz-images', accounts)).rejects.toThrow(/exceed/);
      expect(client._getLog()).not.toContain('setRepositoryPolicy');
    });
  });
});
