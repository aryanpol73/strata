import { createServer } from 'node:http';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { getEnv } from './config/env.js';
import { startJobs } from './jobs/index.js';
import { logger } from './lib/logger.js';
import { closeRedis } from './lib/redis.js';
import { createGateway } from './realtime/gateway.js';
import { hub } from './realtime/hub.js';

const MONGO_TIMEOUT_MS = 5000;

/** Connection errors can quote the address they failed on, password included. */
const withoutCredentials = (text: string) => text.replace(/\/\/[^@/\s]+@/g, '//***@');

// Libraries fire some Redis calls and forget them. One of those failing shouldn't end every open conversation.
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));

async function main() {
  const env = getEnv();
  // Fails requests in seconds during an outage. The free Atlas tier also has a connection limit to stay well under.
  mongoose.set('bufferTimeoutMS', MONGO_TIMEOUT_MS);
  await mongoose.connect(env.MONGODB_URI, { maxPoolSize: 10, serverSelectionTimeoutMS: MONGO_TIMEOUT_MS });
  logger.info('connected to MongoDB');

  const jobs = await startJobs(env.ROLE);

  if (env.ROLE === 'worker') {
    logger.info('worker running');
    process.once('SIGTERM', () => void jobs.stop().then(() => process.exit(0)));
    return;
  }

  const server = createServer(createApp());
  const io = createGateway(server);
  server.listen(env.PORT, () => logger.info({ port: env.PORT }, 'api listening'));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    hub.detach();
    await io.close();
    await jobs.stop();
    await closeRedis();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err: withoutCredentials(err instanceof Error ? err.message : String(err)) }, 'failed to start');
  process.exit(1);
});
