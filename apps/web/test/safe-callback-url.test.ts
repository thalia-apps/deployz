import { describe, expect, it } from 'vitest';

import { isSafeCallbackUrl } from '../src/lib/safe-callback-url';

describe('isSafeCallbackUrl', () => {
  it.each(['/dashboard', '/accept-invitation/abc?x=1', '/github/setup?installation_id=7'])(
    'accepts the same-origin path %s',
    (url) => {
      expect(isSafeCallbackUrl(url)).toBe(true);
    },
  );

  it.each([null, '', 'https://evil.com', '//evil.com', '/\\evil.com', '/\\\\evil.com', '/\t/evil.com'])(
    'rejects %s',
    (url) => {
      expect(isSafeCallbackUrl(url)).toBe(false);
    },
  );
});
