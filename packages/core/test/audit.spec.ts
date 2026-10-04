import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { LoggerAuditSink } from '../src';

describe('LoggerAuditSink', () => {
  it('writes one structured line per decision', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    new LoggerAuditSink().record({
      decision: 'D',
      stateHash: 'h',
      questionIds: ['q'],
      outcome: 'decided',
      provider: 'p',
      durationMs: 1,
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ decision: 'D' });
    log.mockRestore();
  });
});
