import { create } from 'zustand';
import type { MessageDTO, RoomKeysDTO, SearchHit, SelfDTO } from '@strata/shared';
import { ApiError, api } from '../../api/client';
import { db } from '../../state/db';
import { useStore } from '../../state/store';
import { decryptText, encryptText, generateIdentity, generateRoomKey, openPrivateKey, sealPrivateKey, unwrapRoomKey, wrapContext, wrapRoomKey, type Identity } from './crypto';

export type E2eeStatus = 'idle' | 'loading' | 'needs-setup' | 'locked' | 'ready';

interface E2eeState {
  status: E2eeStatus;
  /** Bumped whenever a room key arrives, so anything waiting on keys tries again. */
  tick: number;
  /** What each message says, once opened. Kept with the ciphertext it came from, so an edit is noticed. */
  clear: Record<string, { ct: string; text: string }>;
  failed: Record<string, string>;
  /** The latest message of each conversation, for the inbox. */
  previews: Record<string, { seq: number; text: string }>;
  /** People in each conversation whose key isn't the one this device remembers. */
  changed: Record<string, { userId: string; name: string }[]>;
  unlockDismissed: boolean;
}

export const useE2ee = create<E2eeState>(() => ({ status: 'idle', tick: 0, clear: {}, failed: {}, previews: {}, changed: {}, unlockDismissed: false }));
const set = useE2ee.setState;
const bump = () => set((s) => ({ tick: s.tick + 1 }));

// Keys live in memory for use and in IndexedDB so that an offline start can still read what was already received.
let identity: Identity | null = null;
const roomKeys = new Map<string, Map<number, CryptoKey>>();

const keysFor = (roomId: string) => {
  let versions = roomKeys.get(roomId);
  if (!versions) roomKeys.set(roomId, (versions = new Map()));
  return versions;
};

async function remember(roomId: string, version: number, key: CryptoKey) {
  keysFor(roomId).set(version, key);
  await db.keys.put({ id: `room:${roomId}:${version}`, key }).catch(() => {});
}

const me = () => useStore.getState().me;

// ---- your own keys -------------------------------------------------------------------------------------------------

export async function initE2ee() {
  const self = me();
  if (!self) return;
  set({ status: 'loading' });
  if (!self.e2ee) return void set({ status: 'needs-setup' });
  const row = await db.keys.get(`identity:${self.id}`).catch(() => undefined);
  if (row?.publicKey === self.e2ee.publicKey) {
    identity = { privateKey: row.key, publicKey: row.publicKey };
    const saved = await db.keys.where('id').startsWith('room:').toArray().catch(() => []);
    for (const entry of saved) {
      const [, roomId, version] = entry.id.split(':');
      if (roomId && version) keysFor(roomId).set(Number(version), entry.key);
    }
    set({ status: 'ready' });
    bump();
    void syncAllRooms();
  } else {
    set({ status: 'locked' });
  }
}

async function activate(next: Identity, user: SelfDTO) {
  identity = next;
  useStore.setState({ me: user });
  await db.keys.put({ id: `identity:${user.id}`, key: next.privateKey, publicKey: next.publicKey });
  set({ status: 'ready', unlockDismissed: false });
  bump();
  void syncAllRooms();
}

/** First time: make a key pair, protect it with the passphrase, and publish only the public half. */
export async function setupE2ee(passphrase: string) {
  const fresh = await generateIdentity();
  const backup = await sealPrivateKey(fresh.privateKey, passphrase);
  const { user } = await api<{ user: SelfDTO }>('/e2ee/me', { method: 'PUT', body: { publicKey: fresh.publicKey, backup } });
  await activate(fresh, user);
}

