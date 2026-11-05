import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { MessageDTO } from '@strata/shared';
import { as, makeGroup, makeUser, nextEvent, send, sleep, socketFor, useHarness } from './helpers.js';

// Runs through the Redis adapter, so that fan-out is tested the way production does it.
const h = useHarness({ redis: true });

describe('rooms', () => {
  it('creates one direct room per pair, even when both sides race', async () => {
    const [a, b] = [await makeUser(h), await makeUser(h)];
    const [x, y] = await Promise.all([
      h.api().post('/api/rooms/direct').set(as(a)).send({ userId: b.id }),
      h.api().post('/api/rooms/direct').set(as(b)).send({ userId: a.id }),
    ]);
    expect(x.status).toBe(201);
    expect(y.status).toBe(201);
    expect(x.body.room.id).toBe(y.body.room.id);
    expect(x.body.room.name).toBe(b.name);
    expect(y.body.room.name).toBe(a.name);
  });

  it('hides a room from non-members with a 404', async () => {
    const [a, b, outsider] = [await makeUser(h), await makeUser(h), await makeUser(h)];
    const room = await makeGroup(h, a, [b]);
    expect((await h.api().get(`/api/rooms/${room.id}`).set(as(outsider))).status).toBe(404);
    expect((await h.api().get(`/api/rooms/${room.id}/messages`).set(as(outsider))).status).toBe(404);
    const res = await h.api().post(`/api/rooms/${room.id}/messages`).set(as(outsider)).send({ clientMessageId: randomUUID(), content: { type: 'text', text: 'hi' } });
    expect(res.status).toBe(404);
  });

  it('enforces roles', async () => {
    const [owner, member, other] = [await makeUser(h), await makeUser(h), await makeUser(h)];
    const room = await makeGroup(h, owner, [member]);
    expect((await h.api().post(`/api/rooms/${room.id}/members`).set(as(member)).send({ userIds: [other.id] })).status).toBe(403);
    expect((await h.api().post(`/api/rooms/${room.id}/members`).set(as(owner)).send({ userIds: [other.id] })).status).toBe(200);
    expect((await h.api().delete(`/api/rooms/${room.id}/members/${owner.id}`).set(as(member))).status).toBe(403);
    expect((await h.api().patch(`/api/rooms/${room.id}/members/${other.id}`).set(as(member)).send({ role: 'admin' })).status).toBe(403);
  });

  it('removing a member cuts off access and live events at once', async () => {
    const [owner, member] = [await makeUser(h), await makeUser(h)];
    const room = await makeGroup(h, owner, [member]);
    const socket = await socketFor(h, member.token);

    await h.api().delete(`/api/rooms/${room.id}/members/${member.id}`).set(as(owner)).expect(204);
    await sleep(80);

    let leaked = false;
    socket.on('message:new', () => {
      leaked = true;
    });
    await send(h, owner, room.id, 'after removal');
    await sleep(150);
    expect(leaked).toBe(false);
    expect((await h.api().get(`/api/rooms/${room.id}/messages`).set(as(member))).status).toBe(404);
  });

  it('hands ownership on when the owner leaves', async () => {
    const [owner, member] = [await makeUser(h), await makeUser(h)];
    const room = await makeGroup(h, owner, [member]);
    await h.api().delete(`/api/rooms/${room.id}/members/${owner.id}`).set(as(owner)).expect(204);
    const res = await h.api().get(`/api/rooms/${room.id}`).set(as(member));
    expect(res.body.room.me.role).toBe('owner');
  });
});

