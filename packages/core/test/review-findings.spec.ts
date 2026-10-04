/**
 * Regression tests for defects found in an independent review. Each test failed before its fix.
 */
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  type AnswersOf,
  choice,
  Decision,
  DecisionRouter,
  DecisionsModule,
  DecisionUnavailableError,
  type EvaluateResult,
  MemoryDecisionCache,
  noul,
  QuestionValidationError,
  score,
  stableHash,
  validateAnswers,
  validateState,
  verdictFromRisk,
  verdictFromTrust,
} from '../src';
import { stubProvider } from './helpers';

const questions = { bad: noul('Is it bad?') };

@Injectable()
class Check extends Decision<{ text: string; when?: unknown }, boolean, typeof questions> {
  readonly questions = questions;
  state(i: { text: string; when?: unknown }) {
    return { text: i.text, when: i.when };
  }
  policy(a: AnswersOf<typeof questions>) {
    return a.bad.noul > 0.5;
  }
}

@Injectable()
class SafeCheck extends Check {
  override fallback() {
    return false;
  }
}

const ok = { bad: { type: 'noul' as const, noul: 0.9 } };
const build = async (provider: ReturnType<typeof stubProvider>, extra = {}) => {
  const mod = await Test.createTestingModule({
    imports: [DecisionsModule.forRoot({ provider, audit: { record: () => {} }, ...extra })],
    providers: [Check, SafeCheck],
  }).compile();
  return { check: mod.get(Check), safe: mod.get(SafeCheck) };
};

describe('answers are validated, not just present (gate fail-open)', () => {
  it('rejects NaN, missing and out-of-range noul answers', async () => {
    for (const bad of [
      { type: 'noul', noul: Number.NaN },
      { type: 'noul' },
      { type: 'noul', noul: 1.5 },
    ]) {
      const { check } = await build(stubProvider(() => ({ answers: { bad } as never })));
      await expect(check.decide({ text: 't' })).rejects.toBeInstanceOf(DecisionUnavailableError);
    }
  });

  it('validateAnswers checks choice and score shapes', () => {
    const q = { c: choice('c', { a: null, b: null }), s: score('s', ['lo', 'hi']) };
    const good = {
      c: { type: 'choice', choice: 'a', probabilities: { a: 0.7, b: 0.3 }, confidence: 0.4 },
      s: {
        type: 'score',
        score: 0.5,
        legend: {},
        probabilities: { '0': 0.5, '1': 0.5 },
        confidence: 0.1,
      },
    } as never;
    expect(() => validateAnswers(q, good)).not.toThrow();
    const wrongChoice = {
      ...(good as object),
      c: { type: 'choice', choice: 'z', probabilities: {}, confidence: 1 },
    };
    expect(() => validateAnswers(q, wrongChoice as never)).toThrow(/undeclared/i);
    const badScore = {
      ...(good as object),
      s: { type: 'score', score: 9, legend: {}, probabilities: {}, confidence: 1 },
    };
    expect(() => validateAnswers(q, badScore as never)).toThrow(/range/i);
    const badConf = {
      ...(good as object),
      c: { type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: Number.NaN },
    };
    expect(() => validateAnswers(q, badConf as never)).toThrow(/confidence/i);
    expect(() => validateAnswers(q, {} as never)).toThrow(/no valid/i);
  });

  it('verdict helpers never allow on an invalid probability and validate bands', () => {
    for (const p of [Number.NaN, undefined as never, -0.1, 1.2]) {
      expect(verdictFromRisk(p, { blockAbove: 0.8, reviewAbove: 0.3 })).toBe('review');
      expect(verdictFromTrust(p, { allowAbove: 0.8, reviewAbove: 0.2 })).toBe('review');
    }
    expect(() => verdictFromRisk(0.5, { blockAbove: 0.3, reviewAbove: 0.8 })).toThrow(/blockAbove/);
    expect(() => verdictFromTrust(0.5, { allowAbove: 0.2, reviewAbove: 0.8 })).toThrow(
      /allowAbove/,
    );
  });
});

