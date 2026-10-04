import type {
  Answer,
  DecisionProvider,
  EvaluateRequest,
  EvaluateResult,
  Question,
} from '@nest-decisions/core';

const has = (state: unknown, words: string[]): boolean => {
  const text = JSON.stringify(state).toLowerCase();
  return words.some((w) => text.includes(w));
};

/**
 * A stand-in so the demo app runs with no API key. It is NOT a model: it answers the demo
 * questions with keyword rules, by question id, so you can try the gate, review queue and policy
 * flow. Its probabilities mean nothing. Set TYPESAFE_API_KEY (or JEV_API_KEY) to use the real
 * provider instead.
 */
export class DemoProvider implements DecisionProvider {
  readonly name = 'demo-keywords';

  async evaluate({ state, questions }: EvaluateRequest): Promise<EvaluateResult> {
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) answers[id] = this.answer(id, q, state);
    return { answers, model: 'demo-keywords', cost: { amount: 0, source: 'mock' }, attempts: 1 };
  }

  private answer(id: string, q: Question, state: unknown): Answer {
    if (q.type === 'noul') {
      const p =
        id === 'injection'
          ? has(state, ['ignore all', 'ignore previous', 'system prompt', 'you are now'])
            ? 0.97
            : 0.03
          : id === 'urgent'
            ? has(state, ['down', 'outage', 'charged twice', 'now'])
              ? 0.92
              : 0.05
            : id === 'legit'
              ? has(state, ['broken', 'cracked', 'never arrived', 'wrong', 'defective'])
                ? 0.95
                : has(state, ['changed my mind', 'cheaper', 'sue'])
                  ? 0.05
                  : 0.5
              : 0.5;
      return { type: 'noul', noul: p };
    }
    if (q.type === 'choice') {
      const options = Object.keys(q.criteria);
      const pick =
        (has(state, ['invoice', 'billing', 'refund', 'charge']) && 'billing') ||
        (has(state, ['log in', 'password', 'locked']) && 'access') ||
        (has(state, ['error', 'broken', 'bug', 'down']) && 'bug') ||
        'other';
      const choice = options.includes(pick) ? pick : (options[0] as string);
      const probabilities = Object.fromEntries(
        options.map((o) => [o, o === choice ? 0.8 : 0.2 / Math.max(1, options.length - 1)]),
      );
      return { type: 'choice', choice, probabilities, confidence: 0.7 };
    }
    const levels = q.criteria.length;
    const value = has(state, ['!!', 'now', 'garbage', 'third time']) ? levels - 1.2 : 0.3;
    const legend = Object.fromEntries(q.criteria.map((c, i) => [String(i), String(c)]));
    const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), 1 / levels]));
    return { type: 'score', score: value, legend, probabilities, confidence: 0.6 };
  }
}
