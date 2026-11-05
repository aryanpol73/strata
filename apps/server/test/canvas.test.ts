import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CanvasBlockDTO, CanvasDTO, RoomDTO } from '@strata/shared';
import { as, makeGroup, makeUser, nextEvent, send, socketFor, useHarness, type TestUser } from './helpers.js';

const h = useHarness();

let owner: TestUser;
let alice: TestUser;
let outsider: TestUser;
let room: RoomDTO;

beforeEach(async () => {
  [owner, alice, outsider] = await Promise.all([makeUser(h, 'Owner'), makeUser(h, 'Alice'), makeUser(h, 'Outsider')]);
  room = await makeGroup(h, owner, [alice]);
});

const canvas = async (by = owner, id = room.id): Promise<CanvasDTO> => (await h.api().get(`/api/rooms/${id}/canvas`).set(as(by))).body.canvas;
const add = async (body: object, by = owner, id = room.id): Promise<CanvasBlockDTO> => {
  const res = await h.api().post(`/api/rooms/${id}/canvas/blocks`).set(as(by)).send(body);
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.block;
};
const note = (text: string) => ({ content: { kind: 'text', text } });

describe('the document', () => {
  it('exists for every room, with a starting section', async () => {
    const c = await canvas();
    expect(c.sections).toHaveLength(1);
    expect(c.blocks).toHaveLength(0);
  });

  it('survives concurrent first reads as one document', async () => {
    const results = await Promise.all([canvas(), canvas(alice), canvas()]);
    expect(new Set(results.map((c) => c.sections[0]!.id)).size).toBe(1);
  });

  it('is closed to non-members', async () => {
    expect((await h.api().get(`/api/rooms/${room.id}/canvas`).set(as(outsider))).status).toBe(404);
    const res = await h.api().post(`/api/rooms/${room.id}/canvas/blocks`).set(as(outsider)).send(note('x'));
    expect(res.status).toBe(404);
  });
});

describe('extracting from the stream', () => {
  it('turns a message into a block with a source reference', async () => {
    const msg = await send(h, alice, room.id, 'We chose Postgres for reporting');
    const block = await add({ fromMessageId: msg.id, asKind: 'decision' });
    expect(block.content).toMatchObject({ kind: 'decision', text: 'We chose Postgres for reporting', status: 'decided' });
    expect(block.source).toMatchObject({ messageId: msg.id, roomId: room.id, seq: msg.seq, senderName: 'Alice', available: true });
  });

  it('recognizes a bare link', async () => {
    const msg = await send(h, alice, room.id, 'https://example.test/spec');
    const block = await add({ fromMessageId: msg.id });
    expect(block.content).toMatchObject({ kind: 'link', url: 'https://example.test/spec' });
  });

  it('turns a merged resolution into a decision', async () => {
    const seed = await send(h, owner, room.id, 'seed');
    const branch = (await h.api().post(`/api/messages/${seed.id}/branches`).set(as(owner)).send({ title: 'Pricing', participantIds: [] })).body.room;
    await h.api().post(`/api/branches/${branch.id}/resolve`).set(as(owner)).send({ summary: 'Keep it at $20' });
    const merged = await h.api().post(`/api/branches/${branch.id}/merge`).set(as(owner)).send({});
    const block = await add({ fromMessageId: merged.body.branch.mergedMessageId });
    expect(block.content).toMatchObject({ kind: 'decision', text: 'Pricing: Keep it at $20' });
  });

  it('embeds a live block rather than copying it', async () => {
    const created = await h.api().post(`/api/rooms/${room.id}/blocks`).set(as(owner)).send({ type: 'checklist', clientMessageId: randomUUID(), data: { title: 'List' } });
    const page = await h.api().get(`/api/rooms/${room.id}/messages`).set(as(owner));
    const block = await add({ fromMessageId: page.body.messages[0].id });
    expect(block.content).toEqual({ kind: 'live', blockId: created.body.block.id });
  });

  it('refuses a message from another room, so branch content cannot move to a wider audience', async () => {
    const seed = await send(h, owner, room.id, 'seed');
    const branch = (await h.api().post(`/api/messages/${seed.id}/branches`).set(as(owner)).send({ title: 'B', participantIds: [] })).body.room;
    const secret = await send(h, owner, branch.id, 'branch only');
    const res = await h.api().post(`/api/rooms/${room.id}/canvas/blocks`).set(as(owner)).send({ fromMessageId: secret.id });
    expect(res.status).toBe(400);
  });

  it('refuses a live block from another room', async () => {
    const other = await makeGroup(h, owner, [], 'Other');
    const created = await h.api().post(`/api/rooms/${other.id}/blocks`).set(as(owner)).send({ type: 'checklist', clientMessageId: randomUUID(), data: { title: 'L' } });
    const res = await h.api().post(`/api/rooms/${room.id}/canvas/blocks`).set(as(owner)).send({ content: { kind: 'live', blockId: created.body.block.id } });
    expect(res.status).toBe(400);
  });
});