describe('budget reserves a slot (concurrency and failed calls)', () => {
  it('does not overshoot under concurrency', async () => {
    const provider = stubProvider(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { answers: ok };
    });
    const { safe } = await build(provider, { budget: { maxCalls: 1 } });
    await Promise.all(Array.from({ length: 10 }, (_, i) => safe.decide({ text: `t${i}` })));
    expect(provider.calls).toHaveLength(1);
  });

  it('counts timed-out and failed calls as attempts', async () => {
    const slow = stubProvider(() => new Promise(() => {}));
    const { safe } = await build(slow, { budget: { maxCalls: 1 }, timeoutMs: 10 });
    await safe.decide({ text: 'a' });
    await safe.decide({ text: 'b' });
    await safe.decide({ text: 'c' });
    expect(slow.calls).toHaveLength(1);
  });
});

describe('cache holds answers only', () => {
  it('never stores raw payloads (which contain state)', async () => {
    const stored: EvaluateResult[] = [];
    const cache = {
      get: () => undefined,
      set: (_k: string, v: EvaluateResult) => void stored.push(v),
    };
    const provider = stubProvider(() => ({
      answers: ok,
      raw: { request: { secret: 'x' }, response: {} },
    }));
    const { check } = await build(provider, { cache });
    await check.decide({ text: 'sensitive' });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.raw).toBeUndefined();
    expect(JSON.stringify(stored[0])).not.toContain('sensitive');
  });

  it('supports an asynchronous cache store', async () => {
    const map = new Map<string, EvaluateResult>();
    const cache = {
      get: async (k: string) => map.get(k),
      set: async (k: string, v: EvaluateResult) => void map.set(k, v),
    };
    const provider = stubProvider(() => ({ answers: ok }));
    const { check } = await build(provider, { cache });
    await check.decide({ text: 'same' });
    await check.decide({ text: 'same' });
    expect(provider.calls).toHaveLength(1);
  });
});

describe('state hashing and validation', () => {
  it('distinguishes nested dates', async () => {
    const provider = stubProvider(() => ({ answers: ok }));
    const { check } = await build(provider, { cache: new MemoryDecisionCache({ ttlMs: 10_000 }) });
    await check.decide({ text: 't', when: new Date(0) });
    await check.decide({ text: 't', when: new Date(99_999_999_999) });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.state).toEqual({ text: 't', when: '1970-01-01T00:00:00.000Z' });
  });

  it('rejects Map, Set, BigInt, functions, non-finite numbers and cycles as validation errors', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const bad of [
      { m: new Map() },
      { s: new Set() },
      { n: 1n },
      { f: () => 1 },
      { n: Number.NaN },
      { n: Number.POSITIVE_INFINITY },
      cyclic,
    ]) {
      expect(() => validateState(bad)).toThrow(QuestionValidationError);
    }
    expect(() => validateState({ a: [{ b: new Date(0) }], c: undefined })).not.toThrow();
  });

  it('allows class instances such as DTOs', () => {
    class Dto {
      constructor(readonly text: string) {}
    }
    expect(() => validateState(new Dto('x'))).not.toThrow();
  });

  it('hashes with a secret when given', () => {
    expect(stableHash({ a: 1 }, 'k1')).not.toBe(stableHash({ a: 1 }));
    expect(stableHash({ a: 1 }, 'k1')).toBe(stableHash({ a: 1 }, 'k1'));
    expect(stableHash({ a: 1 }, 'k1')).not.toBe(stableHash({ a: 1 }, 'k2'));
  });
});

describe('router', () => {
  it('does not dispatch on prototype keys', async () => {
    const provider = stubProvider(() => ({
      answers: {
        r: { type: 'choice', choice: 'toString', probabilities: { toString: 1 }, confidence: 1 },
      },
    }));
    @Injectable()
    class R extends Decision<string, string, { r: ReturnType<typeof choice<'toString'>> }> {
      readonly questions = { r: choice('r', { toString: null }) };
      state(s: string) {
        return { s };
      }
      policy(a: never) {
        return (a as { r: { choice: string } }).r.choice;
      }
    }
    const mod = await Test.createTestingModule({
      imports: [DecisionsModule.forRoot({ provider, audit: { record: () => {} } })],
      providers: [R],
    }).compile();
    const router = new DecisionRouter(mod.get(R), {} as never);
    await expect(router.handle('x')).rejects.toThrow(/No handler/);
  });
});

describe('option validation', () => {
  it('rejects bad timeouts', async () => {
    const provider = stubProvider(() => ({ answers: ok }));
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      await expect(build(provider, { timeoutMs })).rejects.toThrow(/timeoutMs/);
    }
  });
});