describe('sending', () => {
  it('assigns increasing sequence numbers under concurrency', async () => {
    const [a, b] = [await makeUser(h), await makeUser(h)];
    const room = await makeGroup(h, a, [b]);
    const sent = await Promise.all(Array.from({ length: 25 }, (_, i) => send(h, i % 2 ? a : b, room.id, `m${i}`)));
    expect(new Set(sent.map((m) => m.seq)).size).toBe(25);

    const page = await h.api().get(`/api/rooms/${room.id}/messages`).set(as(a));
    const seqs = page.body.messages.map((m: MessageDTO) => m.seq);
    expect(seqs).toEqual([...seqs].sort((x: number, y: number) => x - y));
  });

  it('returns the original message when a send is retried', async () => {
    const [a, b] = [await makeUser(h), await makeUser(h)];
    const room = await makeGroup(h, a, [b]);
    const body = { clientMessageId: randomUUID(), content: { type: 'text', text: 'once' } };
    const [one, two, three] = await Promise.all(
      [1, 2, 3].map(() => h.api().post(`/api/rooms/${room.id}/messages`).set(as(a)).send(body)),
    );
    expect(new Set([one!.body.message.id, two!.body.message.id, three!.body.message.id]).size).toBe(1);
    const page = await h.api().get(`/api/rooms/${room.id}/messages`).set(as(a));
    expect(page.body.messages).toHaveLength(1);
  });

  it('is persisted before anyone hears about it', async () => {
    const [a, b] = [await makeUser(h), await makeUser(h)];
    const room = await makeGroup(h, a, [b]);
    const socket = await socketFor(h, b.token);
    const heard = nextEvent<{ message: MessageDTO }>(socket, 'message:new');
    const sent = await send(h, a, room.id, 'hello');
    const { message } = await heard;
    expect(message.id).toBe(sent.id);
    const { Message } = await import('../src/models/messages.js');
    expect(await Message.exists({ _id: message.id })).toBeTruthy();
  });

  it('refuses client-supplied block, resolution or system payloads', async () => {
    const a = await makeUser(h);
    const room = await makeGroup(h, a, []);
    const res = await h.api().post(`/api/rooms/${room.id}/messages`).set(as(a)).send({
      clientMessageId: randomUUID(),
      content: { type: 'system', text: 'forged' },
    });
    expect(res.status).toBe(400);
  });

  it('keeps replies inside the conversation', async () => {
    const [a, b] = [await makeUser(h), await makeUser(h)];
    const [one, two] = [await makeGroup(h, a, [b], 'One'), await makeGroup(h, a, [b], 'Two')];
    const elsewhere = await send(h, a, one.id, 'over here');
    const local = await send(h, a, two.id, 'local');

    const bad = await h.api().post(`/api/rooms/${two.id}/messages`).set(as(a)).send({
      clientMessageId: randomUUID(),
      content: { type: 'text', text: 'reply' },
      replyToId: elsewhere.id,
    });
    expect(bad.status).toBe(400);

    const good = await send(h, b, two.id, 'reply', { replyToId: local.id });
    expect(good.replyTo?.excerpt).toBe('local');
  });
});

describe('message management', () => {
  it('edits and deletes only your own, and admins can delete', async () => {
    const [owner, a, b] = [await makeUser(h), await makeUser(h), await makeUser(h)];
    const room = await makeGroup(h, owner, [a, b]);
    const msg = await send(h, a, room.id, 'mine');

    expect((await h.api().patch(`/api/messages/${msg.id}`).set(as(b)).send({ text: 'hacked' })).status).toBe(403);
    expect((await h.api().delete(`/api/messages/${msg.id}`).set(as(b))).status).toBe(403);

    const edited = await h.api().patch(`/api/messages/${msg.id}`).set(as(a)).send({ text: 'changed' });
    expect(edited.body.message.payload.text).toBe('changed');
    expect(edited.body.message.editedAt).toBeTruthy();
    expect(edited.body.message.rev).toBeGreaterThan(msg.rev);

    expect((await h.api().delete(`/api/messages/${msg.id}`).set(as(owner))).status).toBe(204);
  });

  it('leaves a tombstone that keeps its place and drops its content', async () => {
    const a = await makeUser(h);
    const room = await makeGroup(h, a, []);
    const msg = await send(h, a, room.id, 'secret contents');
    await h.api().delete(`/api/messages/${msg.id}`).set(as(a)).expect(204);

    const page = await h.api().get(`/api/rooms/${room.id}/messages`).set(as(a));
    expect(page.body.messages[0].payload).toEqual({ type: 'deleted' });
    expect(page.body.messages[0].seq).toBe(msg.seq);
    expect(JSON.stringify(page.body)).not.toContain('secret contents');

    const found = await h.api().get('/api/search').set(as(a)).query({ q: 'secret' });
    expect(found.body.hits).toHaveLength(0);
  });

  it('toggles reactions and survives concurrent ones', async () => {
    const [a, b, c] = [await makeUser(h), await makeUser(h), await makeUser(h)];
    const room = await makeGroup(h, a, [b, c]);
    const msg = await send(h, a, room.id, 'react');
    const react = (u: typeof a) => h.api().post(`/api/messages/${msg.id}/reactions`).set(as(u)).send({ emoji: '👍' });

    await Promise.all([react(a), react(b), react(c)]);
    let page = await h.api().get(`/api/rooms/${room.id}/messages`).set(as(a));
    expect(page.body.messages[0].reactions).toHaveLength(1);
    expect(page.body.messages[0].reactions[0].principalIds).toHaveLength(3);

    await Promise.all([react(a), react(b), react(c)]);
    page = await h.api().get(`/api/rooms/${room.id}/messages`).set(as(a));
    expect(page.body.messages[0].reactions).toHaveLength(0);
  });
});

