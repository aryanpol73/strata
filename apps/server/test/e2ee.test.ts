import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MessageDTO, RoomDTO, RoomKeysDTO } from '@strata/shared';
import { as, makeGroup, makeUser, nextEvent, socketFor, useHarness, type TestUser } from './helpers.js';

/**
 * The server never sees keys or plaintext, so these tests use random bytes where a browser would use real ciphertext.
 * What's under test is everything the server is responsible for: who may hold keys, what it will store, and what it
 * refuses to accept.
 */
const h = useHarness();

const b64 = (bytes: number) => randomBytes(bytes).toString('base64url');
const publicKey = () => b64(65);
const backup = () => ({ salt: b64(16), iter: 600_000, iv: b64(12), ct: b64(300) });
const wrapped = () => ({ epk: b64(65), iv: b64(12), ct: b64(48) });
const body = (kv = 1) => ({ type: 'encrypted', v: 1, kv, iv: b64(12), ct: b64(40) });

async function enable(u: TestUser, key = publicKey()) {
  const res = await h.api().put('/api/e2ee/me').set(as(u)).send({ publicKey: key, backup: backup() });
  expect(res.status).toBe(200);
  return key;
}

async function keys(u: TestUser, roomId: string): Promise<RoomKeysDTO> {
  return (await h.api().get(`/api/e2ee/rooms/${roomId}`).set(as(u))).body;
}

const post = (u: TestUser, roomId: string, payload: object) => h.api().post(`/api/e2ee/rooms/${roomId}/keys`).set(as(u)).send(payload);
const say = (u: TestUser, roomId: string, content: object) =>
  h.api().post(`/api/rooms/${roomId}/messages`).set(as(u)).send({ clientMessageId: randomUUID(), content });

let ada: TestUser;
let bo: TestUser;
let cy: TestUser;
let room: RoomDTO;

beforeEach(async () => {
  [ada, bo, cy] = await Promise.all([makeUser(h, 'Ada'), makeUser(h, 'Bo'), makeUser(h, 'Cy')]);
  await Promise.all([enable(ada), enable(bo)]);
  room = await makeGroup(h, ada, [bo, cy], 'Secret Plans');
});

describe('identity', () => {
  it('stores a public key and a protected backup, and only ever returns them to their owner', async () => {
    const me = await h.api().get('/api/e2ee/me').set(as(ada));
    expect(me.body.backup.iter).toBe(600_000);
    const self = await h.api().get('/api/users/me').set(as(ada));
    expect(self.body.user.e2ee).toMatchObject({ hasBackup: true });
    expect(JSON.stringify(self.body)).not.toContain(me.body.backup.ct);
    expect((await h.api().get('/api/e2ee/me').set(as(cy))).status).toBe(404);
  });

  it('refuses a backup that could be brute-forced cheaply', async () => {
    const res = await h.api().put('/api/e2ee/me').set(as(cy)).send({ publicKey: publicKey(), backup: { ...backup(), iter: 1000 } });
    expect(res.status).toBe(400);
  });

  it('drops every room key sealed to a replaced identity', async () => {
    await post(ada, room.id, { newVersion: 1, wraps: [{ userId: ada.id, version: 1, wrapped: wrapped() }, { userId: bo.id, version: 1, wrapped: wrapped() }] });
    expect((await keys(bo, room.id)).mine).toHaveLength(1);
    await enable(bo, publicKey());
    expect((await keys(bo, room.id)).mine).toHaveLength(0);
    expect((await keys(ada, room.id)).mine).toHaveLength(1);
  });

  it('tells the people in a room when someone\'s keys change', async () => {
    const socket = await socketFor(h, ada.token);
    const heard = nextEvent(socket, 'keys:updated');
    await enable(bo, publicKey());
    expect(await heard).toMatchObject({ roomId: room.id });
  });
});

