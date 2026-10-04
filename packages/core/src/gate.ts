import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
  SetMetadata,
  type Type,
  UseGuards,
} from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import type { Decision } from './decision.js';
import { DecisionsService } from './decisions.service.js';
import { DecisionUnavailableError } from './errors.js';
import type { Questions } from './types.js';

export type Verdict = 'allow' | 'review' | 'block';
export type GateOutput = Verdict | { verdict: Verdict; reason?: string };

const isProbability = (p: unknown): p is number => typeof p === 'number' && p >= 0 && p <= 1;

/**
 * Thresholds for a "bad thing" probability (injection, fraud, abuse). Higher is worse. An invalid
 * probability (NaN, missing, out of range) is never allowed: it goes to review.
 */
export function verdictFromRisk(
  p: number,
  t: { blockAbove: number; reviewAbove: number },
): Verdict {
  if (t.blockAbove < t.reviewAbove) {
    throw new Error('blockAbove must be greater than or equal to reviewAbove.');
  }
  if (!isProbability(p)) return 'review';
  if (p > t.blockAbove) return 'block';
  if (p > t.reviewAbove) return 'review';
  return 'allow';
}

/**
 * Thresholds for a "good thing" probability (legitimate request). Higher is better. An invalid
 * probability goes to review, the same as verdictFromRisk.
 */
export function verdictFromTrust(
  p: number,
  t: { allowAbove: number; reviewAbove: number },
): Verdict {
  if (t.allowAbove < t.reviewAbove) {
    throw new Error('allowAbove must be greater than or equal to reviewAbove.');
  }
  if (!isProbability(p)) return 'review';
  if (p > t.allowAbove) return 'allow';
  if (p >= t.reviewAbove) return 'review';
  return 'block';
}

/**
 * The request was not run and has been queued for a human. HTTP 202 by default (accepted, not
 * completed); the body `{ status: 'pending_review', reviewId }` is a stable contract. A global
 * exception filter must let this exception through unchanged.
 */
export class DecisionReviewRequiredException extends HttpException {
  constructor(
    readonly reviewId: string,
    status: number = HttpStatus.ACCEPTED,
  ) {
    super({ status: 'pending_review', reviewId }, status);
  }
}

/** Why a gate refused to run the handler. Map it to your transport's error with `exceptionFactory`. */
export type GateDenial =
  | { kind: 'review'; reviewId: string; reason?: string }
  | { kind: 'block' }
  | { kind: 'unavailable'; message: string };

export interface GateOptions<In> {
  /** A Decision whose output is a Verdict. Must be provided somewhere in your modules. */
  decision: Type<Decision<In, GateOutput, Questions>>;
  /** Build the decision's input from the call. Required: nothing is sent by default. */
  input: (context: ExecutionContext) => In | Promise<In>;
  /**
   * What goes into the review queue. Defaults to the redacted state the model saw, so reviewers
   * (and the queue's storage) do not receive the raw request. Return more only if they need it.
   */
  reviewPayload?: (input: In) => unknown;
  /**
   * A decision that fell back normally fails closed here: a fallback verdict of `allow` answers 503
   * instead of running the handler. Set this only when running the handler during an outage is
   * exactly what you want. A fallback `review` or `block` is always honored.
   */
  allowOnFallback?: boolean;
  /** HTTP status for a request held for review. Default 202. */
  reviewStatus?: number;
  /**
   * Build the error to throw for a denial. The default throws HTTP exceptions, which Nest's HTTP
   * and GraphQL layers render correctly. For microservices or websockets return an `RpcException`
   * or `WsException` here, because those transports turn an HttpException into a generic 500.
   */
  exceptionFactory?: (denial: GateDenial) => Error;
}

const GATE_KEY = 'nest-decisions:gate';

/** Input helpers for common transports. The Decision's own `state()` still picks what is sent. */
export const from = {
  httpBody: <T = unknown>(context: ExecutionContext): T => context.switchToHttp().getRequest().body,
  httpQuery: <T = unknown>(context: ExecutionContext): T =>
    context.switchToHttp().getRequest().query,
  rpcPayload: <T = unknown>(context: ExecutionContext): T => context.switchToRpc().getData(),
  /** The nth handler argument, which is the GraphQL args object for resolvers or any arg elsewhere. */
  arg:
    <T = unknown>(index: number) =>
    (context: ExecutionContext): T =>
      context.getArgs()[index],
};

