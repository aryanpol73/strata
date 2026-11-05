import { describe, expect, it } from 'vitest';
import { makeUser, useHarness } from './helpers.js';

// Redis-backed, which is how limits are shared between nodes in production.
const h = useHarness({ redis: true, rateLimits: true });

describe('rate limits', () => {
  it('limits guest link guessing', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      statuses.push((await h.api().post('/api/guest/redeem').send({ token: 'y'.repeat(43), displayName: 'X' })).status);
    }
    expect(statuses.filter((s) => s === 404)).toHaveLength(20);
    expect(statuses.at(-1)).toBe(429);
  });

  it('limits password guessing', async () => {
    const user = await makeUser(h);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      statuses.push((await h.api().post('/api/auth/login').send({ email: user.email, password: 'wrong password' })).status);
    }
    expect(statuses.at(-1)).toBe(429);
  });

  it('answers in the standard error shape', async () => {
    const res = await h.api().post('/api/guest/redeem').send({ token: 'y'.repeat(43), displayName: 'X' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});
