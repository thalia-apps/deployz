import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AiGatewayNotAvailableError,
  AiModelMismatchError,
  MAX_OUTPUT_TOKENS,
  MAX_PROMPT_TOKENS,
  MAX_TOTAL_TOKENS,
  createAiGateway,
  estimateTokens,
  truncateToTokens,
  type AiGatewayConfig,
} from '../src/ai-gateway.js';

// ==========================================================================
// Test helpers — a fake fetch that records the request the SDK actually made
// ==========================================================================

const schema = z
  .object({
    failureCode: z.string(),
    what: z.string(),
    why: z.string(),
    fix: z.string(),
  })
  .strict();

const modelOutput = {
  failureCode: 'UNKNOWN',
  what: 'what',
  why: 'why',
  fix: 'fix',
};

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * A fetch stub that returns a well-formed OpenAI chat-completion response and
 * records what the SDK sent. Nothing here touches the network.
 */
function recordingFetch(recorded: RecordedRequest[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    recorded.push({
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify(modelOutput) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

const config: AiGatewayConfig = {
  baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct-123/gw-456/compat',
  model: 'workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731',
  providerApiKey: 'provider-key-aaa',
  gatewayToken: 'gateway-token-bbb',
};

// ==========================================================================
// Unconfigured gateway
// ==========================================================================

describe('createAiGateway — unconfigured', () => {
  it('returns a stub that throws AiGatewayNotAvailableError', async () => {
    const gateway = createAiGateway(undefined);

    await expect(gateway.generate('prompt', schema)).rejects.toThrow(
      AiGatewayNotAvailableError,
    );
  });

  it('never performs a network call when unconfigured', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(undefined, recordingFetch(recorded));

    await expect(gateway.generate('prompt', schema)).rejects.toThrow();
    expect(recorded).toHaveLength(0);
  });
});

// ==========================================================================
// Authentication — the two-token separation
// ==========================================================================

describe('createAiGateway — authentication headers', () => {
  it('sends the provider key as the Authorization bearer', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(config, recordingFetch(recorded));

    await gateway.generate('prompt', schema);

    expect(recorded[0]?.headers['authorization']).toBe('Bearer provider-key-aaa');
  });

  it('sends the gateway token on cf-aig-authorization', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(config, recordingFetch(recorded));

    await gateway.generate('prompt', schema);

    expect(recorded[0]?.headers['cf-aig-authorization']).toBe('Bearer gateway-token-bbb');
  });

  it('omits cf-aig-authorization entirely when no gateway token is set', async () => {
    // An unauthenticated gateway 401s on a cf-aig-authorization header it
    // cannot validate, so an absent token must mean an absent header — not an
    // empty or bogus one.
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(
      { ...config, gatewayToken: undefined },
      recordingFetch(recorded),
    );

    await gateway.generate('prompt', schema);

    expect(recorded[0]?.headers).not.toHaveProperty('cf-aig-authorization');
    expect(recorded[0]?.headers['authorization']).toBe('Bearer provider-key-aaa');
  });

  it('keeps the two credentials distinct (an authenticated gateway 401s otherwise)', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(config, recordingFetch(recorded));

    await gateway.generate('prompt', schema);

    const sent = recorded[0]?.headers ?? {};
    expect(sent['authorization']).not.toBe(sent['cf-aig-authorization']);
  });
});

// ==========================================================================
// Endpoint + model
// ==========================================================================

