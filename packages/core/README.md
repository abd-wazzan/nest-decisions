# @nest-decisions/core

Decision-first building blocks for NestJS: typed questions, confidence-aware policies, guards,
fallbacks, audit and calibration. Providers plug in through one small interface.

```ts
@Injectable()
class TicketTriage extends Decision<Ticket, Route, typeof questions> {
  readonly questions = questions;
  state(t: Ticket) { return { subject: t.subject, body: t.body }; }   // what the model sees
  policy(a: AnswersOf<typeof questions>): Route { /* plain, testable rules */ }
  override fallback(): Route { return { queue: 'human-review' }; }
}
```

What is in the box: `Decision`, `DecisionsModule` (`forRoot` / `forRootAsync`), `noul` / `choice` /
`score` builders, `@Gate` with `verdictFromRisk` / `verdictFromTrust`, `DecisionRouter`, `shadowRun`,
`MemoryDecisionCache`, budget guard, review queue, audit sink, and threshold calibration helpers.

Status: pre-alpha. Start with the [quickstart](https://github.com/abd-wazzan/nest-decisions/blob/main/docs/quickstart.md) and the
[production checklist](https://github.com/abd-wazzan/nest-decisions/blob/main/docs/production-checklist.md).

Peers: `@nestjs/common` and `@nestjs/core` 10, 11 or 12, `reflect-metadata`. Node 20.19+. MIT.
