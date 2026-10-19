import { describe, expect, it } from 'vitest';

import {
  AI_MODEL_DEFAULT,
  ANALYSIS_AI_MODEL_DEFAULT,
  ANALYSIS_REVIEWER_MODEL_DEFAULT,
  FIX_INSTRUCTIONS_AI_PROBLEMS,
  FIX_INSTRUCTIONS_MODEL_DEFAULT,
  OPENROUTER_BASE_URL_DEFAULT,
  createAnalysisAiGateways,
  gatewayOpenRouterUrl,
  describeFixInstructionsAiConfig,
  resolveAiGatewayConfig,
  resolveAnalysisAiConfig,
} from './ai-config.js';

const complete = {
  AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/acct/gw/compat',
  AI_PROVIDER_API_KEY: 'provider-key',
  AI_GATEWAY_TOKEN: 'gateway-token',
};

describe('resolveAiGatewayConfig', () => {
  it('builds a config when every credential is present', () => {
    expect(resolveAiGatewayConfig(complete)).toEqual({
      baseUrl: complete.AI_GATEWAY_BASE_URL,
      providerApiKey: 'provider-key',
      gatewayToken: 'gateway-token',
      model: AI_MODEL_DEFAULT,
    });
  });

  it('uses AI_MODEL when set', () => {
    const config = resolveAiGatewayConfig({ ...complete, AI_MODEL: 'anthropic/claude-haiku-4-5' });

    expect(config?.model).toBe('anthropic/claude-haiku-4-5');
  });

  it('returns undefined when nothing is configured', () => {
    expect(resolveAiGatewayConfig({})).toBeUndefined();
  });

  // An UNAUTHENTICATED gateway is a valid, common setup: Cloudflare only
  // requires cf-aig-authorization when the gateway has authentication turned
  // on. Requiring the token here made AI unconfigurable against such a
  // gateway, and sending a bogus one makes it answer 401.
  it('configures without a gateway token (unauthenticated gateway)', () => {
    const config = resolveAiGatewayConfig({
      AI_GATEWAY_BASE_URL: complete.AI_GATEWAY_BASE_URL,
      AI_PROVIDER_API_KEY: 'provider-key',
    });

    expect(config).toEqual({
      baseUrl: complete.AI_GATEWAY_BASE_URL,
      providerApiKey: 'provider-key',
      gatewayToken: undefined,
      model: AI_MODEL_DEFAULT,
    });
  });

  // A half-wired gateway is worse than a disabled one: it fails at request
  // time instead of degrading to deterministic remediation.
  it.each([
    ['AI_GATEWAY_BASE_URL'],
    ['AI_PROVIDER_API_KEY'],
  ])('treats a config missing %s as unconfigured', (missing) => {
    const partial: Record<string, string> = { ...complete };
    delete partial[missing];

    expect(resolveAiGatewayConfig(partial)).toBeUndefined();
  });

  it('treats an empty-string required credential as unset', () => {
    expect(resolveAiGatewayConfig({ ...complete, AI_PROVIDER_API_KEY: '' })).toBeUndefined();
  });

  it('treats an empty-string gateway token as an unauthenticated gateway', () => {
    expect(resolveAiGatewayConfig({ ...complete, AI_GATEWAY_TOKEN: '' })?.gatewayToken)
      .toBeUndefined();
  });

  it('refuses a config that reuses one secret for both headers', () => {
    // The gateway token and the provider key authenticate different hops. If
    // they are equal it is a copy-paste error, and an authenticated gateway
    // would reject every request.
    const reused = resolveAiGatewayConfig({
      ...complete,
      AI_PROVIDER_API_KEY: 'same-secret',
      AI_GATEWAY_TOKEN: 'same-secret',
    });

    expect(reused).toBeUndefined();
  });
});

describe('describeFixInstructionsAiConfig', () => {
  it('defaults to Claude Opus 5.5 on OpenRouter', () => {
    expect(describeFixInstructionsAiConfig({ OPENROUTER_API_KEY: 'or-key' })).toEqual({
      provider: 'openrouter',
      config: {
        provider: 'openrouter',
        baseUrl: OPENROUTER_BASE_URL_DEFAULT,
        providerApiKey: 'or-key',
        model: FIX_INSTRUCTIONS_MODEL_DEFAULT,
      },
      problem: undefined,
    });
    expect(FIX_INSTRUCTIONS_MODEL_DEFAULT).toBe('anthropic/claude-opus-5.5');
  });

  it('uses FIX_INSTRUCTIONS_AI_MODEL and OPENROUTER_BASE_URL when set', () => {
    const { config } = describeFixInstructionsAiConfig({
      OPENROUTER_API_KEY: 'or-key',
      OPENROUTER_BASE_URL: 'https://gateway.example/openrouter',
      FIX_INSTRUCTIONS_AI_MODEL: 'anthropic/claude-sonnet-5.5',
    });

    expect(config?.baseUrl).toBe('https://gateway.example/openrouter');
    expect(config?.model).toBe('anthropic/claude-sonnet-5.5');
  });

  // No silent fallback: OpenRouter without its key never answers from the
  // shared gateway's model, even when that gateway is configured.
  it('stays unconfigured without OPENROUTER_API_KEY, even with the shared gateway set', () => {
    expect(describeFixInstructionsAiConfig(complete)).toEqual({
      provider: 'openrouter',
      config: undefined,
      problem: 'missing-openrouter-key',
    });
  });

  it('rolls back to the shared gateway and its own model, ignoring the OpenRouter model id', () => {
    const { provider, config } = describeFixInstructionsAiConfig({
      ...complete,
      FIX_INSTRUCTIONS_AI_PROVIDER: 'gateway',
      FIX_INSTRUCTIONS_AI_MODEL: 'anthropic/claude-opus-5.5',
      OPENROUTER_API_KEY: 'or-key',
    });

    expect(provider).toBe('gateway');
    expect(config).toEqual(resolveAiGatewayConfig(complete));
    expect(config?.model).toBe(AI_MODEL_DEFAULT);
  });

  it('reports a rollback without a shared gateway as unconfigured', () => {
    expect(describeFixInstructionsAiConfig({ FIX_INSTRUCTIONS_AI_PROVIDER: 'gateway' }).problem).toBe('missing-gateway');
  });

  it('rejects an unknown provider instead of guessing one', () => {
    const result = describeFixInstructionsAiConfig({ FIX_INSTRUCTIONS_AI_PROVIDER: 'openai', OPENROUTER_API_KEY: 'or-key' });

    expect(result.config).toBeUndefined();
    expect(result.problem).toBe('invalid-provider');
  });
});

