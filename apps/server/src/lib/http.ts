import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError, badRequest } from './errors.js';
import { logger } from './logger.js';

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  throw badRequest(issues[0]?.message ?? 'Invalid request', issues);
}

/** Route params are strings or string arrays in Express 5 types. All of ours are single values. */
export const param = (req: Request, name: string): string => String(req.params[name]);

export const errorHandler: ErrorRequestHandler = (err, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  // Body parser failures carry a 4xx status of their own.
  const status = (err as { status?: number }).status;
  if (status && status >= 400 && status < 500) {
    res.status(status).json({ error: { code: 'VALIDATION', message: 'Malformed request' } });
    return;
  }
  logger.error({ err }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
};

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
};

/** Cookie-authenticated endpoints need this header. Cross-site forms can't set it, which closes off CSRF. */
export const requireClientHeader: RequestHandler = (req, _res, next) => {
  if (req.get('x-strata-client') !== 'web') throw new AppError(403, 'FORBIDDEN', 'Missing client header');
  next();
};
