import {
  createAiGateway,
  parseAnalysisEngine,
  type AiAnalysisGateways,
  type AiGatewayConfig,
  type AnalysisEngine,
} from '@deployz/analysis';

// §16/§29 AI gateway configuration, resolved from the environment.
//
// Kept as a pure function over an env-shaped record (rather than reading
// `process.env` inline) so the partial-configuration rules below are testable
// without mutating global state.

/**
 * The default model, provider-qualified for the unified `/compat` endpoint.
 * Override with `AI_MODEL`; switching provider is a one-variable change
 * because the endpoint stays the same.
 */
export const AI_MODEL_DEFAULT = 'workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731';

/** Why a gateway configuration was rejected, for the startup warning. */
export type AiConfigProblem = 'missing' | 'reused-secret';

/**
 * Build the gateway config, or `undefined` when the environment does not fully
 * configure one.
 *
 * A PARTIAL configuration is treated as no configuration on purpose. Half-wired
 * credentials fail at request time, once per diagnostics view; an absent
 * configuration degrades cleanly to deterministic remediation guidance.
 */
export function resolveAiGatewayConfig(
  source: Record<string, string | undefined>,
): AiGatewayConfig | undefined {
  return describeAiGatewayConfig(source).config;
}

/**
 * `resolveAiGatewayConfig` plus the reason it rejected, so callers can warn
 * with something more useful than "not configured".
 */
export function describeAiGatewayConfig(source: Record<string, string | undefined>): {
  config: AiGatewayConfig | undefined;
  problem: AiConfigProblem | undefined;
} {
  const baseUrl = source.AI_GATEWAY_BASE_URL;
  const providerApiKey = source.AI_PROVIDER_API_KEY;
  // Optional: only a gateway with authentication switched on requires it. An
  // unauthenticated gateway 401s on a cf-aig-authorization header it cannot
  // validate, so an unset token must mean no header at all.
  const gatewayToken = source.AI_GATEWAY_TOKEN || undefined;

  if (!baseUrl || !providerApiKey) {
    return { config: undefined, problem: 'missing' };
  }

  // The two credentials authenticate different hops: the gateway checks
  // cf-aig-authorization, the upstream provider checks Authorization. Equal
  // values mean one was pasted twice, and an authenticated gateway would
  // reject every request — better to disable AI than to fail every view.
  if (gatewayToken && providerApiKey === gatewayToken) {
    return { config: undefined, problem: 'reused-secret' };
  }

  return {
    config: {
      baseUrl,
      providerApiKey,
      gatewayToken,
      model: source.AI_MODEL ?? AI_MODEL_DEFAULT,
    },
    problem: undefined,
  };
}

// AI-first application Analysis (docs/decisions/README.md): the analyst and the
// reviewer go through the shared Cloudflare gateway to its OpenRouter route,
// with the OpenRouter key. The gateway's unified /compat endpoint answers 402
// for these models. The production gateway is authenticated and
// AI_PROVIDER_API_KEY is its token (the /compat calls send it as the bearer),
// so it is the cf-aig-authorization token here unless AI_GATEWAY_TOKEN is set.

/** The analyst model (OpenRouter id). Override with `ANALYSIS_AI_MODEL`. */
export const ANALYSIS_AI_MODEL_DEFAULT = 'anthropic/claude-opus-5.5';
/** The reviewer model (OpenRouter id). Override with `ANALYSIS_REVIEWER_MODEL`. */
// A pinned version from another model family than the analyst: it makes other
// mistakes, and a fixed version keeps two analyses of a commit comparable.
export const ANALYSIS_REVIEWER_MODEL_DEFAULT = 'deepseek/deepseek-v4-pro-0813';

