import { twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

import { apiUrl } from '@/lib/api-url';

// The browser talks directly to the Fastify-hosted Better Auth instance.
// Cookies are host-scoped (localhost), so credentialed fetch is all the
// wiring the cross-port session needs.
export const authClient = createAuthClient({
  baseURL: apiUrl,
  fetchOptions: { credentials: 'include' },
  plugins: [twoFactorClient()],
});
