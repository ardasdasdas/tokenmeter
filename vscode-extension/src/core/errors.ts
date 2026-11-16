export type ErrorCode =
  | 'invalid'
  | 'gated'
  | 'not_found'
  | 'no_tokenizer'
  | 'network'
  | 'too_large'
  | 'corrupt'
  | 'internal';

export class TokenmeterError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'TokenmeterError';
    this.code = code;
  }
}
