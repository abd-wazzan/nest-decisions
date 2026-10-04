import type { DecisionProvider, EvaluateRequest, EvaluateResult } from '../src';

export function stubProvider(
  respond: (req: EvaluateRequest) => Partial<EvaluateResult> | Promise<Partial<EvaluateResult>>,
): DecisionProvider & { calls: EvaluateRequest[] } {
  const calls: EvaluateRequest[] = [];
  return {
    name: 'stub',
    calls,
    async evaluate(req) {
      calls.push(req);
      const r = await respond(req);
      return {
        model: 'stub-1',
        cost: { amount: 0, source: 'mock' },
        answers: {},
        ...r,
      } as EvaluateResult;
    },
  };
}
