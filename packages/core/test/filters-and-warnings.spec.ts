import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  HttpException,
  type INestApplication,
  Injectable,
  Logger,
  Post,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AnswersOf,
  Decision,
  DecisionReviewRequiredException,
  DecisionsModule,
  from,
  Gate,
  type GateOutput,
  noul,
} from '../src';
import { stubProvider } from './helpers';

const questions = { ok: noul('Fine?') };

@Injectable()
class ReviewAll extends Decision<{ text: string }, GateOutput, typeof questions> {
  readonly questions = questions;
  state(i: { text: string }) {
    return { text: i.text };
  }
  policy(_a: AnswersOf<typeof questions>): GateOutput {
    return 'review';
  }
}

@Controller()
class Api {
  @Gate({ decision: ReviewAll, input: (c) => from.httpBody(c) })
  @Post('go')
  go(@Body() _b: unknown) {
    return {};
  }
}

// A typical app-wide filter that wraps every error in an envelope.
@Catch()
class EnvelopeEverything implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    res.status(status).json({ error: true, message: 'wrapped' });
  }
}

// The same filter, but written the way the docs tell you to: review passes through untouched.
@Catch()
class EnvelopeUnlessReview implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (exception instanceof DecisionReviewRequiredException) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    res.status(status).json({ error: true, message: 'wrapped' });
  }
}

let app: INestApplication | undefined;
afterEach(async () => app?.close());

async function boot(filter: new () => ExceptionFilter) {
  const mod = await Test.createTestingModule({
    imports: [
      DecisionsModule.forRoot({
        provider: stubProvider(() => ({ answers: { ok: { type: 'noul', noul: 0.5 } } })),
        audit: { record: () => {} },
      }),
    ],
    controllers: [Api],
    providers: [ReviewAll, { provide: APP_FILTER, useClass: filter }],
  }).compile();
  app = mod.createNestApplication();
  await app.init();
}

describe('review responses and global exception filters', () => {
  it('a filter that wraps every error hides the review contract (why docs say to pass it through)', async () => {
    await boot(EnvelopeEverything);
    const res = await request(app?.getHttpServer()).post('/go').send({ text: 'x' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ error: true, message: 'wrapped' }); // contract lost
  });

  it('a filter that passes DecisionReviewRequiredException through keeps the contract', async () => {
    await boot(EnvelopeUnlessReview);
    const res = await request(app?.getHttpServer()).post('/go').send({ text: 'x' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'pending_review' });
    expect(typeof res.body.reviewId).toBe('string');
  });
});

describe('production warnings for in-memory defaults', () => {
  const build = (extra: Record<string, unknown>) =>
    Test.createTestingModule({
      imports: [
        DecisionsModule.forRoot({
          provider: stubProvider(() => ({ answers: {} })),
          audit: { record: () => {} },
          ...extra,
        }),
      ],
    }).compile();

  it('warns once about the default review queue and per-process budgets in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    await build({ budget: { maxCalls: 10 } });
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /in-memory review queue/.test(m))).toBe(true);
    expect(messages.some((m) => /per process/.test(m))).toBe(true);
    warn.mockRestore();
    vi.unstubAllEnvs();
  });

  it('is quiet outside production, and when a review queue is provided', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    await build({});
    vi.stubEnv('NODE_ENV', 'production');
    await build({ reviewQueue: { enqueue: async () => ({ id: 'x' }) } });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    vi.unstubAllEnvs();
  });
});
