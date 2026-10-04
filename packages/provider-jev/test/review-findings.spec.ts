import { inspect } from 'node:util';
import { noul } from '@nest-decisions/core';
import { describe, expect, it, vi } from 'vitest';
import { JevContractError, JevHttpError, JevProvider } from '../src';

const req = { state: { t: 1 }, questions: { a: noul('q') } };
const good = {
  model: 'm',
  answers: { a: { type: 'noul', noul: 0.5 } },
  usage: { input_tokens: 1, output_tokens: 1 },
};
const json = (b: unknown, status = 200, h: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers: h });

describe('review findings', () => {
  it('keeps the api key off enumerable state and out of inspection', () => {
    const p = new JevProvider({ backend: 'typesafe', apiKey: 'sk-very-secret' });
    expect(JSON.stringify(p)).not.toContain('sk-very-secret');
    expect(inspect(p, { depth: 5, showHidden: true })).not.toContain('sk-very-secret');
  });

  it('fails fast when Retry-After exceeds the cap instead of retrying early', async () => {
    const f = vi.fn(async () => json({}, 429, { 'retry-after': '60' }));
    const p = new JevProvider({
      backend: 'typesafe',
      apiKey: 'k',
      retryDelayMs: 0,
      fetch: f as never,
    });
    await expect(p.evaluate(req)).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining('60s'),
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('honors a Retry-After within the cap', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(json(good));
    const p = new JevProvider({
      backend: 'typesafe',
      apiKey: 'k',
      retryDelayMs: 0,
      fetch: f as never,
    });
    await expect(p.evaluate(req)).resolves.toBeDefined();
  });

  it('validates maxRetryWaitMs', () => {
    expect(() => new JevProvider({ backend: 'typesafe', apiKey: 'k', maxRetryWaitMs: -1 })).toThrow(
      /maxRetryWaitMs/,
    );
  });

  it('does not echo an upstream body in the error for non-JSON responses', async () => {
    const f = async () => new Response('<html>secret-upstream-detail</html>');
    const p = new JevProvider({ backend: 'typesafe', apiKey: 'k', fetch: f as never });
    const err = await p.evaluate(req).catch((e) => e);
    expect(err).toBeInstanceOf(JevContractError);
    expect(err.message).not.toContain('secret-upstream-detail');
  });

  it('exports JevHttpError for callers that branch on status', () => {
    expect(new JevHttpError(503, 'x').status).toBe(503);
  });
});
