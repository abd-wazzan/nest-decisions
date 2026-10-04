import type { Questions } from '@nest-decisions/core';

export class JevContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JevContractError';
  }
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
const isNonneg = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const isUnit = (x: unknown): x is number => isNonneg(x) && x <= 1;
const isTokens = (x: unknown): x is number => isNonneg(x) && Number.isSafeInteger(x);

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
  cost?: unknown;
}

/** Strict check of the live response against the questions that were asked. Unknown fields are kept. */
export function validateResponse(
  response: unknown,
  questions: Questions,
): asserts response is { model: string; answers: Record<string, unknown>; usage: JevUsage } {
  if (
    !isObject(response) ||
    !isObject(response.answers) ||
    typeof response.model !== 'string' ||
    !response.model.trim()
  ) {
    throw new JevContractError('Invalid response envelope: expected model and answers.');
  }
  const usage = response.usage;
  if (!isObject(usage) || !isTokens(usage.input_tokens) || !isTokens(usage.output_tokens)) {
    throw new JevContractError('Invalid usage: expected integer input_tokens and output_tokens.');
  }
  for (const [id, q] of Object.entries(questions)) {
    const answer = response.answers[id];
    if (!Object.hasOwn(response.answers, id) || !isObject(answer) || answer.type !== q.type) {
      throw new JevContractError(`Missing or mismatched answer: ${id}`);
    }
    if (q.type === 'noul') {
      if (!isUnit(answer.noul)) throw new JevContractError(`Invalid noul: ${id}`);
      continue;
    }
    if (!isUnit(answer.confidence) || !isObject(answer.probabilities)) {
      throw new JevContractError(`Invalid distribution: ${id}`);
    }
    const keys =
      q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    const probs = answer.probabilities;
    if (
      Object.keys(probs).length !== keys.length ||
      !keys.every((k) => Object.hasOwn(probs, k) && isUnit(probs[k]))
    ) {
      throw new JevContractError(`Distribution keys must match the declared criteria: ${id}`);
    }
    const sum = keys.reduce((acc, k) => acc + (probs[k] as number), 0);
    if (Math.abs(sum - 1) > 0.025) {
      throw new JevContractError(`Distribution does not sum to one: ${id} (${sum})`);
    }
    if (q.type === 'choice') {
      if (typeof answer.choice !== 'string' || !keys.includes(answer.choice)) {
        throw new JevContractError(`Undeclared choice returned: ${id}`);
      }
    } else if (!isNonneg(answer.score) || answer.score > keys.length - 1) {
      throw new JevContractError(`Score out of range: ${id}`);
    }
  }
}
