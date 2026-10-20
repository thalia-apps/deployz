import { describe, expect, it } from 'vitest';

import { analystOutputSchema, fromWire } from '../../src/ai-analysis/analyst.js';
import { cite, factsOf, toWire } from './helpers.js';

describe('fromWire', () => {
  it('rebuilds the analyst facts, workers and required variables from the flat wire format', () => {
    const facts = factsOf({
      port: { value: 8080, confidence: 'high', evidence: cite('Dockerfile', 2, 'EXPOSE 8080') },
      workers: [{ id: 'sidekiq', command: 'bundle exec sidekiq', confidence: 'medium', evidence: cite('Procfile', 2, 'sidekiq') }],
      requiredVariables: [{ name: 'SECRET_KEY', confidence: 'high', evidence: cite('app.py', 1, "os.environ['SECRET_KEY']") }],
    });
    expect(analystOutputSchema.parse(fromWire(toWire(facts)))).toEqual(facts);
  });

  it('refuses a scalar fact given twice', () => {
    const wire = toWire(factsOf());
    expect(() => fromWire({ facts: [...wire.facts, wire.facts[1]!] })).toThrow(/twice/);
  });

  it('reads a null database answer as a low-confidence "none", which the checks then refuse', () => {
    const wire = toWire(factsOf());
    const unsure = wire.facts.map((entry) => (entry.fact === 'database' ? { ...entry, value: 'null', confidence: 'high' as const } : entry));
    expect(analystOutputSchema.parse(fromWire({ facts: unsure })).database).toMatchObject({ value: 'none', confidence: 'low' });
  });

  it('leaves a missing fact or a wrongly typed value to the strict schema', () => {
    const wire = toWire(factsOf());
    expect(analystOutputSchema.safeParse(fromWire({ facts: wire.facts.filter((entry) => entry.fact !== 'port') })).success).toBe(false);
    const badPort = wire.facts.map((entry) => (entry.fact === 'port' ? { ...entry, value: '"eighty"' } : entry));
    expect(analystOutputSchema.safeParse(fromWire({ facts: badPort })).success).toBe(false);
  });
});
