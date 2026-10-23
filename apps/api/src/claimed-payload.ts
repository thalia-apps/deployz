import { APP_API_KEY_PARAMETER, APP_SIGNING_SECRET_PARAMETER } from '@deployz/contracts';

import { SECRET_MASK } from './config.js';

/**
 * Parameters the control plane GENERATES at install time — their values are
 * secrets. `redactClaimedPayload` scrubs these from the INSTALL job payload
 * once the relay has claimed it, so generated install secrets do not sit in
 * `deployment_jobs.payload` indefinitely (§31 "stop storing generated install
 * secrets unnecessarily in job payloads").
 */
const INSTALL_SECRET_PARAMETER_IDS = new Set<string>([
  APP_API_KEY_PARAMETER,
  APP_SIGNING_SECRET_PARAMETER,
]);

/**
 * The relay receives a command's payload exactly once, at claim time
 * (`GET /api/relay/commands`). After that response the stored row never
 * needs the plaintext again, so the claim handler scrubs it in the same
 * request that serves it:
 *  - CONFIG_UPDATE: newly-entered secret VALUES (transport-only) become
 *    key stubs — the DB keeps key names, never values.
 *  - INSTALL: generated secret parameter values become SECRET_MASK; plain
 *    parameters (image reference, desired count) survive untouched.
 */
export function redactClaimedPayload(job: {
  readonly type: string;
  readonly payload: Record<string, unknown> | null;
}): Record<string, unknown> | null {
  const payload = job.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;

  if (job.type === 'CONFIG_UPDATE' && Array.isArray(payload['secrets'])) {
    return {
      ...payload,
      secrets: (payload['secrets'] as { key?: unknown }[]).map((entry) => ({
        key: typeof entry.key === 'string' ? entry.key : '',
      })),
    };
  }

  if (job.type === 'INSTALL' && typeof payload['parameters'] === 'object' && payload['parameters'] !== null) {
    const parameters = payload['parameters'] as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parameters)) {
      redacted[key] = INSTALL_SECRET_PARAMETER_IDS.has(key) ? SECRET_MASK : value;
    }
    return { ...payload, parameters: redacted };
  }

  return payload;
}
