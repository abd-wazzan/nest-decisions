import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  type AnswersOf,
  Decision,
  DecisionsModule,
  DecisionUnavailableError,
  MemoryDecisionCache,
  noul,
} from '../src';
import { stubProvider } from './helpers';

const questions = { bad: noul('Is it bad?') };

@Injectable()
class Check extends Decision<{ text: string }, boolean, typeof questions> {
  readonly questions = questions;
  state(i: { text: string }) {
    return { text: i.text };
  }
  policy(a: AnswersOf<typeof questions>) {
    return a.bad.noul > 0.5;
  }
}

const provider = () => stubProvider(() => ({ answers: { bad: { type: 'noul', noul: 0.9 } } }));
const build = async (p: ReturnType<typeof provider>, extra = {}) => {
  const mod = await Test.createTestingModule({
    imports: [DecisionsModule.forRoot({ provider: p, audit: { record: () => {} }, ...extra })],
    providers: [Check],
  }).compile();
  return mod.get(Check);
};

describe('cache in the service', () => {
  it('skips the provider for identical state and marks the result cached', async () => {
    const p = provider();
    const check = await build(p, { cache: new MemoryDecisionCache({ ttlMs: 10_000 }) });
    const first = await check.decide({ text: 'same' });
    const second = await check.decide({ text: 'same' });
    await check.decide({ text: 'different' });
    expect(p.calls).toHaveLength(2);
    expect(first.result.fromFallback === false && first.result.cached).toBe(false);
    expect(second.result.fromFallback === false && second.result.cached).toBe(true);
    expect(second.decision).toBe(true);
  });
});

describe('budget in the service', () => {
  it('fails closed over budget without calling the provider', async () => {
    const p = provider();
    const check = await build(p, { budget: { maxCalls: 1 } });
    await check.decide({ text: 'a' });
    await expect(check.decide({ text: 'b' })).rejects.toBeInstanceOf(DecisionUnavailableError);
    expect(p.calls).toHaveLength(1);
  });
});
