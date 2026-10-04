import type {
  CallOptions,
  DecisionCost,
  DecisionProvider,
  EvaluateRequest,
  EvaluateResult,
} from '@nest-decisions/core';
import { validateQuestions, validateState } from '@nest-decisions/core';
import { JevContractError, type JevUsage, validateResponse } from './validate-response.js';

export type JevBackend = 'typesafe' | 'openrouter';

const ENDPOINTS: Record<JevBackend, string> = {
  typesafe: 'https://api.typesafe.ai/v1/systemone',
  openrouter: 'https://openrouter.ai/api/alpha/decisions',
};
const DEFAULT_MODELS: Record<JevBackend, string> = {
  typesafe: 'jev-latest',
  openrouter: '~typesafe/jev-latest',
};
const KEY_ENV: Record<JevBackend, string> = {
  typesafe: 'TYPESAFE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};
const RETRY_STATUSES = new Set([429, 502, 503, 529]);

/** Caller-supplied USD prices. No rates are assumed for any provider or model. */
export interface JevPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface JevProviderOptions {
  /** Which API to call. Auto-selected from the environment when omitted and no apiKey is given. */
  backend?: JevBackend;
  /** Requires an explicit `backend`. Prefer passing it from your config service. */
  apiKey?: string;
  /** Full endpoint URL, not an origin. Redirects are refused. */
  baseUrl?: string;
  /** Pin a versioned model id instead of the moving alias. */
  model?: string;
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /**
   * Longest wait between attempts. A `Retry-After` beyond this fails immediately instead of
   * retrying early against a rate-limited API. Default 8000.
   */
  maxRetryWaitMs?: number;
  /** Exponential backoff base in ms, plus up to 20% jitter. Default 500. */
  retryDelayMs?: number;
  /** Used only when the response carries no valid reported cost. */
  pricing?: JevPricing;
  /** Inject a fetch implementation (tests, proxies). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export class JevHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'JevHttpError';
  }
}

const nonneg = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;

/**
 * Jev provider. The backend and credentials are fixed at construction and never switched after a
 * failure. Missing credentials throw here, at startup, so production never silently degrades.
 */
export class JevProvider implements DecisionProvider {
  readonly name: string;
  readonly backend: JevBackend;
  readonly #apiKey: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryWaitMs: number;
  private readonly pricing?: JevPricing;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JevProviderOptions = {}) {
    if (options.apiKey !== undefined && !options.backend) {
      throw new Error('apiKey requires an explicit backend ("typesafe" or "openrouter").');
    }
    this.backend = options.backend ?? JevProvider.backendFromEnv();
    this.name = `jev:${this.backend}`;
    const key = (options.apiKey ?? process.env[KEY_ENV[this.backend]])?.trim();
    if (!key) {
      throw new Error(
        `Backend "${this.backend}" needs a nonblank apiKey or ${KEY_ENV[this.backend]}.`,
      );
    }
    this.#apiKey = key;
    this.endpoint = options.baseUrl ?? ENDPOINTS[this.backend];
    this.model = options.model ?? DEFAULT_MODELS[this.backend];
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.maxRetryWaitMs = options.maxRetryWaitMs ?? 8000;
    if (!nonneg(this.maxRetryWaitMs))
      throw new Error('maxRetryWaitMs must be finite and nonnegative.');
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error('maxAttempts must be a positive integer.');
    }
    if (!nonneg(this.retryDelayMs)) throw new Error('retryDelayMs must be finite and nonnegative.');
    if (options.pricing !== undefined) {
      if (!nonneg(options.pricing?.inputPerMillion) || !nonneg(options.pricing?.outputPerMillion)) {
        throw new Error('pricing needs finite, nonnegative inputPerMillion and outputPerMillion.');
      }
      this.pricing = { ...options.pricing };
    }
    this.fetchImpl = options.fetch ?? fetch;
  }

  private static backendFromEnv(): JevBackend {
    if (process.env.TYPESAFE_API_KEY?.trim()) return 'typesafe';
    if (process.env.OPENROUTER_API_KEY?.trim()) return 'openrouter';
    throw new Error(
      'No Jev credentials: set TYPESAFE_API_KEY or OPENROUTER_API_KEY, or pass apiKey.',
    );
  }

  async evaluate(request: EvaluateRequest, options: CallOptions = {}): Promise<EvaluateResult> {
    validateState(request.state);
    validateQuestions(request.questions);
    const body = {
      model: request.model ?? this.model,
      state: request.state,
      questions: request.questions,
    };
    const requestText = JSON.stringify(body);
    const signal = options.signal;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      signal?.throwIfAborted();
      let res: Response;
      try {
        res = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
          body: requestText,
          signal,
          // Never follow a redirect: it would forward the bearer token to another host.
          redirect: 'manual',
        });
      } catch (error) {
        // Caller aborts and exhausted attempts surface as they are; anything else is a transport
        // failure (reset, DNS, TLS) and is retried with the same backoff as a retryable status.
        if (signal?.aborted) throw signal.reason ?? error;
        if (attempt >= this.maxAttempts) throw error;
        const backoff = this.retryDelayMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.2);
        await sleep(Math.min(this.maxRetryWaitMs, backoff), signal);
        continue;
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        // The target is deliberately not echoed.
        throw new JevHttpError(res.status, `${this.name} HTTP ${res.status}: redirect refused.`);
      }
      if (RETRY_STATUSES.has(res.status) && attempt < this.maxAttempts) {
        await res.body?.cancel();
        const asked = retryAfterMs(res.headers.get('retry-after'));
        if (asked > this.maxRetryWaitMs) {
          // Retrying earlier than the server asked only hammers a rate-limited API.
          throw new JevHttpError(
            res.status,
            `${this.name} HTTP ${res.status}; retry after ${Math.round(asked / 1000)}s.`,
          );
        }
        const backoff = this.retryDelayMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.2);
        await sleep(Math.min(this.maxRetryWaitMs, Math.max(backoff, asked)), signal);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        const hint = res.status === 401 ? ` Check the ${KEY_ENV[this.backend]} key.` : '';
        throw new JevHttpError(res.status, `${this.name} HTTP ${res.status}.${hint}`);
      }
      const text = await res.text();
      let response: unknown;
      try {
        response = JSON.parse(text);
      } catch {
        // Never echo the body: it may be an HTML error page or contain upstream detail.
        throw new JevContractError('Invalid response JSON.');
      }
      validateResponse(response, request.questions);
      return {
        answers: response.answers as EvaluateResult['answers'],
        model: response.model,
        cost: this.cost(response.usage),
        attempts: attempt,
        raw: { request: JSON.parse(requestText), response },
      };
    }
    throw new Error(`${this.name} retries exhausted.`);
  }

  private cost(usage: JevUsage): DecisionCost {
    if (nonneg(usage.cost)) return { amount: usage.cost, source: 'reported' };
    if (this.pricing) {
      const amount =
        (usage.input_tokens / 1_000_000) * this.pricing.inputPerMillion +
        (usage.output_tokens / 1_000_000) * this.pricing.outputPerMillion;
      if (nonneg(amount)) return { amount, source: 'estimated' };
    }
    return { amount: null, source: 'unknown' };
  }
}

/** Ignore malformed or negative values so NaN can never erase the backoff. */
function retryAfterMs(header: string | null): number {
  const value = header?.trim();
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value) * 1000;
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(value)) return 0;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