/** The gateway's OpenRouter route: `…/{account}/{gateway}/openrouter/v1`, from the `/compat` base URL. */
export function gatewayOpenRouterUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/compat(?:\/chat\/completions)?\/?$/, '').replace(/\/$/, '')}/openrouter/v1`;
}

export interface AnalysisAiConfig {
  /** `ANALYSIS_ENGINE`: `rules` (the default), `shadow` or `ai`. */
  readonly engine: AnalysisEngine;
  /** Undefined without AI_GATEWAY_BASE_URL and OPENROUTER_API_KEY: the engine then runs the rules only. */
  readonly analyst: AiGatewayConfig | undefined;
  /** Undefined when the gateway is not configured. */
  readonly reviewer: AiGatewayConfig | undefined;
}

export function resolveAnalysisAiConfig(source: Record<string, string | undefined>): AnalysisAiConfig {
  const engine = parseAnalysisEngine(source.ANALYSIS_ENGINE);
  const baseUrl = source.AI_GATEWAY_BASE_URL;
  const providerApiKey = source.OPENROUTER_API_KEY;
  const gatewayToken = source.AI_GATEWAY_TOKEN || source.AI_PROVIDER_API_KEY || undefined;
  const role = (model: string): AiGatewayConfig | undefined =>
    baseUrl && providerApiKey && providerApiKey !== gatewayToken
      ? { provider: 'openrouter', baseUrl: gatewayOpenRouterUrl(baseUrl), providerApiKey, gatewayToken, model }
      : undefined;
  return {
    engine,
    analyst: role(source.ANALYSIS_AI_MODEL || ANALYSIS_AI_MODEL_DEFAULT),
    reviewer: role(source.ANALYSIS_REVIEWER_MODEL || ANALYSIS_REVIEWER_MODEL_DEFAULT),
  };
}

/** The gateways the analysis runner uses, or undefined when the analyst is not configured. */
export function createAnalysisAiGateways(config: AnalysisAiConfig): AiAnalysisGateways | undefined {
  if (!config.analyst) return undefined;
  return { analyst: createAiGateway(config.analyst), reviewer: config.reviewer ? createAiGateway(config.reviewer) : undefined };
}

// Fix-instructions model configuration. Only the coding-agent fix prompt uses
// it; repository analysis and failure explanations stay on the shared gateway.

/** The fix-instructions model on OpenRouter. Override with `FIX_INSTRUCTIONS_AI_MODEL`. */
export const FIX_INSTRUCTIONS_MODEL_DEFAULT = 'anthropic/claude-opus-5.5';

/** OpenRouter's OpenAI-compatible API. Override with `OPENROUTER_BASE_URL`. */
export const OPENROUTER_BASE_URL_DEFAULT = 'https://openrouter.ai/api/v1';

/**
 * Where fix instructions are generated: `openrouter` (the default) or
 * `gateway` — the shared AI gateway and its model, the rollback to the
 * previous generator model.
 */
export type FixInstructionsAiProvider = 'openrouter' | 'gateway';

/** Why the fix-instructions model is not configured, for the startup warning. */
export type FixInstructionsAiProblem = 'invalid-provider' | 'missing-openrouter-key' | 'missing-gateway';

/** What to set for each problem. The startup warning and the local-only API message both use it. */
export const FIX_INSTRUCTIONS_AI_PROBLEMS = {
  'invalid-provider': 'FIX_INSTRUCTIONS_AI_PROVIDER must be "openrouter" or "gateway"',
  'missing-openrouter-key': 'OPENROUTER_API_KEY is not set',
  'missing-gateway': 'FIX_INSTRUCTIONS_AI_PROVIDER=gateway but AI_GATEWAY_BASE_URL/AI_PROVIDER_API_KEY are not both set',
} as const satisfies Record<FixInstructionsAiProblem, string>;

/**
 * Resolve the fix-instructions model. There is no fallback between
 * providers: a provider without its credentials leaves fix instructions
 * unavailable (a retryable 503 per request) and names the problem, rather
 * than answering from another model.
 */
export function describeFixInstructionsAiConfig(source: Record<string, string | undefined>): {
  provider: FixInstructionsAiProvider | undefined;
  config: AiGatewayConfig | undefined;
  problem: FixInstructionsAiProblem | undefined;
} {
  const rawProvider = source.FIX_INSTRUCTIONS_AI_PROVIDER || 'openrouter';

  if (rawProvider === 'gateway') {
    const shared = resolveAiGatewayConfig(source);
    if (!shared) return { provider: 'gateway', config: undefined, problem: 'missing-gateway' };
    // FIX_INSTRUCTIONS_AI_MODEL names an OpenRouter model; the rollback keeps
    // the shared gateway's own AI_MODEL, the previous generator model.
    return { provider: 'gateway', config: shared, problem: undefined };
  }

  if (rawProvider !== 'openrouter') return { provider: undefined, config: undefined, problem: 'invalid-provider' };

  const apiKey = source.OPENROUTER_API_KEY;
  if (!apiKey) return { provider: 'openrouter', config: undefined, problem: 'missing-openrouter-key' };
  return {
    provider: 'openrouter',
    config: {
      provider: 'openrouter',
      baseUrl: source.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL_DEFAULT,
      providerApiKey: apiKey,
      model: source.FIX_INSTRUCTIONS_AI_MODEL || FIX_INSTRUCTIONS_MODEL_DEFAULT,
    },
    problem: undefined,
  };
}

// Jev shadow-mode client configuration, resolved from the same environment.

/** The default model id — a TypeSafe native alias that resolves to the current version. Override with `JEV_MODEL`. */
export const JEV_MODEL_DEFAULT = 'jev-latest';

/** How long a single Jev attempt may take. Override with `JEV_TIMEOUT_MS`. */
export const JEV_TIMEOUT_MS_DEFAULT = 10_000;

/**
 * Jev resolved as far as the environment allows. `enabled` is false unless
 * JEV_ENABLED=true AND both JEV_GATEWAY_URL and JEV_API_KEY are set — the
 * client is shadow-mode only, so a partial configuration disables it with a
 * warning rather than failing per request later.
 */
export interface JevConfig {
  readonly enabled: boolean;
  readonly baseUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly model: string;
  readonly gatewayToken?: string | undefined;
  readonly timeoutMs: number;
}

function parseJevTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return JEV_TIMEOUT_MS_DEFAULT;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : JEV_TIMEOUT_MS_DEFAULT;
}

/**
 * Build the Jev config. A PARTIAL configuration (one of URL/key missing while
 * JEV_ENABLED) is treated as disabled on purpose, mirroring the AI gateway's
 * rule — half-wired credentials fail at request time, an absent configuration
 * degrades cleanly.
 */
export function resolveJevConfig(source: Record<string, string | undefined>): JevConfig {
  const baseUrl = source.JEV_GATEWAY_URL;
  const apiKey = source.JEV_API_KEY;
  // Jev routes through the same Cloudflare AI Gateway as the AI explanations,
  // so the gateway's own token is the same shared AI_GATEWAY_TOKEN.
  const gatewayToken = source.AI_GATEWAY_TOKEN || undefined;
  const model = source.JEV_MODEL ?? JEV_MODEL_DEFAULT;
  const timeoutMs = parseJevTimeoutMs(source.JEV_TIMEOUT_MS);

  if (source.JEV_ENABLED !== 'true') {
    return { enabled: false, model, gatewayToken, timeoutMs };
  }

  if (!baseUrl || !apiKey) {
    console.warn(
      '[jev] JEV_ENABLED=true but JEV_GATEWAY_URL/JEV_API_KEY are not both set — ' +
        'the Jev shadow client stays disabled. Set them in .env.',
    );
    return { enabled: false, model, gatewayToken, timeoutMs };
  }

  return { enabled: true, baseUrl, apiKey, model, gatewayToken, timeoutMs };
}
