import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { type ShadowReport, shadowRun } from '../src';

describe('shadowRun', () => {
  it('returns the legacy result and reports agreement', async () => {
    const reports: ShadowReport<{ q: string }>[] = [];
    const { value, shadow } = await shadowRun({
      name: 'triage',
      legacy: () => ({ q: 'billing' }),
      candidate: async () => ({ q: 'billing' }),
      report: (r) => void reports.push(r),
    });
    expect(value).toEqual({ q: 'billing' });
    expect((await shadow).agreed).toBe(true);
    expect(reports[0]).toMatchObject({ name: 'triage', agreed: true });
  });

  it('reports disagreement without changing the returned value', async () => {
    const { value, shadow } = await shadowRun({
      name: 'n',
      legacy: () => 'a',
      candidate: () => 'b',
      report: () => {},
    });
    expect(value).toBe('a');
    expect(await shadow).toMatchObject({ agreed: false, legacy: 'a', candidate: 'b' });
  });

  it('supports a custom comparison', async () => {
    const { shadow } = await shadowRun({
      name: 'n',
      legacy: () => ({ queue: 'x', note: 1 }),
      candidate: () => ({ queue: 'x', note: 2 }),
      equals: (a, b) => a.queue === b.queue,
      report: () => {},
    });
    expect((await shadow).agreed).toBe(true);
  });

  it('survives a failing candidate', async () => {
    const { value, shadow } = await shadowRun({
      name: 'n',
      legacy: () => 1,
      candidate: () => {
        throw new Error('provider down');
      },
      report: () => {},
    });
    expect(value).toBe(1);
    expect(await shadow).toMatchObject({ agreed: false, error: 'provider down' });
  });

  it('survives a non-Error rejection and a failing reporter', async () => {
    const { shadow } = await shadowRun({
      name: 'n',
      legacy: () => 1,
      candidate: () => Promise.reject('plain string'),
      report: () => {
        throw new Error('sink down');
      },
    });
    expect(await shadow).toMatchObject({ error: 'plain string' });
  });

  it('does not leave an unhandled rejection when legacy throws', async () => {
    await expect(
      shadowRun({
        name: 'n',
        legacy: () => {
          throw new Error('legacy broke');
        },
        candidate: () => Promise.reject(new Error('also broke')),
      }),
    ).rejects.toThrow('legacy broke');
  });

  it('logs through Nest when no reporter is given', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const { shadow } = await shadowRun({ name: 'logged', legacy: () => 1, candidate: () => 1 });
    await shadow;
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ name: 'logged' });
    log.mockRestore();
  });

  it('runs the candidate concurrently with legacy', async () => {
    const order: string[] = [];
    const { shadow } = await shadowRun({
      name: 'n',
      legacy: async () => {
        order.push('legacy-start');
        await new Promise((r) => setTimeout(r, 10));
        order.push('legacy-end');
        return 1;
      },
      candidate: async () => {
        order.push('candidate');
        return 1;
      },
      report: () => {},
    });
    await shadow;
    expect(order.indexOf('candidate')).toBeLessThan(order.indexOf('legacy-end'));
  });
});

describe('shadowRun privacy and timeouts', () => {
  it('logs hashes and agreement by default, never the values', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const { shadow } = await shadowRun({
      name: 'pii',
      legacy: () => ({ email: 'jane@example.com' }),
      candidate: () => ({ email: 'jane@example.com' }),
    });
    await shadow;
    const line = String(log.mock.calls.at(-1)?.[0]);
    expect(line).not.toContain('jane@example.com');
    expect(JSON.parse(line)).toMatchObject({ name: 'pii', agreed: true });
    expect(JSON.parse(line).legacyHash).toMatch(/^[0-9a-f]{64}$/);
    log.mockRestore();
  });

  it('treats a hung candidate as failed after the timeout', async () => {
    const { value, shadow } = await shadowRun({
      name: 'hung',
      legacy: () => 'ok',
      candidate: () => new Promise<string>(() => {}),
      timeoutMs: 20,
      report: () => {},
    });
    expect(value).toBe('ok');
    expect(await shadow).toMatchObject({ agreed: false, error: expect.stringContaining('20ms') });
  });
});
