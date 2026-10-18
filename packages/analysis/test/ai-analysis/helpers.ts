import type { z } from 'zod';

import type { AiGateway, AiGatewayResponse } from '../../src/ai-gateway.js';
import type { AnalystOutput } from '../../src/ai-analysis/analyst.js';
import type { EvidencePack } from '../../src/ai-analysis/evidence-pack.js';
import type { FileTree } from '../../src/detectors.js';

/** A pack over in-memory files, with the original line numbers. */
export function packOf(files: FileTree): EvidencePack {
  return {
    files: Object.entries(files).map(([path, content]) => ({ path, lines: content.split('\n'), truncated: false })),
    signals: {},
    paths: Object.keys(files),
    totalPaths: Object.keys(files).length,
  };
}

/** Analyst facts where every fact is the neutral value; override what a test needs. */
export function factsOf(overrides: Partial<AnalystOutput> = {}): AnalystOutput {
  const neutral = <T>(value: T) => ({ value, confidence: 'high' as const, evidence: [] });
  return {
    dockerfile: neutral(null),
    port: neutral(null),
    startCommand: neutral(null),
    healthPath: neutral(null),
    database: neutral('none' as const),
    redis: neutral(false),
    storage: neutral(false),
    migration: neutral({ mode: 'unknown' as const, command: null }),
    workers: [],
    requiredVariables: [],
    ...overrides,
  };
}

export const cite = (path: string, line: number, quote: string) => [{ path, line, quote }];

export interface FakeGateway extends AiGateway {
  readonly prompts: string[];
}

/** A gateway that returns a canned object (or runs a function) and records the prompts. */
export function fakeGateway(
  respond: unknown,
  usage = { promptTokens: 100, completionTokens: 50 },
): FakeGateway {
  const prompts: string[] = [];
  return {
    prompts,
    generate(prompt: string, _schema: z.ZodType): Promise<AiGatewayResponse> {
      prompts.push(prompt);
      const object = typeof respond === 'function' ? (respond as () => unknown)() : respond;
      return Promise.resolve({ object, usage, model: 'fake-model' });
    },
  };
}
