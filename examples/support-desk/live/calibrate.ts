/**
 * Opt-in live calibration: runs the labelled cases through the real API and prints the threshold
 * tradeoffs. Spends a few cents; never run by `pnpm test`. From the repo root:
 *   node --env-file=.env --import tsx examples/support-desk/live/calibrate.ts
 */
import 'reflect-metadata';
import {
  type CalibrationSample,
  type EvaluateResult,
  evaluateThreshold,
  type NoulAnswer,
  suggestBands,
  suggestThreshold,
} from '@nest-decisions/core';
import { JevProvider } from '@nest-decisions/provider-jev';
import { InjectionCheck, RefundCheck } from '../src/guards';
import { injectionCases, refundCases } from './data';

const apiKey = process.env.JEV_API_KEY;
if (!apiKey) throw new Error('Set JEV_API_KEY (e.g. via --env-file=.env).');
const provider = new JevProvider({ backend: 'typesafe', apiKey });

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

const noul = (r: EvaluateResult, id: string) => (r.answers[id] as NoulAnswer).noul;

function table(title: string, samples: CalibrationSample[], thresholds: number[]) {
  console.log(
    `\n${title}  (n=${samples.length}, positives=${samples.filter((s) => s.positive).length})`,
  );
  console.log('threshold  precision  recall  TP  FP  FN  TN');
  for (const t of thresholds) {
    const r = evaluateThreshold(samples, t);
    console.log(
      `${t.toFixed(2).padStart(9)}  ${r.precision.toFixed(2).padStart(9)}  ${r.recall.toFixed(2).padStart(6)}  ${String(r.truePositives).padStart(2)}  ${String(r.falsePositives).padStart(2)}  ${String(r.falseNegatives).padStart(2)}  ${String(r.trueNegatives).padStart(2)}`,
    );
  }
}

async function main() {
  const inj = new InjectionCheck();
  const injResults = await pool(injectionCases, 5, (c) =>
    provider.evaluate({ state: inj.state(c as never) as never, questions: inj.questions }),
  );
  const injSamples = injectionCases.map((c, i) => ({
    p: noul(injResults[i] as EvaluateResult, 'injection'),
    positive: c.positive,
  }));
  table(
    'INJECTION: flag when p(injection) > threshold',
    injSamples,
    [0.1, 0.3, 0.5, 0.7, 0.8, 0.85, 0.9, 0.95],
  );
  console.log('misses (attacks scored low) and false alarms (normal scored high):');
  injectionCases.forEach((c, i) => {
    const p = injSamples[i]?.p ?? 0;
    if ((c.positive && p < 0.8) || (!c.positive && p > 0.3)) {
      console.log(
        `  p=${p.toFixed(2)} ${c.positive ? 'ATTACK' : 'normal'}  ${c.message.slice(0, 70)}`,
      );
    }
  });
  console.log(
    'suggested bands (block precision>=0.95, review recall>=0.95):',
    (() => {
      const b = suggestBands(injSamples);
      return b
        ? `blockAbove=${b.blockAbove.threshold.toFixed(2)} reviewAbove=${b.reviewAbove.threshold.toFixed(2)}`
        : 'unreachable';
    })(),
  );

  const ref = new RefundCheck();
  const refResults = await pool(refundCases, 5, (c) =>
    provider.evaluate({
      state: ref.state({
        orderId: 'x',
        amount: 40,
        reason: c.reason,
        orderStatus: c.orderStatus,
      }) as never,
      questions: ref.questions,
    }),
  );
  const legitP = refundCases.map((c, i) => ({
    p: noul(refResults[i] as EvaluateResult, 'legit'),
    legit: c.legit,
  }));
  // Auto-approve: flag when p(legit) is high; the cost that matters is approving an illegitimate refund.
  const approve: CalibrationSample[] = legitP.map((x) => ({ p: x.p, positive: x.legit }));
  table(
    'REFUND approve: flag when p(legit) > threshold',
    approve,
    [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95],
  );
  // Auto-reject: flag when p(not legit) is high; the cost that matters is rejecting a real refund.
  const reject: CalibrationSample[] = legitP.map((x) => ({ p: 1 - x.p, positive: !x.legit }));
  table('REFUND reject: flag when 1-p(legit) > threshold', reject, [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]);
  console.log('legit refunds scored low / illegitimate scored high:');
  refundCases.forEach((c, i) => {
    const p = legitP[i]?.p ?? 0;
    if ((c.legit && p < 0.8) || (!c.legit && p > 0.3)) {
      console.log(
        `  p(legit)=${p.toFixed(2)} ${c.legit ? 'LEGIT' : 'not legit'}  ${c.reason.slice(0, 66)}`,
      );
    }
  });
  const a = suggestThreshold(approve, { minPrecision: 0.95 });
  const r = suggestThreshold(reject, { minPrecision: 0.95 });
  console.log(
    `suggested: allowAbove=${a ? a.threshold.toFixed(2) : 'unreachable'}  blockBelow=${r ? (1 - r.threshold).toFixed(2) : 'unreachable'}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
