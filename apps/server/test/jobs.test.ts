import { afterEach, expect, it, vi } from 'vitest';

const sweep = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('../src/modules/delivery/service.js', () => ({ sweep, setSweepKick: vi.fn() }));
vi.mock('../src/modules/blocks/service.js', () => ({ compactBlock: vi.fn(), setCompactionScheduler: vi.fn() }));

import { resetEnv } from '../src/config/env.js';
import { startJobs } from '../src/jobs/index.js';
import { closeRedis } from '../src/lib/redis.js';

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnv();
});

it('starts and keeps the delivery clock running with no Redis at all', async () => {
  const env = {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/jobs_test',
    REDIS_URL: 'redis://127.0.0.1:1',
    JWT_SECRET: 'a'.repeat(40),
    MEDIA_SIGNING_SECRET: 'b'.repeat(40),
    DELIVERY_SWEEP_SECONDS: '1',
    LOG_LEVEL: 'silent',
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  resetEnv();

  const jobs = await startJobs('all');
  await vi.waitFor(() => expect(sweep).toHaveBeenCalled(), { timeout: 3000 });
  await jobs.stop();
  await closeRedis();
});
