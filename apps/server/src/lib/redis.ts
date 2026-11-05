import { Redis } from 'ioredis';
import { getEnv } from '../config/env.js';
import { logger } from './logger.js';

let shared: Redis | null | undefined;
const opened: Redis[] = [];

/** A new connection. Pub/sub and BullMQ blocking commands each need their own. */
export function connectRedis(options: { forBullMq?: boolean } = {}): Redis | null {
  const url = getEnv().REDIS_URL;
  if (!url) return null;
  const client = new Redis(url, {
    lazyConnect: false,
    // BullMQ requires this to be null on blocking connections.
    maxRetriesPerRequest: options.forBullMq ? null : 3,
  });
  client.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
  opened.push(client);
  return client;
}

export function getRedis(): Redis | null {
  if (shared === undefined) shared = connectRedis();
  return shared;
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled(opened.splice(0).map((c) => c.quit()));
  shared = undefined;
}
