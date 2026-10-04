import { ConfigurableModuleBuilder } from '@nestjs/common';
import type { AuditSink } from './audit.js';
import type { BudgetOptions } from './budget.js';
import type { DecisionCache } from './cache.js';
import type { DecisionProvider } from './provider.js';
import type { ReviewQueue } from './review.js';
import type { State } from './types.js';

export type Redactor = (state: State) => State;

export interface DecisionsModuleOptions {
  provider: DecisionProvider;
  /** Where decision records go. Defaults to a structured logger line. */
  audit?: AuditSink;
  /** Runs on the state before it is sent or hashed. Use it to strip PII. */
  redact?: Redactor;
  /** Total time allowed for one provider call. Default 30000. */
  timeoutMs?: number;
  /**
   * Secret for HMAC-ing audit and cache hashes. Without it they are plain SHA-256, which can be
   * reversed by guessing when the state is low-entropy (an email, a phone number).
   */
  hashSecret?: string;
  /** Provider model override. */
  model?: string;
  /** Caps provider calls and spend over a rolling window. */
  budget?: BudgetOptions;
  /**
   * Identical requests in flight at the same time share one provider call (and one budget slot).
   * Followers are marked `cached`. Default true.
   */
  dedupe?: boolean;
  /** Reuses provider results for identical state, questions and model. */
  cache?: DecisionCache;
  /** Receives gated requests that need a human. Defaults to an in-memory queue. */
  reviewQueue?: ReviewQueue;
}

export const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN: DECISIONS_OPTIONS,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<DecisionsModuleOptions>()
  .setClassMethodName('forRoot')
  .setExtras({ isGlobal: true }, (definition, extras) => ({
    ...definition,
    global: extras.isGlobal,
  }))
  .build();