describe('createAiGateway — endpoint and model', () => {
  it('posts to the /compat endpoint with /chat/completions appended once', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(config, recordingFetch(recorded));

    await gateway.generate('prompt', schema);

    expect(recorded[0]?.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct-123/gw-456/compat/chat/completions',
    );
  });

  it('does not double-append when the configured base URL already ends in /chat/completions', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(
      { ...config, baseUrl: `${config.baseUrl}/chat/completions` },
      recordingFetch(recorded),
    );

    await gateway.generate('prompt', schema);

    expect(recorded[0]?.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct-123/gw-456/compat/chat/completions',
    );
  });

  it('constrains the model with a json_schema response format', async () => {
    // Without this the SDK falls back to coaxing JSON out of the prompt, and
    // the .strict() schema becomes a post-hoc rejection rather than a
    // constraint the model was actually held to.
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(config, recordingFetch(recorded));

    await gateway.generate('prompt', schema);

    expect(recorded[0]?.body.response_format).toMatchObject({ type: 'json_schema' });
  });

  it('sends the provider-qualified model id the /compat endpoint expects', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(config, recordingFetch(recorded));

    await gateway.generate('prompt', schema);

    expect(recorded[0]?.body.model).toBe(
      'workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731',
    );
  });

  it("switches a hybrid reasoning model's thinking off when the caller disables reasoning", async () => {
    // Workers AI reads `chat_template_kwargs.thinking`; the SDK passes it
    // through untouched because it is not one of its own option keys.
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(config, recordingFetch(recorded));

    await gateway.generate('prompt', schema, { reasoning: false });

    expect(recorded[0]?.body.chat_template_kwargs).toEqual({ thinking: false });
  });

  it('leaves thinking on by default', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(config, recordingFetch(recorded));

    await gateway.generate('prompt', schema);

    expect(recorded[0]?.body.chat_template_kwargs).toBeUndefined();
  });
});

// ==========================================================================
// OpenRouter — structured output required, cost reported, model verified
// ==========================================================================

