/**
 * Threshold calibration from labelled examples. Thresholds guessed by hand are the weakest part of
 * any decision; run a few dozen labelled cases through the model, then let these helpers show the
 * precision/recall tradeoff and pick cut-offs. All rules are "flag when p > threshold", the same
 * convention `verdictFromRisk` uses.
 */

export interface CalibrationSample {
  /** The model's probability for the class you want to flag (a Noul answer). */
  p: number;
  /** Ground truth: is this case really in that class? */
  positive: boolean;
}

export interface ThresholdStats {
  threshold: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  /** Share of flagged cases that were truly positive. 1 when nothing is flagged. */
  precision: number;
  /** Share of true positives that were flagged. 1 when there are no positives. */
  recall: number;
}

function check(samples: readonly CalibrationSample[]): void {
  if (samples.length === 0) throw new Error('Calibration needs at least one sample.');
  for (const s of samples) {
    if (!(s.p >= 0 && s.p <= 1)) throw new Error(`Sample probability out of range: ${s.p}`);
  }
}

export function evaluateThreshold(
  samples: readonly CalibrationSample[],
  threshold: number,
): ThresholdStats {
  check(samples);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const s of samples) {
    const flagged = s.p > threshold;
    if (flagged && s.positive) tp++;
    else if (flagged) fp++;
    else if (s.positive) fn++;
    else tn++;
  }
  return {
    threshold,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
  };
}

/** Candidate cut-offs: between every pair of distinct observed probabilities, plus 0 and 1. */
export function candidateThresholds(samples: readonly CalibrationSample[]): number[] {
  check(samples);
  const values = [...new Set(samples.map((s) => s.p))].sort((a, b) => a - b);
  const mids = values.slice(1).map((v, i) => ((values[i] as number) + v) / 2);
  return [...new Set([0, ...mids, 1])].sort((a, b) => a - b);
}

/** Every candidate threshold with its confusion counts, lowest first. Print it as a table. */
export function sweepThresholds(samples: readonly CalibrationSample[]): ThresholdStats[] {
  return candidateThresholds(samples).map((t) => evaluateThreshold(samples, t));
}

export interface SuggestOptions {
  /** Require at least this precision (e.g. 0.95 before auto-blocking). */
  minPrecision?: number;
  /** Require at least this recall (e.g. 0.9 before letting things through unreviewed). */
  minRecall?: number;
}

/**
 * Suggest a threshold. With `minPrecision`, returns the lowest threshold that still meets it
 * (most recall for that precision). With only `minRecall`, returns the highest threshold that
 * still meets it (most precision for that recall). Returns undefined when no threshold satisfies
 * every requirement: the model cannot separate your cases that well, so add review, not a cut-off.
 */
export function suggestThreshold(
  samples: readonly CalibrationSample[],
  options: SuggestOptions,
): ThresholdStats | undefined {
  const { minPrecision, minRecall } = options;
  if (minPrecision === undefined && minRecall === undefined) {
    throw new Error('Give minPrecision and/or minRecall.');
  }
  const sweep = sweepThresholds(samples);
  // A threshold that flags nothing has vacuous precision; it is never a useful suggestion.
  const ok = (s: ThresholdStats) =>
    (minPrecision === undefined ||
      (s.truePositives + s.falsePositives > 0 && s.precision >= minPrecision)) &&
    (minRecall === undefined || s.recall >= minRecall);
  const matching = sweep.filter(ok);
  if (matching.length === 0) return undefined;
  return minPrecision !== undefined ? matching[0] : matching[matching.length - 1];
}

export interface SuggestedBands {
  /** Use as `blockAbove`: precise enough to act without a human. */
  blockAbove: ThresholdStats;
  /** Use as `reviewAbove`: sensitive enough that little slips through unreviewed. */
  reviewAbove: ThresholdStats;
}

/**
 * Two-band suggestion for `verdictFromRisk`. Defaults: block only when precision >= 0.95, review
 * everything the model flags at recall >= 0.95. Returns undefined if either target is unreachable.
 */
export function suggestBands(
  samples: readonly CalibrationSample[],
  targets: { blockPrecision?: number; reviewRecall?: number } = {},
): SuggestedBands | undefined {
  const blockAbove = suggestThreshold(samples, { minPrecision: targets.blockPrecision ?? 0.95 });
  const reviewAbove = suggestThreshold(samples, { minRecall: targets.reviewRecall ?? 0.95 });
  if (!blockAbove || !reviewAbove) return undefined;
  // Bands must not cross: review starts at or below where blocking starts.
  return reviewAbove.threshold <= blockAbove.threshold
    ? { blockAbove, reviewAbove }
    : { blockAbove, reviewAbove: blockAbove };
}
