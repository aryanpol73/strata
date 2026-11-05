import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  checklist,
  checklistOps,
  roster,
  rosterOps,
  type BlockDTO,
  type ChecklistSummary,
  type MessageDTO,
  type RoomDTO,
  type RosterSummary,
} from '@strata/shared';
import { as, makeGroup, makeUser, send, sleep, socketFor, useHarness, type ClientSocket, type TestUser } from './helpers.js';

const h = useHarness({ redis: true });

let owner: TestUser;
let alice: TestUser;
let room: RoomDTO;

beforeEach(async () => {
  [owner, alice] = await Promise.all([makeUser(h, 'Owner'), makeUser(h, 'Alice')]);
  room = await makeGroup(h, owner, [alice]);
});

const makeBlock = async (by: TestUser, roomId: string, type: string, data: object, extra: object = {}): Promise<BlockDTO> => {
  const res = await h.api().post(`/api/rooms/${roomId}/blocks`).set(as(by)).send({ type, clientMessageId: randomUUID(), data, ...extra });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.block;
};

interface Client {
  doc: Y.Doc;
  socket: ClientSocket;
  push(): Promise<{ ok: boolean; message?: string; code?: string }>;
  sent: Uint8Array;
}

/** A minimal client: joins, keeps a doc, and pushes local changes as a diff against what the server has. */
async function join(socket: ClientSocket, blockId: string, existing?: Y.Doc): Promise<Client> {
  const doc = existing ?? new Y.Doc();
  const res = await new Promise<{ ok: true; data: { diff: ArrayBuffer; stateVector: ArrayBuffer } } | { ok: false; message: string }>((resolve) =>
    socket.emit('block:join', { blockId, stateVector: Y.encodeStateVector(doc) }, resolve as never),
  );
  if (!res.ok) throw new Error(res.message);
  Y.applyUpdate(doc, new Uint8Array(res.data.diff), 'server');
  socket.on('block:update', (e) => {
    if (e.blockId === blockId) Y.applyUpdate(doc, new Uint8Array(e.update as unknown as ArrayBuffer), 'server');
  });
  const client: Client = {
    doc,
    socket,
    sent: new Uint8Array(res.data.stateVector),
    push: () =>
      new Promise((resolve) => {
        const update = Y.encodeStateAsUpdate(doc, client.sent);
        socket.emit('block:update', { blockId, update, clientUpdateId: randomUUID() }, (r) => {
          if (r.ok) client.sent = Y.encodeStateVector(doc);
          resolve(r);
        });
      }),
  };
  return client;
}

describe('creating', () => {
  it('produces one message and a live block', async () => {
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Trip', items: ['Tickets'] });
    const page = await h.api().get(`/api/rooms/${room.id}/messages`).set(as(owner));
    expect(page.body.messages).toHaveLength(1);
    expect(page.body.messages[0].payload).toMatchObject({ type: 'block', blockId: block.id, title: 'Trip', blockType: 'checklist' });
    expect((block.summary as ChecklistSummary).items).toHaveLength(1);
  });

  it('validates input per type', async () => {
    const res = await h.api().post(`/api/rooms/${room.id}/blocks`).set(as(owner)).send({ type: 'roster', clientMessageId: randomUUID(), data: { title: 'No slots', slots: [] } });
    expect(res.status).toBe(400);
    const bad = await h.api().post(`/api/rooms/${room.id}/blocks`).set(as(owner)).send({ type: 'nonsense', clientMessageId: randomUUID(), data: {} });
    expect(bad.status).toBe(400);
  });

  it('a retried create yields one block', async () => {
    const body = { type: 'checklist', clientMessageId: randomUUID(), data: { title: 'Once' } };
    const first = await h.api().post(`/api/rooms/${room.id}/blocks`).set(as(owner)).send(body);
    const second = await h.api().post(`/api/rooms/${room.id}/blocks`).set(as(owner)).send(body);
    expect(second.body.block.id).toBe(first.body.block.id);
    const { Block } = await import('../src/models/blocks.js');
    expect(await Block.countDocuments({ roomId: room.id })).toBe(1);
  });
});

