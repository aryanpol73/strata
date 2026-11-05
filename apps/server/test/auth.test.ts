import { describe, expect, it } from 'vitest';
import { as, makeUser, nextEvent, sleep, socketFor, useHarness } from './helpers.js';

const h = useHarness();
const web = { 'x-strata-client': 'web' };

describe('accounts', () => {
  it('never returns the password hash', async () => {
    const res = await h.api().post('/api/auth/register').send({
      email: 'hash@example.test',
      password: 'correct horse battery',
      displayName: 'H',
      handle: 'hash_user',
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
  });

  it('refuses a duplicate email', async () => {
    const user = await makeUser(h);
    const res = await h.api().post('/api/auth/register').send({
      email: user.email,
      password: 'correct horse battery',
      displayName: 'X',
      handle: 'another_one',
    });
    expect(res.status).toBe(409);
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const user = await makeUser(h);
    const wrong = await h.api().post('/api/auth/login').send({ email: user.email, password: 'wrong password here' });
    const unknown = await h.api().post('/api/auth/login').send({ email: 'nobody@example.test', password: 'wrong password here' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('rejects malformed input before it reaches the database', async () => {
    const res = await h.api().post('/api/auth/login').send({ email: { $gt: '' }, password: { $gt: '' } });
    expect(res.status).toBe(400);
  });
});

describe('refresh rotation', () => {
  it('sets a hardened cookie', async () => {
    const res = await h.api().post('/api/auth/login').send({ email: (await makeUser(h)).email, password: 'correct horse battery' });
    const cookie = String(res.headers['set-cookie']?.[0]);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/auth/);
  });

  it('issues a new token each time', async () => {
    const user = await makeUser(h);
    const res = await h.api().post('/api/auth/refresh').set(web).set('Cookie', user.cookie);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(String(res.headers['set-cookie']?.[0]).split(';')[0]).not.toBe(user.cookie);
  });

  it('refuses a refresh without the client header', async () => {
    const user = await makeUser(h);
    const res = await h.api().post('/api/auth/refresh').set('Cookie', user.cookie);
    expect(res.status).toBe(403);
  });

  it('tolerates a superseded token inside the grace window, without disturbing the cookie', async () => {
    const user = await makeUser(h);
    await h.api().post('/api/auth/refresh').set(web).set('Cookie', user.cookie);
    const racing = await h.api().post('/api/auth/refresh').set(web).set('Cookie', user.cookie);
    expect(racing.status).toBe(200);
    expect(racing.body.accessToken).toBeTruthy();
    expect(racing.headers['set-cookie']).toBeUndefined();
  });

  it('two tabs refreshing together both succeed, and exactly one rotates', async () => {
    const user = await makeUser(h);
    const results = await Promise.all(Array.from({ length: 6 }, () => h.api().post('/api/auth/refresh').set(web).set('Cookie', user.cookie)));
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));

    // A response that cleared or replaced the cookie is what used to sign people out.
    const cookies = results.flatMap((r) => (r.headers['set-cookie'] as unknown as string[] | undefined) ?? []);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).not.toMatch(/strata_rt=;/);

    const survivor = cookies[0]!.split(';')[0]!;
    const { DeviceSession } = await import('../src/models/identity.js');
    await DeviceSession.updateOne({ _id: user.sessionId }, { rotatedAt: new Date(Date.now() - 60_000) });
    expect((await h.api().post('/api/auth/refresh').set(web).set('Cookie', survivor)).status).toBe(200);
  });

  it('ends the session when a superseded token is replayed later', async () => {
    const user = await makeUser(h);
    const first = await h.api().post('/api/auth/refresh').set(web).set('Cookie', user.cookie);
    const { DeviceSession } = await import('../src/models/identity.js');
    await DeviceSession.updateOne({ _id: user.sessionId }, { rotatedAt: new Date(Date.now() - 60_000) });

    const replay = await h.api().post('/api/auth/refresh').set(web).set('Cookie', user.cookie);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('SESSION_REVOKED');

    // The thief's replay also kills what the legitimate client holds. That's the point.
    const legitimate = await h.api().post('/api/auth/refresh').set(web).set('Cookie', String(first.headers['set-cookie']?.[0]).split(';')[0]!);
    expect(legitimate.status).toBe(401);
    const api = await h.api().get('/api/users/me').set('Authorization', `Bearer ${first.body.accessToken}`);
    expect(api.status).toBe(401);
  });
});

describe('device sessions', () => {
  it('lists sessions and marks the current one', async () => {
    const user = await makeUser(h);
    await h.api().post('/api/auth/login').send({ email: user.email, password: 'correct horse battery', deviceName: 'Phone' });
    const res = await h.api().get('/api/auth/sessions').set(as(user));
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
  });

  it('revocation stops an unexpired token immediately and drops its sockets', async () => {
    const user = await makeUser(h);
    const other = await h.api().post('/api/auth/login').send({ email: user.email, password: 'correct horse battery' });
    const socket = await socketFor(h, other.body.accessToken);
    const revoked = nextEvent(socket, 'session:revoked');
    const closed = new Promise((resolve) => socket.once('disconnect', resolve));

    const res = await h.api().delete(`/api/auth/sessions/${other.body.sessionId}`).set(as(user));
    expect(res.status).toBe(204);
    await revoked;
    await closed;

    const after = await h.api().get('/api/users/me').set('Authorization', `Bearer ${other.body.accessToken}`);
    expect(after.status).toBe(401);
    const stillFine = await h.api().get('/api/users/me').set(as(user));
    expect(stillFine.status).toBe(200);
  });

  it("can't revoke someone else's session", async () => {
    const [a, b] = [await makeUser(h), await makeUser(h)];
    const res = await h.api().delete(`/api/auth/sessions/${b.sessionId}`).set(as(a));
    expect(res.status).toBe(404);
  });

  it('logout revokes the session', async () => {
    const user = await makeUser(h);
    await h.api().post('/api/auth/logout').set(web).set('Cookie', user.cookie);
    await sleep(10);
    expect((await h.api().get('/api/users/me').set(as(user))).status).toBe(401);
  });
});

describe('socket authentication', () => {
  it('refuses a connection with no token, or a forged one', async () => {
    await expect(socketFor(h, '')).rejects.toThrow();
    await expect(socketFor(h, 'not.a.token')).rejects.toThrow();
  });

  it('ignores a claimed identity and uses the token', async () => {
    const [a, b] = [await makeUser(h), await makeUser(h)];
    const { io } = await import('socket.io-client');
    const spoof = h.track(io(h.url, { auth: { token: a.token, userId: b.id }, query: { userId: b.id }, transports: ['websocket'], forceNew: true }));
    await new Promise((r) => spoof.once('connect', () => r(null)));
    await sleep(100);
    const sockets = await h.io.in(`user:${b.id}`).fetchSockets();
    expect(sockets).toHaveLength(0);
  });
});

describe('user privacy', () => {
  it('finds people by handle prefix only, without emails', async () => {
    const [a, b] = [await makeUser(h, 'Finder'), await makeUser(h, 'Findable')];
    const res = await h.api().get('/api/users/search').set(as(a)).query({ q: b.handle.slice(0, 8) });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(b.email);
    expect(res.body.users.some((u: { id: string }) => u.id === b.id)).toBe(true);
  });

  it('hides profiles from people who share no room', async () => {
    const [a, b] = [await makeUser(h), await makeUser(h)];
    expect((await h.api().get(`/api/users/${b.id}`).set(as(a))).status).toBe(404);
  });
});