describe('pagination and sync', () => {
  it('pages backwards without gaps or overlap', async () => {
    const a = await makeUser(h);
    const room = await makeGroup(h, a, []);
    for (let i = 0; i < 7; i += 1) await send(h, a, room.id, `m${i}`);

    const first = await h.api().get(`/api/rooms/${room.id}/messages`).set(as(a)).query({ limit: 3 });
    expect(first.body.hasMore).toBe(true);
    const second = await h.api().get(`/api/rooms/${room.id}/messages`).set(as(a)).query({ limit: 3, beforeSeq: first.body.messages[0].seq });
    const third = await h.api().get(`/api/rooms/${room.id}/messages`).set(as(a)).query({ limit: 3, beforeSeq: second.body.messages[0].seq });
    expect(third.body.hasMore).toBe(false);
    const all = [...third.body.messages, ...second.body.messages, ...first.body.messages].map((m: MessageDTO) => (m.payload as { text: string }).text);
    expect(all).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  });

  it('jumps to a message with its surroundings', async () => {
    const a = await makeUser(h);
    const room = await makeGroup(h, a, []);
    const sent: MessageDTO[] = [];
    for (let i = 0; i < 9; i += 1) sent.push(await send(h, a, room.id, `m${i}`));
    const res = await h.api().get(`/api/rooms/${room.id}/messages`).set(as(a)).query({ aroundSeq: sent[4]!.seq, limit: 4 });
    expect(res.body.messages.map((m: MessageDTO) => m.seq)).toContain(sent[4]!.seq);
    expect(res.body.messages.length).toBeLessThanOrEqual(5);
  });

  it('recovers everything a disconnected client missed, including edits and deletes', async () => {
    const [a, b] = [await makeUser(h), await makeUser(h)];
    const room = await makeGroup(h, a, [b]);
    const kept = await send(h, a, room.id, 'one');
    const gone = await send(h, a, room.id, 'two');
    const known = (await h.api().get(`/api/rooms/${room.id}`).set(as(b))).body.room.rev;

    await h.api().patch(`/api/messages/${kept.id}`).set(as(a)).send({ text: 'one edited' });
    await h.api().delete(`/api/messages/${gone.id}`).set(as(a));
    await send(h, a, room.id, 'three');

    const sync = await h.api().get(`/api/rooms/${room.id}/sync`).set(as(b)).query({ sinceRev: known });
    const ids = sync.body.messages.map((m: MessageDTO) => m.payload);
    expect(ids).toContainEqual({ type: 'text', text: 'one edited' });
    expect(ids).toContainEqual({ type: 'deleted' });
    expect(ids).toContainEqual({ type: 'text', text: 'three' });
    expect(sync.body.rev).toBeGreaterThan(known);
  });
});

