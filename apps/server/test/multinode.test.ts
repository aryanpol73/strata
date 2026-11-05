import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { io as connect } from 'socket.io-client';
import { checklist, checklistOps, type ChecklistSummary, type MessageDTO } from '@strata/shared';
import { as, makeGroup, makeUser, nextEvent, record, send, sleep, useHarness, type ClientSocket } from './helpers.js';

/**
 * Two real server processes sharing MongoDB and Redis, which is how production runs. Node A is this test process, and
 * node B is a separate OS process, so the only way anything can cross between them is through Redis and Mongo.
 */
const h = useHarness({ redis: true });

const PORT_B = 4301;
const NODE_B = `http://127.0.0.1:${PORT_B}`;
let nodeB: ChildProcess;

beforeAll(async () => {
  nodeB = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(PORT_B), ROLE: 'api', LOG_LEVEL: 'silent' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i += 1) {
    const up = await fetch(`${NODE_B}/api/health`).then((r) => r.ok).catch(() => false);
    if (up) return;
    await sleep(150);
  }
  throw new Error('node B did not start');
}, 30_000);

afterAll(() => {
  nodeB.kill();
});

async function socketOn(url: string, token: string): Promise<ClientSocket> {
  const socket = h.track(connect(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true }));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  await sleep(150);
  return socket;
}

const onA = (token: string) => socketOn(h.url, token);
const onB = (token: string) => socketOn(NODE_B, token);

async function joinDoc(socket: ClientSocket, blockId: string) {
  const doc = new Y.Doc();
  const res = await new Promise<{ ok: true; data: { diff: ArrayBuffer } }>((resolve) => socket.emit('block:join', { blockId }, resolve as never));
  Y.applyUpdate(doc, new Uint8Array(res.data.diff), 'server');
  socket.on('block:update', (e) => {
    if (e.blockId === blockId) Y.applyUpdate(doc, new Uint8Array(e.update as unknown as ArrayBuffer), 'server');
  });
  return doc;
}

async function pushEdit(socket: ClientSocket, blockId: string, doc: Y.Doc, edit: () => void) {
  const before = Y.encodeStateVector(doc);
  edit();
  const update = Y.encodeStateAsUpdate(doc, before);
  return new Promise<{ ok: boolean }>((resolve) => socket.emit('block:update', { blockId, update, clientUpdateId: randomUUID() }, resolve));
}

