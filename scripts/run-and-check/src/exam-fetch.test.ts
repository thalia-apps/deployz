import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { artifactTarget } from './exam-fetch.js';

describe('artifactTarget', () => {
  it('puts an observation in observations/ and a full run under its analyser', () => {
    expect(artifactTarget('runcheck-observe-new-12', 'root')).toBe(join('root', 'observations'));
    expect(artifactTarget('runcheck-full-rules@0fc073b8-repo-001', 'root')).toBe(join('root', '.runs', 'full', 'rules@0fc073b8'));
    expect(artifactTarget('runcheck-full-ai@1a2b3c4d-F3', 'root')).toBe(join('root', '.runs', 'full', 'ai@1a2b3c4d'));
  });

  it('ignores other artifacts', () => {
    expect(artifactTarget('runcheck-image-abc', 'root')).toBeNull();
    expect(artifactTarget('runcheck-full-../x-repo-001', 'root')).toBeNull();
  });
});
