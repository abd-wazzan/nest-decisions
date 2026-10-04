# @nest-decisions/testing

A deterministic provider and helpers for testing code built on `@nest-decisions/core`, with no API key.

```ts
const { module, provider } = DecisionsTestingModule.with({
  answers: { urgent: mockNoul(0.95), topic: mockChoice('billing', 0.9, ['billing', 'bug']) },
});
const app = await Test.createTestingModule({ imports: [module], providers: [TicketTriage] }).compile();

provider.calls[0].state;                 // assert exactly what was sent
provider.set({ urgent: mockNoul(0.1) }); // change an answer
```

The mock is held to the same bar as a live provider (no `NaN`, declared choices, scores inside
their levels), and a question with no configured answer throws. It checks wiring and policy, not
model accuracy.

Status: pre-alpha. MIT.
