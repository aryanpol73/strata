import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { checklist, type GuestLinkCreated, type MessageDTO, type RoomDTO } from '@strata/shared';
import { as, makeGroup, makeUser, nextEvent, record, send, sleep, socketFor, useHarness, type TestUser } from './helpers.js';

/**
 * The adversarial suite for the most important boundary in the product. A guest here is assumed to be actively
 * hostile: holding a valid token and trying everything else with it.
 */
const h = useHarness();

const PARENT_SECRET = 'PARENT-ONLY-acquisition-target';

let owner: TestUser;
let member: TestUser;
let parent: RoomDTO;
let other: RoomDTO;
let branch: RoomDTO;
let parentMessage: MessageDTO;

beforeEach(async () => {
  [owner, member] = await Promise.all([makeUser(h, 'Owner'), makeUser(h, 'Member')]);
  parent = await makeGroup(h, owner, [member], 'Parent');
  other = await makeGroup(h, owner, [member], 'Unrelated');
  parentMessage = await send(h, owner, parent.id, PARENT_SECRET);
  const res = await h.api().post(`/api/messages/${parentMessage.id}/branches`).set(as(owner)).send({ title: 'Vendor call', participantIds: [member.id] });
  branch = res.body.room;
});

async function link(extra: object = {}): Promise<GuestLinkCreated> {
  const res = await h.api().post(`/api/branches/${branch.id}/guest-links`).set(as(owner)).send({ label: 'Vendor', ...extra });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.link;
}

async function guest(extra: object = {}, redeem: object = {}) {
  const created = await link(extra);
  const res = await h.api().post('/api/guest/redeem').send({ token: created.token, displayName: 'Vic Vendor', ...redeem });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return {
    link: created,
    id: res.body.guest.id as string,
    token: res.body.accessToken as string,
    cookie: String(res.headers['set-cookie']?.[0]).split(';')[0]!,
    auth: { Authorization: `Bearer ${res.body.accessToken}` },
  };
}

describe('creating a link', () => {
  it('stores only a hash of the token', async () => {
    const created = await link();
    const { GuestCapability } = await import('../src/models/guests.js');
    const row = await GuestCapability.findById(created.id).lean();
    expect(JSON.stringify(row)).not.toContain(created.token);
  });

  it('never shows the token again', async () => {
    const created = await link();
    const res = await h.api().get(`/api/branches/${branch.id}/guest-links`).set(as(owner));
    expect(JSON.stringify(res.body)).not.toContain(created.token);
  });

  it('only works for a branch, and only for its participants', async () => {
    expect((await h.api().post(`/api/branches/${parent.id}/guest-links`).set(as(owner)).send({ label: 'x' })).status).toBe(400);
    const stranger = await makeUser(h);
    expect((await h.api().post(`/api/branches/${branch.id}/guest-links`).set(as(stranger)).send({ label: 'x' })).status).toBe(404);
  });

  it('caps the lifetime', async () => {
    const res = await h.api().post(`/api/branches/${branch.id}/guest-links`).set(as(owner)).send({ label: 'x', expiresInHours: 24 * 365 });
    expect(res.status).toBe(400);
  });
});

