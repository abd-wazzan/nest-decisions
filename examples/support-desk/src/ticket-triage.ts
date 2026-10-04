import { type AnswersOf, choice, Decision, noul, score } from '@nest-decisions/core';
import { Injectable } from '@nestjs/common';

export interface Ticket {
  subject: string;
  body: string;
  /** Present on the ticket but deliberately never sent to the model. */
  customerEmail: string;
}

export type Route =
  | { queue: 'escalation'; reason: string }
  | { queue: 'human-review'; reason: string }
  | { queue: 'billing' | 'bug' | 'access' | 'other'; reason: string };

const questions = {
  urgent: noul('Does the customer report an outage, data loss, or money lost right now?', {
    true: 'An active outage, lost data, or a charge the customer did not authorize',
    false: 'A question, a request, or a minor annoyance',
  }),
  frustration: score('How frustrated is the customer?', ['calm', 'annoyed', 'angry', 'furious']),
  topic: choice('What is this ticket mainly about?', {
    billing: 'Charges, invoices, refunds, plans',
    bug: 'Something is broken or behaves wrongly',
    access: 'Login, permissions, account lockout',
    other: 'Anything else',
  }),
};

/**
 * One call, three answers, and the routing rules live here in plain code.
 * Replaces keyword matching ("refund" -> billing) that breaks on every new phrasing.
 */
@Injectable()
export class TicketTriage extends Decision<Ticket, Route, typeof questions> {
  readonly questions = questions;

  // Minimal state on purpose: no email, no ids.
  state(ticket: Ticket) {
    return { subject: ticket.subject, body: ticket.body };
  }

  policy(a: AnswersOf<typeof questions>): Route {
    if (a.urgent.noul > 0.8) return { queue: 'escalation', reason: 'urgent' };
    // The scale tops out at 3 ("furious"); a clearly angry message lands around 2.5 to 3.
    if (a.frustration.score >= 2.5) return { queue: 'escalation', reason: 'furious customer' };
    if (a.topic.confidence < 0.6) return { queue: 'human-review', reason: 'unsure of the topic' };
    return { queue: a.topic.choice, reason: 'classified' };
  }

  // If the provider is down, a human looks at it. Omit this method to fail closed instead.
  override fallback(): Route {
    return { queue: 'human-review', reason: 'decision service unavailable' };
  }
}
