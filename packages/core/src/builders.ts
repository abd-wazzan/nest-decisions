import type {
  ChoiceQuestion,
  Instructions,
  NoulCriteria,
  NoulQuestion,
  ScoreCriteria,
  ScoreQuestion,
} from './types.js';

/** A yes/no question. The answer is the probability of yes. */
export function noul(instructions: Instructions, criteria?: NoulCriteria): NoulQuestion {
  return criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions };
}

/** Pick exactly one of your options. Option ids are inferred as a literal union. */
export function choice<const O extends string>(
  instructions: Instructions,
  criteria: Record<O, string | null>,
): ChoiceQuestion<O> {
  return { type: 'choice', instructions, criteria };
}

/** Grade on an ordered rubric of 2 to 10 levels, low to high. */
export function score(instructions: Instructions, criteria: ScoreCriteria): ScoreQuestion {
  return { type: 'score', instructions, criteria };
}