describe('real-time sync', () => {
  it('concurrent editors converge, through the server and Redis', async () => {
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Trip', items: ['Tickets'] });
    const [a, b] = [await join(await socketFor(h, owner.token), block.id), await join(await socketFor(h, alice.token), block.id)];

    const itemId = checklist.summarize(a.doc).items[0]!.id;
    checklistOps.add(a.doc, 'Hotel');
    checklistOps.add(b.doc, 'Visa');
    checklistOps.toggle(a.doc, itemId, 'Owner');
    checklistOps.text(b.doc, itemId)!.insert(0, 'Train ');
    const results = await Promise.all([a.push(), b.push()]);
    expect(results.every((r) => r.ok)).toBe(true);
    await sleep(200);

    expect(checklist.summarize(a.doc)).toEqual(checklist.summarize(b.doc));
    const s = checklist.summarize(a.doc);
    expect(s.items).toHaveLength(3);
    expect(s.items.find((i) => i.id === itemId)).toMatchObject({ text: 'Train Tickets', done: true });
  });

  it('many interleaved edits from several clients still converge', async () => {
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Stress', items: [] });
    const third = await makeUser(h);
    await h.api().post(`/api/rooms/${room.id}/members`).set(as(owner)).send({ userIds: [third.id] });
    const clients = [
      await join(await socketFor(h, owner.token), block.id),
      await join(await socketFor(h, alice.token), block.id),
      await join(await socketFor(h, third.token), block.id),
    ];
    for (let round = 0; round < 8; round += 1) {
      clients.forEach((c, i) => checklistOps.add(c.doc, `r${round}-c${i}`));
      const results = await Promise.all(clients.map((c) => c.push()));
      expect(results.every((r) => r.ok)).toBe(true);
    }
    await sleep(300);
    const summaries = clients.map((c) => checklist.summarize(c.doc));
    expect(summaries[0]!.items).toHaveLength(24);
    expect(summaries[1]).toEqual(summaries[0]);
    expect(summaries[2]).toEqual(summaries[0]);
  });

  it('never creates replacement messages', async () => {
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'One message' });
    const a = await join(await socketFor(h, owner.token), block.id);
    for (let i = 0; i < 5; i += 1) {
      checklistOps.add(a.doc, `item ${i}`);
      await a.push();
    }
    const page = await h.api().get(`/api/rooms/${room.id}/messages`).set(as(owner));
    expect(page.body.messages.filter((m: MessageDTO) => m.payload.type === 'block')).toHaveLength(1);
    expect(page.body.messages).toHaveLength(1);
  });

  it('updates the stored summary, so previews work without a live doc', async () => {
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Sum' });
    const a = await join(await socketFor(h, owner.token), block.id);
    checklistOps.add(a.doc, 'x');
    await a.push();
    const res = await h.api().get(`/api/blocks/${block.id}`).set(as(alice));
    expect((res.body.block.summary as ChecklistSummary).items).toHaveLength(1);
  });

  it('persists before acknowledging', async () => {
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Durable' });
    const a = await join(await socketFor(h, owner.token), block.id);
    checklistOps.add(a.doc, 'x');
    await a.push();
    const { BlockUpdate } = await import('../src/models/blocks.js');
    expect(await BlockUpdate.countDocuments({ blockId: block.id })).toBe(1);
  });

  it('applies a retried update once', async () => {
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Retry' });
    const socket = await socketFor(h, owner.token);
    const a = await join(socket, block.id);
    const before = Y.encodeStateVector(a.doc);
    checklistOps.add(a.doc, 'once');
    const update = Y.encodeStateAsUpdate(a.doc, before);
    const clientUpdateId = randomUUID();
    const push = () => new Promise<{ ok: boolean; data?: { seq: number } }>((resolve) => socket.emit('block:update', { blockId: block.id, update, clientUpdateId }, resolve as never));
    const [one, two] = [await push(), await push()];
    expect(one.data?.seq).toBe(two.data?.seq);
    const { BlockUpdate } = await import('../src/models/blocks.js');
    expect(await BlockUpdate.countDocuments({ blockId: block.id })).toBe(1);
  });
});