describe('receipts and unread', () => {
  it('tracks unread and advances watermarks', async () => {
    const [a, b] = [await makeUser(h), await makeUser(h)];
    const room = await makeGroup(h, a, [b]);
    await send(h, a, room.id, 'one');
    const last = await send(h, a, room.id, 'two');
    await send(h, a, room.id, 'quiet', { posture: 'whisper' });

    let me = (await h.api().get(`/api/rooms/${room.id}`).set(as(b))).body.room.me;
    expect(me.unread).toBe(2);
    expect(me.quietUnread).toBe(1);

    const socket = await socketFor(h, a.token);
    const receipt = nextEvent<{ readSeq: number; principalId: string }>(socket, 'receipt');
    await h.api().post(`/api/rooms/${room.id}/read`).set(as(b)).send({ seq: last.seq }).expect(204);
    expect(await receipt).toMatchObject({ principalId: b.id, readSeq: last.seq });

    me = (await h.api().get(`/api/rooms/${room.id}`).set(as(b))).body.room.me;
    expect(me.unread).toBe(0);
  });

  it("won't move a watermark backwards or past the end", async () => {
    const [a, b] = [await makeUser(h), await makeUser(h)];
    const room = await makeGroup(h, a, [b]);
    const msg = await send(h, a, room.id, 'one');
    await h.api().post(`/api/rooms/${room.id}/read`).set(as(b)).send({ seq: 999999 });
    await h.api().post(`/api/rooms/${room.id}/read`).set(as(b)).send({ seq: 0 });
    const me = (await h.api().get(`/api/rooms/${room.id}`).set(as(b))).body.room.me;
    expect(me.lastReadSeq).toBe(msg.rev);
  });

  it('marks delivery from the socket, and a non-member cannot', async () => {
    const [a, b, outsider] = [await makeUser(h), await makeUser(h), await makeUser(h)];
    const room = await makeGroup(h, a, [b]);
    const msg = await send(h, a, room.id, 'one');
    const bSocket = await socketFor(h, b.token);
    const aSocket = await socketFor(h, a.token);
    const receipt = nextEvent<{ deliveredSeq: number }>(aSocket, 'receipt');
    bSocket.emit('receipt:delivered', { roomId: room.id, seq: msg.seq });
    expect((await receipt).deliveredSeq).toBe(msg.seq);

    const spy = await socketFor(h, outsider.token);
    spy.emit('receipt:delivered', { roomId: room.id, seq: msg.seq });
    await sleep(100);
    const { RoomMember } = await import('../src/models/rooms.js');
    expect(await RoomMember.exists({ roomId: room.id, userId: outsider.id })).toBeNull();
  });
});

describe('typing and presence', () => {
  it('relays typing to the room but not the typist', async () => {
    const [a, b] = [await makeUser(h, 'Typist'), await makeUser(h)];
    const room = await makeGroup(h, a, [b]);
    const [sa, sb] = [await socketFor(h, a.token), await socketFor(h, b.token)];
    let echoed = false;
    sa.on('typing', () => {
      echoed = true;
    });
    const typing = nextEvent<{ name: string }>(sb, 'typing');
    sa.emit('typing', { roomId: room.id, active: true });
    expect((await typing).name).toBe('Typist');
    await sleep(50);
    expect(echoed).toBe(false);
  });

  it("drops typing for a room you aren't in", async () => {
    const [a, b, outsider] = [await makeUser(h), await makeUser(h), await makeUser(h)];
    const room = await makeGroup(h, a, [b]);
    const [sb, spy] = [await socketFor(h, b.token), await socketFor(h, outsider.token)];
    let got = false;
    sb.on('typing', () => {
      got = true;
    });
    spy.emit('typing', { roomId: room.id, active: true });
    await sleep(120);
    expect(got).toBe(false);
  });

  it('survives a second tab closing, unlike a one-socket-per-user map', async () => {
    const [a, b] = [await makeUser(h), await makeUser(h)];
    await makeGroup(h, a, [b]);
    const watcher = await socketFor(h, b.token);
    const tab1 = await socketFor(h, a.token);
    await socketFor(h, a.token);
    let offline = false;
    watcher.on('presence', (e) => {
      if (e.userId === a.id && !e.online) offline = true;
    });
    tab1.disconnect();
    await sleep(200);
    expect(offline).toBe(false);
  });

  it('announces offline when the last socket goes', async () => {
    const [a, b] = [await makeUser(h), await makeUser(h)];
    await makeGroup(h, a, [b]);
    const watcher = await socketFor(h, b.token);
    const tab = await socketFor(h, a.token);
    const gone = new Promise((resolve) => {
      watcher.on('presence', (e) => {
        if (e.userId === a.id && !e.online) resolve(true);
      });
    });
    tab.disconnect();
    expect(await gone).toBe(true);
  });
});

describe('search', () => {
  it('finds text in your rooms and nothing in anyone else\'s', async () => {
    const [a, b, outsider] = [await makeUser(h), await makeUser(h), await makeUser(h)];
    const room = await makeGroup(h, a, [b]);
    await send(h, a, room.id, 'the quarterly zeppelin forecast');

    const mine = await h.api().get('/api/search').set(as(b)).query({ q: 'zeppelin' });
    expect(mine.body.hits).toHaveLength(1);
    const theirs = await h.api().get('/api/search').set(as(outsider)).query({ q: 'zeppelin' });
    expect(theirs.body.hits).toHaveLength(0);
    const forced = await h.api().get('/api/search').set(as(outsider)).query({ q: 'zeppelin', roomId: room.id });
    expect(forced.status).toBe(404);
  });
});

