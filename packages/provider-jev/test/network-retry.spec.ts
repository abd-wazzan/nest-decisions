import { noul } from '@nest-decisions/core';
import { describe, expect, it, vi } from 'vitest';
import { JevHttpError, JevProvider } from '../src';

const req = { state: { t: 1 }, questions: { a: noul('q') } };
const good = {
  model: 'm',
  answers: { a: { type: 'noul', noul: 0.5 } },
  usage: { input_tokens: 1, output_tokens: 1 },
};
const ok = () => new Response(JSON.stringify(good));
const make = (f: unknown, extra = {}) =>
  new JevProvider({
    backend: 'typesafe',
    apiKey: 'k',
    retryDelayMs: 0,
    fetch: f as typeof fetch,
    ...extra,
  });

describe('network errors', () => {
  it('retries a transport failure and then succeeds', async () => {
    const f = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(ok());
    await expect(make(f).evaluate(req)).resolves.toBeDefined();
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('throws the last transport error after maxAttempts', async () => {
    const f = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(make(f, { maxAttempts: 2 }).evaluate(req)).rejects.toThrow('fetch failed');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the caller aborted', async () => {
    const c = new AbortController();
    const f = vi.fn(async () => {
      c.abort(new Error('stop'));
      throw new TypeError('fetch failed');
    });
    await expect(make(f).evaluate(req, { signal: c.signal })).rejects.toThrow('stop');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('refuses redirects explicitly and does not retry them', async () => {
    const f = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
    );
    const err = await make(f)
      .evaluate(req)
      .catch((e) => e);
    expect(err).toBeInstanceOf(JevHttpError);
    expect(err.status).toBe(302);
    expect(err.message).toMatch(/redirect/i);
    expect(err.message).not.toContain('evil.example');
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('manual');
  });
});
