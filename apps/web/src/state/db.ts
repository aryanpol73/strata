import Dexie, { type EntityTable } from 'dexie';
import type { MessageDTO, Posture, RoomDTO } from '@strata/shared';

export interface OutboxEntry {
  clientMessageId: string;
  roomId: string;
  text: string;
  replyToId?: string;
  posture: Posture;
  ackDeadline?: string;
  createdAt: number;
}

/** Local cache for instant start and offline reading, plus the outbox for messages written while offline. */
class StrataDB extends Dexie {
  rooms!: EntityTable<RoomDTO, 'id'>;
  messages!: EntityTable<MessageDTO, 'id'>;
  outbox!: EntityTable<OutboxEntry, 'clientMessageId'>;
  /** Encryption keys for this device: the person's own private key, and the room keys opened with it. */
  keys!: EntityTable<{ id: string; key: CryptoKey; publicKey?: string }, 'id'>;
  /** The public key each person had when first seen. Not secret, and kept across sign-outs so a swapped key is noticed. */
  pins!: EntityTable<{ id: string; publicKey: string }, 'id'>;

  constructor() {
    super('strata');
    this.version(1).stores({
      rooms: 'id',
      messages: 'id, [roomId+seq]',
      outbox: 'clientMessageId, createdAt',
    });
    this.version(2).stores({
      rooms: 'id',
      messages: 'id, [roomId+seq]',
      outbox: 'clientMessageId, createdAt',
      keys: 'id',
    });
    this.version(3).stores({
      rooms: 'id',
      messages: 'id, [roomId+seq]',
      outbox: 'clientMessageId, createdAt',
      keys: 'id',
      pins: 'id',
    });
  }
}

export const db = new StrataDB();

const KEEP_PER_ROOM = 200;

export async function cacheMessages(roomId: string, messages: MessageDTO[]) {
  await db.messages.bulkPut(messages);
  const count = await db.messages.where('[roomId+seq]').between([roomId, Dexie.minKey], [roomId, Dexie.maxKey]).count();
  if (count > KEEP_PER_ROOM) {
    const old = await db.messages
      .where('[roomId+seq]')
      .between([roomId, Dexie.minKey], [roomId, Dexie.maxKey])
      .limit(count - KEEP_PER_ROOM)
      .primaryKeys();
    await db.messages.bulkDelete(old);
  }
}

export async function cachedMessages(roomId: string): Promise<MessageDTO[]> {
  return db.messages.where('[roomId+seq]').between([roomId, Dexie.minKey], [roomId, Dexie.maxKey]).toArray();
}

/** Nothing from one account should be readable after signing out on a shared machine. */
export async function clearLocalData() {
  await Promise.all([db.rooms.clear(), db.messages.clear(), db.outbox.clear(), db.keys.clear()]);
}
