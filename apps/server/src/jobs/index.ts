import { Queue, Worker } from 'bullmq';
import { getEnv } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { connectRedis } from '../lib/redis.js';
import { compactBlock, setCompactionScheduler } from '../modules/blocks/service.js';
import { setSweepKick, sweep } from '../modules/delivery/service.js';

const QUEUE = 'strata';
const COMPACTION_DELAY_MS = 35_000;
const CLOSE_WAIT_MS = 3000;

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

/** Closing waits on Redis, which may be gone, and shutdown can't wait forever. */
const within = (ms: number, work: Promise<unknown>) => Promise.race([work, new Promise((resolve) => setTimeout(resolve, ms).unref())]);

/**
 * The delivery clock is a plain timer, not a Redis job. Redis can lose everything at any moment, and a schedule kept
 * there would vanish with it and stop every deadline until a restart. What's due is a Mongo query and claims are atomic,
 * so several nodes can tick safely. Redis only carries compaction, which the next block update asks for again if lost.
 *
 * Nothing here waits for Redis, so the app can start while it's away.
 */
export async function startJobs(role: 'all' | 'api' | 'worker'): Promise<Jobs> {
  const env = getEnv();
  if (!env.REDIS_URL) return startLocal();

  const queue = new Queue(QUEUE, { connection: connectRedis({ background: true })! });
  queue.on('error', (err) => logger.warn({ err: err.message }, 'queue error'));
  const run = makeSweeper();

  // Kicks stay in-process: the rows are already durable, so a lost kick only costs a wait for the next tick.
  setSweepKick(() => void run());
  setCompactionScheduler((blockId) => {
    queue
      .add('compact-block', { blockId }, { jobId: `compact-${blockId}`, delay: COMPACTION_DELAY_MS, removeOnComplete: true, removeOnFail: 100 })
      .catch((err) => logger.error({ err }, 'could not schedule compaction'));
  });

  let worker: Worker | undefined;
  let timer: NodeJS.Timeout | undefined;
  if (role !== 'api') {
    timer = setInterval(() => void run(), env.DELIVERY_SWEEP_SECONDS * 1000);
    timer.unref();
    worker = new Worker(
      QUEUE,
      async (job) => {
        if (job.name === 'compact-block') await compactBlock((job.data as { blockId: string }).blockId);
      },
      { connection: connectRedis({ background: true })!, concurrency: 4 },
    );
    worker.on('failed', (job, err) => logger.error({ job: job?.name, err }, 'job failed'));
    worker.on('error', (err) => logger.warn({ err: err.message }, 'worker error'));
  }

  return {
    stop: async () => {
      clearInterval(timer);
      await within(CLOSE_WAIT_MS, Promise.allSettled([worker?.close(), queue.close()]));
    },
  };
}
