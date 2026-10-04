import type {
  Answer,
  CallOptions,
  ChoiceAnswer,
  DecisionProvider,
  EvaluateRequest,
  EvaluateResult,
  NoulAnswer,
  Question,
  ScoreAnswer,
} from '@nest-decisions/core';
import { validateAnswers } from '@nest-decisions/core';

/** A fixed answer for one question id, or a function that builds one from the question. */
export type MockAnswer = Answer | ((question: Question) => Answer);

export const mockNoul = (probability: number): NoulAnswer => ({ type: 'noul', noul: probability });

export function mockChoice<O extends string>(
  option: O,
  confidence = 0.9,
  options: readonly string[] = [option],
): ChoiceAnswer<O> {
  const rest = options.filter((o) => o !== option);
  const share = rest.length ? (1 - confidence) / rest.length : 0;
  const probabilities = Object.fromEntries([
    [option, rest.length ? confidence : 1],
    ...rest.map((o) => [o, share]),
  ]) as Record<O, number>;
  return { type: 'choice', choice: option, probabilities, confidence };
}

export function mockScore(value: number, confidence = 0.9, levels = 4): ScoreAnswer {
  const probabilities: Record<string, number> = {};
  const legend: Record<string, string> = {};
  const nearest = Math.min(levels - 1, Math.max(0, Math.round(value)));
  for (let i = 0; i < levels; i++) {
    legend[String(i)] = `level ${i}`;
    probabilities[String(i)] = i === nearest ? confidence : (1 - confidence) / (levels - 1);
  }
  return { type: 'score', score: value, legend, probabilities, confidence };
}

export interface MockProviderOptions {
  answers?: Record<string, MockAnswer>;
  /** Make every call fail, to exercise fallbacks and fail-closed paths. */
  failWith?: Error;
  /** Resolve after this many ms, to exercise timeouts. */
  delayMs?: number;
}

/**
 * Deterministic provider for tests. It checks wiring and policy, not model accuracy: it will
 * happily return whatever you configure. A question with no configured answer throws, so a
 * forgotten mock never silently passes.
 */
export class MockProvider implements DecisionProvider {
  readonly name = 'mock';
  /** Every request received, so tests can assert exactly what state was sent. */
  readonly calls: EvaluateRequest[] = [];

  constructor(private options: MockProviderOptions = {}) {}

  /** Replace or add answers between calls. */
  set(answers: Record<string, MockAnswer>): void {
    this.options = { ...this.options, answers: { ...this.options.answers, ...answers } };
  }

  async evaluate(request: EvaluateRequest, callOptions?: CallOptions): Promise<EvaluateResult> {
    this.calls.push(structuredClone(request));
    callOptions?.signal?.throwIfAborted();
    if (this.options.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const signal = callOptions?.signal;
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, this.options.delayMs);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (this.options.failWith) throw this.options.failWith;
    const answers: Record<string, Answer> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      const configured = this.options.answers?.[id];
      if (configured === undefined) {
        throw new Error(`MockProvider has no answer configured for question "${id}".`);
      }
      answers[id] = typeof configured === 'function' ? configured(question) : configured;
    }
    // Hold mocks to the same bar as a live provider, so a test cannot pass on an answer that
    // production would reject (NaN, an undeclared choice, a score outside its levels).
    validateAnswers(request.questions, answers);
    return { answers, model: 'mock', cost: { amount: 0, source: 'mock' } };
  }
}