/** A new device: fetch the encrypted backup and open it with the passphrase, in this browser. */
export async function unlockE2ee(passphrase: string) {
  const self = me();
  if (!self?.e2ee) throw new Error('Encryption is not set up yet');
  const backup = await api<{ publicKey: string; backup: Parameters<typeof openPrivateKey>[0] }>('/e2ee/me');
  const privateKey = await openPrivateKey(backup.backup, passphrase, backup.publicKey);
  await activate({ privateKey, publicKey: backup.publicKey }, self);
}

/** Choosing a new passphrase keeps the same keys, so nothing needs re-sharing. */
export async function changePassphrase(passphrase: string) {
  if (!identity) throw new Error('Unlock encryption first');
  const backup = await sealPrivateKey(identity.privateKey, passphrase);
  const { user } = await api<{ user: SelfDTO }>('/e2ee/me', { method: 'PUT', body: { publicKey: identity.publicKey, backup } });
  useStore.setState({ me: user });
}

/** The way out of a forgotten passphrase. Old messages stay unreadable until another member shares the keys again. */
export async function resetE2ee(passphrase: string) {
  roomKeys.clear();
  await db.keys.clear().catch(() => {});
  set({ clear: {}, failed: {}, previews: {} });
  await setupE2ee(passphrase);
}

export async function forgetE2ee() {
  identity = null;
  roomKeys.clear();
  await db.keys.clear().catch(() => {});
  set({ status: 'idle', tick: 0, clear: {}, failed: {}, previews: {}, changed: {}, unlockDismissed: false });
}

export const myPublicKey = () => identity?.publicKey ?? null;

// ---- room keys -----------------------------------------------------------------------------------------------------

const inflight = new Map<string, Promise<void>>();
const again = new Set<string>();

/**
 * Makes this device able to read and write a conversation: collects the keys sealed to us, starts the first key if
 * nobody has, replaces it after someone left, and seals what we hold for any member who is missing a copy.
 */
export function ensureRoomKeys(roomId: string): Promise<void> {
  const running = inflight.get(roomId);
  if (running) {
    again.add(roomId);
    return running;
  }
  const run = (async () => {
    try {
      do {
        again.delete(roomId);
        await syncRoom(roomId);
      } while (again.has(roomId));
    } finally {
      inflight.delete(roomId);
    }
  })();
  inflight.set(roomId, run);
  return run;
}

async function syncAllRooms() {
  const rooms = Object.values(useStore.getState().rooms).filter((r) => r.encryption?.enabled && r.me.role);
  for (const room of rooms) await ensureRoomKeys(room.id).catch(() => {});
}

export const syncEncryptedRooms = syncAllRooms;

async function seal(roomId: string, version: number, key: CryptoKey, members: RoomKeysDTO['members'], blocked: Set<string>, only?: (userId: string) => boolean) {
  const self = me()!;
  const wraps = [];
  for (const m of members) {
    if (only && !only(m.userId)) continue;
    if (blocked.has(m.userId)) continue;
    const publicKey = m.userId === self.id ? identity!.publicKey : m.publicKey;
    if (!publicKey) continue;
    wraps.push({ userId: m.userId, version, wrapped: await wrapRoomKey(key, publicKey, wrapContext(roomId, version, m.userId)) });
  }
  return wraps;
}

