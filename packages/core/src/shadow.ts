import { Logger } from '@nestjs/common';
import type { Decision } from './decision.js';
import { stableHash } from './stable-hash.js';
import type { Questions } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface ShadowReport<T> {
  name: string;
  agreed: boolean;
  legacy: T;
  /** Undefined when the shadow decision failed. */
  candidate?: T;
  error?: string;
  durationMs: number;
}

export interface ShadowOptions<T> {
  /** Label used in reports. */
  name: string;
  /** The behavior in production today. Its result is always what the caller gets. */
  legacy: () => T | Promise<T>;
  /** The decision being evaluated. Runs alongside; its result is only compared and reported. */
  candidate: () => T | Promise<T>;
  /** Defaults to structural equality. Override to compare only the field that matters. */
  equals?: (legacy: T, candidate: T) => boolean;
  /** How long the candidate may take before it counts as failed. Default 30000. */
  timeoutMs?: number;
  /**
   * Where reports go. Receives the full values. The default logs only agreement, timing and hashes
   * of both values, so personal data in them never reaches your logs.
   */
  report?: (report: ShadowReport<T>) => void | Promise<void>;
}

const logger = new Logger('DecisionsShadow');

/**
 * Run a decision beside existing logic without acting on it. The caller always receives the legacy
 * result. The shadow side can fail, hang, or disagree without affecting the response; every
 * outcome is reported. `shadow` resolves when the comparison is done, if a test or job wants it.
 *
 *   const { value } = await shadowRun({ name: 'triage', legacy: () => keywordRoute(t),
 *     candidate: () => triage.decide(t).then((r) => r.decision) });
 */
export async function shadowRun<T>(
  options: ShadowOptions<T>,
): Promise<{ value: T; shadow: Promise<ShadowReport<T>> }> {
  const started = Date.now();
  // Start the candidate before awaiting legacy so the two overlap instead of running in sequence.
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Candidate exceeded ${timeoutMs}ms.`)), timeoutMs);
  });
  const candidate = Promise.race([Promise.resolve().then(options.candidate), deadline]);
  deadline.catch(() => {});
  candidate.catch(() => {}); // handled below; prevents an unhandled rejection if legacy throws
  let value: T;
  try {
    value = await options.legacy();
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }

  const shadow = (async (): Promise<ShadowReport<T>> => {
    const equals = options.equals ?? ((a, b) => stableHash(a) === stableHash(b));
    let report: ShadowReport<T>;
    try {
      const c = await candidate;
      clearTimeout(timer);
      report = {
        name: options.name,
        agreed: equals(value, c),
        legacy: value,
        candidate: c,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      clearTimeout(timer);
      report = {
        name: options.name,
        agreed: false,
        legacy: value,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
    try {
      if (options.report) await options.report(report);
      else {
        logger.log(
          JSON.stringify({
            name: report.name,
            agreed: report.agreed,
            durationMs: report.durationMs,
            error: report.error,
            legacyHash: stableHash(report.legacy),
            candidateHash:
              report.candidate === undefined ? undefined : stableHash(report.candidate),
          }),
        );
      }
    } catch {
      // Reporting problems must never surface to the caller.
    }
    return report;
  })();
  return { value, shadow };
}

/**
 * A shadow candidate from a Decision. If the decision fell back, the provider was unavailable and
 * there is no judgment to compare, so the candidate fails with a clear message instead of being
 * counted as a disagreement.
 *
 *   shadowRun({ name, legacy, candidate: candidateFrom(triage, ticket) })
 */
export function candidateFrom<In, Out, Q extends Questions>(
  decision: Decision<In, Out, Q>,
  input: In,
): () => Promise<Out> {
  return async () => {
    const outcome = await decision.decide(input);
    if (outcome.result.fromFallback) {
      throw new Error('Candidate decision fell back (provider unavailable); not compared.');
    }
    return outcome.decision;
  };
}
