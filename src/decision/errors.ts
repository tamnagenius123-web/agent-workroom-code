// Caller mistakes (a question set that is not the point's fixed set, a bad threshold).
// These are not model answers and are not treated as "no".

export class DecisionInputError extends Error {
  readonly code: 'question_set' | 'threshold' | 'candidate' | 'hard_filter';

  constructor(code: DecisionInputError['code'], message: string) {
    super(message);
    this.name = 'DecisionInputError';
    this.code = code;
  }
}
