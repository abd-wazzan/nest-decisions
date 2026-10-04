# Why decisions

Every backend is full of small judgment calls. Is this ticket urgent? Which team owns it? Is this
message trying to manipulate our assistant? Is this refund legitimate?

Today those calls are made one of two ways:

- **A regex or keyword list.** Cheap and fast, and it breaks on every new phrasing. `"refund"`
  routes to billing until a customer writes "I want my money back".
- **A full chat-model call.** Flexible, but slow, expensive per call, and it returns prose you then
  have to parse. The answer can also be a label you never defined.

A **decision** is the third option: ask a bounded question, get a typed answer with a probability,
and let your code choose the path.

## The mindset shift

> Wherever your code guesses, ask a bounded question and let confidence choose the code path:
> **auto**, **review**, or **reject**.

Three things change when you think this way.

**1. Confidence is a first-class input.** Instead of `if (looksUrgent) escalate()`, you write
"escalate when the urgency probability is above 0.8, ask a human between 0.3 and 0.8, otherwise
proceed". The middle band is where a human adds value, and it only exists once you have a number.

**2. The model judges, your code decides.** The model answers questions. It does not hold your
business rules. Limits, arithmetic, permissions and routing tables stay in a pure function you can
unit test. A refund over 500 goes to review no matter how sure the model is.

**3. Every decision is auditable.** Each one records what was asked, the probabilities, the model
version, the cost and the outcome. When a decision is wrong you can see exactly why, and replay
the case against a new model before you upgrade.

## What a decision looks like

```ts
@Injectable()
export class TicketTriage extends Decision<Ticket, Route, typeof questions> {
  readonly questions = questions;                       // what to ask
  state(t: Ticket) { return { subject: t.subject, body: t.body }; }   // what the model sees
  policy(a: AnswersOf<typeof questions>): Route {       // pure rules over the answers
    if (a.urgent.noul > 0.8) return { queue: 'escalation' };
    if (a.topic.confidence < 0.6) return { queue: 'human-review' };
    return { queue: a.topic.choice };
  }
  override fallback(): Route { return { queue: 'human-review' }; }   // provider down? still safe
}
```

Questions, state selection and policy live together in one class, which is the part a human
reviews.

## Where decisions fit, and where they do not

Good fits: routing, triage, moderation, abuse and injection signals, extraction choices, ranking,
"is this request legitimate", "does this need a human".

Poor fits, keep these in code:

- **Arithmetic and limits.** The model should not add up an order or compare dates.
- **Authorization.** A gate is an extra signal, never the only control. Never let a probability
  stand in for "is this user allowed to do this".
- **Free-form generation.** Decisions pick among options and grade things. They do not write.

## Adopting without risk: shadow mode

You do not have to trust a decision on day one. Run it beside your existing logic and compare:

```ts
const { value } = await shadowRun({
  name: 'triage',
  legacy: () => keywordRoute(ticket),               // behavior in production today
  candidate: () => triage.decide(ticket).then((r) => r.decision.queue),
});
// `value` is always the legacy result. Disagreements are reported, never acted on.
```

Watch the disagreement report for a week, look at the cases where they differ, and switch over
when you are confident.
