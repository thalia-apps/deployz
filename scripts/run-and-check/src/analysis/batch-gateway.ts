/**
 * An `AiGateway` that sends every `generate` call as one request of an
 * Anthropic Message Batch (half the standard price, results usually within
 * minutes). Test harness only: production keeps the OpenRouter gateway.
 *
 * Calls queue until no new call has arrived for `idleMs` (or `maxBatchSize`
 * calls wait). The queue then goes out as one batch, which is polled until it
 * ends. The request carries the same system prompt, user prompt, output cap
 * and JSON schema (from the caller's Zod schema) as the production call.
 * `reasoning: false` and `reasoningEffort` map to `output_config.effort`;
 * thinking stays adaptive, the only mode Claude Opus 5.5 has. A request that
 * fails rejects its own call only. Unlike the production gateway, a failed
 * call is not retried and `abortSignal` is not used.
 */
import { MAX_OUTPUT_TOKENS, type AiGateway } from '@deployz/analysis';
import { z } from 'zod';

const API = 'https://api.anthropic.com/v1/messages/batches';
export const BATCH_MODEL = 'claude-opus-5-5';
/** USD per million tokens: half of the Claude Opus 5.5 standard price ($4 input, $20 output). */
export const BATCH_PRICE = { input: 2, output: 10 } as const;

export interface BatchGatewayOptions {
  readonly apiKey: string;
  readonly fetchFn?: typeof fetch;
  readonly idleMs?: number;
  readonly maxBatchSize?: number;
  readonly pollMs?: number;
}

interface Pending {
  readonly params: Record<string, unknown>;
  readonly schema: z.ZodType;
  readonly resolve: (value: Awaited<ReturnType<AiGateway['generate']>>) => void;
  readonly reject: (error: unknown) => void;
}

interface BatchLine {
  custom_id: string;
  result: {
    type: string;
    message?: { model: string; stop_reason: string; content: { type: string; text?: string }[]; usage: { input_tokens: number; output_tokens: number } };
    error?: { error?: { message?: string } };
  };
}

/** The structured-output API rejects number and string bounds; the caller's Zod schema still checks them. */
function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node === null || typeof node !== 'object') return node;
  const unsupported = new Set(['$schema', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength']);
  return Object.fromEntries(Object.entries(node).filter(([key]) => !unsupported.has(key)).map(([key, value]) => [key, stripUnsupported(value)]));
}

export function createBatchGateway(options: BatchGatewayOptions): AiGateway {
  const { apiKey, fetchFn = fetch, idleMs = 30_000, maxBatchSize = 1000, pollMs = 15_000 } = options;
  let queue: Pending[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const send = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const response = await fetchFn(url, { ...init, headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
    if (!response.ok) throw new Error(`Anthropic batch ${init.method ?? 'GET'} ${url.slice(API.length)}: HTTP ${response.status} ${await response.text()}`);
    return response;
  };

  const submit = async (items: readonly Pending[]): Promise<void> => {
    try {
      const requests = items.map((item, index) => ({ custom_id: String(index), params: item.params }));
      let batch = (await (await send(API, { method: 'POST', body: JSON.stringify({ requests }) })).json()) as { id: string; processing_status: string };
      while (batch.processing_status !== 'ended') {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        batch = (await (await send(`${API}/${batch.id}`)).json()) as typeof batch;
      }
      const lines = (await (await send(`${API}/${batch.id}/results`)).text()).split('\n').filter((line) => line.trim() !== '');
      const settled = new Set<number>();
      for (const line of lines) {
        const { custom_id, result } = JSON.parse(line) as BatchLine;
        const item = items[Number(custom_id)]!;
        settled.add(Number(custom_id));
        try {
          if (result.type !== 'succeeded' || !result.message) throw new Error(`batch request ${result.type}: ${result.error?.error?.message ?? ''}`.trim());
          const { message } = result;
          const text = message.content.find((block) => block.type === 'text')?.text;
          if (text === undefined) throw new Error(`batch answer has no text (stop reason ${message.stop_reason})`);
          item.resolve({
            object: item.schema.parse(JSON.parse(text)),
            usage: {
              promptTokens: message.usage.input_tokens,
              completionTokens: message.usage.output_tokens,
              costUsd: (message.usage.input_tokens * BATCH_PRICE.input + message.usage.output_tokens * BATCH_PRICE.output) / 1_000_000,
            },
            model: message.model,
          });
        } catch (error) {
          item.reject(error);
        }
      }
      items.forEach((item, index) => settled.has(index) || item.reject(new Error('batch ended without a result for this request')));
    } catch (error) {
      for (const item of items) item.reject(error);
    }
  };

  const flush = (): void => {
    clearTimeout(timer);
    const items = queue;
    queue = [];
    if (items.length > 0) void submit(items);
  };

  return {
    generate(prompt, schema, generateOptions = {}) {
      const effort = generateOptions.reasoning === false ? 'low' : generateOptions.reasoningEffort;
      const params = {
        model: BATCH_MODEL,
        max_tokens: generateOptions.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
        ...(generateOptions.system !== undefined ? { system: generateOptions.system } : {}),
        messages: [{ role: 'user', content: prompt }],
        output_config: {
          ...(effort !== undefined ? { effort } : {}),
          format: { type: 'json_schema', schema: stripUnsupported(z.toJSONSchema(schema, { io: 'output' })) },
        },
      };
      return new Promise((resolve, reject) => {
        queue.push({ params, schema, resolve, reject });
        if (queue.length >= maxBatchSize) flush();
        else {
          clearTimeout(timer);
          timer = setTimeout(flush, idleMs);
        }
      });
    },
  };
}
