import { DecisionUnavailableError } from './errors.js';
import type { DecisionCost } from './provider.js';

export interface BudgetLimits {
  /** Max provider calls per window. */
  maxCalls?: number;
  /** Max reported or estimated spend per window, in USD. Calls with unknown cost add nothing. */
  maxUsd?: number;
}

export interface BudgetOptions extends BudgetLimits {
  /** Rolling window length. Default 60000 (one minute). */
  windowMs?: number;
  /**
   * Limits applied separately to each budget key (for example a tenant id from
   * `Decision.budgetKey`). Calls without a key only count against the global limits above.
   */
  perKey?: BudgetLimits;
  /**
   * Where counters live. The default keeps them in this process, so with several instances the
   * effective limit is multiplied by the number of instances. Use a shared store (for example
   * `RedisBudgetStore` from `@nest-decisions/redis`) to enforce one limit across all instances.
   */
  store?: BudgetStore;
}

export interface BudgetReservation {
  /**
   * Settle the reservation with the cost the call turned out to have, if it is known, and the
   * number of provider requests it actually made (retries included, default 1).
   */
  settle(cost?: DecisionCost, attempts?: number): void | Promise<void>;
}

/** What a store needs to decide whether one more call fits. */
export interface BudgetReserveRequest {
  key?: string;
  windowMs: number;
  global: BudgetLimits;
  perKey?: BudgetLimits;
}

/**
 * Storage behind the budget. `reserve` must be atomic: check the limits and take a slot in one
 * step, so concurrent callers (and concurrent instances) cannot overshoot. It rejects with
 * `DecisionUnavailableError` when over budget.
 */
export interface BudgetStore {
  reserve(request: BudgetReserveRequest): Promise<BudgetReservation>;
}

interface BudgetEvent {
  at: number;
  usd: number;
  key?: string;
}

/** Budget counters in this process. The default store. */
export class MemoryBudgetStore implements BudgetStore {
  private readonly events: BudgetEvent[] = [];

  async reserve(request: BudgetReserveRequest): Promise<BudgetReservation> {
    // No await between the check and the push, so this is atomic within the process.
    this.prune(request.windowMs);
    check(this.events, request.global, 'global', request.windowMs);
    if (request.key !== undefined && request.perKey) {
      check(
        this.events.filter((e) => e.key === request.key),
        request.perKey,
        `key "${request.key}"`,
        request.windowMs,
      );
    }
    const key = request.key;
    const event: BudgetEvent = { at: Date.now(), usd: 0, key };
    this.events.push(event);
    return {
      settle: (cost, attempts = 1) => {
        event.usd = cost?.amount ?? 0;
        // A provider that retried inside one call made several billable requests.
        for (let i = 1; i < attempts; i++) this.events.push({ at: event.at, usd: 0, key });
      },
    };
  }

  private prune(windowMs: number): void {
    const cutoff = Date.now() - windowMs;
    while (this.events.length && (this.events[0] as BudgetEvent).at <= cutoff) this.events.shift();
  }
}

function check(events: BudgetEvent[], limits: BudgetLimits, scope: string, windowMs: number): void {
  throwIfOver(
    events.length,
    events.reduce((sum, e) => sum + e.usd, 0),
    limits,
    scope,
    windowMs,
  );
}

/** Shared by every store, so all of them reject with the same error and message. */
export function throwIfOver(
  calls: number,
  usd: number,
  limits: BudgetLimits,
  scope: string,
  windowMs: number,
): void {
  const where = scope === 'global' ? '' : ` for ${scope}`;
  if (limits.maxCalls !== undefined && calls >= limits.maxCalls) {
    throw new DecisionUnavailableError(
      `Budget exceeded${where}: ${limits.maxCalls} calls per ${windowMs}ms.`,
    );
  }
  if (limits.maxUsd !== undefined && usd >= limits.maxUsd) {
    throw new DecisionUnavailableError(
      `Budget exceeded${where}: $${limits.maxUsd} per ${windowMs}ms.`,
    );
  }
}

/**
 * Rolling-window cap on provider calls and spend, global and optionally per key. A slot is reserved
 * before the call, so concurrent callers cannot overshoot, and every attempt counts even if it
 * times out or fails (the provider may still bill for it). A call over budget fails before it is
 * sent, as DecisionUnavailableError.
 */
export class BudgetGuard {
  private readonly windowMs: number;
  private readonly store: BudgetStore;

  constructor(private readonly options: BudgetOptions) {
    this.windowMs = options.windowMs ?? 60_000;
    if (!(this.windowMs > 0)) throw new Error('windowMs must be positive.');
    this.store = options.store ?? new MemoryBudgetStore();
  }

  /** Rejects when over budget; otherwise reserves a slot and returns a handle to settle it. */
  reserve(key?: string): Promise<BudgetReservation> {
    return this.store.reserve({
      key,
      windowMs: this.windowMs,
      global: { maxCalls: this.options.maxCalls, maxUsd: this.options.maxUsd },
      perKey: this.options.perKey,
    });
  }
}
