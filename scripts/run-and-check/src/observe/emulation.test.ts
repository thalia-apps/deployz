import { describe, expect, it } from 'vitest';

import { emulationCrash } from './emulation.js';
import type { ObservationRun } from '../contract.js';

const fact = (texts: string[]) => ({
  status: 'observed' as const,
  value: null,
  arch: 'amd64-emulated' as const,
  evidence: texts.map((text) => ({ kind: 'log' as const, source: 'web#1', text })),
});

function run(webLog: string, buildLog = ''): ObservationRun {
  const base = Object.fromEntries(
    ['listeningPorts', 'httpPaths', 'smoke', 'database', 'startupMigration', 'migrationCommands', 'redis', 'objectStorage', 'localDiskWrites', 'workers', 'requiredVariables', 'twoCopiesHealthy', 'restartHealthy', 'sizes'].map((name) => [name, fact([])]),
  );
  return { ...base, build: fact([buildLog]), webHealthy: fact([webLog]) } as unknown as ObservationRun;
}

describe('emulationCrash', () => {
  it('finds a QEMU crash in the application logs', () => {
    expect(emulationCrash(run('start\nqemu-x86_64: QEMU internal SIGSEGV {code=MAPERR, addr=0x1}\n'))).toBe(
      'qemu-x86_64: QEMU internal SIGSEGV {code=MAPERR, addr=0x1}',
    );
  });

  it('ignores the build log and a clean run', () => {
    expect(emulationCrash(run('listening on 8080', 'qemu: uncaught target signal 6'))).toBeNull();
  });
});

describe('the Go runtime under QEMU', () => {
  it('is an emulation crash', () => {
    expect(emulationCrash(run('emulation crash: PC=0x43102e m=1 sigcode=1 addr=0xfffff135b6e466a0'))).not.toBeNull();
    expect(emulationCrash(run('panic: runtime error: invalid memory address or nil pointer dereference\n[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x4a1b2c]'))).toBeNull();
  });
});
