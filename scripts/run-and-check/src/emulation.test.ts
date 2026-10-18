import { describe, expect, it } from 'vitest';

import { runtimeLimit } from './emulation.js';

describe('runtimeLimit', () => {
  it('finds a QEMU crash and a failed name lookup', () => {
    expect(runtimeLimit('a\nqemu-x86_64: QEMU internal SIGSEGV {code=MAPERR}\n')?.kind).toBe('emulation');
    expect(runtimeLimit('Error: request to https://binaries.prisma.sh failed, reason: getaddrinfo EAI_AGAIN binaries.prisma.sh')?.kind).toBe('internet');
  });

  it('is null for an ordinary log', () => {
    expect(runtimeLimit('listening on :8080\nGET /health 200')).toBeNull();
  });
});