async function syncRoom(roomId: string) {
  const self = me();
  const room = useStore.getState().rooms[roomId];
  if (!identity || !self || !room?.encryption?.enabled) return;

  const state = await api<RoomKeysDTO>(`/e2ee/rooms/${roomId}`);
  const held = keysFor(roomId);
  for (const copy of state.mine) {
    if (held.has(copy.version)) continue;
    try {
      await remember(roomId, copy.version, await unwrapRoomKey(copy.wrapped, identity.privateKey, wrapContext(roomId, copy.version, self.id)));
    } catch {
      // A copy we can't open was sealed to a key we no longer have. Someone else has to seal it again.
    }
  }

  // A key this device has never seen for someone is remembered. A different one later is not trusted until it's accepted.
  const blocked = new Set<string>();
  const changed: { userId: string; name: string }[] = [];
  for (const m of state.members) {
    if (!m.publicKey || m.userId === self.id) continue;
    const pinned = (await db.pins.get(`${self.id}:${m.userId}`).catch(() => undefined))?.publicKey;
    if (!pinned) await db.pins.put({ id: `${self.id}:${m.userId}`, publicKey: m.publicKey }).catch(() => {});
    else if (pinned !== m.publicKey) {
      blocked.add(m.userId);
      changed.push({ userId: m.userId, name: m.displayName });
    }
  }
  set((s) => ({ changed: { ...s.changed, [roomId]: changed } }));

  let version = state.version;
  const startNew = state.version === 0 || (state.needsRotation && held.has(state.version));
  if (startNew) {
    const next = state.version + 1;
    const key = await generateRoomKey();
    try {
      await api(`/e2ee/rooms/${roomId}/keys`, { method: 'POST', body: { newVersion: next, wraps: await seal(roomId, next, key, state.members, blocked) } });
      await remember(roomId, next, key);
      version = next;
    } catch (err) {
      // Someone else got there first. Their key is the one to use, so go round again and collect it.
      if (err instanceof ApiError && err.status === 409) return void again.add(roomId);
      throw err;
    }
  } else {
    const wraps = [];
    for (const [v, key] of held) {
      wraps.push(...(await seal(roomId, v, key, state.members, blocked, (id) => id !== self.id && !state.members.find((m) => m.userId === id)?.versions.includes(v))));
    }
    if (wraps.length) await api(`/e2ee/rooms/${roomId}/keys`, { method: 'POST', body: { wraps: wraps.slice(0, 1000) } });
  }

  useStore.getState().patchRoom(roomId, { encryption: { enabled: true, keyVersion: version, needsRotation: startNew ? false : state.needsRotation } });
  bump();
  await openLatest(roomId);
}

/**
 * The inbox shows the latest message of every conversation, including ones that haven't been opened since the page loaded.
 * So once the keys are here, fetch just that one message and open it, without loading the whole conversation.
 */
async function openLatest(roomId: string) {
  const last = useStore.getState().rooms[roomId]?.lastMessage;
  if (!last || useE2ee.getState().previews[roomId]?.seq === last.seq) return;
  const { messages } = await api<{ messages: MessageDTO[] }>(`/rooms/${roomId}/messages`, { query: { limit: 1 } });
  const m = messages[0];
  const key = m?.payload.type === 'encrypted' ? roomKeys.get(roomId)?.get(m.payload.kv) : undefined;
  if (!m || m.payload.type !== 'encrypted' || !key) return;
  try {
    const text = await decryptText(key, roomId, m.payload);
    set((s) => ({ clear: { ...s.clear, [m.id]: { ct: (m.payload as { ct: string }).ct, text } }, previews: { ...s.previews, [roomId]: { seq: m.seq, text } } }));
  } catch {
    // An unreadable preview just stays as the placeholder.
  }
}

/** Accepts a person's new key, after the codes have been compared, and shares what this device holds with it. */
export async function acceptKeyChange(roomId: string, userId: string) {
  const self = me();
  if (!self) return;
  const state = await api<RoomKeysDTO>(`/e2ee/rooms/${roomId}`);
  const person = state.members.find((m) => m.userId === userId);
  if (!person?.publicKey) return;
  await db.pins.put({ id: `${self.id}:${userId}`, publicKey: person.publicKey });
  await ensureRoomKeys(roomId);
}

export type RoomCrypto = 'plain' | 'ready' | 'waiting' | 'locked' | 'setup';

/** Where a conversation stands for this device, which decides whether the composer can be used. */
export function useRoomCrypto(roomId: string): RoomCrypto {
  const encryption = useStore((s) => s.rooms[roomId]?.encryption);
  const status = useE2ee((s) => s.status);
  useE2ee((s) => s.tick);
  if (!encryption?.enabled) return 'plain';
  if (status === 'needs-setup') return 'setup';
  if (status === 'locked') return 'locked';
  if (status !== 'ready') return 'waiting';
  return !encryption.needsRotation && encryption.keyVersion > 0 && roomKeys.get(roomId)?.has(encryption.keyVersion) ? 'ready' : 'waiting';
}

