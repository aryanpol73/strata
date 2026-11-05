import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { checklist, checklistOps, type ChecklistSummary } from '@strata/shared';
import { BlockSession } from '../src/features/blocks/blockSession';

type Handler = (payload: never) => void;

/** Stands in for the server: holds the canonical doc, and can refuse updates or go offline. */
class FakeSocket {
  connected = true;
  server = new Y.Doc();
  refuse = false;
  received = 0;
  private handlers = new Map<string, Set<Handler>>();

  on(event: string, fn: Handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
    return this;
  }
  off(event: string, fn: Handler) {
    this.handlers.get(event)?.delete(fn);
    return this;
  }
  fire(event: string, payload: unknown) {
    this.handlers.get(event)?.forEach((fn) => fn(payload as never));
  }
  timeout() {
    return { emit: (event: string, payload: unknown, cb: (err: Error | null, res: unknown) => void) => this.handle(event, payload, (res) => cb(null, res)) };
  }
  emit(event: string, payload: unknown, cb?: (res: unknown) => void) {
    this.handle(event, payload, (res) => cb?.(res));
    return this;
  }
  private handle(event: string, payload: unknown, cb: (res: unknown) => void) {
    if (event === 'block:join') {
      const { stateVector } = payload as { stateVector?: Uint8Array };
      cb({ ok: true, data: { diff: Y.encodeStateAsUpdate(this.server, stateVector), stateVector: Y.encodeStateVector(this.server), canEdit: true, seq: 1 } });
    }
    if (event === 'block:update') {
      this.received += 1;
      if (this.refuse) return cb({ ok: false, code: 'BLOCK_UPDATE_REJECTED', message: 'You can only sign yourself up' });
      // The same check the real server makes: an update with a gap beneath it can't be accepted.
      const copy = new Y.Doc();
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(this.server));
      Y.applyUpdate(copy, (payload as { update: Uint8Array }).update);
      if (copy.store.pendingStructs) return cb({ ok: false, code: 'BLOCK_UPDATE_REJECTED', message: 'That update could not be applied' });
      Y.applyUpdate(this.server, (payload as { update: Uint8Array }).update);
      cb({ ok: true, data: { seq: 2 } });
    }
  }
}

const texts = (doc: Y.Doc) => checklist.summarize(doc).items.map((i: ChecklistSummary['items'][number]) => i.text);
const flush = async () => {
  await vi.advanceTimersByTimeAsync(200);
};

describe('BlockSession', () => {
  let socket: FakeSocket;
  let session: BlockSession;

  beforeEach(() => {
    vi.useFakeTimers();
    socket = new FakeSocket();
    checklist.init(socket.server, { title: 'Trip', items: ['Tickets'] });
    session = new BlockSession('b1', socket as never);
  });

  it('loads the server state on join', () => {
    expect(session.status).toBe('live');
    expect(session.canEdit).toBe(true);
    expect(texts(session.doc)).toEqual(['Tickets']);
  });

  it('sends a burst of edits as one update', async () => {
    checklistOps.add(session.doc, 'One');
    checklistOps.add(session.doc, 'Two');
    checklistOps.add(session.doc, 'Three');
    await flush();
    expect(socket.received).toBe(1);
    expect(texts(socket.server)).toEqual(['Tickets', 'One', 'Two', 'Three']);
  });

  it('applies remote updates without echoing them back', async () => {
    const before = Y.encodeStateVector(socket.server);
    checklistOps.add(socket.server, 'From Bo');
    socket.fire('block:update', { blockId: 'b1', update: Y.encodeStateAsUpdate(socket.server, before) });
    await flush();
    expect(texts(session.doc)).toContain('From Bo');
    expect(socket.received).toBe(0);
  });

  it('ignores updates for other blocks', () => {
    const other = new Y.Doc();
    other.getMap('items').set('x', new Y.Map());
    socket.fire('block:update', { blockId: 'b2', update: Y.encodeStateAsUpdate(other) });
    expect(texts(session.doc)).toEqual(['Tickets']);
  });

  it('keeps offline edits, and reconciles both ways on rejoin', async () => {
    socket.connected = false;
    socket.fire('disconnect', undefined);
    expect(session.status).toBe('offline');

    checklistOps.add(session.doc, 'Made offline');
    await flush();
    expect(socket.received).toBe(0);
    expect(texts(session.doc)).toContain('Made offline');

    checklistOps.add(socket.server, 'Made online');
    socket.connected = true;
    session.join();
    await flush();

    expect(session.status).toBe('live');
    expect(texts(session.doc).sort()).toEqual(['Made offline', 'Made online', 'Tickets']);
    expect(texts(socket.server).sort()).toEqual(texts(session.doc).sort());
  });

  it('drops a refused change and shows why', async () => {
    socket.refuse = true;
    checklistOps.add(session.doc, 'Not allowed');
    await flush();
    expect(session.error).toBe('You can only sign yourself up');
    expect(texts(session.doc)).toEqual(['Tickets']);
  });

  it('can keep working after a refusal', async () => {
    socket.refuse = true;
    checklistOps.add(session.doc, 'Not allowed');
    await flush();
    socket.refuse = false;
    checklistOps.add(session.doc, 'Allowed');
    await flush();
    expect(texts(socket.server)).toContain('Allowed');
  });

  it('reports a block it may not see', () => {
    const denied = { ...socket, connected: true, on: socket.on.bind(socket), off: socket.off.bind(socket), emit: (_e: string, _p: unknown, cb?: (r: unknown) => void) => cb?.({ ok: false, code: 'NOT_FOUND', message: 'Block not found' }) };
    const s = new BlockSession('b9', denied as never);
    expect(s.status).toBe('denied');
  });
});
