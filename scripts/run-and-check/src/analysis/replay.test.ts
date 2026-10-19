import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { replayAnalyst } from './replay.js';

describe('replayAnalyst', () => {
  it('answers with the saved answer of the selected recipe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-'));
    writeFileSync(join(dir, 'repo-001.json'), '{"facts":[]}');
    const replay = replayAnalyst(dir);
    replay.select('repo-001');
    await expect(replay.gateway.generate('pack', z.unknown())).resolves.toMatchObject({ object: { facts: [] }, model: 'replay' });
  });

  it('fails without an answer, so the engine falls back to the rules', async () => {
    const replay = replayAnalyst(mkdtempSync(join(tmpdir(), 'replay-')));
    await expect(replay.gateway.generate('pack', z.unknown())).rejects.toThrow(/no recipe selected/);
    replay.select('repo-002');
    await expect(replay.gateway.generate('pack', z.unknown())).rejects.toThrow(/no saved answer for repo-002/);
  });
});
