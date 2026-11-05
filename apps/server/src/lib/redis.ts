import { Redis } from 'ioredis';
import { getEnv } from '../config/env.js';
import { logger } from './logger.js';

const COMMAND_TIMEOUT_MS = 1000;

let shared: Redis | null | undefined;
const opened: Redis[] = [];

/** A new connection. Pub/sub and BullMQ blocking commands each need their own. */
export function connectRedis(options: { background?: boolean } = {}): Redis | null {
  const url = getEnv().REDIS_URL;
  if (!url) return null;
  const client = new Redis(url, {
    lazyConnect: false,
    // Background clients wait for Redis to return. BullMQ requires that, and the Socket.IO adapter publishes without
    // handling failure, so a rejected publish would take the process down.
    maxRetriesPerRequest: options.background ? null : 1,
    // Requests wait on the other commands, so a missing Redis has to fail quickly instead of queueing them.
    ...(options.background ? {} : { commandTimeout: COMMAND_TIMEOUT_MS }),
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
  await Promise.allSettled(opened.splice(0).map((c) => (c.status === 'ready' ? c.quit() : c.disconnect())));
  shared = undefined;
}