describe('two real nodes', () => {
  it('a message sent through one node reaches a client on the other', async () => {
    const [a, b] = [await makeUser(h, 'Ada'), await makeUser(h, 'Bo')];
    const room = await makeGroup(h, a, [b]);
    const client = await onB(b.token);
    const heard = nextEvent<{ message: MessageDTO }>(client, 'message:new');
    await send(h, a, room.id, 'across nodes');
    expect((await heard).message.payload).toMatchObject({ text: 'across nodes' });
  });

  it('joining a room on one node reaches sockets held by the other', async () => {
    const [a, b] = [await makeUser(h, 'Ada'), await makeUser(h, 'Bo')];
    const client = await onB(b.token);
    const room = await makeGroup(h, a, [b]);
    await sleep(150);
    const heard = nextEvent<{ message: MessageDTO }>(client, 'message:new');
    await send(h, a, room.id, 'new room');
    expect((await heard).message.roomId).toBe(room.id);
  });

  it('removing a member on one node cuts off their socket on the other', async () => {
    const [a, b] = [await makeUser(h, 'Ada'), await makeUser(h, 'Bo')];
    const room = await makeGroup(h, a, [b]);
    const client = await onB(b.token);
    const log = record(client);
    await h.api().delete(`/api/rooms/${room.id}/members/${b.id}`).set(as(a)).expect(204);
    await sleep(200);
    await send(h, a, room.id, 'after removal');
    await sleep(200);
    expect(JSON.stringify(log)).not.toContain('after removal');
  });

  it('revoking a session on one node disconnects its socket on the other', async () => {
    const a = await makeUser(h, 'Ada');
    const second = await h.api().post('/api/auth/login').send({ email: a.email, password: 'correct horse battery' });
    const client = await onB(second.body.accessToken);
    const closed = new Promise((resolve) => client.once('disconnect', resolve));
    await h.api().delete(`/api/auth/sessions/${second.body.sessionId}`).set(as(a)).expect(204);
    await closed;
  });

  it('revoking a guest link on one node ends a guest connected to the other', async () => {
    const a = await makeUser(h, 'Ada');
    const room = await makeGroup(h, a, []);
    const seed = await send(h, a, room.id, 'seed');
    const branch = (await h.api().post(`/api/messages/${seed.id}/branches`).set(as(a)).send({ title: 'B', participantIds: [] })).body.room;
    const { link } = (await h.api().post(`/api/branches/${branch.id}/guest-links`).set(as(a)).send({ label: 'G' })).body;
    const guest = (await h.api().post('/api/guest/redeem').send({ token: link.token, displayName: 'Guest' })).body;

    const client = await onB(guest.accessToken);
    const closed = new Promise((resolve) => client.once('disconnect', resolve));
    await h.api().delete(`/api/guest-links/${link.id}`).set(as(a)).expect(204);
    await closed;
  });

  it('a user stays online while a tab survives on the other node', async () => {
    const [a, b] = [await makeUser(h, 'Ada'), await makeUser(h, 'Bo')];
    await makeGroup(h, a, [b]);
    const watcher = await onA(b.token);
    const tabOnA = await onA(a.token);
    await onB(a.token);

    let offline = false;
    watcher.on('presence', (e) => {
      if (e.userId === a.id && !e.online) offline = true;
    });
    tabOnA.disconnect();
    await sleep(300);
    expect(offline).toBe(false);
  });

  it('editors on different nodes converge, and each node keeps up with the other', async () => {
    const [a, b] = [await makeUser(h, 'Ada'), await makeUser(h, 'Bo')];
    const room = await makeGroup(h, a, [b]);
    const created = await h.api().post(`/api/rooms/${room.id}/blocks`).set(as(a)).send({ type: 'checklist', clientMessageId: randomUUID(), data: { title: 'Split', items: [] } });
    const blockId = created.body.block.id;
    const [sa, sb] = [await onA(a.token), await onB(b.token)];
    const [da, db] = [await joinDoc(sa, blockId), await joinDoc(sb, blockId)];

    // Each node's cached document goes stale every time the other writes, so alternating is the hard case.
    for (let i = 0; i < 6; i += 1) {
      const [socket, doc] = i % 2 ? [sb, db] : [sa, da];
      const res = await pushEdit(socket, blockId, doc, () => checklistOps.add(doc, `item ${i}`));
      expect(res.ok).toBe(true);
      await sleep(60);
    }
    await sleep(200);

    expect(checklist.summarize(da)).toEqual(checklist.summarize(db));
    expect(checklist.summarize(da).items).toHaveLength(6);
    const stored = await h.api().get(`/api/blocks/${blockId}`).set(as(a));
    expect((stored.body.block.summary as ChecklistSummary).items).toHaveLength(6);
  });

  it('concurrent writes through both nodes all survive', async () => {
    const [a, b] = [await makeUser(h, 'Ada'), await makeUser(h, 'Bo')];
    const room = await makeGroup(h, a, [b]);
    const created = await h.api().post(`/api/rooms/${room.id}/blocks`).set(as(a)).send({ type: 'checklist', clientMessageId: randomUUID(), data: { title: 'Race' } });
    const blockId = created.body.block.id;
    const [sa, sb] = [await onA(a.token), await onB(b.token)];
    const [da, db] = [await joinDoc(sa, blockId), await joinDoc(sb, blockId)];

    const results = await Promise.all([
      pushEdit(sa, blockId, da, () => checklistOps.add(da, 'from A')),
      pushEdit(sb, blockId, db, () => checklistOps.add(db, 'from B')),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    await sleep(250);

    const fresh = await joinDoc(await onA(a.token), blockId);
    expect(checklist.summarize(fresh).items.map((i) => i.text).sort()).toEqual(['from A', 'from B']);
    expect(checklist.summarize(da)).toEqual(checklist.summarize(db));
  });

  it('a retried send through the other node still makes one message', async () => {
    const [a, b] = [await makeUser(h, 'Ada'), await makeUser(h, 'Bo')];
    const room = await makeGroup(h, a, [b]);
    const body = JSON.stringify({ clientMessageId: randomUUID(), content: { type: 'text', text: 'once' } });
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${a.token}` };
    const [one, two] = await Promise.all([
      fetch(`${h.url}/api/rooms/${room.id}/messages`, { method: 'POST', headers, body }).then((r) => r.json() as Promise<{ message: MessageDTO }>),
      fetch(`${NODE_B}/api/rooms/${room.id}/messages`, { method: 'POST', headers, body }).then((r) => r.json() as Promise<{ message: MessageDTO }>),
    ]);
    expect(one.message.id).toBe(two.message.id);
  });
});
