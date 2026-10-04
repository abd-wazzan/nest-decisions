import { Inject } from '@nestjs/common';
import { DecisionsService } from './decisions.service.js';
import { DecisionUnavailableError } from './errors.js';
import type { DecisionCost } from './provider.js';
import type { AnswersOf, Questions, State } from './types.js';

export type DecisionResult<Q extends Questions> =
  | {
      fromFallback: false;
      answers: AnswersOf<Q>;
      model: string;
      cost: DecisionCost;
      durationMs: number;
      cached: boolean;
      stateHash: string;
      raw?: { request: unknown; response: unknown };
    }
  | {
      fromFallback: true;
      error: DecisionUnavailableError;
      durationMs: number;
      stateHash: string;
    };

export interface DecisionOutcome<Out, Q extends Questions> {
  decision: Out;
  /** The redacted state that was sent to the provider (what a reviewer should see). */
  state: State;
  /** Everything behind the decision, kept for audit, calibration and replay. */
  result: DecisionResult<Q>;
}

/**
 * One decision = its questions, the state sent for them, and a pure policy over the answers.
 *
 *   class TicketTriage extends Decision<Ticket, Route, typeof questions> { ... }
 *
 * `fallback` decides what happens when the provider is unavailable. Leave it out to fail
 * closed: `decide` then throws DecisionUnavailableError.
 */
export abstract class Decision<In, Out, Q extends Questions> {
  @Inject(DecisionsService)
  protected readonly decisions!: DecisionsService;

  abstract readonly questions: Q;

  /** Pick exactly what the model should see. Keep it minimal; never spread a whole DTO. */
  abstract state(input: In): State | Promise<State>;

  /** Pure and synchronous, so it is trivially unit-testable. */
  abstract policy(answers: AnswersOf<Q>, input: In): Out;

  /**
   * Which per-key budget this call counts against (a tenant or user id). Used with
   * `budget.perKey`. Return undefined to count only against the global budget.
   */
  budgetKey?(input: In): string | undefined;

  /** Used when the provider is unavailable. Omit to fail closed. */
  fallback?(error: DecisionUnavailableError, input: In): Out;

  get name(): string {
    return this.constructor.name;
  }

  async decide(input: In): Promise<DecisionOutcome<Out, Q>> {
    if (!this.decisions) {
      throw new Error(
        `${this.name} must be created by Nest: add it to a module's providers and inject it. It cannot be built with \`new\`.`,
      );
    }
    // Prepared once: validated, redacted and normalized. Reviewers get exactly what the model saw.
    const state = this.decisions.prepareState(await this.state(input));
    try {
      const { result, stateHash, durationMs, cached } = await this.decisions.evaluate({
        decision: this.name,
        state,
        prepared: true,
        questions: this.questions,
        budgetKey: this.budgetKey?.(input),
      });
      const answers = result.answers as unknown as AnswersOf<Q>;
      let decision: Out;
      try {
        decision = this.policy(answers, input);
      } catch (error) {
        // The provider call was paid for; leave a record before surfacing the bug.
        await this.decisions.record({
          decision: this.name,
          stateHash,
          questionIds: Object.keys(this.questions),
          outcome: 'error',
          provider: this.decisions.providerName,
          model: result.model,
          cost: result.cost,
          durationMs,
          cached,
          error: `policy failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        throw error;
      }
      await this.decisions.record({
        decision: this.name,
        stateHash,
        questionIds: Object.keys(this.questions),
        outcome: 'decided',
        provider: this.decisions.providerName,
        model: result.model,
        cost: result.cost,
        durationMs,
        cached,
        answers: result.answers,
      });
      return {
        decision,
        state,
        result: {
          fromFallback: false,
          answers,
          model: result.model,
          cost: result.cost,
          durationMs,
          cached,
          stateHash,
          raw: result.raw,
        },
      };
    } catch (error) {
      if (!(error instanceof DecisionUnavailableError)) throw error;
      const stateHash = error.stateHash ?? '';
      const durationMs = error.durationMs ?? 0;
      const base = {
        decision: this.name,
        stateHash,
        questionIds: Object.keys(this.questions),
        provider: this.decisions.providerName,
        durationMs,
        error: error.message,
      };
      if (!this.fallback) {
        await this.decisions.record({ ...base, outcome: 'error' });
        throw error;
      }
      let decision: Out;
      try {
        decision = this.fallback(error, input);
      } catch (fallbackError) {
        await this.decisions.record({
          ...base,
          outcome: 'error',
          error: `fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        });
        throw fallbackError;
      }
      await this.decisions.record({ ...base, outcome: 'fallback' });
      return { decision, state, result: { fromFallback: true, error, durationMs, stateHash } };
    }
  }
}
