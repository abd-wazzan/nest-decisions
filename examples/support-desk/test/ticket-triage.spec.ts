import { DecisionUnavailableError } from '@nest-decisions/core';
import { DecisionsTestingModule, mockChoice, mockNoul, mockScore } from '@nest-decisions/testing';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Ticket, TicketTriage } from '../src/ticket-triage';

const topics = ['billing', 'bug', 'access', 'other'] as const;
const ticket: Ticket = {
  subject: 'Charged twice',
  body: 'I was billed two times this month.',
  customerEmail: 'jane@example.com',
};

let triage: TicketTriage;
let provider: ReturnType<typeof DecisionsTestingModule.with>['provider'];

beforeEach(async () => {
  const testing = DecisionsTestingModule.with({
    answers: {
      urgent: mockNoul(0.1),
      frustration: mockScore(1),
      topic: mockChoice('billing', 0.9, topics),
    },
  });
  provider = testing.provider;
  const mod = await Test.createTestingModule({
    imports: [testing.module],
    providers: [TicketTriage],
  }).compile();
  triage = mod.get(TicketTriage);
});

describe('TicketTriage', () => {
  it('routes a clear billing ticket to billing', async () => {
    const { decision } = await triage.decide(ticket);
    expect(decision).toEqual({ queue: 'billing', reason: 'classified' });
  });

  it('never sends the customer email to the provider', async () => {
    await triage.decide(ticket);
    expect(JSON.stringify(provider.calls)).not.toContain('jane@example.com');
    expect(provider.calls[0]?.state).toEqual({ subject: ticket.subject, body: ticket.body });
  });

  it('asks all three questions in a single call', async () => {
    await triage.decide(ticket);
    expect(provider.calls).toHaveLength(1);
    expect(Object.keys(provider.calls[0]?.questions ?? {})).toEqual([
      'urgent',
      'frustration',
      'topic',
    ]);
  });

  it('escalates urgent tickets regardless of topic', async () => {
    provider.set({ urgent: mockNoul(0.95) });
    expect((await triage.decide(ticket)).decision.queue).toBe('escalation');
  });

  it('escalates furious customers', async () => {
    provider.set({ frustration: mockScore(2.6) });
    expect((await triage.decide(ticket)).decision).toMatchObject({ reason: 'furious customer' });
  });

  it('sends low-confidence topics to a human', async () => {
    provider.set({ topic: mockChoice('bug', 0.4, topics) });
    expect((await triage.decide(ticket)).decision.queue).toBe('human-review');
  });

  it('falls back to human review when the provider fails', async () => {
    const testing = DecisionsTestingModule.with({ failWith: new Error('down') });
    const mod = await Test.createTestingModule({
      imports: [testing.module],
      providers: [TicketTriage],
    }).compile();
    const { decision, result } = await mod.get(TicketTriage).decide(ticket);
    expect(decision).toEqual({ queue: 'human-review', reason: 'decision service unavailable' });
    expect(result.fromFallback && result.error).toBeInstanceOf(DecisionUnavailableError);
  });
});