describe('reconnection', () => {
  it('a client that edited offline reconciles on reconnect, in both directions', async () => {
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Offline', items: ['base'] });
    const socket = await socketFor(h, alice.token);
    const a = await join(socket, block.id);
    socket.disconnect();

    checklistOps.add(a.doc, 'added offline');
    const online = await join(await socketFor(h, owner.token), block.id);
    checklistOps.add(online.doc, 'added online');
    await online.push();

    const back = await join(await socketFor(h, alice.token), block.id, a.doc);
    back.sent = new Uint8Array(online.sent);
    expect((await back.push()).ok).toBe(true);
    await sleep(150);

    const texts = (d: Y.Doc) => checklist.summarize(d).items.map((i) => i.text).sort();
    expect(texts(a.doc)).toEqual(['added offline', 'added online', 'base']);
    expect(texts(online.doc)).toEqual(texts(a.doc));
  });

  it('a fresh client sees everything, from snapshot plus log', async () => {
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Fresh', items: ['a'] });
    const a = await join(await socketFor(h, owner.token), block.id);
    checklistOps.add(a.doc, 'b');
    await a.push();

    const { clearBlockCache } = await import('../src/modules/blocks/service.js');
    clearBlockCache();
    const fresh = await join(await socketFor(h, alice.token), block.id);
    expect(checklist.summarize(fresh.doc).items.map((i) => i.text)).toEqual(['a', 'b']);
  });
});

describe('compaction', () => {
  it('folds the log into the snapshot and loses nothing', async () => {
    const { compactBlock, clearBlockCache } = await import('../src/modules/blocks/service.js');
    const { Block, BlockUpdate } = await import('../src/models/blocks.js');
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Compact', items: ['a'] });
    const a = await join(await socketFor(h, owner.token), block.id);
    for (const text of ['b', 'c', 'd']) {
      checklistOps.add(a.doc, text);
      await a.push();
    }
    expect(await compactBlock(block.id, 0)).toBe(3);
    expect(await BlockUpdate.countDocuments({ blockId: block.id })).toBe(0);
    expect((await Block.findById(block.id).lean())!.snapshotSeq).toBe(3);

    clearBlockCache();
    const fresh = await join(await socketFor(h, alice.token), block.id);
    expect(checklist.summarize(fresh.doc).items.map((i) => i.text)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('accepts edits after compaction, including from clients that joined before it', async () => {
    const { compactBlock } = await import('../src/modules/blocks/service.js');
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'After' });
    const a = await join(await socketFor(h, owner.token), block.id);
    checklistOps.add(a.doc, 'before');
    await a.push();
    await compactBlock(block.id, 0);
    checklistOps.add(a.doc, 'after');
    expect((await a.push()).ok).toBe(true);
    const res = await h.api().get(`/api/blocks/${block.id}`).set(as(owner));
    expect((res.body.block.summary as ChecklistSummary).items).toHaveLength(2);
  });

  it('leaves young updates alone, so a write in flight is never lost', async () => {
    const { compactBlock } = await import('../src/modules/blocks/service.js');
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Young' });
    const a = await join(await socketFor(h, owner.token), block.id);
    checklistOps.add(a.doc, 'x');
    await a.push();
    expect(await compactBlock(block.id, 60_000)).toBe(0);
  });

  it('two compactors running together do no harm', async () => {
    const { compactBlock, clearBlockCache } = await import('../src/modules/blocks/service.js');
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Race', items: ['a'] });
    const a = await join(await socketFor(h, owner.token), block.id);
    checklistOps.add(a.doc, 'b');
    await a.push();
    await Promise.all([compactBlock(block.id, 0), compactBlock(block.id, 0)]);
    clearBlockCache();
    const fresh = await join(await socketFor(h, alice.token), block.id);
    expect(checklist.summarize(fresh.doc).items).toHaveLength(2);
  });

  it('keeps change history through compaction', async () => {
    const { compactBlock } = await import('../src/modules/blocks/service.js');
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'History' });
    const a = await join(await socketFor(h, owner.token), block.id);
    checklistOps.add(a.doc, 'x');
    await a.push();
    await compactBlock(block.id, 0);
    const res = await h.api().get(`/api/blocks/${block.id}/activity`).set(as(alice));
    expect(res.body.activity.map((e: { action: string }) => e.action)).toEqual(['added', 'created']);
    expect(res.body.activity[0].actorName).toBe('Owner');
  });
});