describe('resolveAnalysisAiConfig', () => {
  const withOpenRouter = { ...complete, OPENROUTER_API_KEY: 'or-key' };

  it('defaults to the rules engine and both models on the gateway OpenRouter route', () => {
    const config = resolveAnalysisAiConfig(withOpenRouter);

    expect(config.engine).toBe('rules');
    expect(config.analyst).toEqual({
      provider: 'openrouter',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct/gw/openrouter/v1',
      providerApiKey: 'or-key',
      gatewayToken: 'gateway-token',
      model: ANALYSIS_AI_MODEL_DEFAULT,
    });
    expect(config.reviewer).toMatchObject({ provider: 'openrouter', model: ANALYSIS_REVIEWER_MODEL_DEFAULT });
  });

  it('reads the engine and the models', () => {
    const config = resolveAnalysisAiConfig({
      ...withOpenRouter,
      ANALYSIS_ENGINE: 'shadow',
      ANALYSIS_AI_MODEL: 'anthropic/other',
      ANALYSIS_REVIEWER_MODEL: 'openai/other',
    });

    expect(config.engine).toBe('shadow');
    expect(config.analyst?.model).toBe('anthropic/other');
    expect(config.reviewer?.model).toBe('openai/other');
  });

  it('maps an unknown engine to rules', () => {
    expect(resolveAnalysisAiConfig({ ...withOpenRouter, ANALYSIS_ENGINE: 'magic' }).engine).toBe('rules');
  });

  it('has no gateways without the gateway URL or the OpenRouter key, or with a key equal to the gateway token', () => {
    expect(createAnalysisAiGateways(resolveAnalysisAiConfig({ ANALYSIS_ENGINE: 'ai' }))).toBeUndefined();
    expect(resolveAnalysisAiConfig(complete).analyst).toBeUndefined();
    expect(resolveAnalysisAiConfig({ ...complete, OPENROUTER_API_KEY: 'gateway-token' }).analyst).toBeUndefined();
    expect(createAnalysisAiGateways(resolveAnalysisAiConfig(withOpenRouter))).toMatchObject({
      analyst: expect.any(Object),
      reviewer: expect.any(Object),
    });
  });

  it('authenticates to the gateway with AI_PROVIDER_API_KEY when AI_GATEWAY_TOKEN is unset', () => {
    const config = resolveAnalysisAiConfig({
      AI_GATEWAY_BASE_URL: complete.AI_GATEWAY_BASE_URL,
      AI_PROVIDER_API_KEY: 'provider-key',
      OPENROUTER_API_KEY: 'or-key',
    });

    expect(config.analyst).toMatchObject({ gatewayToken: 'provider-key', providerApiKey: 'or-key' });
  });

  it('derives the OpenRouter route from the /compat base URL', () => {
    expect(gatewayOpenRouterUrl('https://gateway.ai.cloudflare.com/v1/a/g/compat')).toBe('https://gateway.ai.cloudflare.com/v1/a/g/openrouter/v1');
    expect(gatewayOpenRouterUrl('https://gateway.ai.cloudflare.com/v1/a/g/compat/chat/completions')).toBe(
      'https://gateway.ai.cloudflare.com/v1/a/g/openrouter/v1',
    );
    expect(gatewayOpenRouterUrl('https://gateway.ai.cloudflare.com/v1/a/g/')).toBe('https://gateway.ai.cloudflare.com/v1/a/g/openrouter/v1');
  });
});

describe('FIX_INSTRUCTIONS_AI_PROBLEMS', () => {
  it('names the setting to fix for every problem describeFixInstructionsAiConfig reports', () => {
    const problems = [
      describeFixInstructionsAiConfig({}).problem,
      describeFixInstructionsAiConfig({ FIX_INSTRUCTIONS_AI_PROVIDER: 'gateway' }).problem,
      describeFixInstructionsAiConfig({ FIX_INSTRUCTIONS_AI_PROVIDER: 'openai' }).problem,
    ];

    for (const problem of problems) {
      expect(problem).toBeDefined();
      expect(FIX_INSTRUCTIONS_AI_PROBLEMS[problem!]).toMatch(/[A-Z_]{6,}/);
    }
  });
});
