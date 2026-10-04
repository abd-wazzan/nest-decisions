import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { type AnswersOf, choice, Decision, DecisionRouter, DecisionsModule } from '../src';
import { stubProvider } from './helpers';

const questions = { intent: choice('Intent?', { search: null, chat: null }) };
type Route = 'search' | 'chat';

@Injectable()
class Intent extends Decision<string, Route, typeof questions> {
  readonly questions = questions;
  state(text: string) {
    return { text };
  }
  policy(a: AnswersOf<typeof questions>): Route {
    return a.intent.choice;
  }
}

const setup = async (pick: Route) => {
  const provider = stubProvider(() => ({
    answers: {
      intent: {
        type: 'choice',
        choice: pick,
        probabilities: { search: 0.5, chat: 0.5 },
        confidence: 0.9,
      },
    },
  }));
  const mod = await Test.createTestingModule({
    imports: [DecisionsModule.forRoot({ provider, audit: { record: () => {} } })],
    providers: [Intent],
  }).compile();
  return mod.get(Intent);
};

describe('DecisionRouter', () => {
  it('dispatches to the handler for the decided route', async () => {
    const router = new DecisionRouter(await setup('search'), {
      search: (q) => `searching ${q}`,
      chat: (q) => `chatting ${q}`,
    });
    expect(await router.handle('cats')).toBe('searching cats');
  });

  it('throws on an unhandled route at runtime', async () => {
    const router = new DecisionRouter(await setup('chat'), { search: () => 1 } as never);
    await expect(router.handle('x')).rejects.toThrow(/No handler for route "chat"/);
  });
});