describe('permissions', () => {
  it('a creator-only block refuses other members, on the server', async () => {
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Mine', items: ['keep'] }, { policy: 'creator' });
    const b = await join(await socketFor(h, alice.token), block.id);
    checklistOps.add(b.doc, 'sneaky');
    const res = await b.push();
    expect(res).toMatchObject({ ok: false, code: 'BLOCK_UPDATE_REJECTED' });
    const stored = await h.api().get(`/api/blocks/${block.id}`).set(as(owner));
    expect((stored.body.block.summary as ChecklistSummary).items.map((i) => i.text)).toEqual(['keep']);
  });

  it('a rejected update is never relayed', async () => {
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Mine' }, { policy: 'creator' });
    const watcher = await socketFor(h, owner.token);
    let relayed = false;
    watcher.on('block:update', () => {
      relayed = true;
    });
    const b = await join(await socketFor(h, alice.token), block.id);
    checklistOps.add(b.doc, 'sneaky');
    await b.push();
    await sleep(120);
    expect(relayed).toBe(false);
  });

  it('roster: members sign themselves up, and cannot forge anyone else', async () => {
    const block = await makeBlock(owner, room.id, 'roster', { title: 'Shifts', slots: [{ label: 'AM', capacity: 1 }] });
    const slotId = (block.summary as RosterSummary).slots[0]!.id;
    const b = await join(await socketFor(h, alice.token), block.id);

    rosterOps.claim(b.doc, slotId, { id: alice.id, name: 'Alice' });
    expect((await b.push()).ok).toBe(true);

    rosterOps.claim(b.doc, slotId, { id: owner.id, name: 'Owner' });
    expect(await b.push()).toMatchObject({ ok: false });
    const stored = await h.api().get(`/api/blocks/${block.id}`).set(as(owner));
    expect((stored.body.block.summary as RosterSummary).claims.map((c) => c.name)).toEqual(['Alice']);
  });

  it('roster: the creator manages slots, and racing claims agree on who got in', async () => {
    const block = await makeBlock(owner, room.id, 'roster', { title: 'Shifts', slots: [{ label: 'AM', capacity: 1 }] });
    const slotId = (block.summary as RosterSummary).slots[0]!.id;
    const [a, b] = [await join(await socketFor(h, owner.token), block.id), await join(await socketFor(h, alice.token), block.id)];

    rosterOps.claim(a.doc, slotId, { id: owner.id, name: 'Owner' });
    rosterOps.claim(b.doc, slotId, { id: alice.id, name: 'Alice' });
    await Promise.all([a.push(), b.push()]);
    await sleep(200);
    const [sa, sb] = [roster.summarize(a.doc).slots[0]!, roster.summarize(b.doc).slots[0]!];
    expect(sa).toEqual(sb);
    expect(sa.confirmed).toHaveLength(1);
    expect(sa.waitlist).toHaveLength(1);
  });

  it('non-members cannot join or write', async () => {
    const outsider = await makeUser(h);
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Private' });
    const socket = await socketFor(h, outsider.token);
    const join1 = await new Promise<{ ok: boolean; code?: string }>((resolve) => socket.emit('block:join', { blockId: block.id }, resolve));
    expect(join1).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const write = await new Promise<{ ok: boolean }>((resolve) =>
      socket.emit('block:update', { blockId: block.id, update: new Uint8Array([1, 2, 3]), clientUpdateId: randomUUID() }, resolve),
    );
    expect(write.ok).toBe(false);
    expect((await h.api().get(`/api/blocks/${block.id}`).set(as(outsider))).status).toBe(404);
  });

  it('a member removed mid-session stops being able to write', async () => {
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Revoked' });
    const b = await join(await socketFor(h, alice.token), block.id);
    await h.api().delete(`/api/rooms/${room.id}/members/${alice.id}`).set(as(owner));
    checklistOps.add(b.doc, 'after removal');
    expect((await b.push()).ok).toBe(false);
  });

  it('a block in a closed branch is read-only', async () => {
    const seed = await send(h, owner, room.id, 'seed');
    const branch = (await h.api().post(`/api/messages/${seed.id}/branches`).set(as(owner)).send({ title: 'B', participantIds: [] })).body.room;
    const block = await makeBlock(owner, branch.id, 'checklist', { title: 'Closed' });
    const a = await join(await socketFor(h, owner.token), block.id);
    await h.api().post(`/api/branches/${branch.id}/resolve`).set(as(owner)).send({ summary: 'done' });
    checklistOps.add(a.doc, 'late');
    expect((await a.push()).ok).toBe(false);
  });
});

