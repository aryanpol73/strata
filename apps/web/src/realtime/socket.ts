import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@strata/shared';
import { client } from '../api/client';
import { ensureRoomKeys } from '../features/e2ee/service';
import { handleRevoked, loadNeedsYou, loadNotifications, loadRoom, resync } from '../state/actions';
import { cacheMessages } from '../state/db';
import { useStore } from '../state/store';

export type StrataSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: StrataSocket | null = null;
const connectListeners = new Set<() => void>();

export const getSocket = () => socket;

// A dead connection can take most of a minute to time out. The browser knows sooner, so act on what it says.
const goOffline = () => socket?.disconnect();
const goOnline = () => socket?.connect();

/** Live blocks use this to rejoin and reconcile after a dropped connection. */
export function onConnected(fn: () => void) {
  connectListeners.add(fn);
  return () => connectListeners.delete(fn);
}

const get = useStore.getState;

export function connectSocket() {
  if (socket) return socket;
  let firstConnect = true;

  const s: StrataSocket = io({
    // Called on every attempt, so that a reconnect always uses a fresh token.
    auth: (cb) => {
      void (async () => {
        if (!firstConnect) await client.refresh().catch(() => {});
        cb({ token: client.getToken() });
      })();
    },
    transports: ['websocket', 'polling'],
    reconnectionDelayMax: 8000,
  });
  socket = s;
  window.addEventListener('offline', goOffline);
  window.addEventListener('online', goOnline);

  /** Which window is in front decides where an alert goes: here, or to the phone as a push. */
  const tellVisibility = () => s.emit('client:visibility', { visible: document.visibilityState === 'visible' });
  document.addEventListener('visibilitychange', tellVisibility);

  s.on('connect', () => {
    useStore.setState({ connection: 'online' });
    tellVisibility();
    if (!firstConnect) void resync();
    firstConnect = false;
    connectListeners.forEach((fn) => fn());
  });
  s.on('disconnect', () => useStore.setState({ connection: 'offline' }));
  s.on('connect_error', () => useStore.setState({ connection: 'offline' }));

  s.on('message:new', ({ message }) => {
    get().upsertMessages(message.roomId, [message]);
    void cacheMessages(message.roomId, [message]).catch(() => {});

    const state = get();
    const room = state.rooms[message.roomId];
    if (!room) return;
    const mine = message.sender.id === state.me?.id;
    const quiet = message.posture === 'whisper';
    state.patchRoom(message.roomId, {
      rev: Math.max(room.rev, message.rev),
      lastMessage: {
        seq: message.seq,
        senderName: message.sender.name,
        text: previewOf(message),
        posture: message.posture,
        at: message.createdAt,
      },
      me: mine ? room.me : { ...room.me, unread: room.me.unread + (quiet ? 0 : 1), quietUnread: room.me.quietUnread + (quiet ? 1 : 0) },
    });
    if (!mine) s.emit('receipt:delivered', { roomId: message.roomId, seq: message.seq });
    if (!mine && message.posture === 'blocking_ack') void loadNeedsYou().catch(() => {});
  });

  s.on('message:updated', ({ message }) => {
    get().upsertMessages(message.roomId, [message]);
    void cacheMessages(message.roomId, [message]).catch(() => {});
  });

  s.on('receipt', (e) => get().applyReceipt(e));
  s.on('typing', (e) => get().setTyping(e));
  s.on('presence', ({ userId, online }) => get().setPresence(userId, online));
  s.on('notification:new', ({ notification }) => {
    get().addNotification(notification);
    // Someone already reading the conversation doesn't need telling about what's on screen.
    const reading = document.visibilityState === 'visible' && !!notification.roomId && location.pathname === `/r/${notification.roomId}`;
    if (reading && notification.kind === 'message' && notification.posture !== 'blocking_ack') return;
    get().showToast(notification.kind === 'message' ? `${notification.title}: ${notification.body}` : notification.title);
  });

  s.on('room:joined', ({ roomId }) => void loadRoom(roomId).then(() => ensureRoomKeys(roomId)).catch(() => {}));
  s.on('keys:updated', ({ roomId }) => void ensureRoomKeys(roomId).catch(() => {}));
  s.on('room:left', ({ roomId }) => get().removeRoom(roomId));
  s.on('room:updated', ({ room }) => get().patchRoom(room.id, room));
  s.on('member:updated', ({ roomId }) => void loadRoom(roomId).then(() => ensureRoomKeys(roomId)).catch(() => {}));
  s.on('branch:updated', ({ roomId, branch }) => {
    const room = get().rooms[roomId];
    if (room?.branch) get().patchRoom(roomId, { branch: { ...room.branch, ...branch } });
    window.dispatchEvent(new CustomEvent('strata:branches'));
  });
  s.on('canvas:changed', (e) => window.dispatchEvent(new CustomEvent('strata:canvas', { detail: e })));
  s.on('ack:updated', () => {
    void loadNotifications().catch(() => {});
    void loadNeedsYou().catch(() => {});
  });
  s.on('session:revoked', () => void handleRevoked());

  return s;
}

function previewOf(message: { payload: { type: string } & Record<string, unknown> }): string {
  const p = message.payload;
  if (p.type === 'text') return String(p.text).slice(0, 140);
  if (p.type === 'encrypted') return 'Encrypted message';
  if (p.type === 'media') return String(p.caption || p.name);
  if (p.type === 'block') return String(p.title);
  if (p.type === 'resolution') return `Resolved: ${String(p.summary).slice(0, 120)}`;
  return String(p.text ?? '');
}

export function disconnectSocket() {
  window.removeEventListener('offline', goOffline);
  window.removeEventListener('online', goOnline);
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
}

