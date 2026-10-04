import { choice, noul, score } from '@nest-decisions/core';
import { describe, expect, it } from 'vitest';
import { DecisionsTestingModule, MockProvider, mockChoice, mockNoul, mockScore } from '../src';

const req = (questions: Record<string, ReturnType<typeof noul>>) => ({ state: 'x', questions });

describe('MockProvider', () => {
  it('returns configured answers and records a snapshot of calls', async () => {
    const p = new MockProvider({ answers: { a: mockNoul(0.7) } });
    const body = req({ a: noul('q') });
    const res = await p.evaluate(body);
    expect(res.answers.a).toEqual({ type: 'noul', noul: 0.7 });
    expect(res.cost).toEqual({ amount: 0, source: 'mock' });
    expect(p.calls).toEqual([body]);
  });

  it('throws on a question with no configured answer', async () => {
    await expect(new MockProvider().evaluate(req({ a: noul('q') }))).rejects.toThrow(/"a"/);
  });

  it('supports function answers, set(), and failWith', async () => {
    const p = new MockProvider({
      answers: { a: (q) => (q.type === 'noul' ? mockNoul(0.1) : mockNoul(0.9)) },
    });
    p.set({ b: mockScore(0.5, 0.9, 2) });
    const res = await p.evaluate({
      state: 's',
      questions: { a: noul('q'), b: score('q', ['l', 'h']) },
    });
    expect(res.answers.a).toMatchObject({ noul: 0.1 });
    expect(res.answers.b).toMatchObject({ type: 'score', score: 0.5 });
    const failing = new MockProvider({ failWith: new Error('down') });
    await expect(failing.evaluate(req({ a: noul('q') }))).rejects.toThrow('down');
  });

  it('delays and honors abort', async () => {
    const p = new MockProvider({ answers: { a: mockNoul(0.5) }, delayMs: 5 });
    await expect(p.evaluate(req({ a: noul('q') }))).resolves.toBeDefined();
    const c = new AbortController();
    const slow = new MockProvider({ answers: { a: mockNoul(0.5) }, delayMs: 1000 });
    const pending = slow.evaluate(req({ a: noul('q') }), { signal: c.signal });
    c.abort();
    await expect(pending).rejects.toThrow('aborted');
  });

  it('builds choice probabilities that sum to 1', () => {
    const a = mockChoice('bug', 0.7, ['billing', 'bug', 'other']);
    expect(Object.values(a.probabilities).reduce((x, y) => x + y, 0)).toBeCloseTo(1);
    expect(a.choice).toBe('bug');
    expect(mockChoice('only').probabilities).toEqual({ only: 1 });
  });

  it('exposes a ready testing module', () => {
    const { module, provider } = DecisionsTestingModule.with({
      answers: { c: mockChoice('x') },
    });
    expect(module.module.name).toBe('DecisionsModule');
    expect(provider.name).toBe('mock');
    void choice;
  });
});
