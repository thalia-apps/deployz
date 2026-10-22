import type { InfrastructureSizeTier } from '@deployz/contracts';

import { apiUrl } from '@/lib/api-url';

export interface PublicInstallConfirmBody {
  idempotencyKey: string;
  region: string;
  sizeProfile: InfrastructureSizeTier;
  /** The fingerprint of the plan the customer reviewed for this Region and size. */
  planFingerprint: string;
  /** Required for a reusable link; a targeted invitation already names the customer. */
  customer?: { name: string; email: string };
  config: Array<{ key: string; value: string; isSecret: boolean }>;
}

export type PublicInstallConfirmResult =
  | { ok: true; installLinkId: string; installLinkToken: string }
  | { ok: false; code: string };

/** POST /api/public-install/:linkId/confirm — idempotent customer acceptance. */
export async function confirmPublicInstall(
  linkId: string,
  body: PublicInstallConfirmBody,
  token?: string,
): Promise<PublicInstallConfirmResult> {
  const response = await fetch(
    `${apiUrl}/api/public-install/${encodeURIComponent(linkId)}/confirm`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token !== undefined ? { 'x-deployz-token': token } : {}),
      },
      body: JSON.stringify(body),
    },
  );
  if (response.status === 201 || response.status === 200) {
    const payload = (await response.json()) as { installLinkId: string; installLinkToken: string };
    return { ok: true, installLinkId: payload.installLinkId, installLinkToken: payload.installLinkToken };
  }
  const payload: unknown = await response.json().catch(() => null);
  const code = (payload as { error?: { code?: string } } | null)?.error?.code ?? 'UNKNOWN';
  return { ok: false, code };
}
