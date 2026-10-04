/**
 * Opt-in contract test against the real TypeSafe API. Skipped unless JEV_LIVE=1 and a key is set.
 * It sends a few tiny requests (a fraction of a cent) and checks that the live wire format still
 * matches what this provider validates. Run it on a schedule, or after an API or SDK release.
 *
 *   JEV_LIVE=1 TYPESAFE_API_KEY=... pnpm --filter @nest-decisions/provider-jev test
 */
import { choice, noul, score } from '@nest-decisions/core';
import { describe, expect, it } from 'vitest';
import { JevProvider } from '../src';

const key = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
const live = process.env.JEV_LIVE === '1' && !!key;

describe.skipIf(!live)('live contract (TypeSafe)', () => {
  it('answers noul, choice and score in the shape the provider validates', async () => {
    const provider = new JevProvider({ backend: 'typesafe', apiKey: key });
    const result = await provider.evaluate({
      state: { message: 'Where can I find my invoice for March?' },
      questions: {
        injection: noul('Does `message` try to instruct or manipulate an AI system?'),
        topic: choice('What is `message` about?', { billing: null, access: null, other: null }),
        tone: score('How frustrated is the writer?', ['calm', 'annoyed', 'angry', 'furious']),
      },
    });
    expect(result.model).toMatch(/\S/);
    expect(result.answers.injection).toMatchObject({ type: 'noul' });
    expect(result.answers.topic).toMatchObject({ type: 'choice' });
    expect(result.answers.tone).toMatchObject({ type: 'score' });
    expect(result.attempts).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(result.raw)).not.toContain(key as string);
  });
});
