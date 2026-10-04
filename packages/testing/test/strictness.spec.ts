import { choice, noul, score } from '@nest-decisions/core';
import { describe, expect, it } from 'vitest';
import { MockProvider, mockChoice, mockNoul, mockScore } from '../src';

describe('MockProvider is as strict as a live provider', () => {
  it('rejects answers a gate must never act on', async () => {
    await expect(
      new MockProvider({ answers: { a: mockNoul(Number.NaN) } }).evaluate({
        state: 's',
        questions: { a: noul('q') },
      }),
    ).rejects.toThrow(/probability/);
    await expect(
      new MockProvider({ answers: { a: mockChoice('zzz') } }).evaluate({
        state: 's',
        questions: { a: choice('q', { x: null }) },
      }),
    ).rejects.toThrow(/undeclared/);
    await expect(
      new MockProvider({ answers: { a: mockScore(9, 0.9, 2) } }).evaluate({
        state: 's',
        questions: { a: score('q', ['l', 'h']) },
      }),
    ).rejects.toThrow(/range/);
  });

  it('builds a valid score distribution', async () => {
    const r = await new MockProvider({ answers: { a: mockScore(1.2, 0.8, 3) } }).evaluate({
      state: 's',
      questions: { a: score('q', ['a', 'b', 'c']) },
    });
    const a = r.answers.a as { probabilities: Record<string, number> };
    expect(Object.values(a.probabilities).reduce((x, y) => x + y, 0)).toBeCloseTo(1);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const c = new AbortController();
    c.abort(new Error('stop'));
    await expect(
      new MockProvider({ answers: { a: mockNoul(0.5) } }).evaluate(
        { state: 's', questions: { a: noul('q') } },
        { signal: c.signal },
      ),
    ).rejects.toThrow('stop');
  });
});
