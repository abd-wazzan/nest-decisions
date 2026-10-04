import { describe, expect, it } from 'vitest';
import {
  type CalibrationSample,
  candidateThresholds,
  evaluateThreshold,
  suggestBands,
  suggestThreshold,
  sweepThresholds,
} from '../src';

const s = (p: number, positive: boolean): CalibrationSample => ({ p, positive });
const samples = [
  s(0.99, true),
  s(0.9, true),
  s(0.8, true),
  s(0.6, false),
  s(0.4, true),
  s(0.1, false),
  s(0.02, false),
];

describe('evaluateThreshold', () => {
  it('counts the confusion matrix using p > threshold', () => {
    const r = evaluateThreshold(samples, 0.7);
    expect(r).toMatchObject({
      truePositives: 3,
      falsePositives: 0,
      falseNegatives: 1,
      trueNegatives: 3,
    });
    expect(r.precision).toBe(1);
    expect(r.recall).toBeCloseTo(0.75);
  });

  it('is exclusive at the boundary', () => {
    expect(evaluateThreshold([s(0.5, true)], 0.5).truePositives).toBe(0);
  });

  it('handles nothing flagged and no positives', () => {
    expect(evaluateThreshold([s(0.1, true)], 0.9).precision).toBe(1);
    expect(evaluateThreshold([s(0.9, false)], 0.5).recall).toBe(1);
  });

  it('validates input', () => {
    expect(() => evaluateThreshold([], 0.5)).toThrow(/at least one/);
    expect(() => evaluateThreshold([s(1.2, true)], 0.5)).toThrow(/out of range/);
  });
});

describe('sweep and candidates', () => {
  it('uses midpoints plus 0 and 1, sorted and unique', () => {
    const c = candidateThresholds([s(0.2, true), s(0.4, false), s(0.4, true)]);
    expect(c).toHaveLength(3);
    expect(c[0]).toBe(0);
    expect(c[1]).toBeCloseTo(0.3);
    expect(c[2]).toBe(1);
    expect(sweepThresholds(samples).length).toBe(candidateThresholds(samples).length);
  });
});

describe('suggestThreshold', () => {
  it('finds the lowest threshold meeting a precision floor', () => {
    const r = suggestThreshold(samples, { minPrecision: 1 });
    expect(r?.precision).toBe(1);
    expect(r?.threshold).toBeCloseTo(0.7);
    expect(r?.recall).toBeCloseTo(0.75);
  });

  it('finds the highest threshold meeting a recall floor', () => {
    const r = suggestThreshold(samples, { minRecall: 1 });
    expect(r?.recall).toBe(1);
    expect(r?.threshold).toBeCloseTo(0.25);
  });

  it('combines both floors, or reports that none is reachable', () => {
    expect(suggestThreshold(samples, { minPrecision: 1, minRecall: 0.75 })?.threshold).toBeCloseTo(
      0.7,
    );
    expect(suggestThreshold(samples, { minPrecision: 1, minRecall: 1 })).toBeUndefined();
  });

  it('requires a target', () => {
    expect(() => suggestThreshold(samples, {})).toThrow(/minPrecision/);
  });
});

describe('suggestBands', () => {
  it('returns non-crossing block and review thresholds', () => {
    const bands = suggestBands(samples, { blockPrecision: 1, reviewRecall: 1 });
    expect(bands).toBeDefined();
    expect((bands?.reviewAbove.threshold ?? 1) <= (bands?.blockAbove.threshold ?? 0)).toBe(true);
  });

  it('is undefined when targets are unreachable', () => {
    const noisy = [s(0.9, false), s(0.8, true), s(0.7, false), s(0.2, true)];
    expect(suggestBands(noisy, { blockPrecision: 1, reviewRecall: 1 })).toBeUndefined();
  });

  it('clamps review up to block if they would cross', () => {
    const odd = [s(0.9, true), s(0.8, false), s(0.7, true), s(0.1, false)];
    const bands = suggestBands(odd, { blockPrecision: 1, reviewRecall: 0.5 });
    expect(bands && bands.reviewAbove.threshold <= bands.blockAbove.threshold).toBe(true);
  });
});
