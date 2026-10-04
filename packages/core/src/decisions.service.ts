import { Inject, Injectable, Logger } from '@nestjs/common';
import { type AuditSink, LoggerAuditSink } from './audit.js';
import { BudgetGuard, type BudgetReservation } from './budget.js';
import type { DecisionCache } from './cache.js';
import { DecisionUnavailableError } from './errors.js';
import { DECISIONS_OPTIONS, type DecisionsModuleOptions } from './options.js';
import type { DecisionProvider, EvaluateResult } from './provider.js';
import { InMemoryReviewQueue, type ReviewQueue } from './review.js';
import { stableHash } from './stable-hash.js';
import type { Questions, State } from './types.js';
import { normalizeState, validateAnswers, validateQuestions, validateState } from './validation.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;

export interface EvaluateInput {
  /** Used in audit records. */
  decision: string;
  state: State;
  questions: Questions;
  /** Which per-key budget this call counts against, such as a tenant id. */
  budgetKey?: string;
  /** The state came from `prepareState` already; do not redact it twice. */
  prepared?: boolean;
}

export interface Evaluation {
  result: EvaluateResult;
  stateHash: string;
  durationMs: number;
  /** True when the provider was not called because an identical result was cached. */
  cached: boolean;
}

@Injectable()
export class DecisionsService {
  private readonly audit: AuditSink;
  private readonly provider: DecisionProvider;
  private readonly budget?: BudgetGuard;
  private readonly cache?: DecisionCache;
  private readonly timeoutMs: number;
  private readonly inflight = new Map<string, Promise<Evaluation>>();
  readonly reviewQueue: ReviewQueue;

