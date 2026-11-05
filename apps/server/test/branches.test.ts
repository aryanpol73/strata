import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BranchSummaryDTO, MessageDTO, RoomDTO } from '@strata/shared';
import { as, makeGroup, makeUser, nextEvent, record, send, sleep, socketFor, useHarness, type TestUser } from './helpers.js';

const h = useHarness();

let owner: TestUser;
let alice: TestUser;
let bob: TestUser;
let outsider: TestUser;
let room: RoomDTO;
let origin: MessageDTO;

beforeEach(async () => {
  [owner, alice, bob, outsider] = await Promise.all([makeUser(h, 'Owner'), makeUser(h, 'Alice'), makeUser(h, 'Bob'), makeUser(h, 'Outsider')]);
  room = await makeGroup(h, owner, [alice, bob]);
  origin = await send(h, owner, room.id, 'Should we move the launch?');
});

async function branch(by: TestUser, participants: TestUser[], extra: object = {}): Promise<RoomDTO> {
  const res = await h.api().post(`/api/messages/${origin.id}/branches`).set(as(by)).send({
    title: 'Launch date',
    participantIds: participants.map((p) => p.id),
    ...extra,
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.room;
}

const resolve = (by: TestUser, id: string) => h.api().post(`/api/branches/${id}/resolve`).set(as(by)).send({ summary: 'Moving to March' });
const merge = (by: TestUser, id: string, transcriptPolicy = 'participants') => h.api().post(`/api/branches/${id}/merge`).set(as(by)).send({ transcriptPolicy });
const list = async (by: TestUser): Promise<BranchSummaryDTO[]> => (await h.api().get(`/api/rooms/${room.id}/branches`).set(as(by))).body.branches;
const messages = async (by: TestUser, id: string): Promise<MessageDTO[]> => (await h.api().get(`/api/rooms/${id}/messages`).set(as(by))).body.messages;

describe('creating a branch', () => {
  it('links parent and child, and keeps histories apart', async () => {
    const b = await branch(owner, [alice]);
    expect(b).toMatchObject({ kind: 'branch', parentRoomId: room.id, parentMessageId: origin.id, depth: 1 });
    expect(b.branch).toMatchObject({ status: 'open', title: 'Launch date' });
    expect(b.branch?.origin?.excerpt).toBe('Should we move the launch?');

    await send(h, alice, b.id, 'in the branch');
    const parent = await messages(owner, room.id);
    expect(parent.every((m) => JSON.stringify(m.payload).indexOf('in the branch') === -1)).toBe(true);
  });

  it('leaves the original message unchanged apart from its marker', async () => {
    await branch(owner, [alice]);
    const [after] = await messages(owner, room.id);
    expect(after!.payload).toEqual(origin.payload);
    expect(after!.branchCount).toBe(1);
  });

  it('refuses participants who are not in the parent conversation', async () => {
    const res = await h.api().post(`/api/messages/${origin.id}/branches`).set(as(owner)).send({ title: 'x', participantIds: [outsider.id] });
    expect(res.status).toBe(400);
  });

  it('refuses someone who cannot see the message', async () => {
    const res = await h.api().post(`/api/messages/${origin.id}/branches`).set(as(outsider)).send({ title: 'x', participantIds: [] });
    expect(res.status).toBe(404);
  });

  it('allows nesting up to a limit', async () => {
    let parent = await branch(owner, [alice]);
    for (const depth of [2, 3]) {
      const seed = await send(h, owner, parent.id, 'deeper');
      const res = await h.api().post(`/api/messages/${seed.id}/branches`).set(as(owner)).send({ title: `d${depth}`, participantIds: [] });
      expect(res.status).toBe(201);
      expect(res.body.room.rootRoomId).toBe(room.id);
      parent = res.body.room;
    }
    const seed = await send(h, owner, parent.id, 'too deep');
    const res = await h.api().post(`/api/messages/${seed.id}/branches`).set(as(owner)).send({ title: 'd4', participantIds: [] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BRANCH_DEPTH_EXCEEDED');
  });
});

describe('visibility matrix', () => {
  it('listed: non-participants see metadata but never the transcript', async () => {
    const b = await branch(owner, [alice]);
    await send(h, alice, b.id, 'confidential detail');

    const [seen] = await list(bob);
    expect(seen).toMatchObject({ title: 'Launch date', participantCount: 2, isParticipant: false, canReadTranscript: false });
    expect(JSON.stringify(seen)).not.toContain('confidential');

    for (const path of ['', '/messages', '/sync?sinceRev=0', '/canvas']) {
      expect((await h.api().get(`/api/rooms/${b.id}${path}`).set(as(bob))).status).toBe(404);
    }
    expect((await h.api().post(`/api/rooms/${b.id}/messages`).set(as(bob)).send({ clientMessageId: randomUUID(), content: { type: 'text', text: 'hi' } })).status).toBe(404);
  });

  it('private: non-participants learn nothing, not even a count', async () => {
    const b = await branch(owner, [alice], { visibility: 'private' });
    expect(await list(bob)).toHaveLength(0);
    expect((await list(alice)).map((x) => x.roomId)).toEqual([b.id]);

    const [parentMessage] = await messages(bob, room.id);
    expect(parentMessage!.branchCount).toBe(0);
    const refs = await h.api().get(`/api/messages/${origin.id}/references`).set(as(bob));
    expect(refs.body.references).toHaveLength(0);
  });

  it('listed branches show up in references for non-participants, private ones only for participants', async () => {
    await branch(owner, [alice]);
    const privateBranch = await branch(owner, [alice], { visibility: 'private' });
    const bobRefs = (await h.api().get(`/api/messages/${origin.id}/references`).set(as(bob))).body.references;
    expect(bobRefs).toHaveLength(1);
    const aliceRefs = (await h.api().get(`/api/messages/${origin.id}/references`).set(as(alice))).body.references;
    expect(aliceRefs.map((r: { roomId: string }) => r.roomId)).toContain(privateBranch.id);
  });

  it('a private branch emits nothing to the parent room', async () => {
    const socket = await socketFor(h, bob.token);
    const log = record(socket);
    const b = await branch(owner, [alice], { visibility: 'private' });
    await send(h, alice, b.id, 'quiet');
    await sleep(150);
    expect(JSON.stringify(log)).not.toContain(b.id);
    expect(JSON.stringify(log)).not.toContain('Launch date');
  });

  it('only participants get branch messages live', async () => {
    const b = await branch(owner, [alice]);
    const [inside, excluded] = [await socketFor(h, alice.token), await socketFor(h, bob.token)];
    const log = record(excluded);
    const heard = nextEvent<{ message: MessageDTO }>(inside, 'message:new');
    await send(h, owner, b.id, 'for branch ears');
    expect((await heard).message.payload).toMatchObject({ text: 'for branch ears' });
    await sleep(100);
    expect(JSON.stringify(log)).not.toContain('for branch ears');
  });

  it('branch content stays out of search for non-participants', async () => {
    const b = await branch(owner, [alice]);
    await send(h, alice, b.id, 'xylophone budget');
    expect((await h.api().get('/api/search').set(as(alice)).query({ q: 'xylophone' })).body.hits).toHaveLength(1);
    expect((await h.api().get('/api/search').set(as(bob)).query({ q: 'xylophone' })).body.hits).toHaveLength(0);
    expect((await h.api().get('/api/search').set(as(bob)).query({ q: 'xylophone', roomId: b.id })).status).toBe(404);
  });

  it('a resolution summary stays private until the merge', async () => {
    const b = await branch(owner, [alice]);
    await resolve(owner, b.id);
    const [before] = await list(bob);
    expect(before!.status).toBe('resolved');
    expect(before!.resolution).toBeNull();
    await merge(owner, b.id);
    const [after] = await list(bob);
    expect(after!.resolution?.summary).toBe('Moving to March');
  });
});

describe('lifecycle', () => {
  it('blocks new messages once resolved, and reopening restores them', async () => {
    const b = await branch(owner, [alice]);
    await resolve(owner, b.id);
    const res = await h.api().post(`/api/rooms/${b.id}/messages`).set(as(alice)).send({ clientMessageId: randomUUID(), content: { type: 'text', text: 'late' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BRANCH_NOT_OPEN');

    await h.api().post(`/api/branches/${b.id}/reopen`).set(as(owner)).expect(200);
    await send(h, alice, b.id, 'back open');
  });

  it('reserves lifecycle actions for the branch owner and parent admins', async () => {
    const b = await branch(alice, [bob]);
    expect((await resolve(bob, b.id)).status).toBe(403);
    expect((await resolve(owner, b.id)).status).toBe(200);
    expect((await merge(bob, b.id)).status).toBe(403);
  });

  it('removing someone from the parent removes them from its branches, at every depth', async () => {
    const b = await branch(owner, [alice, bob]);
    const seed = await send(h, owner, b.id, 'nested');
    const nested = (await h.api().post(`/api/messages/${seed.id}/branches`).set(as(owner)).send({ title: 'n', participantIds: [bob.id] })).body.room;

    await h.api().delete(`/api/rooms/${room.id}/members/${bob.id}`).set(as(owner)).expect(204);
    expect((await h.api().get(`/api/rooms/${b.id}`).set(as(bob))).status).toBe(404);
    expect((await h.api().get(`/api/rooms/${nested.id}`).set(as(bob))).status).toBe(404);
  });

  it('adds later participants, parent members only', async () => {
    const b = await branch(owner, []);
    expect((await h.api().post(`/api/branches/${b.id}/participants`).set(as(owner)).send({ userIds: [outsider.id] })).status).toBe(400);
    expect((await h.api().post(`/api/branches/${b.id}/participants`).set(as(owner)).send({ userIds: [bob.id] })).status).toBe(200);
    expect((await h.api().get(`/api/rooms/${b.id}`).set(as(bob))).status).toBe(200);
  });
});

describe('merging', () => {
  it('requires a resolution first', async () => {
    const b = await branch(owner, [alice]);
    const res = await merge(owner, b.id);
    expect(res.status).toBe(409);
  });

  it('posts one resolution card to the parent', async () => {
    const b = await branch(owner, [alice]);
    await resolve(owner, b.id);
    const res = await merge(owner, b.id);
    expect(res.status).toBe(200);
    expect(res.body.branch.mergedMessageId).toBeTruthy();

    const card = (await messages(bob, room.id)).find((m) => m.payload.type === 'resolution');
    expect(card?.payload).toMatchObject({ branchRoomId: b.id, summary: 'Moving to March', resolvedBy: 'Owner', participantCount: 2, transcriptOpen: false });
  });

  it('produces exactly one card, however many people merge at once', async () => {
    const b = await branch(owner, [alice]);
    await h.api().patch(`/api/rooms/${room.id}/members/${bob.id}`).set(as(owner)).send({ role: 'admin' });
    await resolve(owner, b.id);
    await h.api().post(`/api/branches/${b.id}/participants`).set(as(owner)).send({ userIds: [bob.id] });

    const results = await Promise.all([merge(owner, b.id), merge(bob, b.id), merge(owner, b.id), merge(bob, b.id)]);
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    const cards = (await messages(owner, room.id)).filter((m) => m.payload.type === 'resolution');
    expect(cards).toHaveLength(1);

    const again = await merge(owner, b.id);
    expect(again.body.error.code).toBe('BRANCH_ALREADY_MERGED');
  });

  it('finishes cleanly if a crash left the card posted but the merge unrecorded', async () => {
    const b = await branch(owner, [alice]);
    await resolve(owner, b.id);
    await merge(owner, b.id);
    const { Room } = await import('../src/models/rooms.js');
    await Room.updateOne({ _id: b.id }, { 'branch.mergedAt': null, 'branch.mergedMessageId': null });

    const retry = await merge(owner, b.id);
    expect(retry.status).toBe(200);
    expect((await messages(owner, room.id)).filter((m) => m.payload.type === 'resolution')).toHaveLength(1);
  });

  it('keeps the transcript private by default', async () => {
    const b = await branch(owner, [alice]);
    await send(h, alice, b.id, 'sensitive reasoning');
    await resolve(owner, b.id);
    await merge(owner, b.id);
    expect((await h.api().get(`/api/rooms/${b.id}/messages`).set(as(bob))).status).toBe(404);
  });

  it('can open a read-only transcript to parent members', async () => {
    const b = await branch(owner, [alice]);
    await send(h, alice, b.id, 'now public reasoning');
    await resolve(owner, b.id);
    await merge(owner, b.id, 'parent_members');

    const read = await h.api().get(`/api/rooms/${b.id}/messages`).set(as(bob));
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).toContain('now public reasoning');
    expect((await h.api().get(`/api/rooms/${b.id}`).set(as(bob))).body.room.me.readOnly).toBe(true);

    const write = await h.api().post(`/api/rooms/${b.id}/messages`).set(as(bob)).send({ clientMessageId: randomUUID(), content: { type: 'text', text: 'hi' } });
    expect(write.status).toBe(403);
    expect((await h.api().get(`/api/rooms/${b.id}/messages`).set(as(outsider))).status).toBe(404);
  });

  it('notifies parent members about the card, but not the person who merged', async () => {
    const b = await branch(owner, [alice]);
    await resolve(owner, b.id);
    await merge(owner, b.id);
    const { Notification } = await import('../src/models/delivery.js');
    const card = (await messages(owner, room.id)).find((m) => m.payload.type === 'resolution')!;
    const rows = await Notification.find({ messageId: card.id }).lean();
    expect(rows.map((r) => String(r.userId)).sort()).toEqual([alice.id, bob.id].sort());
  });
});

describe('scoped notifications', () => {
  it('only notifies branch participants', async () => {
    const b = await branch(owner, [alice]);
    const msg = await send(h, owner, b.id, 'branch only');
    const { Notification } = await import('../src/models/delivery.js');
    const rows = await Notification.find({ messageId: msg.id }).lean();
    expect(rows.map((r) => String(r.userId))).toEqual([alice.id]);
  });
});