describe('bidirectional references', () => {
  it('message to Canvas and back', async () => {
    const msg = await send(h, alice, room.id, 'Remember this');
    const block = await add({ fromMessageId: msg.id });

    const refs = await h.api().get(`/api/messages/${msg.id}/references`).set(as(alice));
    expect(refs.body.references).toContainEqual(expect.objectContaining({ kind: 'canvas', id: block.id, roomId: room.id }));

    const page = await h.api().get(`/api/rooms/${room.id}/messages`).set(as(owner)).query({ aroundSeq: block.source!.seq, limit: 10 });
    const target = page.body.messages.find((m: { id: string }) => m.id === block.source!.messageId);
    expect(target.refCount).toBe(1);
  });

  it('removing the block removes the reference', async () => {
    const msg = await send(h, alice, room.id, 'Temporary');
    const block = await add({ fromMessageId: msg.id });
    await h.api().delete(`/api/canvas/blocks/${block.id}`).set(as(owner)).expect(204);
    const refs = await h.api().get(`/api/messages/${msg.id}/references`).set(as(alice));
    expect(refs.body.references).toHaveLength(0);
  });

  it('a deleted source is marked unavailable, and the Canvas content remains', async () => {
    const msg = await send(h, alice, room.id, 'Keep the note');
    await add({ fromMessageId: msg.id });
    await h.api().delete(`/api/messages/${msg.id}`).set(as(alice)).expect(204);
    const [block] = (await canvas()).blocks;
    expect(block!.source?.available).toBe(false);
    expect(block!.content).toMatchObject({ text: 'Keep the note' });
  });

  it('lists replies as references too', async () => {
    const msg = await send(h, alice, room.id, 'Original');
    const reply = await send(h, owner, room.id, 'Answer', { replyToId: msg.id });
    const refs = await h.api().get(`/api/messages/${msg.id}/references`).set(as(alice));
    expect(refs.body.references).toContainEqual(expect.objectContaining({ kind: 'message', id: reply.id }));
  });
});

describe('editing', () => {
  it('uses version checks, so a stale edit cannot overwrite a newer one', async () => {
    const block = await add(note('v1'));
    const edit = (text: string, version: number) =>
      h.api().patch(`/api/canvas/blocks/${block.id}`).set(as(owner)).send({ content: { kind: 'text', text }, version });

    expect((await edit('v2', 1)).status).toBe(200);
    const stale = await edit('stale', 1);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details.latest.content.text).toBe('v2');
  });

  it('refuses a change of kind and scripted links', async () => {
    const block = await add(note('text'));
    const res = await h.api().patch(`/api/canvas/blocks/${block.id}`).set(as(owner)).send({ content: { kind: 'decision', text: 'x' }, version: 1 });
    expect(res.status).toBe(400);
    const bad = await h.api().post(`/api/rooms/${room.id}/canvas/blocks`).set(as(owner)).send({ content: { kind: 'link', url: 'javascript:alert(1)' } });
    expect(bad.status).toBe(400);
  });

  it('tells the room', async () => {
    const socket = await socketFor(h, alice.token);
    const changed = nextEvent<{ change: { kind: string } }>(socket, 'canvas:changed');
    await add(note('hello'));
    expect((await changed).change.kind).toBe('block');
  });
});

describe('organizing', () => {
  const order = async () => (await canvas()).blocks.map((b) => (b.content as { text: string }).text);

  it('reorders within a section', async () => {
    const [a, b, c] = [await add(note('a')), await add(note('b')), await add(note('c'))];
    const section = a.sectionId;
    await h.api().post(`/api/canvas/blocks/${c.id}/move`).set(as(owner)).send({ sectionId: section, afterId: null, beforeId: a.id }).expect(200);
    expect(await order()).toEqual(['c', 'a', 'b']);
    await h.api().post(`/api/canvas/blocks/${c.id}/move`).set(as(owner)).send({ sectionId: section, afterId: a.id, beforeId: b.id }).expect(200);
    expect(await order()).toEqual(['a', 'c', 'b']);
  });

  it('survives many moves between the same neighbours', async () => {
    const [a, b, c] = [await add(note('a')), await add(note('b')), await add(note('c'))];
    for (let i = 0; i < 12; i += 1) {
      const [mover, after, before] = i % 2 ? [b, a, c] : [c, a, b];
      await h.api().post(`/api/canvas/blocks/${mover.id}/move`).set(as(owner)).send({ sectionId: a.sectionId, afterId: after.id, beforeId: before.id }).expect(200);
    }
    expect((await order()).sort()).toEqual(['a', 'b', 'c']);
  });

  it('moves between sections, and keeps blocks when a section is deleted', async () => {
    const a = await add(note('a'));
    const withSection = await h.api().post(`/api/rooms/${room.id}/canvas/sections`).set(as(owner)).send({ title: 'Decisions' });
    const target = withSection.body.canvas.sections[1];
    await h.api().post(`/api/canvas/blocks/${a.id}/move`).set(as(owner)).send({ sectionId: target.id, afterId: null, beforeId: null }).expect(200);
    expect((await canvas()).blocks[0]!.sectionId).toBe(target.id);

    await h.api().delete(`/api/rooms/${room.id}/canvas/sections/${target.id}`).set(as(owner)).expect(200);
    const c = await canvas();
    expect(c.sections).toHaveLength(1);
    expect(c.blocks).toHaveLength(1);
    expect(c.blocks[0]!.sectionId).toBe(c.sections[0]!.id);
  });

  it('keeps at least one section', async () => {
    const c = await canvas();
    const res = await h.api().delete(`/api/rooms/${room.id}/canvas/sections/${c.sections[0]!.id}`).set(as(owner));
    expect(res.status).toBe(409);
  });

  it('renames sections', async () => {
    const c = await canvas();
    await h.api().patch(`/api/rooms/${room.id}/canvas/sections/${c.sections[0]!.id}`).set(as(owner)).send({ title: 'Renamed' }).expect(200);
    expect((await canvas()).sections[0]!.title).toBe('Renamed');
  });
});
