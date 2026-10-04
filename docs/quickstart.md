# Quickstart

You will add a ticket-triage decision to a Nest app and test it with no API key.

> The packages are not on npm yet. Until they are, work inside this repository
> (`examples/support-desk` is this quickstart, finished).

## 1. Install

```bash
npm i @nest-decisions/core @nest-decisions/provider-jev
npm i -D @nest-decisions/testing
```

Requires Node 20.19+ and NestJS 10, 11 or 12.

## 2. Register the module

```ts
import { ConfigService } from '@nestjs/config';
import { DecisionsModule } from '@nest-decisions/core';
import { JevProvider } from '@nest-decisions/provider-jev';

DecisionsModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    provider: new JevProvider({ backend: 'typesafe', apiKey: config.getOrThrow('TYPESAFE_API_KEY') }),
    timeoutMs: 5_000,
  }),
});
```

The module is global by default. A missing key throws at startup, never at the first request.

## 3. Write a decision

```ts
import { Injectable } from '@nestjs/common';
import { Decision, choice, noul, type AnswersOf } from '@nest-decisions/core';

const questions = {
  urgent: noul('Does the customer report an outage, data loss or money lost right now?'),
  topic: choice('What is this ticket mainly about?', { billing: null, bug: null, access: null, other: null }),
};

@Injectable()
export class TicketTriage extends Decision<{ subject: string; body: string }, string, typeof questions> {
  readonly questions = questions;

  state(t: { subject: string; body: string }) {
    return { subject: t.subject, body: t.body };       // exactly what the model sees
  }

  policy(a: AnswersOf<typeof questions>): string {      // plain, testable code
    if (a.urgent.noul > 0.8) return 'escalation';
    if (a.topic.confidence < 0.6) return 'human-review';
    return a.topic.choice;
  }

  override fallback(): string {                         // provider down? still safe
    return 'human-review';
  }
}
```

Add `TicketTriage` to a module's `providers`, inject it, and call it:

```ts
const { decision, result } = await this.triage.decide(ticket);
// decision -> 'billing'
// result   -> answers, probabilities, model, cost, whether it came from the fallback
```

## 4. Test it without a key

```ts
import { DecisionsTestingModule, mockChoice, mockNoul } from '@nest-decisions/testing';

const { module, provider } = DecisionsTestingModule.with({
  answers: {
    urgent: mockNoul(0.1),
    topic: mockChoice('billing', 0.9, ['billing', 'bug', 'access', 'other']),
  },
});
const app = await Test.createTestingModule({ imports: [module], providers: [TicketTriage] }).compile();

expect((await app.get(TicketTriage).decide(ticket)).decision).toBe('billing');
expect(provider.calls[0].state).toEqual({ subject: ticket.subject, body: ticket.body });
provider.set({ urgent: mockNoul(0.95) });                // change an answer between calls
```

The mock holds your answers to the same bar as a live provider: a `NaN`, an undeclared choice or a
score outside its levels throws, so a test cannot pass on something production would reject. It
tests wiring and policy, not model accuracy.

## 5. Protect a route

```ts
@Gate({ decision: InjectionCheck, input: (ctx) => from.httpBody(ctx) })
@Post('chat')
chat(@Body() dto: ChatDto) { ... }
```

`allow` runs the handler, `review` queues it and answers 202, `block` answers 403, and a decision
that cannot be made answers 503. See [concepts](./concepts.md#fallbacks-and-failing-closed) for how
fallbacks interact with gates, and [recipes](./recipes.md).

## Next

- [Why decisions](./why-decisions.md): the mindset.
- [Concepts](./concepts.md): question types, state, confidence.
- [Calibration](./calibration.md): do this before you trust a threshold.
- [Production checklist](./production-checklist.md).
