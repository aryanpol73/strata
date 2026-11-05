import type { Request, RequestHandler } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { getEnv } from '../config/env.js';
import { AppError } from './errors.js';
import { getRedis } from './redis.js';

interface LimitOptions {
  name: string;
  windowSeconds: number;
  max: number;
  key?: (req: Request) => string | undefined;
}

const ipKey = (req: Request) => ipKeyGenerator(req.ip ?? 'unknown');

/** Built on first use, because the Redis store needs a live connection and env to be loaded. */
export function limiter({ name, windowSeconds, max, key }: LimitOptions): RequestHandler {
  let handler: RequestHandler | undefined;
  return (req, res, next) => {
    if (!getEnv().RATE_LIMITS_ENABLED) return next();
    handler ??= build();
    return handler(req, res, next);
  };

  function build(): RequestHandler {
    const redis = getRedis();
    return rateLimit({
      windowMs: windowSeconds * 1000,
      limit: max,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      // Limiters build on first use because the Redis store needs loaded config, so this check doesn't apply.
      validate: { creationStack: false },
      keyGenerator: (req) => `${name}:${key?.(req) ?? ipKey(req)}`,
      ...(redis
        ? {
            store: new RedisStore({
              prefix: 'rl:',
              sendCommand: (...args: string[]) =>
                redis.call(args[0]!, ...args.slice(1)) as Promise<RedisReply>,
            }),
          }
        : {}),
      handler: () => {
        throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.');
      },
    });
  }
}

export const limits = {
  login: limiter({ name: 'login', windowSeconds: 900, max: 10 }),
  register: limiter({ name: 'register', windowSeconds: 3600, max: 10 }),
  refresh: limiter({ name: 'refresh', windowSeconds: 60, max: 30 }),
  guestRedeem: limiter({ name: 'guest-redeem', windowSeconds: 900, max: 20 }),
  guestSend: limiter({ name: 'guest-send', windowSeconds: 60, max: 30, key: (req) => req.guest?.sessionId }),
  send: limiter({ name: 'send', windowSeconds: 60, max: 120, key: (req) => req.user?.id }),
  search: limiter({ name: 'search', windowSeconds: 60, max: 60, key: (req) => req.user?.id }),
  media: limiter({ name: 'media', windowSeconds: 60, max: 30, key: (req) => req.user?.id }),
  blockingAck: limiter({ name: 'blocking-ack', windowSeconds: 3600, max: 20, key: (req) => req.user?.id }),
};
