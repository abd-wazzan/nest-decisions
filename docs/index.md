---
layout: home

hero:
  name: nest-decisions
  text: Decisions for NestJS
  tagline: Ask a bounded question, get a probability, and let confidence choose the code path - auto, review or reject.
  actions:
    - theme: brand
      text: Quickstart
      link: /quickstart
    - theme: alt
      text: Why decisions
      link: /why-decisions
    - theme: alt
      text: GitHub
      link: https://github.com/abd-wazzan/nest-decisions

features:
  - title: Policy in code
    details: A decision bundles typed questions, the exact state the model sees, and a pure policy() you can unit test. The model judges; your code decides.
  - title: Allow, review, block
    details: "@Gate turns a decision into a guard. Confident requests run, uncertain ones are queued for a human (202), clearly bad ones are blocked, and outages fail closed."
  - title: Adopt without risk
    details: Run a decision beside your existing logic in shadow mode, read the disagreements, and switch over when you trust it.
  - title: Calibrate, don't guess
    details: Helpers turn a few labelled examples into precision/recall tables and threshold suggestions. Measure before you trust a number.
---

::: warning Pre-alpha
The packages are not on npm yet and the API can change. The numbers in these docs come from small,
hand-labelled sets and are illustrations, not benchmarks.
:::

## A decision in one screen

```ts
@Injectable()
export class RefundCheck extends Decision<RefundRequest, GateOutput, typeof questions> {
  readonly questions = questions;

  // Exactly what the model sees: no ids, no amount.
  state(r: RefundRequest) {
    return { reason: r.reason, orderStatus: r.orderStatus };
  }

  // Plain, testable rules. Limits stay in code, whatever the model says.
  policy(a: AnswersOf<typeof questions>, r: RefundRequest): GateOutput {
    if (r.amount > 500) return { verdict: 'review', reason: 'amount above auto limit' };
    return verdictFromTrust(a.legit.noul, this.thresholds);
  }
}

@Gate({ decision: RefundCheck, input: (ctx) => loadRefund(ctx) })
@Post('refund')
refund(@Body() dto: RefundDto) { /* runs only when allowed */ }
```

Try it with no API key: the repository's `examples/support-desk` is a runnable Nest app.
