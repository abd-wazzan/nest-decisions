import { choice, noul, type Questions, score } from '@nest-decisions/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JevContractError, JevHttpError, JevProvider, validateResponse } from '../src';

const questions: Questions = {
  urgent: noul('Is it urgent?'),
  topic: choice('Topic?', { billing: null, bug: null }),
  mood: score('Mood?', ['calm', 'angry']),
};

const good = (extra: Record<string, unknown> = {}) => ({
  model: 'jev-1.2',
  answers: {
    urgent: { type: 'noul', noul: 0.9 },
    topic: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.8, bug: 0.2 },
      confidence: 0.7,
    },
    mood: {
      type: 'score',
      score: 0.4,
      legend: { '0': 'calm', '1': 'angry' },
      probabilities: { '0': 0.6, '1': 0.4 },
      confidence: 0.2,
    },
  },
  usage: { input_tokens: 100, output_tokens: 10, ...extra },
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const make = (fetchImpl: typeof fetch, extra = {}) =>
  new JevProvider({
    backend: 'typesafe',
    apiKey: 'sk-secret',
    retryDelayMs: 0,
    fetch: fetchImpl,
    ...extra,
  });

const req = { state: { text: 'hi' }, questions };

afterEach(() => vi.unstubAllEnvs());

describe('JevProvider construction', () => {
  it('requires credentials and an explicit backend with apiKey', () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(() => new JevProvider()).toThrow(/No Jev credentials/);
    expect(() => new JevProvider({ apiKey: 'k' })).toThrow(/explicit backend/);
    expect(() => new JevProvider({ backend: 'typesafe' })).toThrow(/TYPESAFE_API_KEY/);
    expect(() => new JevProvider({ backend: 'typesafe', apiKey: '  ' })).toThrow(/nonblank/);
  });

  it('prefers TypeSafe, then OpenRouter, from the environment', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'o');
    expect(new JevProvider().name).toBe('jev:openrouter');
    vi.stubEnv('TYPESAFE_API_KEY', 't');
    expect(new JevProvider().name).toBe('jev:typesafe');
  });

  it('rejects bad numeric options', () => {
    const base = { backend: 'typesafe' as const, apiKey: 'k' };
    expect(() => new JevProvider({ ...base, maxAttempts: 0 })).toThrow(/maxAttempts/);
    expect(() => new JevProvider({ ...base, retryDelayMs: -1 })).toThrow(/retryDelayMs/);
    expect(
      () => new JevProvider({ ...base, pricing: { inputPerMillion: -1, outputPerMillion: 1 } }),
    ).toThrow(/pricing/);
  });
});

