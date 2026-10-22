import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

// Monorepo: pin tracing to the repo root so Next doesn't pick a stray
// lockfile higher up the tree as the workspace root.
const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..'),
  // The dev-tools indicator badge renders bottom-left in dev mode and would
  // sit inside every visual-regression screenshot.
  devIndicators: false,
  poweredByHeader: false,
  // Script CSP is post-MVP; these headers stop framing and sniffing only.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
  // Emit .next/standalone: a self-contained server plus only the node_modules
  // it actually traced. This is what the container image ships, and it is why
  // the image does not need pnpm or the workspace at runtime.
  //
  // Opt-in rather than always-on. Assembling the standalone tree symlinks into
  // pnpm's store, and Windows refuses those symlinks (EPERM) unless Developer
  // Mode is enabled — so making this unconditional would break `pnpm build`
  // for anyone developing on Windows. The container build (Linux) sets
  // NEXT_OUTPUT=standalone; nothing else needs the tree.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
};

export default nextConfig;