describe('hostile updates', () => {
  it('refuses garbage bytes without harming the block', async () => {
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Tough', items: ['safe'] });
    const socket = await socketFor(h, owner.token);
    const junk = new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * 37) % 256));
    const res = await new Promise<{ ok: boolean }>((resolve) => socket.emit('block:update', { blockId: block.id, update: junk, clientUpdateId: randomUUID() }, resolve));
    expect(res.ok).toBe(false);
    const fresh = await join(await socketFor(h, alice.token), block.id);
    expect(checklist.summarize(fresh.doc).items).toHaveLength(1);
  });

  it('refuses an update that depends on state the server never received', async () => {
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Gap' });
    const a = await join(await socketFor(h, owner.token), block.id);
    const start = Y.encodeStateVector(a.doc);
    checklistOps.add(a.doc, 'first');
    const middle = Y.encodeStateVector(a.doc);
    checklistOps.add(a.doc, 'second');
    expect(start).toBeTruthy();
    const onlySecond = Y.encodeStateAsUpdate(a.doc, middle);
    const res = await new Promise<{ ok: boolean }>((resolve) =>
      a.socket.emit('block:update', { blockId: block.id, update: onlySecond, clientUpdateId: randomUUID() }, resolve),
    );
    expect(res.ok).toBe(false);
  });

  it('drops an oversized frame at the transport, and the block is untouched', async () => {
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Big' });
    const a = await join(await socketFor(h, owner.token), block.id);
    const closed = new Promise((resolve) => a.socket.once('disconnect', resolve));
    checklistOps.add(a.doc, 'x'.repeat(70_000));
    void a.push();
    await closed;
    const stored = await h.api().get(`/api/blocks/${block.id}`).set(as(owner));
    expect((stored.body.block.summary as ChecklistSummary).items).toHaveLength(0);
  });

  it('refuses a valid update that breaks type limits', async () => {
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Limit' });
    const a = await join(await socketFor(h, owner.token), block.id);
    checklistOps.add(a.doc, 'y'.repeat(3000));
    expect(await a.push()).toMatchObject({ ok: false, code: 'BLOCK_UPDATE_REJECTED' });
  });

  it('keeps working after a rejection', async () => {
    const block = await makeBlock(owner, room.id, 'checklist', { title: 'Resilient' });
    const a = await join(await socketFor(h, owner.token), block.id);
    const socket = a.socket;
    await new Promise((resolve) => socket.emit('block:update', { blockId: block.id, update: new Uint8Array([255, 255]), clientUpdateId: randomUUID() }, resolve));
    checklistOps.add(a.doc, 'fine');
    expect((await a.push()).ok).toBe(true);
  });
});
