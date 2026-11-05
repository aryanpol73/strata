import type { ErrorCode } from '@strata/shared';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const forbidden = (message = 'You do not have permission to do that') => new AppError(403, 'FORBIDDEN', message);
export const unauthenticated = (message = 'Sign in to continue') => new AppError(401, 'UNAUTHENTICATED', message);
export const conflict = (message: string, code: ErrorCode = 'CONFLICT') => new AppError(409, code, message);
export const badRequest = (message: string, details?: unknown) => new AppError(400, 'VALIDATION', message, details);

/** Mongo duplicate-key errors drive idempotent retries, so they get a named check. */
export const isDuplicateKey = (err: unknown): boolean => (err as { code?: number })?.code === 11000;
