import type { Architecture, Evidence } from '../contract.js';

export interface Fact<T> {
  status: 'observed' | 'not_run' | 'error';
  value: T | null;
  arch: Architecture;
  evidence: Evidence[];
  note?: string | undefined;
}

const MAX_TEXT = 2000;

export function observed<T>(value: T, arch: Architecture, evidence: Evidence[] = [], note?: string): Fact<T> {
  return { status: 'observed', value, arch, evidence, ...(note === undefined ? {} : { note }) };
}

export function notRun<T>(arch: Architecture, note: string): Fact<T> {
  return { status: 'not_run', value: null, arch, evidence: [], note };
}

export function failed<T>(arch: Architecture, error: unknown, evidence: Evidence[] = []): Fact<T> {
  return { status: 'error', value: null, arch, evidence, note: error instanceof Error ? error.message : String(error) };
}

/** Keeps the end of the text (the end of a log holds the failure) and hides every secret value. */
export function makeEvidence(kind: Evidence['kind'], source: string, text: string, secrets: Iterable<string> = []): Evidence {
  let clean = text;
  for (const secret of secrets) {
    if (secret.length >= 4) clean = clean.split(secret).join('***');
  }
  return { kind, source, text: clean.length > MAX_TEXT ? clean.slice(clean.length - MAX_TEXT) : clean };
}