describe('which conversations are encrypted', () => {
  it('encrypts rooms started by someone with encryption set up, and not otherwise', async () => {
    expect(room.encryption).toEqual({ enabled: true, keyVersion: 0, needsRotation: false });
    const plain = await makeGroup(h, cy, [ada], 'Plain');
    expect(plain.encryption.enabled).toBe(false);
    const direct = await h.api().post('/api/rooms/direct').set(as(ada)).send({ userId: bo.id });
    expect(direct.body.room.encryption.enabled).toBe(true);
  });

  it('lists who can already be sent a key, and who has not set up yet', async () => {
    const state = await keys(ada, room.id);
    const byId = Object.fromEntries(state.members.map((m) => [m.userId, m]));
    expect(byId[ada.id]?.publicKey).toBeTruthy();
    expect(byId[cy.id]?.publicKey).toBeNull();
  });

  it('gives branches the same protection, unless guests are wanted', async () => {
    const seed = await h.api().post(`/api/rooms/${room.id}/messages`).set(as(ada));
    void seed;
    await post(ada, room.id, { newVersion: 1, wraps: [{ userId: ada.id, version: 1, wrapped: wrapped() }] });
    const first = (await say(ada, room.id, body())).body.message as MessageDTO;

    const sealed = await h.api().post(`/api/messages/${first.id}/branches`).set(as(ada)).send({ title: 'Quiet', participantIds: [bo.id] });
    expect(sealed.body.room.encryption.enabled).toBe(true);
    const open = await h.api().post(`/api/messages/${first.id}/branches`).set(as(ada)).send({ title: 'With a vendor', participantIds: [bo.id], encrypted: false });
    expect(open.body.room.encryption.enabled).toBe(false);
  });

  it('will not invite a guest to an encrypted branch, because they could not read it', async () => {
    await post(ada, room.id, { newVersion: 1, wraps: [{ userId: ada.id, version: 1, wrapped: wrapped() }] });
    const first = (await say(ada, room.id, body())).body.message as MessageDTO;
    const sealed = (await h.api().post(`/api/messages/${first.id}/branches`).set(as(ada)).send({ title: 'Quiet', participantIds: [bo.id] })).body.room;
    const res = await h.api().post(`/api/branches/${sealed.id}/guest-links`).set(as(ada)).send({ label: 'Vendor' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/encrypted/);
  });
});

describe('room keys', () => {
  const both = (v = 1) => [
    { userId: ada.id, version: v, wrapped: wrapped() },
    { userId: bo.id, version: v, wrapped: wrapped() },
  ];

  it('lets one member start version one, and sends everyone else to use that key', async () => {
    const [first, second] = await Promise.all([post(ada, room.id, { newVersion: 1, wraps: both() }), post(bo, room.id, { newVersion: 1, wraps: [{ userId: bo.id, version: 1, wrapped: wrapped() }] })]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect((await keys(ada, room.id)).version).toBe(1);
  });

  it('hands each member only their own sealed copy', async () => {
    await post(ada, room.id, { newVersion: 1, wraps: both() });
    const mine = await keys(bo, room.id);
    expect(mine.mine).toHaveLength(1);
    expect(mine.mine[0]!.version).toBe(1);
    expect(mine.members.find((m) => m.userId === ada.id)?.versions).toEqual([1]);
  });

  it('needs the creator to hold a copy of their own new version', async () => {
    const res = await post(ada, room.id, { newVersion: 1, wraps: [{ userId: bo.id, version: 1, wrapped: wrapped() }] });
    expect(res.status).toBe(400);
    expect((await keys(ada, room.id)).version).toBe(0);
  });

  it('refuses keys for strangers, for versions that do not exist, and from non-members', async () => {
    await post(ada, room.id, { newVersion: 1, wraps: both() });
    const outsider = await makeUser(h, 'Outsider');
    expect((await post(ada, room.id, { wraps: [{ userId: outsider.id, version: 1, wrapped: wrapped() }] })).status).toBe(400);
    expect((await post(ada, room.id, { wraps: [{ userId: bo.id, version: 7, wrapped: wrapped() }] })).status).toBe(400);
    expect((await post(outsider, room.id, { wraps: [{ userId: outsider.id, version: 1, wrapped: wrapped() }] })).status).toBe(404);
    expect((await h.api().get(`/api/e2ee/rooms/${room.id}`).set(as(outsider))).status).toBe(404);
  });

  it('never overwrites a key that was already shared', async () => {
    await post(ada, room.id, { newVersion: 1, wraps: both() });
    const original = (await keys(bo, room.id)).mine[0]!.wrapped;
    await post(ada, room.id, { wraps: [{ userId: bo.id, version: 1, wrapped: wrapped() }] });
    expect((await keys(bo, room.id)).mine[0]!.wrapped).toEqual(original);
  });

  it('lets a member share the existing key with someone who joined later', async () => {
    await post(ada, room.id, { newVersion: 1, wraps: both() });
    await enable(cy);
    expect((await post(bo, room.id, { wraps: [{ userId: cy.id, version: 1, wrapped: wrapped() }] })).status).toBe(200);
    expect((await keys(cy, room.id)).mine).toHaveLength(1);
  });

  it('finishes a key version whose creator died before storing any copies', async () => {
    await post(ada, room.id, { newVersion: 1, wraps: both() });
    const { Room } = await import('../src/models/rooms.js');
    const { RoomKey } = await import('../src/models/e2ee.js');
    await Room.updateOne({ _id: room.id }, { keyVersion: 2 });
    expect((await post(bo, room.id, { newVersion: 2, wraps: [{ userId: bo.id, version: 2, wrapped: wrapped() }] })).status).toBe(200);
    expect(await RoomKey.countDocuments({ roomId: room.id, version: 2 })).toBe(1);
  });

  it('asks for a new key when someone leaves, and takes their copies away', async () => {
    await post(ada, room.id, { newVersion: 1, wraps: [...both(), { userId: cy.id, version: 1, wrapped: wrapped() }] });
    const left = await h.api().delete(`/api/rooms/${room.id}/members/${cy.id}`).set(as(ada));
    expect(left.status).toBeLessThan(300);

    const state = await keys(ada, room.id);
    expect(state.needsRotation).toBe(true);
    expect(state.members.map((m) => m.userId)).not.toContain(cy.id);
    expect((await h.api().get(`/api/e2ee/rooms/${room.id}`).set(as(cy))).status).toBe(404);

    expect((await post(ada, room.id, { newVersion: 2, wraps: both(2) })).status).toBe(200);
    expect((await keys(ada, room.id)).needsRotation).toBe(false);
  });

  it('is not available for a conversation that is not encrypted', async () => {
    const plain = await makeGroup(h, cy, [ada], 'Plain');
    expect((await post(cy, plain.id, { newVersion: 1, wraps: [{ userId: cy.id, version: 1, wrapped: wrapped() }] })).status).toBe(400);
  });
});

describe('messages', () => {
  beforeEach(async () => {
    await post(ada, room.id, { newVersion: 1, wraps: [{ userId: ada.id, version: 1, wrapped: wrapped() }, { userId: bo.id, version: 1, wrapped: wrapped() }] });
  });

  it('refuses plaintext, so nothing readable can enter an encrypted conversation', async () => {
    const res = await say(ada, room.id, { type: 'text', text: 'this should never be stored' });
    expect(res.status).toBe(400);
    const page = await h.api().get(`/api/rooms/${room.id}/messages`).set(as(ada));
    expect(page.body.messages).toHaveLength(0);
  });

  it('stores ciphertext and nothing else, and every surface shows only a placeholder', async () => {
    const sent = body();
    const res = await say(ada, room.id, sent);
    expect(res.status).toBe(201);
    expect(res.body.message.payload).toMatchObject({ type: 'encrypted', ct: sent.ct });

    const { Message } = await import('../src/models/messages.js');
    const row = await Message.findById(res.body.message.id).lean();
    expect(row!.searchText).toBe('');

    const { Room } = await import('../src/models/rooms.js');
    expect((await Room.findById(room.id).lean())!.lastMessage!.text).toBe('Encrypted message');

    const { Notification } = await import('../src/models/delivery.js');
    const note = await Notification.findOne({ messageId: res.body.message.id, userId: bo.id }).lean();
    expect(note!.body).toBe('Encrypted message');
  });

  it('cannot be searched, because there is nothing readable to search', async () => {
    await say(ada, room.id, body());
    const res = await h.api().get('/api/search').query({ q: 'Encrypted' }).set(as(ada));
    expect(res.body.hits).toHaveLength(0);
  });

  it('refuses a key version that does not exist yet', async () => {
    expect((await say(ada, room.id, body(2))).status).toBe(400);
  });

  it('refuses ciphertext in a conversation that is not encrypted', async () => {
    const plain = await makeGroup(h, cy, [ada], 'Plain');
    expect((await say(cy, plain.id, body())).status).toBe(400);
  });

  it('accepts a retry of the same send once', async () => {
    const content = body();
    const clientMessageId = randomUUID();
    const send = () => h.api().post(`/api/rooms/${room.id}/messages`).set(as(ada)).send({ clientMessageId, content });
    const [a, b] = [await send(), await send()];
    expect(a.body.message.id).toBe(b.body.message.id);
  });

  it('edits only with fresh ciphertext, and never accepts plaintext as an edit', async () => {
    const original = (await say(ada, room.id, body())).body.message as MessageDTO;
    const edited = await h.api().patch(`/api/messages/${original.id}`).set(as(ada)).send({ encrypted: { v: 1, kv: 1, iv: b64(12), ct: b64(40) } });
    expect(edited.status).toBe(200);
    expect(edited.body.message.editedAt).toBeTruthy();
    const plain = await h.api().patch(`/api/messages/${original.id}`).set(as(ada)).send({ text: 'now readable' });
    expect(plain.status).toBe(400);
  });

  it('will not file an encrypted message on the Canvas unless the person supplies the text', async () => {
    const sent = (await say(ada, room.id, body())).body.message as MessageDTO;
    const bare = await h.api().post(`/api/rooms/${room.id}/canvas/blocks`).set(as(ada)).send({ fromMessageId: sent.id });
    expect(bare.status).toBe(400);
    const chosen = await h.api().post(`/api/rooms/${room.id}/canvas/blocks`).set(as(ada)).send({ fromMessageId: sent.id, content: { kind: 'quote', text: 'I chose to share this' } });
    expect(chosen.status).toBeLessThan(300);
  });

  it('still lets a plain conversation work exactly as before', async () => {
    const plain = await makeGroup(h, cy, [ada], 'Plain');
    const res = await say(cy, plain.id, { type: 'text', text: 'readable here' });
    expect(res.status).toBe(201);
  });
});