describe('JevProvider.evaluate', () => {
  it('posts the documented body with a bearer key and returns typed results', async () => {
    const fetchMock = vi.fn(async () => json(good({ cost: 0.0002 })));
    const res = await make(fetchMock as never).evaluate(req);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret');
    expect(init.redirect).toBe('manual');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'jev-latest',
      state: { text: 'hi' },
      questions,
    });
    expect(res.model).toBe('jev-1.2');
    expect(res.answers.urgent).toEqual({ type: 'noul', noul: 0.9 });
    expect(res.cost).toEqual({ amount: 0.0002, source: 'reported' });
  });

  it('uses the OpenRouter endpoint and model alias', async () => {
    const fetchMock = vi.fn(async () => json(good()));
    await new JevProvider({
      backend: 'openrouter',
      apiKey: 'k',
      fetch: fetchMock as never,
    }).evaluate(req);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(JSON.parse(init.body as string).model).toBe('~typesafe/jev-latest');
  });

  it('never leaks the key into the retained raw exchange', async () => {
    const res = await make((async () => json(good())) as never).evaluate(req);
    expect(JSON.stringify(res.raw)).not.toContain('sk-secret');
  });

  it('labels cost as estimated or unknown when none is reported', async () => {
    const f = (async () => json(good())) as never;
    expect((await make(f).evaluate(req)).cost).toEqual({ amount: null, source: 'unknown' });
    const priced = make(f, { pricing: { inputPerMillion: 1, outputPerMillion: 2 } });
    const { cost } = await priced.evaluate(req);
    expect(cost.source).toBe('estimated');
    expect(cost.amount).toBeCloseTo(0.00012);
    const bad = make((async () => json(good({ cost: -1 }))) as never);
    expect((await bad.evaluate(req)).cost.source).toBe('unknown');
  });

  it('retries 429/529 then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(json({}, 529))
      .mockResolvedValueOnce(json(good()));
    const res = await make(fetchMock as never).evaluate(req);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.model).toBe('jev-1.2');
  });

  it('gives up after maxAttempts with the last status', async () => {
    const fetchMock = vi.fn(async () => json({}, 503));
    await expect(make(fetchMock as never, { maxAttempts: 2 }).evaluate(req)).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry 401/422 and hints at the key on 401', async () => {
    const fetchMock = vi.fn(async () => json({}, 401));
    const err = await make(fetchMock as never)
      .evaluate(req)
      .catch((e) => e);
    expect(err).toBeInstanceOf(JevHttpError);
    expect(err.message).toMatch(/TYPESAFE_API_KEY/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const r422 = vi.fn(async () => json({}, 422));
    await expect(make(r422 as never).evaluate(req)).rejects.toMatchObject({ status: 422 });
  });

  it('honors Retry-After dates and ignores garbage values', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': 'garbage' }))
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': 'Mon, 01 Jan 2001 00:00:00 GMT' }))
      .mockResolvedValueOnce(json(good()));
    await make(fetchMock as never).evaluate(req);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('stops promptly when aborted, including during backoff', async () => {
    const c = new AbortController();
    c.abort(new Error('stop'));
    await expect(
      make((async () => json(good())) as never).evaluate(req, { signal: c.signal }),
    ).rejects.toThrow('stop');

    const c2 = new AbortController();
    const fetchMock = vi.fn(async () => json({}, 429, { 'retry-after': '5' }));
    const pending = make(fetchMock as never).evaluate(req, { signal: c2.signal });
    setTimeout(() => c2.abort(new Error('late stop')), 10);
    await expect(pending).rejects.toThrow('late stop');
  });

  it('validates the request before any network call', async () => {
    const fetchMock = vi.fn();
    await expect(make(fetchMock as never).evaluate({ state: '  ', questions })).rejects.toThrow(
      /blank/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and contract violations', async () => {
    await expect(
      make((async () => new Response('not json')) as never).evaluate(req),
    ).rejects.toThrow();
    const broken = good();
    (broken.answers.topic as { choice: string }).choice = 'refunds';
    await expect(make((async () => json(broken)) as never).evaluate(req)).rejects.toThrow(
      JevContractError,
    );
  });
});

describe('validateResponse', () => {
  const run = (mutate: (r: ReturnType<typeof good>) => void) => {
    const r = good();
    mutate(r);
    return () => validateResponse(r, questions);
  };

  it('accepts a valid response', () => {
    expect(run(() => {})).not.toThrow();
  });

  it.each([
    ['bad envelope', () => validateResponse(null, questions), /envelope/],
    ['blank model', run((r) => (r.model = ' ')), /envelope/],
    ['bad usage', run((r) => ((r.usage as { input_tokens: unknown }).input_tokens = 1.5)), /usage/],
    ['missing answer', run((r) => delete (r.answers as Record<string, unknown>).urgent), /Missing/],
    [
      'wrong type',
      run((r) => ((r.answers.urgent as { type: string }).type = 'choice')),
      /mismatched/,
    ],
    ['noul out of range', run((r) => (r.answers.urgent.noul = 1.5)), /Invalid noul/],
    ['bad confidence', run((r) => (r.answers.topic.confidence = 2)), /Invalid distribution/],
    [
      'wrong keys',
      run((r) => ((r.answers.topic.probabilities as Record<string, number>) = { billing: 1 })),
      /keys must match/,
    ],
    [
      'probabilities not summing to one',
      run((r) => (r.answers.topic.probabilities = { billing: 0.5, bug: 0.2 })),
      /sum to one/,
    ],
    ['score out of range', run((r) => (r.answers.mood.score = 5)), /Score out of range/],
  ])('rejects %s', (_n, fn, message) => {
    expect(fn).toThrow(message);
  });
});
