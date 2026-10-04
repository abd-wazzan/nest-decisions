# Writing a provider

Core knows one thing about a vendor: the `DecisionProvider` interface.

```ts
interface DecisionProvider {
  readonly name: string;
  evaluate(request: EvaluateRequest, options?: { signal?: AbortSignal }): Promise<EvaluateResult>;
}

interface EvaluateRequest { state: State; questions: Questions; model?: string }
interface EvaluateResult {
  answers: Record<string, Answer>;   // one per question id
  model: string;                     // the versioned model that answered
  cost: { amount: number; source: 'reported' | 'estimated' | 'mock' } | { amount: null; source: 'unknown' };
  attempts?: number;                 // requests actually made, retries included; the budget counts each
  raw?: { request: unknown; response: unknown };   // optional, for audit; never include credentials
}
```

## What core does for you

Before your provider is called, core validates the questions, redacts and normalizes the state, checks the
cache, reserves budget and starts the timeout (your `signal` aborts when it fires). After it
returns, core validates every answer (right type, finite probabilities in 0 to 1, a declared
choice, a score inside its levels) and treats anything else as an outage. You do not need to
re-validate for safety, but validating against the wire contract gives better error messages.

## What you owe

- **Fixed credentials and backend at construction.** Throw at startup if a key is missing. Never
  switch backend after a failure.
- **Honor `signal`.** Stop work and reject when it aborts.
- **Never put credentials in `raw`, errors or logs.**
- **Do not echo upstream bodies in error messages.**
- **Label cost honestly:** `reported` only when the API reported it, `estimated` only from caller-supplied
  prices, otherwise `unknown`.
- **Retry only what is safe**, with backoff and jitter, and honor `Retry-After`; fail fast when it
  is longer than you are willing to wait. Never retry a caller abort.
- **Never follow redirects** with credentials attached.

## A minimal provider

```ts
export class MyProvider implements DecisionProvider {
  readonly name = 'my-provider';
  constructor(private readonly client: MyClient) {}

  async evaluate({ state, questions, model }: EvaluateRequest, { signal }: CallOptions = {}) {
    const res = await this.client.decide({ state, questions, model }, { signal });
    return {
      answers: res.answers,
      model: res.modelVersion,
      cost: res.cost != null ? { amount: res.cost, source: 'reported' as const } : { amount: null, source: 'unknown' as const },
    };
  }
}
```

Test it with the same contract the Jev provider uses: a mocked transport (no network), retry and
abort behavior, malformed responses, and a check that the key never appears in `raw`.
