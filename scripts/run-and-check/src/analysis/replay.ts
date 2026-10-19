/**
 * A replay analyst for `runcheck:analyse --engine ai --replay <dir>`: it
 * answers each recipe with the saved answer `<dir>/<id>.json` instead of a
 * model call. The answers then go through the production checks and merge,
 * so a prompt can be scored from answers made elsewhere (for example in a
 * coding session) at no API cost. A missing answer fails the call, and the
 * engine records a fallback to the rules for that recipe.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AiGateway } from '@deployz/analysis';

export interface ReplayAnalyst {
  /** Selects the recipe whose answer the next call returns. */
  select(id: string): void;
  readonly gateway: AiGateway;
}

export function replayAnalyst(dir: string): ReplayAnalyst {
  let current: string | null = null;
  return {
    select(id) {
      current = id;
    },
    gateway: {
      async generate() {
        if (current === null) throw new Error('no recipe selected for the replay');
        const file = join(dir, `${current}.json`);
        if (!existsSync(file)) throw new Error(`no saved answer for ${current}`);
        return { object: JSON.parse(readFileSync(file, 'utf8')) as unknown, usage: { promptTokens: 0, completionTokens: 0 }, model: 'replay' };
      },
    },
  };
}