/**
 * Gate a handler (or a whole controller) on a decision:
 *   allow  -> the handler runs
 *   review -> the request is queued for a human and answered with 202; the handler does not run
 *   block  -> 403
 * If the decision cannot be made and has no fallback, the request fails closed with 503.
 *
 *   @Gate({ decision: RefundCheck, input: (c) => ({ ...from.httpBody(c), user: ... }) })
 *   @Post('refund') refund(@Body() dto: RefundDto) { ... }
 */
export function Gate<In>(options: GateOptions<In>): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(GATE_KEY, options), UseGuards(DecisionGateGuard));
}

@Injectable()
export class DecisionGateGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    @Inject(DecisionsService) private readonly decisions: DecisionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<GateOptions<unknown> | undefined>(GATE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return true;

    const decision = this.moduleRef.get(options.decision, { strict: false });
    const input = await options.input(context);
    const deny = (denial: GateDenial): never => {
      throw options.exceptionFactory
        ? options.exceptionFactory(denial)
        : defaultDenial(denial, options.reviewStatus);
    };
    const failClosed = (message = 'Decision service unavailable.'): never =>
      deny({ kind: 'unavailable', message });

    let outcome: Awaited<ReturnType<typeof decision.decide>>;
    try {
      outcome = await decision.decide(input);
    } catch (error) {
      if (error instanceof DecisionUnavailableError) return failClosed();
      throw error;
    }

    const base = {
      decision: decision.name,
      stateHash: outcome.result.stateHash,
      questionIds: Object.keys(decision.questions),
      provider: this.decisions.providerName,
      durationMs: outcome.result.durationMs,
    };
    const parsed = parseVerdict(outcome.decision);
    if (!parsed) {
      await this.decisions.record({
        ...base,
        outcome: 'error',
        error: 'Policy returned an invalid gate verdict (expected allow, review or block).',
      });
      return failClosed();
    }
    if (outcome.result.fromFallback && parsed.verdict === 'allow' && !options.allowOnFallback) {
      await this.decisions.record({
        ...base,
        outcome: 'error',
        error: 'Fallback returned allow; refused because the gate does not set allowOnFallback.',
      });
      return failClosed();
    }
    await this.decisions.record({
      ...base,
      outcome: 'gated',
      verdict: parsed.verdict,
      cached: outcome.result.fromFallback ? undefined : outcome.result.cached,
    });

    if (parsed.verdict === 'allow') return true;
    if (parsed.verdict === 'review') {
      let id: string;
      try {
        // Default: exactly the redacted state the model saw, computed once by the decision.
        const payload = options.reviewPayload ? options.reviewPayload(input) : outcome.state;
        ({ id } = await this.decisions.reviewQueue.enqueue({
          decision: decision.name,
          payload,
          reason: parsed.reason,
        }));
      } catch {
        // If a human cannot be asked, do not let the request through.
        return failClosed('Review queue unavailable.');
      }
      return deny({ kind: 'review', reviewId: id, reason: parsed.reason });
    }
    // The model's reason stays server-side; callers get a generic message.
    return deny({ kind: 'block' });
  }
}

const VERDICTS: readonly string[] = ['allow', 'review', 'block'];

function parseVerdict(output: unknown): { verdict: Verdict; reason?: string } | undefined {
  if (typeof output === 'string') {
    return VERDICTS.includes(output) ? { verdict: output as Verdict } : undefined;
  }
  if (output !== null && typeof output === 'object') {
    const { verdict, reason } = output as { verdict?: unknown; reason?: unknown };
    if (typeof verdict === 'string' && VERDICTS.includes(verdict)) {
      return {
        verdict: verdict as Verdict,
        reason: typeof reason === 'string' ? reason : undefined,
      };
    }
  }
  return undefined;
}

function defaultDenial(denial: GateDenial, reviewStatus?: number): Error {
  switch (denial.kind) {
    case 'review':
      return new DecisionReviewRequiredException(denial.reviewId, reviewStatus);
    case 'block':
      return new ForbiddenException('Request blocked by policy.');
    case 'unavailable':
      return new ServiceUnavailableException(denial.message);
  }
}
