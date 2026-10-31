import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { BATCH_MODEL, createBatchGateway } from './batch-gateway.js';

const schema = z.object({ verdict: z.enum(['ok', 'bad']), line: z.number().int() }).strict();

function message(text: string) {
  return { model: BATCH_MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 100 } };
}

/** A fake Anthropic API: `answer` gives the result line of each request, by custom id. */
function fakeApi(answer: (id: string) => object) {
  const posted: { requests: { custom_id: string; params: Record<string, any> }[] }[] = [];
  let polls = 0;
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('https://api.anthropic.com/v1/messages/batches', '');
    if (init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)));
      return Response.json({ id: 'b1', processing_status: 'in_progress' });
    }
    if (path === '/b1') return Response.json({ id: 'b1', processing_status: ++polls < 2 ? 'in_progress' : 'ended' });
    return new Response(posted[0]!.requests.map((request) => JSON.stringify({ custom_id: request.custom_id, result: answer(request.custom_id) })).join('\n'));
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, posted };
}

const succeeded = (text: string) => ({ type: 'succeeded', message: message(text) });

describe('createBatchGateway', () => {
  it('sends the system prompt, schema, effort and cap, and flushes calls after the idle time as one batch', async () => {
    const api = fakeApi(() => succeeded('{"verdict":"ok","line":3}'));
    const gateway = createBatchGateway({ apiKey: 'k', fetchFn: api.fetchFn, idleMs: 10, pollMs: 1 });
    const [first, second] = await Promise.all([
      gateway.generate('user one', schema, { system: 'rules', maxOutputTokens: 4000, reasoningEffort: 'low' }),
      gateway.generate('user two', schema, { system: 'rules', reasoning: false }),
    ]);
    expect(api.posted).toHaveLength(1);
    const [one, two] = api.posted[0]!.requests;
    expect(one!.params).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      system: 'rules',
      messages: [{ role: 'user', content: 'user one' }],
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    const sent = one!.params['output_config'].format.schema;
    expect(sent).toMatchObject({ type: 'object', additionalProperties: false, required: ['verdict', 'line'], properties: { verdict: { enum: ['ok', 'bad'] } } });
    expect(JSON.stringify(sent)).not.toMatch(/"(minimum|maximum)"/);
    expect(two!.params['output_config'].effort).toBe('low');
    expect(first.object).toEqual({ verdict: 'ok', line: 3 });
    expect(second.model).toBe('claude-opus-5-5');
  });

  it('prices usage at the batch price', async () => {
    const api = fakeApi(() => succeeded('{"verdict":"ok","line":1}'));
    const gateway = createBatchGateway({ apiKey: 'k', fetchFn: api.fetchFn, idleMs: 5, pollMs: 1 });
    const { usage } = await gateway.generate('p', schema);
    expect(usage).toEqual({ promptTokens: 1000, completionTokens: 100, costUsd: 0.003 });
  });

  it('rejects only the request that failed or answered badly', async () => {
    const api = fakeApi((id) => (id === '0' ? { type: 'errored', error: { error: { message: 'overloaded' } } } : id === '1' ? succeeded('not json') : succeeded('{"verdict":"ok","line":2}')));
    const gateway = createBatchGateway({ apiKey: 'k', fetchFn: api.fetchFn, idleMs: 5, pollMs: 1 });
    const results = await Promise.allSettled([gateway.generate('a', schema), gateway.generate('b', schema), gateway.generate('c', schema)]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'fulfilled']);
    expect((results[0] as PromiseRejectedResult).reason.message).toContain('overloaded');
  });

  it('starts a new batch when the batch size is reached', async () => {
    const api = fakeApi(() => succeeded('{"verdict":"ok","line":1}'));
    const gateway = createBatchGateway({ apiKey: 'k', fetchFn: api.fetchFn, idleMs: 60_000, maxBatchSize: 2, pollMs: 1 });
    await Promise.all([gateway.generate('a', schema), gateway.generate('b', schema)]);
    expect(api.posted[0]!.requests).toHaveLength(2);
  });

  it('rejects every call when the batch cannot be created', async () => {
    const fetchFn = (async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch;
    const gateway = createBatchGateway({ apiKey: 'k', fetchFn, idleMs: 5 });
    await expect(gateway.generate('a', schema)).rejects.toThrow('HTTP 401');
  });
});
