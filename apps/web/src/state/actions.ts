import type { AuthResponse, MessageDTO, MessagePage, NeedsYouDTO, NotificationDTO, Posture, RoomDTO, SyncResponse } from '@strata/shared';
import { ApiError, CLIENT_HEADER, api, client, setSignedOutHandler } from '../api/client';
import { ensureRoomKeys, forgetE2ee, initE2ee, rememberClear, sealMessage, syncEncryptedRooms } from '../features/e2ee/service';
import { adoptAppearance } from '../features/settings/appearance';
import { syncPush } from '../features/settings/push';
import { connectSocket, disconnectSocket } from '../realtime/socket';
import { cacheMessages, cachedMessages, clearLocalData, db } from './db';
import { useStore, type PendingMessage } from './store';

const get = useStore.getState;

const newId = () => crypto.randomUUID();
const flushOnline = () => void flushOutbox();
const START_RETRY_MS = 4000;
/** How long the server may take before the app opens from what's saved on this device. */
const SLOW_START_MS = 3000;

async function enter(res: AuthResponse) {
  client.setToken(res.accessToken);
  useStore.setState({ waking: false });
  get().setAuth(res.user, res.sessionId);
  adoptAppearance(res.user.appearance);
  // Settled before anything is shown, so the app never appears for a moment and then gets covered by the unlock screen.
  await initE2ee();
  connectSocket();
  // HTTP can fail while the socket stays up, so waiting for a reconnect alone could strand the outbox.
  window.removeEventListener('online', flushOnline);
  window.addEventListener('online', flushOnline);
  await Promise.all([loadRooms(), loadNotifications(), loadNeedsYou()]);
  // Having said yes once, this device keeps receiving pushes after sign-ins, new accounts and cleared subscriptions.
  void syncPush().catch(() => {});
  void syncEncryptedRooms().catch(() => {});
  await syncTimezone();
  await restoreOutbox();
}

/** Tabs share a rotating cookie, so this takes the same lock as every other refresh. */
const refreshSession = (patience?: number) => {
  const run = () =>
    fetch('/api/auth/refresh', { method: 'POST', headers: CLIENT_HEADER, credentials: 'same-origin', signal: patience ? AbortSignal.timeout(patience) : undefined });
  return navigator.locks ? navigator.locks.request('strata-refresh', run) : run();
};

async function start() {
  setSignedOutHandler(() => void endSession());
  // The cache paints the sidebar before the network answers, and it's all there is when offline.
  const cached = await db.rooms.toArray().catch(() => []);
  try {
    // With something saved to show, don't make anyone watch a spinner while a sleeping server wakes. Without it there's
    // nothing to show yet, so wait as long as it takes.
    const res = await refreshSession(cached.length ? SLOW_START_MS : undefined);
    if (res.ok) return await enter((await res.json()) as AuthResponse);
    get().setAuth(null);
  } catch {
    if (cached.length) {
      get().setRooms(cached);
      const waking = navigator.onLine;
      useStore.setState({ authStatus: 'ready', connection: waking ? 'connecting' : 'offline', waking, me: JSON.parse(localStorage.getItem('strata:me') ?? 'null') });
      void initE2ee();
      retryStartWhenOnline();
    } else {
      get().setAuth(null);
    }
  }
}

/**
 * Started without a network, so there's no token and no socket yet. The `online` event can fire a moment before the
 * network actually works, so it can't be the only trigger: a timer keeps trying as well.
 */
function retryStartWhenOnline() {
  const retry = () => {
    clearTimeout(timer);
    window.removeEventListener('online', retry);
    starting = null;
    void bootstrap();
  };
  const timer = setTimeout(retry, START_RETRY_MS);
  window.addEventListener('online', retry);
}

let starting: Promise<void> | null = null;

/** Runs once per page, however many times it's called. */
export function bootstrap() {
  starting ??= start();
  return starting;
}

export async function login(email: string, password: string) {
  await enter(await api<AuthResponse>('/auth/login', { method: 'POST', body: { email, password, deviceName: deviceName() } }));
}

export async function register(input: { email: string; password: string; displayName: string; handle: string }) {
  await enter(await api<AuthResponse>('/auth/register', { method: 'POST', body: { ...input, deviceName: deviceName() } }));
}

