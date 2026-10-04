/** Thrown when a question or state fails validation, before any provider call. */
export class QuestionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionValidationError';
  }
}

/**
 * The provider could not produce a usable answer (outage, timeout, malformed response).
 * Decisions without a `fallback` rethrow this, so they fail closed.
 */
export class DecisionUnavailableError extends Error {
  /** Hash of the state of the failed call, for audit. Set by the service. */
  stateHash?: string;
  /** Time spent before failing, in ms. Set by the service. */
  durationMs?: number;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'DecisionUnavailableError';
  }
}
