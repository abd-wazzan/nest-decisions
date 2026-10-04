import { describe, expect, it } from 'vitest';
import {
  choice,
  noul,
  QuestionValidationError,
  score,
  validateQuestions,
  validateState,
} from '../src';

describe('validateState', () => {
  it('accepts strings, objects, arrays', () => {
    expect(() => validateState('x')).not.toThrow();
    expect(() => validateState({ a: 1 })).not.toThrow();
    expect(() => validateState([1])).not.toThrow();
  });
  it('rejects blank strings and other types', () => {
    expect(() => validateState('  ')).toThrow(QuestionValidationError);
    expect(() => validateState(42)).toThrow(/string, object, or array/);
    expect(() => validateState(null)).toThrow(QuestionValidationError);
    expect(() => validateState(new Date())).toThrow(QuestionValidationError);
  });
});

describe('validateQuestions', () => {
  it('accepts well-formed questions', () => {
    expect(() =>
      validateQuestions({
        a: noul('q', { true: 'y', false: 'n' }),
        b: choice('q', { x: null, y: 'why' }),
        c: score('q', ['low', 'high']),
        d: noul({ question: 'q', about: 'field' }),
      }),
    ).not.toThrow();
  });

  it.each([
    ['empty map', {}, /nonempty/],
    ['non-object question', { a: 1 }, /must be an object/],
    ['unknown type', { a: { type: 'x', instructions: 'q' } }, /unknown type/],
    ['blank instructions', { a: noul('  ') }, /nonblank/],
    [
      'bad noul criteria key',
      { a: { type: 'noul', instructions: 'q', criteria: { maybe: 'x' } } },
      /true\/false/,
    ],
    [
      'non-object choice criteria',
      { a: { type: 'choice', instructions: 'q', criteria: [] } },
      /options|object/,
    ],
    ['empty choice', { a: choice('q', {}) }, /no options/],
    [
      'bad choice description',
      { a: { type: 'choice', instructions: 'q', criteria: { x: 5 } } },
      /strings or null/,
    ],
    [
      'non-array score',
      { a: { type: 'score', instructions: 'q', criteria: {} } },
      /must be an array/,
    ],
    ['one score level', { a: score('q', ['only']) }, /between 2 and 10/],
    [
      'eleven score levels',
      {
        a: score(
          'q',
          Array.from({ length: 11 }, (_, i) => `l${i}`),
        ),
      },
      /between 2 and 10/,
    ],
    ['blank level', { a: score('q', ['ok', ' ']) }, /nonblank/],
  ])('rejects %s', (_name, input, message) => {
    expect(() => validateQuestions(input)).toThrow(message);
  });

  it('rejects more than 255 options', () => {
    const options = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null]));
    expect(() => validateQuestions({ a: choice('q', options) })).toThrow(/maximum is 255/);
  });
});
