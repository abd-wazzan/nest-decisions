import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  type AnswersOf,
  Decision,
  DecisionGateGuard,
  DecisionReviewRequiredException,
  DecisionsModule,
  from,
  Gate,
  type GateOutput,
  noul,
  verdictFromRisk,
} from '../src';
import { stubProvider } from './helpers';

const questions = { bad: noul('Is it abusive?') };

@Injectable()
class AbuseCheck extends Decision<{ text: string }, GateOutput, typeof questions> {
  readonly questions = questions;
  state(i: { text: string }) {
    return { text: i.text };
  }
  policy(a: AnswersOf<typeof questions>): GateOutput {
    return verdictFromRisk(a.bad.noul, { blockAbove: 0.8, reviewAbove: 0.3 });
  }
}

// Handlers shaped like the three non-HTTP transports, each reading its input differently.
class Handlers {
  @Gate({ decision: AbuseCheck, input: (c) => from.rpcPayload(c) })
  onMessage(_data: { text: string }) {}

  @Gate({ decision: AbuseCheck, input: from.arg(1) })
  resolver(_root: unknown, _args: { text: string }, _ctx: unknown, _info: unknown) {}

  @Gate({ decision: AbuseCheck, input: from.arg(1) })
  onSocket(_client: unknown, _data: { text: string }) {}
}

async function guardFor(p: number | 'fail') {
  const provider = stubProvider(() => {
    if (p === 'fail') throw new Error('down');
    return { answers: { bad: { type: 'noul', noul: p } } };
  });
  const mod = await Test.createTestingModule({
    imports: [DecisionsModule.forRoot({ provider, audit: { record: () => {} } })],
    providers: [AbuseCheck, DecisionGateGuard],
  }).compile();
  return { guard: mod.get(DecisionGateGuard), provider };
}

const ctxFor = (method: keyof Handlers, args: unknown[], type: 'rpc' | 'graphql' | 'ws') => {
  const ctx = new ExecutionContextHost(args, Handlers, Handlers.prototype[method]);
  ctx.setType(type);
  return ctx;
};

const cases = [
  ['microservice (rpc)', 'onMessage', [{ text: 'hello' }, {}], 'rpc'],
  ['graphql resolver', 'resolver', [{}, { text: 'hello' }, {}, {}], 'graphql'],
  ['websocket', 'onSocket', [{}, { text: 'hello' }], 'ws'],
] as const;

describe.each(cases)('@Gate over %s', (_name, method, args, type) => {
  it('allows, queues for review, or blocks by verdict, and sends only the chosen state', async () => {
    const allow = await guardFor(0.05);
    expect(await allow.guard.canActivate(ctxFor(method, [...args], type))).toBe(true);
    expect(allow.provider.calls[0]?.state).toEqual({ text: 'hello' });

    const review = await guardFor(0.5);
    await expect(review.guard.canActivate(ctxFor(method, [...args], type))).rejects.toBeInstanceOf(
      DecisionReviewRequiredException,
    );

    const block = await guardFor(0.95);
    await expect(block.guard.canActivate(ctxFor(method, [...args], type))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('fails closed when the decision is unavailable', async () => {
    const { guard } = await guardFor('fail');
    await expect(guard.canActivate(ctxFor(method, [...args], type))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('@Gate on an unmarked handler', () => {
  it('lets the call through untouched', async () => {
    const { guard, provider } = await guardFor(0.99);
    class Plain {
      run() {}
    }
    const ctx = new ExecutionContextHost([], Plain, Plain.prototype.run);
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(provider.calls).toHaveLength(0);
  });
});
