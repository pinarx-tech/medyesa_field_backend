export type ErrorCode =
  | 'validation_error'
  | 'unauthenticated'
  | 'forbidden'
  | 'no_company_scope'
  | 'account_inactive'
  | 'account_deleted'
  | 'not_found'
  | 'conflict'
  | 'business_rule_violation'
  | 'rate_limited'
  | 'internal_error'
  | 'not_implemented';

export interface FieldError {
  field: string;
  message: string;
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly fieldErrors?: FieldError[];
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    statusCode: number,
    message?: string,
    fieldErrors?: FieldError[],
    details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.fieldErrors = fieldErrors;
    this.details = details;
  }
}