  constructor(@Inject(DECISIONS_OPTIONS) private readonly options: DecisionsModuleOptions) {
    this.provider = options.provider;
    this.audit = options.audit ?? new LoggerAuditSink();
    this.budget = options.budget ? new BudgetGuard(options.budget) : undefined;
    this.cache = options.cache;
    this.reviewQueue = options.reviewQueue ?? new InMemoryReviewQueue();
    this.warnAboutInMemoryDefaults();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > MAX_TIMER_MS) {
      throw new Error(`timeoutMs must be a positive integer no greater than ${MAX_TIMER_MS}.`);
    }
  }

  /** In production an in-memory default is usually a mistake: say so once, at startup. */
  private warnAboutInMemoryDefaults(): void {
    if (process.env.NODE_ENV !== 'production') return;
    const logger = new Logger('Decisions');
    if (!this.options.reviewQueue) {
      logger.warn(
        'Using the in-memory review queue in production: gated requests sent to review are lost on restart and not shared between instances. Provide `reviewQueue`.',
      );
    }
    if (this.options.budget) {
      logger.warn(
        'Budgets are counted per process: with N instances the effective limit is N times higher.',
      );
    }
  }

  get providerName(): string {
    return this.provider.name;
  }

  /** Validate, redact and normalize state: exactly what the provider receives and what is hashed. */
  prepareState(state: State): State {
    validateState(state);
    const redacted = this.options.redact ? this.options.redact(state) : state;
    validateState(redacted);
    return normalizeState(redacted);
  }

  /**
   * Prepare state, consult the cache, reserve budget, call the provider within the timeout, and
   * check every answer. Validation problems throw as-is (programmer error); everything else is a
   * DecisionUnavailableError, which a Decision may turn into a fallback.
   */
  async evaluate(input: EvaluateInput): Promise<Evaluation> {
    validateQuestions(input.questions);
    const state = input.prepared ? input.state : this.prepareState(input.state);
    const secret = this.options.hashSecret;
    const stateHash = stableHash(state, secret);
    const started = Date.now();
    const dedupe = this.options.dedupe !== false;
    const cacheKey =
      this.cache || dedupe
        ? stableHash(
            {
              provider: this.provider.name,
              state,
              questions: input.questions,
              model: this.options.model,
            },
            secret,
          )
        : undefined;

    try {
      const shared = dedupe && cacheKey ? this.inflight.get(cacheKey) : undefined;
      if (shared) {
        // An identical call is already in flight: wait for it instead of paying twice.
        const leader = await shared;
        return { ...leader, durationMs: Date.now() - started, cached: true };
      }
      const run = this.cachedOrCall(input, state, stateHash, cacheKey, started);
      if (dedupe && cacheKey) {
        this.inflight.set(cacheKey, run);
        // Remove once settled, success or failure, so the next call starts fresh.
        const clear = () => {
          if (this.inflight.get(cacheKey) === run) this.inflight.delete(cacheKey);
        };
        run.then(clear, clear);
      }
      return await run;
    } catch (error) {
      const failure =
        error instanceof DecisionUnavailableError
          ? error
          : new DecisionUnavailableError(
              `Decision provider failed: ${error instanceof Error ? error.message : String(error)}`,
              error,
            );
      failure.stateHash = stateHash;
      failure.durationMs = Date.now() - started;
      throw failure;
    }
  }

  private async cachedOrCall(
    input: EvaluateInput,
    state: State,
    stateHash: string,
    cacheKey: string | undefined,
    started: number,
  ): Promise<Evaluation> {
    const hit = this.cache && cacheKey ? await this.safeCacheGet(cacheKey) : undefined;
    if (hit) {
      try {
        // A cached entry is held to the same bar as a fresh answer: a store that returned null
        // for NaN, or a half-written entry, must never reach a policy.
        validateAnswers(input.questions, hit.answers);
        return { result: hit, stateHash, durationMs: Date.now() - started, cached: true };
      } catch {
        // Treat an invalid entry as a miss and ask the provider.
      }
    }
    return this.callProvider(input, state, stateHash, cacheKey, started);
  }

  private async callProvider(
    input: EvaluateInput,
    state: State,
    stateHash: string,
    cacheKey: string | undefined,
    started: number,
  ): Promise<Evaluation> {
    const reservation: BudgetReservation | undefined = await this.budget?.reserve(input.budgetKey);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: EvaluateResult | undefined;
    let pending: Promise<EvaluateResult> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Provider call exceeded ${this.timeoutMs}ms.`));
        }, this.timeoutMs);
      });
      pending = this.provider.evaluate(
        { state, questions: input.questions, model: this.options.model },
        { signal: controller.signal },
      );
      result = await Promise.race([pending, timeout]);
      validateAnswers(input.questions, result?.answers);
      if (cacheKey) await this.safeCacheSet(cacheKey, result);
      return { result, stateHash, durationMs: Date.now() - started, cached: false };
    } finally {
      clearTimeout(timer);
      // Every attempt counts, including timeouts and failures: the provider may still bill them.
      await settleQuietly(reservation, result?.cost, result?.attempts);
      // A call abandoned at the timeout can still finish and be billed: settle its cost when it does.
      if (!result)
        pending?.then(
          (late) => void settleQuietly(reservation, late.cost, late.attempts),
          () => {},
        );
    }
  }

  async record(entry: Parameters<AuditSink['record']>[0]): Promise<void> {
    try {
      await this.audit.record(entry);
    } catch {
      // An audit failure must never change a decision's outcome.
    }
  }

  private async safeCacheGet(key: string) {
    try {
      const hit = await this.cache?.get(key);
      return hit ? ({ ...hit } as EvaluateResult) : undefined;
    } catch {
      return undefined; // a broken cache costs a provider call, never a decision
    }
  }

  private async safeCacheSet(key: string, result: EvaluateResult): Promise<void> {
    try {
      // Answers, model and cost only. The raw exchange contains the state.
      await this.cache?.set(key, {
        answers: result.answers,
        model: result.model,
        cost: result.cost,
      });
    } catch {
      // see safeCacheGet
    }
  }
}

/** A failing budget store must never change the outcome of a call that already happened. */
async function settleQuietly(
  reservation: BudgetReservation | undefined,
  cost: EvaluateResult['cost'] | undefined,
  attempts: number | undefined,
): Promise<void> {
  try {
    await reservation?.settle(cost, attempts);
  } catch {
    // The call is already made; a lost settlement only makes the budget slightly optimistic.
  }
}
