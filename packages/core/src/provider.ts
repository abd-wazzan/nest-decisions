import type { Answer, Questions, State } from './types.js';

export interface EvaluateRequest {
  state: State;
  questions: Questions;
  /** Provider-specific model id; the provider chooses its default when omitted. */
  model?: string;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export type DecisionCost =
  | { amount: number; source: 'reported' | 'estimated' | 'mock' }
  | { amount: null; source: 'unknown' };

export interface EvaluateResult {
  answers: Record<string, Answer>;
  /** The versioned model that actually answered. Log it. */
  model: string;
  cost: DecisionCost;
  /**
   * How many requests the provider actually made (retries included). The budget counts each one,
   * because every attempt may be billed. Defaults to 1.
   */
  attempts?: number;
  /** Provider payloads kept for audit and replay, never including credentials. */
  raw?: { request: unknown; response: unknown };
}

/** The only thing core knows about a vendor. Implement this to add a provider. */
export interface DecisionProvider {
  readonly name: string;
  evaluate(request: EvaluateRequest, options?: CallOptions): Promise<EvaluateResult>;
}