function deviceName() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os && `on ${os}`].filter(Boolean).join(' ');
}

async function endSession() {
  disconnectSocket();
  client.setToken(null);
  localStorage.removeItem('strata:me');
  await clearLocalData().catch(() => {});
  await forgetE2ee();
  get().reset();
}

export async function logout() {
  await api('/auth/logout', { method: 'POST', headers: CLIENT_HEADER }).catch(() => {});
  await endSession();
}

export const handleRevoked = endSession;

/** Digests and quiet hours run on the recipient's clock, so the server needs to know what that clock is. */
async function syncTimezone() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { preferences } = await api<{ preferences: { timezone: string } }>('/notifications/preferences');
  if (preferences.timezone === 'UTC' && tz && tz !== 'UTC') {
    await api('/notifications/preferences', { method: 'PUT', body: { ...preferences, timezone: tz } });
  }
}

export async function loadRooms() {
  const { rooms } = await api<{ rooms: RoomDTO[] }>('/rooms');
  get().setRooms(rooms);
  const me = get().me;
  if (me) localStorage.setItem('strata:me', JSON.stringify(me));
  await db.rooms.clear();
  await db.rooms.bulkPut(rooms);
}

export async function loadRoom(id: string): Promise<RoomDTO> {
  const { room } = await api<{ room: RoomDTO }>(`/rooms/${id}`);
  get().upsertRoom(room);
  return room;
}

export async function loadNotifications() {
  const { notifications } = await api<{ notifications: NotificationDTO[] }>('/notifications');
  get().setNotifications(notifications);
}

export async function loadNeedsYou() {
  const { items } = await api<{ items: NeedsYouDTO[] }>('/notifications/needs-you');
  useStore.setState({ needsYou: items });
}

export async function acknowledge(messageId: string) {
  await api(`/messages/${messageId}/ack`, { method: 'POST' });
  await loadNeedsYou();
}

export async function loadMessages(roomId: string, aroundSeq?: number) {
  if (!get().messages[roomId]?.loaded) {
    const cached = await cachedMessages(roomId).catch(() => []);
    if (cached.length) get().upsertMessages(roomId, cached);
  }
  try {
    const page = await api<MessagePage>(`/rooms/${roomId}/messages`, { query: { aroundSeq, limit: 50 } });
    get().setPage(roomId, page, aroundSeq ? 'older' : 'replace');
    void cacheMessages(roomId, page.messages).catch(() => {});
  } catch (err) {
    // Offline, the cached copy is the view. Anything else is a real problem.
    if (!(err instanceof ApiError && err.code === 'NETWORK')) throw err;
  }
}

export async function loadOlder(roomId: string) {
  const first = get().messages[roomId]?.items[0];
  if (!first) return;
  const page = await api<MessagePage>(`/rooms/${roomId}/messages`, { query: { beforeSeq: first.seq, limit: 50 } });
  get().setPage(roomId, page, 'older');
}

/** Repairs everything missed while disconnected: new messages, edits and deletions alike. */
export async function resync() {
  const { messages } = get();
  await loadRooms().catch(() => {});
  await Promise.all(
    Object.entries(messages)
      .filter(([, m]) => m.loaded)
      .map(async ([roomId, m]) => {
        const res = await api<SyncResponse>(`/rooms/${roomId}/sync`, { query: { sinceRev: m.rev } }).catch(() => null);
        if (!res) return;
        if (res.truncated) await loadMessages(roomId);
        else get().upsertMessages(roomId, res.messages);
      }),
  );
  await flushOutbox();
}

interface SendOptions {
  replyToId?: string;
  posture: Posture;
  ackDeadline?: string;
}

/**
 * Only a definite refusal drops a message from the outbox. Being offline, a server having a bad moment, or a rate limit
 * all say nothing about the message itself, so it stays queued and goes out later.
 */
const isRetryable = (err: unknown) => err instanceof ApiError && (err.code === 'NETWORK' || err.status === 429 || err.status >= 500);

