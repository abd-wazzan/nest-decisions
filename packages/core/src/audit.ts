import { Logger } from '@nestjs/common';
import type { DecisionCost } from './provider.js';

export interface AuditEntry {
  decision: string;
  /** SHA-256 of the redacted state. The state itself is never recorded by core. */
  stateHash: string;
  questionIds: string[];
  outcome: 'decided' | 'fallback' | 'error' | 'gated';
  provider: string;
  model?: string;
  cost?: DecisionCost;
  durationMs: number;
  /** True when the answer came from the cache and no provider call was made. */
  cached?: boolean;
  /** Probabilities and picks per question, for calibration and replay. */
  answers?: Record<string, unknown>;
  /** For gated requests: allow, review or block. */
  verdict?: string;
  error?: string;
}

export interface AuditSink {
  record(entry: AuditEntry): void | Promise<void>;
}

/** Default sink: one structured line per decision through the Nest logger. */
export class LoggerAuditSink implements AuditSink {
  private readonly logger = new Logger('Decisions');
  record(entry: AuditEntry): void {
    this.logger.log(JSON.stringify(entry));
  }
}
