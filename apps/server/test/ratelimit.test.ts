import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../src/lib/tokenBucket.js';
import { as, makeGroup, makeUser, socketFor, useHarness } from './helpers.js';

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

describe('socket budget', () => {
  it('allows a burst, refuses a flood, and recovers with time', () => {
    const bucket = new TokenBucket(3, 2);
    expect([bucket.take(0), bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([true, true, true, false]);
    expect(bucket.take(1000)).toBe(true);
    expect(bucket.take(1000)).toBe(true);
    expect(bucket.take(1000)).toBe(false);
  });

  it('refuses a flood of block updates on a live connection', async () => {
    const user = await makeUser(h);
    const room = await makeGroup(h, user, []);
    const created = await h.api().post(`/api/rooms/${room.id}/blocks`).set(as(user)).send({ type: 'checklist', clientMessageId: randomUUID(), data: { title: 'Flood' } });
    const socket = await socketFor(h, user.token);

    const results = await Promise.all(
      Array.from(
        { length: 120 },
        () =>
          new Promise<{ ok: boolean; code?: string }>((resolve) =>
            socket.emit('block:update', { blockId: created.body.block.id, update: new Uint8Array([0]), clientUpdateId: randomUUID() }, resolve),
          ),
      ),
    );
    expect(results.filter((r) => r.code === 'RATE_LIMITED').length).toBeGreaterThan(30);
  });
});