describe('redeeming', () => {
  it('rejects unknown tokens', async () => {
    const res = await h.api().post('/api/guest/redeem').send({ token: 'a'.repeat(43), displayName: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('GUEST_LINK_INVALID');
  });

  it('gives an identical answer for revoked, expired and unknown links', async () => {
    const revoked = await link();
    await h.api().delete(`/api/guest-links/${revoked.id}`).set(as(owner)).expect(204);
    const expired = await link();
    const { GuestCapability } = await import('../src/models/guests.js');
    await GuestCapability.updateOne({ _id: expired.id }, { expiresAt: new Date(Date.now() - 1000) });

    const bodies = await Promise.all(
      [revoked.token, expired.token, 'z'.repeat(43)].map(async (token) => {
        const res = await h.api().post('/api/guest/redeem').send({ token, displayName: 'X' });
        return JSON.stringify([res.status, res.body]);
      }),
    );
    expect(new Set(bodies).size).toBe(1);
  });

  it('requires the PIN and locks after repeated failures', async () => {
    const created = await link({ pin: '4417' });
    const attempt = (pin?: string) => h.api().post('/api/guest/redeem').send({ token: created.token, displayName: 'X', pin });

    expect((await attempt()).body.error.code).toBe('GUEST_PIN_REQUIRED');
    for (let i = 0; i < 4; i += 1) expect((await attempt('0000')).status).toBe(401);
    expect((await attempt('0000')).body.error.code).toBe('GUEST_PIN_LOCKED');
    // The right PIN doesn't help during the lockout.
    expect((await attempt('4417')).body.error.code).toBe('GUEST_PIN_LOCKED');
  });

  it('accepts the right PIN', async () => {
    const created = await link({ pin: '4417' });
    const res = await h.api().post('/api/guest/redeem').send({ token: created.token, displayName: 'X', pin: '4417' });
    expect(res.status).toBe(201);
  });

  it('sets a cookie scoped to the guest API', async () => {
    const created = await link();
    const res = await h.api().post('/api/guest/redeem').send({ token: created.token, displayName: 'X' });
    const cookie = String(res.headers['set-cookie']?.[0]);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/api\/guest/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });
});

describe('what a guest can do', () => {
  it('sees the branch and sends into it', async () => {
    const g = await guest();
    await send(h, member, branch.id, 'welcome');
    const page = await h.api().get('/api/guest/messages').set(g.auth);
    expect(JSON.stringify(page.body)).toContain('welcome');

    const sent = await h.api().post('/api/guest/messages').set(g.auth).send({ clientMessageId: randomUUID(), text: 'hello from outside' });
    expect(sent.status).toBe(201);
    expect(sent.body.message.sender).toMatchObject({ type: 'guest', name: 'Vic Vendor' });

    const seen = await h.api().get(`/api/rooms/${branch.id}/messages`).set(as(owner));
    expect(JSON.stringify(seen.body)).toContain('hello from outside');
  });

  it('retrying a guest send gives the same message', async () => {
    const g = await guest();
    const body = { clientMessageId: randomUUID(), text: 'once' };
    const [a, b] = await Promise.all([
      h.api().post('/api/guest/messages').set(g.auth).send(body),
      h.api().post('/api/guest/messages').set(g.auth).send(body),
    ]);
    expect(a.body.message.id).toBe(b.body.message.id);
  });

  it('honours read-only scope', async () => {
    const g = await guest({ scope: { write: false, blocks: false, canvas: false } });
    const res = await h.api().post('/api/guest/messages').set(g.auth).send({ clientMessageId: randomUUID(), text: 'hi' });
    expect(res.status).toBe(403);
  });

  it('notifies members when a guest writes, without tripping on the guest id', async () => {
    const g = await guest();
    const sent = await h.api().post('/api/guest/messages').set(g.auth).send({ clientMessageId: randomUUID(), text: 'ping' });
    const { Notification } = await import('../src/models/delivery.js');
    const rows = await Notification.find({ messageId: sent.body.message.id }).lean();
    expect(rows).toHaveLength(2);
  });
});

describe('isolation from the parent and everything else', () => {
  it('reveals no parent content or identifiers in the room view', async () => {
    const g = await guest();
    const res = await h.api().get('/api/guest/room').set(g.auth);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(PARENT_SECRET);
    expect(body).not.toContain(parent.id);
    expect(body).not.toContain(parentMessage.id);
    expect(body).not.toContain(owner.email);
    expect(body).not.toContain(owner.id);
    expect(res.body.room.participants.map((p: { name: string }) => p.name)).toContain('Owner');
  });

  it('reveals none of it in messages either', async () => {
    const g = await guest();
    const res = await h.api().get('/api/guest/messages').set(g.auth);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(PARENT_SECRET);
    expect(body).not.toContain(parent.id);
    expect(body).not.toContain(parentMessage.id);
  });

  it('a guest token is refused by every member endpoint', async () => {
    const g = await guest();
    const probes: [string, string][] = [
      ['get', '/api/users/me'],
      ['get', '/api/rooms'],
      ['get', `/api/rooms/${branch.id}`],
      ['get', `/api/rooms/${branch.id}/messages`],
      ['get', `/api/rooms/${branch.id}/sync?sinceRev=0`],
      ['get', `/api/rooms/${parent.id}/messages`],
      ['get', `/api/rooms/${other.id}/messages`],
      ['get', `/api/rooms/${parent.id}/branches`],
      ['get', `/api/rooms/${parent.id}/canvas`],
      ['get', `/api/messages/${parentMessage.id}/references`],
      ['get', '/api/search?q=acquisition'],
      ['get', `/api/users/${owner.id}`],
      ['get', '/api/users/search?q=owner'],
      ['get', '/api/auth/sessions'],
      ['get', '/api/notifications'],
      ['get', `/api/branches/${branch.id}/guest-links`],
      ['post', `/api/messages/${parentMessage.id}/branches`],
      ['post', `/api/messages/${parentMessage.id}/reactions`],
      ['post', `/api/branches/${branch.id}/resolve`],
      ['post', `/api/branches/${branch.id}/merge`],
      ['post', `/api/rooms/${parent.id}/messages`],
      ['post', '/api/media/sign'],
    ];
    for (const [method, path] of probes) {
      const res = await (h.api() as unknown as Record<string, (p: string) => import('supertest').Test>)[method]!(path).set(g.auth).send({});
      expect([path, res.status]).toEqual([path, 401]);
    }
  });

  it('a member token is refused by guest endpoints', async () => {
    expect((await h.api().get('/api/guest/room').set(as(owner))).status).toBe(401);
    expect((await h.api().get('/api/guest/messages').set(as(owner))).status).toBe(401);
  });

  it('parameters cannot redirect a guest to another room', async () => {
    const g = await guest();
    await send(h, owner, other.id, 'unrelated secret');
    const res = await h.api().get('/api/guest/messages').query({ roomId: other.id, room: parent.id }).set(g.auth);
    expect(JSON.stringify(res.body)).not.toContain('unrelated secret');
    expect(JSON.stringify(res.body)).not.toContain(PARENT_SECRET);

    const sent = await h.api().post('/api/guest/messages').set(g.auth).send({ clientMessageId: randomUUID(), text: 'x', roomId: other.id });
    expect(sent.body.message?.roomId ?? branch.id).toBe(branch.id);
  });

  it('cannot reply to a parent message, so nothing is pulled in by reference', async () => {
    const g = await guest();
    const res = await h.api().post('/api/guest/messages').set(g.auth).send({ clientMessageId: randomUUID(), text: 'x', replyToId: parentMessage.id });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(PARENT_SECRET);
  });

  it('cannot fetch files from other rooms', async () => {
    const g = await guest();
    const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
    const signed = await h.api().post('/api/media/sign').set(as(owner)).send({ roomId: parent.id, name: 'a.png', mime: 'image/png', bytes: PNG.length });
    await h.api().put(signed.body.url).set(as(owner)).set('content-type', 'application/octet-stream').send(PNG);
    await h.api().post(`/api/media/${signed.body.assetId}/complete`).set(as(owner)).send({});
    expect((await h.api().get(`/api/guest/media/${signed.body.assetId}/url`).set(g.auth)).status).toBe(404);
  });

  it('receives only allowlisted, sanitized socket events', async () => {
    const g = await guest();
    const socket = await socketFor(h, g.token);
    const log = record(socket);

    await send(h, owner, parent.id, 'parent chatter after join');
    await send(h, owner, other.id, 'unrelated chatter');
    await h.api().post(`/api/rooms/${branch.id}/read`).set(as(owner)).send({ seq: 1 });
    const heard = nextEvent<{ message: MessageDTO }>(socket, 'message:new');
    await send(h, owner, branch.id, 'branch message');
    const { message } = await heard;
    await sleep(120);

    expect(message.roomId).toBe(branch.id);
    const dump = JSON.stringify(log);
    expect(dump).not.toContain('parent chatter');
    expect(dump).not.toContain('unrelated chatter');
    expect(dump).not.toContain(parent.id);
    expect(new Set(log.map((e) => e.event))).toEqual(new Set(['message:new']));
  });

  it('sees neither nested branches nor their resolutions', async () => {
    const g = await guest();
    const seed = await send(h, owner, branch.id, 'seed');
    const nested = (await h.api().post(`/api/messages/${seed.id}/branches`).set(as(owner)).send({ title: 'Inner', participantIds: [] })).body.room;
    await h.api().post(`/api/branches/${nested.id}/resolve`).set(as(owner)).send({ summary: 'INNER-SECRET-SUMMARY' });
    await h.api().post(`/api/branches/${nested.id}/merge`).set(as(owner)).send({});

    const page = await h.api().get('/api/guest/messages').set(g.auth);
    const body = JSON.stringify(page.body);
    expect(body).not.toContain('INNER-SECRET-SUMMARY');
    expect(body).not.toContain(nested.id);
    const seen = page.body.messages.find((m: MessageDTO) => m.id === seed.id);
    expect(seen.branchCount).toBe(0);
  });

  it('cannot join a block from outside its room, or at all without the block scope', async () => {
    const create = async (roomId: string) =>
      (await h.api().post(`/api/rooms/${roomId}/blocks`).set(as(owner)).send({ type: 'checklist', clientMessageId: randomUUID(), data: { title: 'T', items: ['one'] } })).body.block;
    const inParent = await create(parent.id);
    const inBranch = await create(branch.id);

    const scoped = await guest({ scope: { write: true, blocks: true, canvas: false } });
    const socket = await socketFor(h, scoped.token);
    const join = (blockId: string) => new Promise<{ ok: boolean }>((resolve) => socket.emit('block:join', { blockId }, resolve));
    expect((await join(inBranch.id)).ok).toBe(true);
    expect((await join(inParent.id)).ok).toBe(false);

    const unscoped = await guest();
    const plain = await socketFor(h, unscoped.token);
    const result = await new Promise<{ ok: boolean }>((resolve) => plain.emit('block:join', { blockId: inBranch.id }, resolve));
    expect(result.ok).toBe(false);
  });

  it('masks blocks in messages without the block scope', async () => {
    await h.api().post(`/api/rooms/${branch.id}/blocks`).set(as(owner)).send({ type: 'checklist', clientMessageId: randomUUID(), data: { title: 'Hidden list' } });
    const g = await guest();
    const page = await h.api().get('/api/guest/messages').set(g.auth);
    expect(JSON.stringify(page.body)).not.toContain('Hidden list');
  });

  it('a guest edit obeys the block rules', async () => {
    const block = (await h.api().post(`/api/rooms/${branch.id}/blocks`).set(as(owner)).send({
      type: 'checklist',
      clientMessageId: randomUUID(),
      policy: 'creator',
      data: { title: 'Locked', items: [] },
    })).body.block;
    const g = await guest({ scope: { write: true, blocks: true, canvas: false } });
    const socket = await socketFor(h, g.token);
    const joined = await new Promise<{ ok: true; data: { diff: ArrayBuffer } }>((resolve) => socket.emit('block:join', { blockId: block.id }, resolve as never));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(joined.data.diff));
    const before = Y.encodeStateVector(doc);
    doc.getMap('meta').set('title', 'Vandalised');
    expect(checklist.summarize(doc).title).toBe('Vandalised');

    const result = await new Promise<{ ok: boolean }>((resolve) =>
      socket.emit('block:update', { blockId: block.id, update: Y.encodeStateAsUpdate(doc, before), clientUpdateId: randomUUID() }, resolve),
    );
    expect(result.ok).toBe(false);
  });

  it('gates the Canvas on its scope', async () => {
    const without = await guest();
    expect((await h.api().get('/api/guest/canvas').set(without.auth)).status).toBe(403);
    const withCanvas = await guest({ scope: { write: false, blocks: false, canvas: true } });
    const res = await h.api().get('/api/guest/canvas').set(withCanvas.auth);
    expect(res.status).toBe(200);
    expect(res.body.canvas.roomId).toBe(branch.id);
  });
});

describe('ending access', () => {
  it('revocation ends HTTP and socket access at once, with a valid token still in hand', async () => {
    const g = await guest();
    const socket = await socketFor(h, g.token);
    const notified = nextEvent(socket, 'session:revoked');
    const closed = new Promise((resolve) => socket.once('disconnect', resolve));

    await h.api().delete(`/api/guest-links/${g.link.id}`).set(as(owner)).expect(204);
    await notified;
    await closed;

    expect((await h.api().get('/api/guest/messages').set(g.auth)).status).toBe(401);
    await expect(socketFor(h, g.token)).rejects.toThrow();
    const renewed = await h.api().post('/api/guest/token').set('x-strata-client', 'web').set('Cookie', g.cookie);
    expect(renewed.status).toBe(401);
  });

  it('expiry ends access, with a valid token still in hand', async () => {
    const g = await guest();
    const { GuestCapability } = await import('../src/models/guests.js');
    await GuestCapability.updateOne({ _id: g.link.id }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await h.api().get('/api/guest/messages').set(g.auth)).status).toBe(401);
  });

  it('only the link creator or a branch manager can revoke', async () => {
    const created = await link();
    expect((await h.api().delete(`/api/guest-links/${created.id}`).set(as(member))).status).toBe(403);
    const stranger = await makeUser(h);
    expect((await h.api().delete(`/api/guest-links/${created.id}`).set(as(stranger))).status).toBe(404);
  });

  it('archiving the branch closes the bridge', async () => {
    const g = await guest();
    await h.api().post(`/api/branches/${branch.id}/archive`).set(as(owner)).expect(200);
    expect((await h.api().get('/api/guest/messages').set(g.auth)).status).toBe(401);
    const again = await h.api().post('/api/guest/redeem').send({ token: g.link.token, displayName: 'X' });
    expect(again.status).toBe(404);
  });

  it('resolving stops guest writes but keeps reading', async () => {
    const g = await guest();
    await h.api().post(`/api/branches/${branch.id}/resolve`).set(as(owner)).send({ summary: 'done' });
    const res = await h.api().post('/api/guest/messages').set(g.auth).send({ clientMessageId: randomUUID(), text: 'late' });
    expect(res.status).toBe(409);
    expect((await h.api().get('/api/guest/messages').set(g.auth)).status).toBe(200);
  });

  it('renews from the cookie, but only with the client header', async () => {
    const g = await guest();
    expect((await h.api().post('/api/guest/token').set('Cookie', g.cookie)).status).toBe(403);
    const res = await h.api().post('/api/guest/token').set('x-strata-client', 'web').set('Cookie', g.cookie);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('leaving ends only that guest', async () => {
    const [one, two] = [await guest(), await guest()];
    await h.api().post('/api/guest/leave').set(one.auth).expect(204);
    expect((await h.api().get('/api/guest/room').set(one.auth)).status).toBe(401);
    expect((await h.api().get('/api/guest/room').set(two.auth)).status).toBe(200);
  });
});
