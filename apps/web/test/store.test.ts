import { beforeEach, describe, expect, it } from 'vitest';
import type { MessageDTO, RoomDTO } from '@strata/shared';
import { mergeMessages, useStore } from '../src/state/store';

const message = (over: Partial<MessageDTO>): MessageDTO => ({
  id: 'm1',
  roomId: 'r1',
  seq: 1,
  rev: 1,
  sender: { type: 'user', id: 'u1', name: 'Ada' },
  clientMessageId: null,
  payload: { type: 'text', text: 'hello' },
  replyTo: null,
  reactions: [],
  posture: 'standard',
  ack: null,
  branchCount: 0,
  refCount: 0,
  createdAt: new Date(0).toISOString(),
  editedAt: null,
  deletedAt: null,
  ...over,
});

const get = useStore.getState;

beforeEach(() => get().reset());

describe('mergeMessages', () => {
  it('keeps messages in sequence order, whatever order they arrive in', () => {
    const merged = mergeMessages([], [message({ id: 'b', seq: 5 }), message({ id: 'a', seq: 2 }), message({ id: 'c', seq: 9 })]);
    expect(merged.map((m) => m.seq)).toEqual([2, 5, 9]);
  });

  it('refuses a stale copy that arrives after a newer one', () => {
    const edited = message({ rev: 7, payload: { type: 'text', text: 'edited' } });
    const stale = message({ rev: 3, payload: { type: 'text', text: 'old' } });
    expect(mergeMessages([edited], [stale])[0]!.payload).toEqual({ type: 'text', text: 'edited' });
  });

  it('takes the newer copy', () => {
    const merged = mergeMessages([message({ rev: 1 })], [message({ rev: 2, payload: { type: 'deleted' } })]);
    expect(merged[0]!.payload).toEqual({ type: 'deleted' });
  });
});

describe('the store', () => {
  it('tracks the highest revision for resync', () => {
    get().upsertMessages('r1', [message({ id: 'a', rev: 4 }), message({ id: 'b', seq: 2, rev: 9 })]);
    expect(get().messages.r1!.rev).toBe(9);
  });

  it('clears a pending message when the server confirms it, even if the socket gets there first', () => {
    get().addPending({ clientMessageId: 'c1', roomId: 'r1', text: 'hi', posture: 'standard', createdAt: 0, failed: false });
    get().upsertMessages('r1', [message({ clientMessageId: 'c1' })]);
    expect(get().pending.r1).toHaveLength(0);
    expect(get().messages.r1!.items).toHaveLength(1);
  });

  it('keeps pending messages that are not confirmed yet', () => {
    get().addPending({ clientMessageId: 'c1', roomId: 'r1', text: 'hi', posture: 'standard', createdAt: 0, failed: false });
    get().upsertMessages('r1', [message({ clientMessageId: 'other' })]);
    expect(get().pending.r1).toHaveLength(1);
  });

  it('applies receipts to the right member', () => {
    const member = (userId: string) => ({ userId, displayName: 'x', handle: 'x', avatarUrl: null, role: 'member' as const, lastDeliveredSeq: 0, lastReadSeq: 0 });
    get().upsertRoom({ id: 'r1', members: [member('a'), member('b')] } as unknown as RoomDTO);
    get().applyReceipt({ roomId: 'r1', principalId: 'b', deliveredSeq: 5, readSeq: 3 });
    expect(get().rooms.r1!.members.map((m) => m.lastReadSeq)).toEqual([0, 3]);
  });

  it('forgets everything on reset', () => {
    get().upsertMessages('r1', [message({})]);
    get().reset();
    expect(get().messages).toEqual({});
    expect(get().authStatus).toBe('anon');
  });
});
