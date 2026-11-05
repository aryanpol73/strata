/**
 * Runs MongoDB and Redis for local development, for machines without Docker. Data persists in `.data/`.
 * With Docker, `docker compose up -d mongo redis` does the same job.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';

const root = path.resolve(import.meta.dirname, '../../..');
const dbPath = path.join(root, '.data/mongo');
mkdirSync(dbPath, { recursive: true });

const mongo = await MongoMemoryServer.create({
  instance: { port: 27017, ip: '127.0.0.1', dbPath, storageEngine: 'wiredTiger' },
});
console.log(`MongoDB ready at ${mongo.getUri()}`);

const local = path.join(root, '.tools/redis/redis-server.exe');
const redis = spawn(existsSync(local) ? local : 'redis-server', ['--port', '6379', '--save', '60', '1'], {
  cwd: path.join(root, '.data'),
  stdio: ['ignore', 'ignore', 'inherit'],
});
redis.on('error', () => console.error('Redis could not start. See docs/07-deployment.md for how to install it.'));
console.log('Redis ready at redis://127.0.0.1:6379');

const stop = async () => {
  redis.kill();
  await mongo.stop({ doCleanup: false });
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