// ---- messages ------------------------------------------------------------------------------------------------------

const notReady = () => new ApiError(0, 'NETWORK', 'Encryption is not ready yet');

export async function sealMessage(roomId: string, text: string) {
  let room = useStore.getState().rooms[roomId];
  if (room?.encryption.needsRotation) {
    await ensureRoomKeys(roomId);
    room = useStore.getState().rooms[roomId];
  }
  const version = room?.encryption.keyVersion ?? 0;
  const key = roomKeys.get(roomId)?.get(version);
  if (!key || version === 0) throw notReady();
  return { type: 'encrypted' as const, ...(await encryptText(key, roomId, version, text)) };
}

/** Our own messages are known the moment they're written, so they never flash as locked while the echo arrives. */
export function rememberClear(messageId: string, ct: string, text: string) {
  set((s) => ({ clear: { ...s.clear, [messageId]: { ct, text } } }));
}

export const clearText = (m: Pick<MessageDTO, 'id'>) => useE2ee.getState().clear[m.id]?.text;

async function revealAll() {
  const { messages, rooms } = useStore.getState();
  const known = useE2ee.getState();
  const opened: E2eeState['clear'] = {};
  const failed: E2eeState['failed'] = {};
  const previews: E2eeState['previews'] = {};

  for (const [roomId, bucket] of Object.entries(messages)) {
    if (!rooms[roomId]?.encryption?.enabled) continue;
    const held = roomKeys.get(roomId);
    for (const m of bucket.items) {
      if (m.payload.type !== 'encrypted' || m.deletedAt) continue;
      const { ct } = m.payload;
      const have = known.clear[m.id];
      if (have?.ct === ct) continue;
      if (known.failed[m.id] === ct) continue;
      const key = held?.get(m.payload.kv);
      if (!key) continue;
      try {
        opened[m.id] = { ct, text: await decryptText(key, roomId, m.payload) };
      } catch {
        failed[m.id] = ct;
      }
    }
    const last = bucket.items[bucket.items.length - 1];
    const text = last && (opened[last.id] ?? known.clear[last.id])?.text;
    if (last && text && rooms[roomId]?.lastMessage?.seq === last.seq) previews[roomId] = { seq: last.seq, text };
  }

  if (Object.keys(opened).length || Object.keys(failed).length || Object.keys(previews).length) {
    set((s) => ({ clear: { ...s.clear, ...opened }, failed: { ...s.failed, ...failed }, previews: { ...s.previews, ...previews } }));
  }
}

let scheduled = false;
const schedule = () => {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    void revealAll().catch(() => {});
  });
};

/** Opens messages as they arrive, and again whenever a new key does, without anything else having to ask. */
export function startReveal() {
  useStore.subscribe((s, previous) => {
    if (s.messages !== previous.messages || s.rooms !== previous.rooms) schedule();
  });
  useE2ee.subscribe((s, previous) => {
    if (s.tick !== previous.tick) schedule();
  });
}

/** The server can't search what it can't read, so encrypted conversations are searched here, in what's been opened. */
export function searchOpened(query: string): SearchHit[] {
  const needle = query.toLowerCase();
  const { clear } = useE2ee.getState();
  const { messages, rooms } = useStore.getState();
  const hits: SearchHit[] = [];
  for (const [roomId, bucket] of Object.entries(messages)) {
    const room = rooms[roomId];
    if (!room?.encryption?.enabled) continue;
    for (const m of bucket.items) {
      if (clear[m.id]?.text.toLowerCase().includes(needle)) hits.push({ message: m, roomName: room.name, roomKind: room.kind });
    }
  }
  return hits.slice(0, 25);
}
