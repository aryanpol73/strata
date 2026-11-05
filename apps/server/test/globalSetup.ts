import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';

const REDIS_PORT = 6390;

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

/**
 * Tests run against a real MongoDB and a real Redis. Set TEST_REDIS_URL to use your own, otherwise this starts the
 * binary from `.tools/redis`, or `redis-server` from PATH.
 */
async function startRedis(): Promise<ChildProcess | null> {
  if (process.env.TEST_REDIS_URL) return null;
  process.env.TEST_REDIS_URL = `redis://127.0.0.1:${REDIS_PORT}`;
  if (await portOpen(REDIS_PORT)) return null;

  const local = path.resolve(__dirname, '../../../.tools/redis/redis-server.exe');
  const binary = existsSync(local) ? local : 'redis-server';
  const child = spawn(binary, ['--port', String(REDIS_PORT), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) {
    if (await portOpen(REDIS_PORT)) return child;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Redis did not start. Install it, or set TEST_REDIS_URL.');
}

export default async function setup() {
  const mongo = await MongoMemoryServer.create();
  process.env.TEST_MONGO_URI = mongo.getUri();
  const redis = await startRedis();
  return async () => {
    await mongo.stop();
    redis?.kill();
  };
}