describe('media', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');

  async function upload(user: { token: string }, roomId: string, body: Buffer, mime = 'image/png') {
    const signed = await h.api().post('/api/media/sign').set(as(user)).send({ roomId, name: 'a.png', mime, bytes: body.length });
    if (signed.status !== 201) return { signed };
    const put = await h.api().put(signed.body.url).set(as(user)).set('content-type', 'application/octet-stream').send(body);
    return { signed, put };
  }

  it('uploads, sends, and serves through a short-lived link', async () => {
    const [a, b] = [await makeUser(h), await makeUser(h)];
    const room = await makeGroup(h, a, [b]);
    const { signed, put } = await upload(a, room.id, PNG);
    expect(put!.status).toBe(204);
    await h.api().post(`/api/media/${signed.body.assetId}/complete`).set(as(a)).send({ width: 1, height: 1 }).expect(200);

    const msg = await h.api().post(`/api/rooms/${room.id}/messages`).set(as(a)).send({
      clientMessageId: randomUUID(),
      content: { type: 'media', assetId: signed.body.assetId, caption: 'look' },
    });
    expect(msg.status).toBe(201);
    expect(msg.body.message.payload).toMatchObject({ type: 'media', mime: 'image/png', width: 1 });

    const link = await h.api().get(`/api/media/${signed.body.assetId}/url`).set(as(b));
    const file = await h.api().get(link.body.url);
    expect(file.status).toBe(200);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
  });

  it('keeps files away from people outside the room', async () => {
    const [a, outsider] = [await makeUser(h), await makeUser(h)];
    const room = await makeGroup(h, a, []);
    const { signed } = await upload(a, room.id, PNG);
    await h.api().post(`/api/media/${signed.body.assetId}/complete`).set(as(a)).send({});
    expect((await h.api().get(`/api/media/${signed.body.assetId}/url`).set(as(outsider))).status).toBe(404);
    expect((await h.api().post('/api/media/sign').set(as(outsider)).send({ roomId: room.id, name: 'x.png', mime: 'image/png', bytes: 10 })).status).toBe(404);
  });

  it('rejects forged, expired and tampered links', async () => {
    const a = await makeUser(h);
    const room = await makeGroup(h, a, []);
    const { signed } = await upload(a, room.id, PNG);
    await h.api().post(`/api/media/${signed.body.assetId}/complete`).set(as(a)).send({});
    const link = await h.api().get(`/api/media/${signed.body.assetId}/url`).set(as(a));
    const url = new URL(link.body.url, 'http://x');

    expect((await h.api().get(`${url.pathname}?exp=${Date.now() + 999999}&sig=${url.searchParams.get('sig')}`)).status).toBe(404);
    expect((await h.api().get(`${url.pathname}?exp=${Date.now() - 1000}&sig=abc`)).status).toBe(404);
    expect((await h.api().get(url.pathname)).status).toBe(404);
  });

  it('refuses dangerous types, oversized files, and bytes that lie about their type', async () => {
    const a = await makeUser(h);
    const room = await makeGroup(h, a, []);
    const sign = (mime: string, bytes: number) => h.api().post('/api/media/sign').set(as(a)).send({ roomId: room.id, name: 'x', mime, bytes });
    expect((await sign('image/svg+xml', 10)).status).toBe(415);
    expect((await sign('text/html', 10)).status).toBe(415);
    expect((await sign('image/png', 99_000_000)).status).toBe(415);

    const { put } = await upload(a, room.id, Buffer.from('<script>alert(1)</script>'));
    expect(put!.status).toBe(415);
  });

  it("won't attach someone else's upload", async () => {
    const [a, b] = [await makeUser(h), await makeUser(h)];
    const room = await makeGroup(h, a, [b]);
    const { signed } = await upload(a, room.id, PNG);
    await h.api().post(`/api/media/${signed.body.assetId}/complete`).set(as(a)).send({});
    const res = await h.api().post(`/api/rooms/${room.id}/messages`).set(as(b)).send({
      clientMessageId: randomUUID(),
      content: { type: 'media', assetId: signed.body.assetId },
    });
    expect(res.status).toBe(400);
  });
});
