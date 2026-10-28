import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn(() => ({ send })),
  GetSecretValueCommand: vi.fn((input: unknown) => input),
}));

describe('loadGithubAppPrivateKey', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    send.mockReset();
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_PRIVATE_KEY_SECRET_ARN;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('reads the key from Secrets Manager once and sets it for the worker', async () => {
    process.env.GITHUB_APP_PRIVATE_KEY_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:1:secret:key';
    send.mockResolvedValue({ SecretString: 'PEM' });
    const { loadGithubAppPrivateKey } = await import('../src/lambda/github-app-key.js');

    expect(await loadGithubAppPrivateKey()).toBe('PEM');
    expect(await loadGithubAppPrivateKey()).toBe('PEM');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ SecretId: 'arn:aws:secretsmanager:us-east-1:1:secret:key' });
    expect(process.env.GITHUB_APP_PRIVATE_KEY).toBe('PEM');
  });

  it('uses GITHUB_APP_PRIVATE_KEY when no secret is configured', async () => {
    process.env.GITHUB_APP_PRIVATE_KEY = 'LOCAL';
    const { loadGithubAppPrivateKey } = await import('../src/lambda/github-app-key.js');

    expect(await loadGithubAppPrivateKey()).toBe('LOCAL');
    expect(send).not.toHaveBeenCalled();
  });

  it('retries on the next call after a failed read', async () => {
    process.env.GITHUB_APP_PRIVATE_KEY_SECRET_ARN = 'arn';
    send.mockRejectedValueOnce(new Error('throttled')).mockResolvedValueOnce({ SecretString: 'PEM' });
    const { loadGithubAppPrivateKey } = await import('../src/lambda/github-app-key.js');

    await expect(loadGithubAppPrivateKey()).rejects.toThrow('throttled');
    expect(await loadGithubAppPrivateKey()).toBe('PEM');
  });
});
