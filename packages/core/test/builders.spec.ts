import { describe, expect, expectTypeOf, it } from 'vitest';
import { type AnswersOf, choice, noul, score } from '../src';

describe('builders', () => {
  it('builds noul with and without criteria', () => {
    expect(noul('Is it urgent?')).toEqual({ type: 'noul', instructions: 'Is it urgent?' });
    expect(noul('q', { true: 'a' })).toEqual({
      type: 'noul',
      instructions: 'q',
      criteria: { true: 'a' },
    });
  });

  it('infers literal option ids and answer types', () => {
    const questions = {
      urgent: noul('Is it urgent?'),
      category: choice('Topic?', { billing: null, bug: 'broken behavior' }),
      mood: score('Frustration?', ['calm', 'furious']),
    };
    type A = AnswersOf<typeof questions>;
    expectTypeOf<A['urgent']['noul']>().toEqualTypeOf<number>();
    expectTypeOf<A['category']['choice']>().toEqualTypeOf<'billing' | 'bug'>();
    expectTypeOf<A['mood']['score']>().toEqualTypeOf<number>();
  });
});