async function deliver(p: PendingMessage) {
  // Between the network returning and sign-in finishing there's no token yet, which isn't the message's fault.
  if (!client.getToken()) throw new ApiError(0, 'NETWORK', 'Not connected yet');
  // Encrypted here, at the last moment, so what's kept in the outbox while offline is the only plaintext left on the device.
  const encrypted = get().rooms[p.roomId]?.encryption?.enabled;
  const content = encrypted ? await sealMessage(p.roomId, p.text) : { type: 'text' as const, text: p.text };
  const { message } = await api<{ message: MessageDTO }>(`/rooms/${p.roomId}/messages`, {
    method: 'POST',
    body: {
      clientMessageId: p.clientMessageId,
      content,
      replyToId: p.replyToId,
      posture: p.posture,
      ackDeadline: p.ackDeadline,
    },
  });
  await db.outbox.delete(p.clientMessageId);
  // A retry can be stored from an earlier attempt's ciphertext, so remember the one the server actually kept.
  if (message.payload.type === 'encrypted') rememberClear(message.id, message.payload.ct, p.text);
  get().upsertMessages(p.roomId, [message]);
}

export async function editMessageText(m: MessageDTO, text: string) {
  if (m.payload.type !== 'encrypted') return void (await api(`/messages/${m.id}`, { method: 'PATCH', body: { text } }));
  const sealed = await sealMessage(m.roomId, text);
  const { type: _type, ...encrypted } = sealed;
  const { message } = await api<{ message: MessageDTO }>(`/messages/${m.id}`, { method: 'PATCH', body: { encrypted } });
  if (message.payload.type === 'encrypted') rememberClear(message.id, message.payload.ct, text);
  get().upsertMessages(m.roomId, [message]);
}

export { ensureRoomKeys };

/** Shown straight away, kept in the outbox until confirmed, and safe to retry because the id never changes. */
export async function sendText(roomId: string, text: string, options: SendOptions) {
  const entry: PendingMessage = { clientMessageId: newId(), roomId, text, ...options, createdAt: Date.now(), failed: false };
  // Durable first: anything shown as sending has to survive the tab closing a moment later.
  await db.outbox.put({ ...entry }).catch(() => {});
  get().addPending(entry);
  try {
    await deliver(entry);
  } catch (err) {
    if (isRetryable(err)) return;
    await db.outbox.delete(entry.clientMessageId);
    get().setPendingFailed(roomId, entry.clientMessageId, true);
    throw err;
  }
}

export async function retryPending(p: PendingMessage) {
  get().setPendingFailed(p.roomId, p.clientMessageId, false);
  await db.outbox.put({ ...p }).catch(() => {});
  try {
    await deliver(p);
  } catch (err) {
    get().setPendingFailed(p.roomId, p.clientMessageId, true);
    throw err;
  }
}

async function restoreOutbox() {
  const entries = await db.outbox.orderBy('createdAt').toArray().catch(() => []);
  const known = new Set(Object.values(get().pending).flat().map((p) => p.clientMessageId));
  entries.filter((e) => !known.has(e.clientMessageId)).forEach((e) => get().addPending({ ...e, failed: false }));
  await flushOutbox();
}

let flushing = false;

export async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    const entries = await db.outbox.orderBy('createdAt').toArray().catch(() => []);
    for (const entry of entries) {
      try {
        await deliver({ ...entry, failed: false });
      } catch (err) {
        if (isRetryable(err)) break;
        await db.outbox.delete(entry.clientMessageId);
        get().setPendingFailed(entry.roomId, entry.clientMessageId, true);
      }
    }
  } finally {
    flushing = false;
  }
}

const readInFlight = new Map<string, number>();

export function markRead(roomId: string, seq: number) {
  const room = get().rooms[roomId];
  if (!room?.me.role || seq <= room.me.lastReadSeq || (readInFlight.get(roomId) ?? 0) >= seq) return;
  readInFlight.set(roomId, seq);
  get().patchRoom(roomId, { me: { ...room.me, lastReadSeq: seq, unread: 0, quietUnread: 0 } });
  void api(`/rooms/${roomId}/read`, { method: 'POST', body: { seq } }).catch(() => {});
}

export const startDirect = async (userId: string) => {
  const { room } = await api<{ room: RoomDTO }>('/rooms/direct', { method: 'POST', body: { userId } });
  get().upsertRoom(room);
  return room;
};

export const startGroup = async (name: string, memberIds: string[]) => {
  const { room } = await api<{ room: RoomDTO }>('/rooms/group', { method: 'POST', body: { name, memberIds } });
  get().upsertRoom(room);
  return room;
};
