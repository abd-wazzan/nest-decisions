import { QuestionValidationError } from './errors.js';
import { LIMITS, type Questions, type State } from './types.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Values that look like objects but would silently serialize to nothing useful. */
const isOpaqueObject = (value: object): boolean =>
  value instanceof Map ||
  value instanceof Set ||
  value instanceof WeakMap ||
  value instanceof WeakSet ||
  value instanceof Promise ||
  value instanceof RegExp ||
  value instanceof Error;

function walk(value: unknown, path: string, ancestors: Set<object>): void {
  switch (typeof value) {
    case 'string':
    case 'boolean':
    case 'undefined':
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new QuestionValidationError(`State at ${path} must be a finite number.`);
      }
      return;
    case 'object': {
      if (value === null) return;
      if (ancestors.has(value)) {
        throw new QuestionValidationError(`State at ${path} is circular.`);
      }
      if (isOpaqueObject(value)) {
        throw new QuestionValidationError(
          `State at ${path} is a ${value.constructor.name}, which does not serialize. Convert it first.`,
        );
      }
      if (value instanceof Date) return; // serialized as an ISO string
      ancestors.add(value);
      for (const [key, child] of Array.isArray(value)
        ? value.map((c, i) => [String(i), c] as const)
        : Object.entries(value)) {
        walk(child, `${path}.${key}`, ancestors);
      }
      ancestors.delete(value);
      return;
    }
    default:
      throw new QuestionValidationError(`State at ${path} has an unsupported ${typeof value}.`);
  }
}

/**
 * Validate state before it is sent: a nonblank string, array, or object whose contents survive JSON
 * (no Map, Set, BigInt, functions, NaN or cycles). Nested Dates are allowed and sent as ISO strings.
 */
export function validateState(state: unknown): asserts state is State {
  if (typeof state === 'string') {
    if (!state.trim()) throw new QuestionValidationError('State must not be blank.');
    return;
  }
  const topLevelOk =
    Array.isArray(state) ||
    (state !== null &&
      typeof state === 'object' &&
      !isOpaqueObject(state) &&
      !(state instanceof Date));
  if (!topLevelOk) {
    throw new QuestionValidationError('State must be a string, object, or array.');
  }
  walk(state, 'state', new Set());
}

/**
 * The exact JSON the provider will receive. Hash and send this, so what is cached or audited is
 * what the model saw (a Date and its ISO string are the same value, two Dates differ).
 */
export function normalizeState(state: State): State {
  return typeof state === 'string' ? state : (JSON.parse(JSON.stringify(state)) as State);
}

export function validateQuestions(questions: unknown): asserts questions is Questions {
  if (!isRecord(questions) || Object.keys(questions).length === 0) {
    throw new QuestionValidationError('Questions must be a nonempty object.');
  }
  for (const [id, q] of Object.entries(questions)) {
    if (!isRecord(q)) throw new QuestionValidationError(`Question "${id}" must be an object.`);
    if (q.type !== 'noul' && q.type !== 'choice' && q.type !== 'score') {
      throw new QuestionValidationError(`Question "${id}" has a missing or unknown type.`);
    }
    const ins = q.instructions;
    if (typeof ins === 'string' ? !ins.trim() : !isRecord(ins)) {
      throw new QuestionValidationError(
        `Question "${id}" needs nonblank string or object instructions.`,
      );
    }
    if (q.type === 'noul') validateNoul(id, q.criteria);
    else if (q.type === 'choice') validateChoice(id, q.criteria);
    else validateScore(id, q.criteria);
  }
}

function validateNoul(id: string, criteria: unknown): void {
  if (criteria === undefined) return;
  const ok =
    isRecord(criteria) &&
    Object.entries(criteria).every(
      ([k, v]) => (k === 'true' || k === 'false') && (v === undefined || typeof v === 'string'),
    );
  if (!ok) {
    throw new QuestionValidationError(`Noul "${id}" criteria must map true/false to descriptions.`);
  }
}

function validateChoice(id: string, criteria: unknown): void {
  if (!isRecord(criteria)) {
    throw new QuestionValidationError(`Choice "${id}" criteria must be an object.`);
  }
  const options = Object.keys(criteria);
  if (options.length === 0) throw new QuestionValidationError(`Choice "${id}" has no options.`);
  if (options.length > LIMITS.MAX_CHOICE_OPTIONS) {
    throw new QuestionValidationError(
      `Choice "${id}" has ${options.length} options; the maximum is ${LIMITS.MAX_CHOICE_OPTIONS}.`,
    );
  }
  if (Object.values(criteria).some((v) => v !== null && typeof v !== 'string')) {
    throw new QuestionValidationError(`Choice "${id}" descriptions must be strings or null.`);
  }
}

function validateScore(id: string, criteria: unknown): void {
  if (!Array.isArray(criteria)) {
    throw new QuestionValidationError(`Score "${id}" criteria must be an array.`);
  }
  if (criteria.length < LIMITS.MIN_SCORE_LEVELS || criteria.length > LIMITS.MAX_SCORE_LEVELS) {
    throw new QuestionValidationError(
      `Score "${id}" must have between ${LIMITS.MIN_SCORE_LEVELS} and ${LIMITS.MAX_SCORE_LEVELS} levels; got ${criteria.length}.`,
    );
  }
  if (criteria.some((l) => typeof l !== 'string' || !l.trim())) {
    throw new QuestionValidationError(`Score "${id}" levels must be nonblank strings.`);
  }
}

/** The provider returned something that is not a valid answer to the question asked. */
export class AnswerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswerValidationError';
  }
}

const isUnit = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;

/**
 * Check provider answers against the questions: every question answered with the right type and
 * sane values (probabilities finite and within 0 to 1, a choice that was declared, a score within
 * its levels). Core runs this on every provider, so a gate can never act on NaN or a missing value.
 */
export function validateAnswers(questions: Questions, answers: Record<string, unknown>): void {
  for (const [id, q] of Object.entries(questions)) {
    const a = answers?.[id];
    if (!isRecord(a) || a.type !== q.type) {
      throw new AnswerValidationError(
        `Provider returned no valid ${q.type} answer for question "${id}".`,
      );
    }
    if (q.type === 'noul') {
      if (!isUnit(a.noul))
        throw new AnswerValidationError(`Noul "${id}" must be a probability from 0 to 1.`);
      continue;
    }
    if (!isUnit(a.confidence)) {
      throw new AnswerValidationError(`Answer "${id}" has an invalid confidence.`);
    }
    if (!isRecord(a.probabilities) || !Object.values(a.probabilities).every(isUnit)) {
      throw new AnswerValidationError(`Answer "${id}" has invalid probabilities.`);
    }
    if (q.type === 'choice') {
      const declared = Object.keys(q.criteria);
      if (typeof a.choice !== 'string' || !declared.includes(a.choice)) {
        throw new AnswerValidationError(`Choice "${id}" returned an undeclared option.`);
      }
      if (!Object.keys(a.probabilities).every((k) => declared.includes(k))) {
        throw new AnswerValidationError(`Choice "${id}" has probabilities for undeclared options.`);
      }
    } else if (
      typeof a.score !== 'number' ||
      !Number.isFinite(a.score) ||
      a.score < 0 ||
      a.score > q.criteria.length - 1
    ) {
      throw new AnswerValidationError(`Score "${id}" is outside its range.`);
    }
  }
}
