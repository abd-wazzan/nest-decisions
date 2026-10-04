import type { EvaluateResult } from './provider.js';

/** What is cached: answers, model and cost. Never the request or raw payloads, which hold state. */
export type CachedResult = Omit<EvaluateResult, 'raw'>;

/** Sync or async, so a Redis-backed store works without blocking. */
export interface DecisionCache {
  get(key: string): CachedResult | undefined | Promise<CachedResult | undefined>;
  set(key: string, value: CachedResult): void | Promise<void>;
}

export interface MemoryCacheOptions {
  /** How long an entry stays valid. */
  ttlMs: number;
  /** Oldest entries are evicted beyond this. Default 1000. */
  maxEntries?: number;
}

/**
 * In-process cache of provider results, keyed by a hash of state + questions + model. It stores
 * answers only, never the state. Identical inputs skip the provider call and its cost.
 */
export class MemoryDecisionCache implements DecisionCache {
  private readonly entries = new Map<string, { value: CachedResult; expires: number }>();
  private readonly maxEntries: number;

  constructor(private readonly options: MemoryCacheOptions) {
    if (!(options.ttlMs > 0)) throw new Error('ttlMs must be positive.');
    this.maxEntries = options.maxEntries ?? 1000;
  }

  get(key: string): CachedResult | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return structuredClone(hit.value);
  }

  set(key: string, value: CachedResult): void {
    this.entries.delete(key);
    this.entries.set(key, {
      value: structuredClone(value),
      expires: Date.now() + this.options.ttlMs,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
