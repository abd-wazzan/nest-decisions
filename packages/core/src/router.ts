import type { Decision, DecisionOutcome } from './decision.js';

/**
 * Map a decision's output to a handler. Handlers are exhaustive by type, so adding an option to
 * the decision's output type is a compile error until every route is handled.
 *
 *   const router = new DecisionRouter(intent, { search: (q) => ..., chat: (q) => ... });
 *   await router.handle(request);
 */
export class DecisionRouter<In, K extends string, R> {
  constructor(
    // biome-ignore lint/suspicious/noExplicitAny: the router only needs the decision's output key
    private readonly decision: Decision<In, K, any>,
    private readonly handlers: Record<
      K,
      (input: In, outcome: DecisionOutcome<K, never>) => R | Promise<R>
    >,
  ) {}

  async handle(input: In): Promise<R> {
    const outcome = await this.decision.decide(input);
    const key = outcome.decision;
    const handler = Object.hasOwn(this.handlers, key) ? this.handlers[key] : undefined;
    if (!handler) throw new Error(`No handler for route "${String(outcome.decision)}".`);
    return handler(input, outcome as DecisionOutcome<K, never>);
  }
}
