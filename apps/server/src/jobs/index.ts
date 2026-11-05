import { Queue, Worker } from 'bullmq';
import { getEnv } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { connectRedis } from '../lib/redis.js';
import { compactBlock, setCompactionScheduler } from '../modules/blocks/service.js';
import { setSweepKick, sweep } from '../modules/delivery/service.js';

const QUEUE = 'strata';
const COMPACTION_DELAY_MS = 35_000;

export interface Jobs {
  stop(): Promise<void>;
}

/** Runs one sweep at a time here, with at most one more queued behind it. */
function makeSweeper() {
  let running = false;
  let again = false;
  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await sweep();
      } while (again);
    } catch (err) {
      logger.error({ err }, 'delivery sweep failed');
    } finally {
      running = false;
    }
  };
  return run;
}

function startLocal(): Jobs {
  const env = getEnv();
  logger.warn('REDIS_URL is not set: running background work on a local timer, for one node only');
  const run = makeSweeper();
  setSweepKick(() => void run());
  setCompactionScheduler((blockId) => {
    setTimeout(() => compactBlock(blockId).catch((err) => logger.error({ err }, 'compaction failed')), COMPACTION_DELAY_MS).unref();
  });
  const timer = setInterval(() => void run(), env.DELIVERY_SWEEP_SECONDS * 1000);
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
    },
  };
}

/**
 * Mongo holds the state and Redis provides the clock (ADR-7). If Redis loses every job, the next scheduled tick still
 * finds all due work, because what's due is a Mongo query rather than a job.
 */
export async function startJobs(role: 'all' | 'api' | 'worker'): Promise<Jobs> {
  const env = getEnv();
  if (!env.REDIS_URL) return startLocal();

  const queue = new Queue(QUEUE, { connection: connectRedis({ forBullMq: true })! });
  const run = makeSweeper();

  // Kicks stay in-process: the rows are already durable, so a lost kick only costs a wait for the next tick.
  setSweepKick(() => void run());
  setCompactionScheduler((blockId) => {
    queue
      .add('compact-block', { blockId }, { jobId: `compact-${blockId}`, delay: COMPACTION_DELAY_MS, removeOnComplete: true, removeOnFail: 100 })
      .catch((err) => logger.error({ err }, 'could not schedule compaction'));
  });

  let worker: Worker | undefined;
  if (role !== 'api') {
    await queue.upsertJobScheduler(
      'delivery-sweep',
      { every: env.DELIVERY_SWEEP_SECONDS * 1000 },
      { name: 'sweep', opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
    worker = new Worker(
      QUEUE,
      async (job) => {
        if (job.name === 'sweep') await run();
        else if (job.name === 'compact-block') await compactBlock((job.data as { blockId: string }).blockId);
      },
      { connection: connectRedis({ forBullMq: true })!, concurrency: 4 },
    );
    worker.on('failed', (job, err) => logger.error({ job: job?.name, err }, 'job failed'));
  }

  return {
    stop: async () => {
      await worker?.close();
      await queue.close();
    },
  };
}
