import { describe, expect, it } from 'vitest';

import { normalizeErrorText, redactSecrets } from '../src/redact.js';

// The ANSI escape character, built at runtime (not a literal control
// character in source) to avoid embedding a raw control byte in the file.
const ESC = String.fromCharCode(27);

// ==========================================================================
// redactSecrets — URL credentials, tokens, keys, KEY=value pairs, PEM blocks
// ==========================================================================

describe('redactSecrets', () => {
  it('redacts postgresql:// URL credentials', () => {
    expect(redactSecrets('postgresql://user:password@host/db')).toBe(
      'postgresql://[REDACTED]@host/db',
    );
  });

  it('redacts redis:// URL credentials', () => {
    expect(redactSecrets('redis://default:s3cret@cache:6379')).toBe(
      'redis://[REDACTED]@cache:6379',
    );
  });

  it('redacts an AWS access key id', () => {
    const text = redactSecrets('key=AKIAIOSFODNN7EXAMPLE end');
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(text).toContain('[REDACTED_AWS_KEY]');
  });

  it('redacts a GitHub personal access token', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const text = redactSecrets(`token: ${token}`);
    expect(text).not.toContain(token);
    expect(text).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('redacts a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const text = redactSecrets(`Authorization token=${jwt}`);
    expect(text).not.toContain(jwt);
    expect(text).toContain('[REDACTED_JWT]');
  });

  it('redacts an Authorization header', () => {
    expect(redactSecrets('Authorization: Bearer abc.def')).toBe('Authorization: [REDACTED]');
  });

  it('redacts a secret-looking KEY=value pair but leaves unrelated ones alone', () => {
    expect(redactSecrets('DATABASE_PASSWORD=hunter2')).toBe('DATABASE_PASSWORD=[REDACTED]');
    expect(redactSecrets('PORT=3000')).toBe('PORT=3000');
  });

  it('redacts secret-looking keys in any case and in JSON', () => {
    expect(redactSecrets('db_password=hunter2')).toBe('db_password=[REDACTED]');
    expect(redactSecrets('apiKey: abc123')).toBe('apiKey: [REDACTED]');
    expect(redactSecrets('{"client_secret": "s3 cret", "port": 3000}')).toBe(
      '{"client_secret": [REDACTED], "port": 3000}',
    );
    const once = redactSecrets('{"password": "x y"}');
    expect(redactSecrets(once)).toBe(once);
  });

  it.each([
    'sk-' + 'a'.repeat(32),
    'sk-ant-' + 'b'.repeat(40),
    'xoxb-1234567890-abcdefghij',
    'AIza' + 'c'.repeat(35),
    'sk_live_' + 'd'.repeat(24),
    'pk_live_' + 'd'.repeat(24),
    'rk_live_' + 'd'.repeat(24),
    'glpat-' + 'e'.repeat(20),
    'github_pat_' + 'f'.repeat(30),
  ])('redacts the vendor key %s', (key) => {
    const text = redactSecrets(`value ${key} end`);
    expect(text).not.toContain(key);
    expect(text).toMatch(/\[REDACTED_[A-Z_]+\]/);
  });

  it('redacts a PEM private key block', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(pem)).toBe('[REDACTED_PRIVATE_KEY]');
  });

  it('is idempotent — redacting twice equals redacting once', () => {
    const cases = [
      'postgresql://user:password@host/db',
      'redis://default:s3cret@cache:6379',
      'key=AKIAIOSFODNN7EXAMPLE end',
      `token: ghp_${'a'.repeat(36)}`,
      'Authorization token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'Authorization: Bearer abc.def',
      'DATABASE_PASSWORD=hunter2',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----',
    ];
    for (const text of cases) {
      const once = redactSecrets(text);
      const twice = redactSecrets(once);
      expect(twice).toBe(once);
    }
  });
});

// ==========================================================================
// normalizeErrorText — strip ANSI, collapse repeats, trim, truncate, redact
// ==========================================================================

describe('normalizeErrorText', () => {
  it('strips ANSI escape codes', () => {
    expect(normalizeErrorText(`${ESC}[31mERROR${ESC}[0m`)).toBe('ERROR');
  });

  it('collapses runs of identical lines to one', () => {
    const text = Array(5).fill('same line').join('\n');
    expect(normalizeErrorText(text)).toBe('same line');
  });

  it('trims and truncates to maxLength with a suffix', () => {
    const text = 'x'.repeat(5000);
    const result = normalizeErrorText(text);
    expect(result.length).toBeLessThanOrEqual(2015);
    expect(result.endsWith('…[truncated]')).toBe(true);
  });

  it('redacts a connection string inside the text', () => {
    const result = normalizeErrorText('connection failed: postgresql://user:password@host/db');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('user:password');
  });

  it('redacts a secret that straddles the truncation boundary (no fragment leaks)', () => {
    // A DATABASE_PASSWORD=... pair sits well before the maxLength cutoff, so a
    // truncate-then-redact implementation would slice through the middle of
    // the secret value and leak a fragment of it. Redact-then-truncate must
    // replace the whole value first, so no part of it can ever survive.
    const secretValue = 'hunter2345678901234567890';
    const text =
      'A'.repeat(40) + ' DATABASE_PASSWORD=' + secretValue + ' ' + 'B'.repeat(40);
    const result = normalizeErrorText(text, { maxLength: 80 });
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain(secretValue);
    expect(result).not.toContain('hunter');
    expect(result.endsWith('…[truncated]')).toBe(true);
  });

  it('is idempotent — normalizing twice equals normalizing once', () => {
    const text = `${ESC}[31mERROR${ESC}[0m connecting to postgresql://user:password@host/db`;
    const once = normalizeErrorText(text);
    const twice = normalizeErrorText(once);
    expect(twice).toBe(once);
  });
});