describe('createAiGateway — OpenRouter', () => {
  const openRouter: AiGatewayConfig = {
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-opus-5.5',
    providerApiKey: 'or-key-ccc',
  };

  /** A fetch stub answering as OpenRouter does: the served model and the cost in usage. */
  function openRouterFetch(recorded: RecordedRequest[], servedModel: string): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      recorded.push({ url: String(input), headers, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return new Response(
        JSON.stringify({
          id: 'gen-test',
          object: 'chat.completion',
          created: 0,
          model: servedModel,
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(modelOutput) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, cost: 0.0108 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
  }

  it('posts to OpenRouter with the model id, the bearer key, and no gateway header', async () => {
    const recorded: RecordedRequest[] = [];
    await createAiGateway(openRouter, openRouterFetch(recorded, 'anthropic/claude-opus-5.5')).generate('prompt', schema);

    expect(recorded[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(recorded[0]?.body.model).toBe('anthropic/claude-opus-5.5');
    expect(recorded[0]?.headers['authorization']).toBe('Bearer or-key-ccc');
    expect(recorded[0]?.headers).not.toHaveProperty('cf-aig-authorization');
  });

  it('requires a provider that honours the json_schema response format, and asks for the cost', async () => {
    const recorded: RecordedRequest[] = [];
    await createAiGateway(openRouter, openRouterFetch(recorded, 'anthropic/claude-opus-5.5')).generate('prompt', schema);

    expect(recorded[0]?.body.response_format).toMatchObject({ type: 'json_schema' });
    expect(recorded[0]?.body.provider).toEqual({ require_parameters: true });
    expect(recorded[0]?.body.usage).toEqual({ include: true });
  });

  it('asks for low reasoning effort instead of switching thinking off', async () => {
    const recorded: RecordedRequest[] = [];
    await createAiGateway(openRouter, openRouterFetch(recorded, 'anthropic/claude-opus-5.5'))
      .generate('prompt', schema, { reasoning: false });

    expect(recorded[0]?.body.reasoning).toEqual({ effort: 'low' });
    expect(recorded[0]?.body.chat_template_kwargs).toBeUndefined();
  });

  it('sends the system message apart from the prompt, and the asked reasoning effort', async () => {
    const recorded: RecordedRequest[] = [];
    await createAiGateway(openRouter, openRouterFetch(recorded, 'anthropic/claude-opus-5.5'))
      .generate('the data', schema, { system: 'the instructions', reasoningEffort: 'medium' });

    expect(recorded[0]?.body.messages).toEqual([
      { role: 'system', content: 'the instructions' },
      { role: 'user', content: 'the data' },
    ]);
    expect(recorded[0]?.body.reasoning).toEqual({ effort: 'medium' });
  });

  it('reports the served model, the token usage, and the cost', async () => {
    const response = await createAiGateway(openRouter, openRouterFetch([], 'anthropic/claude-opus-5.5'))
      .generate('prompt', schema);

    expect(response.model).toBe('anthropic/claude-opus-5.5');
    expect(response.usage).toEqual({ promptTokens: 1200, completionTokens: 300, costUsd: 0.0108 });
  });

  it('accepts a dated variant of the configured model', async () => {
    const response = await createAiGateway(openRouter, openRouterFetch([], 'anthropic/claude-opus-5.5-20260901'))
      .generate('prompt', schema);

    expect(response.model).toBe('anthropic/claude-opus-5.5-20260901');
  });

  it('accepts the base model for a configured routing variant', async () => {
    const response = await createAiGateway({ ...openRouter, model: 'anthropic/claude-opus-5.5:nitro' }, openRouterFetch([], 'anthropic/claude-opus-5.5'))
      .generate('prompt', schema);

    expect(response.model).toBe('anthropic/claude-opus-5.5');
  });

  it('rejects an answer from another model and never retries it', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(openRouter, openRouterFetch(recorded, 'anthropic/claude-sonnet-5.5'), {
      maxAttempts: 3,
      sleep: async () => {},
    });

    await expect(gateway.generate('prompt', schema)).rejects.toBeInstanceOf(AiModelMismatchError);
    expect(recorded).toHaveLength(1);
  });
});

// ==========================================================================
// Spend limit — a real upstream cap, not a post-hoc discovery
// ==========================================================================

describe('createAiGateway — spend limit', () => {
  it('sends maxOutputTokens so the provider enforces the cap', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(config, recordingFetch(recorded));

    await gateway.generate('prompt', schema);

    expect(recorded[0]?.body.max_tokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it('honours a per-call maxOutputTokens override', async () => {
    const recorded: RecordedRequest[] = [];
    const gateway = createAiGateway(config, recordingFetch(recorded));

    await gateway.generate('prompt', schema, { maxOutputTokens: 2500 });

    expect(recorded[0]?.body.max_tokens).toBe(2500);
  });

  it('reports the usage the gateway returned', async () => {
    const gateway = createAiGateway(config, recordingFetch([]));

    const response = await gateway.generate('prompt', schema);

    expect(response.usage).toEqual({ promptTokens: 11, completionTokens: 7 });
  });

  it('leaves a reasoning model room to finish its JSON', () => {
    // Measured against the live gateway with @cf/deepseek-ai/deepseek-v4-flash:
    // reasoning tokens are charged to max_tokens BEFORE any content is emitted,
    // so a 300-token cap truncated the JSON in 3 of 6 runs (finish_reason
    // "length" -> unparseable -> NoObjectGeneratedError -> silent fallback to
    // deterministic text). At 700 it was 6/6 with a peak completion of 499.
    // Do not lower this without re-measuring against a reasoning model.
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(700);
  });

  it('budgets the prompt separately from the completion', () => {
    // One shared number means a prompt truncated to the ceiling leaves no room
    // for any completion, so the total check can never pass.
    expect(MAX_PROMPT_TOKENS).toBeLessThan(MAX_TOTAL_TOKENS);
    expect(MAX_TOTAL_TOKENS).toBe(MAX_PROMPT_TOKENS + MAX_OUTPUT_TOKENS);
  });

  it('leaves room for a full-budget completion after a maximally truncated prompt', () => {
    const huge = 'x'.repeat(MAX_PROMPT_TOKENS * 4 * 10);

    const truncated = truncateToTokens(huge, MAX_PROMPT_TOKENS);

    expect(estimateTokens(truncated) + MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(
      MAX_TOTAL_TOKENS,
    );
  });
});

// ==========================================================================
// Cancellation
// ==========================================================================

describe('createAiGateway — cancellation', () => {
  it('aborts the request when the caller signal fires', async () => {
    const controller = new AbortController();
    let sawSignal = false;
    // Never resolves on its own: the ONLY way out is the caller's signal, so a
    // signal that fails to reach fetch shows up as a timeout, not a false pass.
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        sawSignal = true;
        const abort = (): void => reject(new DOMException('Aborted', 'AbortError'));
        // The signal may already have fired before the SDK reached fetch.
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort);
      })) as typeof fetch;
    const gateway = createAiGateway(config, hangingFetch);

    const pending = gateway.generate('prompt', schema, {
      abortSignal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(sawSignal).toBe(true);
  });
});

// ==========================================================================
// Retry — bounded retries on transient failures, one repair retry on a
// malformed structured-output response
// ==========================================================================

describe('createAiGateway — retry', () => {
  /** A fetch stub whose responses are scripted call-by-call. */
  function scriptedFetch(responses: Array<() => Response>): {
    fetchFn: typeof fetch;
    callCount: () => number;
  } {
    let calls = 0;
    const fetchFn = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      const index = calls;
      calls += 1;
      const make = responses[index] ?? responses[responses.length - 1];
      if (!make) throw new Error('scriptedFetch: no response scripted');
      return make();
    }) as typeof fetch;
    return { fetchFn, callCount: () => calls };
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  const successBody = {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify(modelOutput) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };

  const malformedBody = {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'not json' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };

  it('retries once on a 500 and succeeds', async () => {
    const { fetchFn, callCount } = scriptedFetch([
      () => jsonResponse(500, { error: 'server error' }),
      () => jsonResponse(200, successBody),
    ]);
    const gateway = createAiGateway(config, fetchFn, { sleep: async () => {} });

    const response = await gateway.generate('prompt', schema);

    expect(response.object).toEqual(modelOutput);
    expect(callCount()).toBe(2);
  });

  it('retries once on a 429', async () => {
    const { fetchFn, callCount } = scriptedFetch([
      () => jsonResponse(429, { error: 'rate limited' }),
      () => jsonResponse(200, successBody),
    ]);
    const gateway = createAiGateway(config, fetchFn, { sleep: async () => {} });

    const response = await gateway.generate('prompt', schema);

    expect(response.object).toEqual(modelOutput);
    expect(callCount()).toBe(2);
  });

  it('does not retry a 400', async () => {
    const { fetchFn, callCount } = scriptedFetch([
      () => jsonResponse(400, { error: 'bad request' }),
    ]);
    const gateway = createAiGateway(config, fetchFn, { sleep: async () => {} });

    await expect(gateway.generate('prompt', schema)).rejects.toThrow();
    expect(callCount()).toBe(1);
  });

  it('does not retry after abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchFn, callCount } = scriptedFetch([() => jsonResponse(200, successBody)]);
    const gateway = createAiGateway(config, fetchFn, { sleep: async () => {} });

    await expect(
      gateway.generate('prompt', schema, { abortSignal: controller.signal }),
    ).rejects.toThrow();
    expect(callCount()).toBeLessThanOrEqual(1);
  });

  it('retries an attempt that stalls past attemptTimeoutMs', async () => {
    let calls = 0;
    // First attempt never answers on its own; only its attempt timeout ends it.
    const fetchFn = ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) return Promise.resolve(jsonResponse(200, successBody));
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }) as typeof fetch;
    const gateway = createAiGateway(config, fetchFn, { sleep: async () => {} });
    const caller = new AbortController();

    const response = await gateway.generate('prompt', schema, {
      abortSignal: caller.signal,
      attemptTimeoutMs: 20,
    });

    expect(response.object).toEqual(modelOutput);
    expect(calls).toBe(2);
  });

  it('gives up after maxAttempts', async () => {
    const { fetchFn, callCount } = scriptedFetch([() => jsonResponse(500, { error: 'server error' })]);
    const gateway = createAiGateway(config, fetchFn, { maxAttempts: 2, sleep: async () => {} });

    await expect(gateway.generate('prompt', schema)).rejects.toThrow();
    expect(callCount()).toBe(2);
  });

  it('retries once on malformed structured output', async () => {
    const { fetchFn, callCount } = scriptedFetch([
      () => jsonResponse(200, malformedBody),
      () => jsonResponse(200, successBody),
    ]);
    const gateway = createAiGateway(config, fetchFn, { sleep: async () => {} });

    const response = await gateway.generate('prompt', schema);

    expect(response.object).toEqual(modelOutput);
    expect(callCount()).toBe(2);
  });
});
