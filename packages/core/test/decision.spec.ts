import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  type AnswersOf,
  type AuditEntry,
  choice,
  Decision,
  DecisionsModule,
  DecisionUnavailableError,
  noul,
  QuestionValidationError,
} from '../src';
import { stubProvider } from './helpers';

const questions = {
  urgent: noul('Is the customer reporting an outage?'),
  topic: choice('What is this about?', { billing: null, bug: null }),
};

type Route = { queue: string };
type Ticket = { text: string; email: string };

@Injectable()
class Triage extends Decision<Ticket, Route, typeof questions> {
  readonly questions = questions;
  state(t: Ticket) {
    return { text: t.text };
  }
  policy(a: AnswersOf<typeof questions>): Route {
    if (a.urgent.noul > 0.8) return { queue: 'escalation' };
    if (a.topic.confidence < 0.6) return { queue: 'review' };
    return { queue: a.topic.choice };
  }
}

@Injectable()
class SafeTriage extends Triage {
  override fallback(): Route {
    return { queue: 'review' };
  }
}

const answers = (urgent: number, topic = 'billing', confidence = 0.9) => ({
  urgent: { type: 'noul' as const, noul: urgent },
  topic: {
    type: 'choice' as const,
    choice: topic,
    probabilities: { billing: 0.9, bug: 0.1 },
    confidence,
  },
});

async function setup(
  provider: ReturnType<typeof stubProvider>,
  extra: Record<string, unknown> = {},
) {
  const mod = await Test.createTestingModule({
    imports: [DecisionsModule.forRoot({ provider, audit: { record: () => {} }, ...extra })],
    providers: [Triage, SafeTriage],
  }).compile();
  return { triage: mod.get(Triage), safe: mod.get(SafeTriage) };
}

const ticket: Ticket = { text: 'site is down', email: 'a@b.co' };

describe('Decision.decide', () => {
  it('sends only the chosen state and applies the policy', async () => {
    const provider = stubProvider(() => ({ answers: answers(0.95) }));
    const { triage } = await setup(provider);
    const { decision, result } = await triage.decide(ticket);
    expect(decision).toEqual({ queue: 'escalation' });
    expect(provider.calls[0]?.state).toEqual({ text: 'site is down' });
    expect(result.fromFallback).toBe(false);
    if (!result.fromFallback) {
      expect(result.model).toBe('stub-1');
      expect(result.answers.topic.choice).toBe('billing');
    }
  });

  it('routes by confidence', async () => {
    const low = stubProvider(() => ({ answers: answers(0.1, 'bug', 0.4) }));
    expect((await (await setup(low)).triage.decide(ticket)).decision).toEqual({ queue: 'review' });
    const ok = stubProvider(() => ({ answers: answers(0.1, 'bug', 0.9) }));
    expect((await (await setup(ok)).triage.decide(ticket)).decision).toEqual({ queue: 'bug' });
  });

  it('fails closed without a fallback', async () => {
    const provider = stubProvider(() => {
      throw new Error('boom');
    });
    const { triage } = await setup(provider);
    await expect(triage.decide(ticket)).rejects.toBeInstanceOf(DecisionUnavailableError);
  });

  it('uses the fallback when the provider fails', async () => {
    const provider = stubProvider(() => {
      throw new Error('boom');
    });
    const { safe } = await setup(provider);
    const { decision, result } = await safe.decide(ticket);
    expect(decision).toEqual({ queue: 'review' });
    expect(result.fromFallback).toBe(true);
  });

  it('treats a missing or wrong-typed answer as unavailable', async () => {
    const missing = stubProvider(() => ({ answers: { urgent: answers(0.5).urgent } }));
    await expect((await setup(missing)).triage.decide(ticket)).rejects.toThrow(/topic/);
    const wrong = stubProvider(() => ({
      answers: { ...answers(0.5), urgent: { type: 'choice', choice: 'x' } } as never,
    }));
    await expect((await setup(wrong)).triage.decide(ticket)).rejects.toThrow(/urgent/);
  });

  it('times out slow providers', async () => {
    const provider = stubProvider(() => new Promise(() => {}));
    const { safe } = await setup(provider, { timeoutMs: 20 });
    const { result } = await safe.decide(ticket);
    expect(result.fromFallback && result.error.message).toMatch(/exceeded 20ms/);
  });

  it('does not swallow validation errors with a fallback', async () => {
    const provider = stubProvider(() => ({ answers: answers(0.5) }));
    const { safe } = await setup(provider);
    vi.spyOn(safe, 'state').mockReturnValue('   ' as never);
    await expect(safe.decide(ticket)).rejects.toBeInstanceOf(QuestionValidationError);
    expect(provider.calls).toHaveLength(0);
  });

  it('redacts state before sending and hashing', async () => {
    const provider = stubProvider(() => ({ answers: answers(0.1) }));
    const entries: AuditEntry[] = [];
    const { triage } = await setup(provider, {
      redact: (s: { text: string }) => ({ text: s.text.replace(/\d+/g, '#') }),
      audit: { record: (e: AuditEntry) => void entries.push(e) },
    });
    await triage.decide({ text: 'card 4242 failed', email: 'x' });
    expect(provider.calls[0]?.state).toEqual({ text: 'card # failed' });
    expect(entries[0]).toMatchObject({ outcome: 'decided', provider: 'stub', decision: 'Triage' });
    expect(JSON.stringify(entries[0])).not.toContain('4242');
    expect(entries[0]?.stateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never lets a failing audit sink change the outcome', async () => {
    const provider = stubProvider(() => ({ answers: answers(0.95) }));
    const { triage } = await setup(provider, {
      audit: {
        record: () => {
          throw new Error('disk full');
        },
      },
    });
    expect((await triage.decide(ticket)).decision).toEqual({ queue: 'escalation' });
  });

  it('records fallback outcomes', async () => {
    const provider = stubProvider(() => {
      throw new Error('down');
    });
    const record = vi.fn();
    const { safe } = await setup(provider, { audit: { record } });
    await safe.decide(ticket);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'fallback', error: expect.stringContaining('down') }),
    );
  });
});

describe('DecisionsModule', () => {
  it('supports forRootAsync with a factory', async () => {
    const provider = stubProvider(() => ({ answers: answers(0.95) }));
    const mod = await Test.createTestingModule({
      imports: [
        DecisionsModule.forRootAsync({
          useFactory: async () => ({ provider, audit: { record: () => {} } }),
        }),
      ],
      providers: [Triage],
    }).compile();
    expect((await mod.get(Triage).decide(ticket)).decision).toEqual({ queue: 'escalation' });
  });
});
