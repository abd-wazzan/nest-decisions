/** The content a decision is made about: a string, object, or array. */
export type State = string | Record<string, unknown> | unknown[];

/** What to ask about the state: a plain string, or an object separating question and data. */
export type Instructions = string | Record<string, unknown>;

export interface NoulCriteria {
  true?: string;
  false?: string;
}

/** Option id -> description. Use null when an option needs no detail. */
export type ChoiceCriteria = Record<string, string | null>;

/** Ordered level descriptions, low to high. */
export type ScoreCriteria = string[];

export interface NoulQuestion {
  type: 'noul';
  instructions: Instructions;
  criteria?: NoulCriteria;
}

export interface ChoiceQuestion<O extends string = string> {
  type: 'choice';
  instructions: Instructions;
  criteria: Record<O, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: Instructions;
  criteria: ScoreCriteria;
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Question ids are for your code; they carry no meaning to the model. */
export type Questions = Record<string, Question>;

export interface NoulAnswer {
  type: 'noul';
  /** Probability of yes: 0 is a strong no, 1 a strong yes, 0.5 uncertain. */
  noul: number;
}

export interface ChoiceAnswer<O extends string = string> {
  type: 'choice';
  /** The highest-probability option. Always one you defined. */
  choice: O;
  probabilities: Record<O, number>;
  /** How certain the model is, derived from the distribution shape (0 to 1). */
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  /** Probability-weighted position along the levels. May fall between levels. */
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** Infer the answer type a question returns. */
export type AnswerOf<Q> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion<infer O>
    ? ChoiceAnswer<O>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : never;

/** Typed question map -> typed answer map. */
export type AnswersOf<Q extends Questions> = { [K in keyof Q]: AnswerOf<Q[K]> };

/** Client-side limits, enforced before any request is sent. */
export const LIMITS = {
  MAX_CHOICE_OPTIONS: 255,
  MIN_SCORE_LEVELS: 2,
  MAX_SCORE_LEVELS: 10,
} as const;
