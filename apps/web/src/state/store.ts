import { create } from 'zustand';
import type { MessageDTO, NotificationDTO, Posture, ReceiptEvent, RoomDTO, SelfDTO, TypingEvent } from '@strata/shared';

/** A message written here that the server hasn't confirmed yet. */
export interface PendingMessage {
  clientMessageId: string;
  roomId: string;
  text: string;
  posture: Posture;
  replyToId?: string;
  ackDeadline?: string;
  createdAt: number;
  failed: boolean;
}

export interface RoomMessages {
  items: MessageDTO[];
  hasMore: boolean;
  loaded: boolean;
  /** Highest revision we've seen. `/sync` continues from here after a reconnect. */
  rev: number;
}

const EMPTY: RoomMessages = { items: [], hasMore: false, loaded: false, rev: 0 };

interface State {
  me: SelfDTO | null;
  sessionId: string | null;
  authStatus: 'loading' | 'anon' | 'ready';
  connection: 'connecting' | 'online' | 'offline';
  rooms: Record<string, RoomDTO>;
  roomsLoaded: boolean;
  messages: Record<string, RoomMessages>;
  pending: Record<string, PendingMessage[]>;
  online: Record<string, true>;
  typing: Record<string, Record<string, { name: string; until: number }>>;
  notifications: NotificationDTO[];
  canvasOpen: boolean;
  toast: { id: number; text: string; tone: 'info' | 'error' } | null;

  setAuth(me: SelfDTO | null, sessionId?: string | null): void;
  setRooms(rooms: RoomDTO[]): void;
  upsertRoom(room: RoomDTO): void;
  patchRoom(id: string, patch: Partial<RoomDTO>): void;
  removeRoom(id: string): void;
  setPage(roomId: string, page: { messages: MessageDTO[]; hasMore: boolean }, mode: 'replace' | 'older'): void;
  upsertMessages(roomId: string, messages: MessageDTO[]): void;
  addPending(p: PendingMessage): void;
  setPendingFailed(roomId: string, clientMessageId: string, failed: boolean): void;
  dropPending(roomId: string, clientMessageId: string): void;
  applyReceipt(e: ReceiptEvent): void;
  setTyping(e: TypingEvent): void;
  setPresence(userId: string, online: boolean): void;
  addNotification(n: NotificationDTO): void;
  setNotifications(n: NotificationDTO[]): void;
  setCanvasOpen(open: boolean): void;
  showToast(text: string, tone?: 'info' | 'error'): void;
  reset(): void;
}

const savedCanvas = () => {
  try {
    return localStorage.getItem('strata:canvas') !== 'closed';
  } catch {
    return true;
  }
};

/** Merges by id. A copy with a lower revision is stale, because socket events can arrive out of order. */
export function mergeMessages(existing: MessageDTO[], incoming: MessageDTO[]): MessageDTO[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const message of incoming) {
    const current = byId.get(message.id);
    if (!current || message.rev >= current.rev) byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

const initial = {
  me: null,
  sessionId: null,
  connection: 'connecting' as const,
  rooms: {},
  roomsLoaded: false,
  messages: {},
  pending: {},
  online: {},
  typing: {},
  notifications: [],
  toast: null,
};

export const useStore = create<State>((set) => ({
  ...initial,
  authStatus: 'loading',
  canvasOpen: savedCanvas(),

  setAuth: (me, sessionId = null) => set({ me, sessionId, authStatus: me ? 'ready' : 'anon' }),

  setRooms: (rooms) => set({ rooms: Object.fromEntries(rooms.map((r) => [r.id, r])), roomsLoaded: true }),
  upsertRoom: (room) => set((s) => ({ rooms: { ...s.rooms, [room.id]: room } })),
  patchRoom: (id, patch) =>
    set((s) => {
      const room = s.rooms[id];
      return room ? { rooms: { ...s.rooms, [id]: { ...room, ...patch } } } : s;
    }),
  removeRoom: (id) =>
    set((s) => {
      const { [id]: _gone, ...rest } = s.rooms;
      return { rooms: rest };
    }),

  setPage: (roomId, page, mode) =>
    set((s) => {
      const current = s.messages[roomId] ?? EMPTY;
      const items = mode === 'replace' ? mergeMessages([], page.messages) : mergeMessages(current.items, page.messages);
      const rev = items.reduce((max, m) => Math.max(max, m.rev), current.rev);
      return { messages: { ...s.messages, [roomId]: { items, hasMore: page.hasMore, loaded: true, rev } } };
    }),

  upsertMessages: (roomId, messages) =>
    set((s) => {
      const current = s.messages[roomId] ?? EMPTY;
      const items = mergeMessages(current.items, messages);
      const rev = messages.reduce((max, m) => Math.max(max, m.rev), current.rev);
      const confirmed = new Set(messages.map((m) => m.clientMessageId));
      const pending = (s.pending[roomId] ?? []).filter((p) => !confirmed.has(p.clientMessageId));
      return {
        messages: { ...s.messages, [roomId]: { ...current, items, rev } },
        pending: { ...s.pending, [roomId]: pending },
      };
    }),

  addPending: (p) => set((s) => ({ pending: { ...s.pending, [p.roomId]: [...(s.pending[p.roomId] ?? []), p] } })),
  setPendingFailed: (roomId, clientMessageId, failed) =>
    set((s) => ({
      pending: {
        ...s.pending,
        [roomId]: (s.pending[roomId] ?? []).map((p) => (p.clientMessageId === clientMessageId ? { ...p, failed } : p)),
      },
    })),
  dropPending: (roomId, clientMessageId) =>
    set((s) => ({
      pending: { ...s.pending, [roomId]: (s.pending[roomId] ?? []).filter((p) => p.clientMessageId !== clientMessageId) },
    })),

  applyReceipt: (e) =>
    set((s) => {
      const room = s.rooms[e.roomId];
      if (!room) return s;
      const members = room.members.map((m) =>
        m.userId === e.principalId ? { ...m, lastDeliveredSeq: e.deliveredSeq, lastReadSeq: e.readSeq } : m,
      );
      return { rooms: { ...s.rooms, [e.roomId]: { ...room, members } } };
    }),

  setTyping: (e) =>
    set((s) => {
      const room = { ...(s.typing[e.roomId] ?? {}) };
      if (e.active) room[e.principalId] = { name: e.name, until: Date.now() + 4000 };
      else delete room[e.principalId];
      return { typing: { ...s.typing, [e.roomId]: room } };
    }),

  setPresence: (userId, online) =>
    set((s) => {
      const next = { ...s.online };
      if (online) next[userId] = true;
      else delete next[userId];
      return { online: next };
    }),

  addNotification: (n) => set((s) => ({ notifications: [n, ...s.notifications.filter((x) => x.id !== n.id)].slice(0, 50) })),
  setNotifications: (notifications) => set({ notifications }),

  setCanvasOpen: (canvasOpen) => {
    try {
      localStorage.setItem('strata:canvas', canvasOpen ? 'open' : 'closed');
    } catch {
      // Private windows can refuse storage. The panel still works for this visit.
    }
    set({ canvasOpen });
  },

  showToast: (text, tone = 'info') => set({ toast: { id: Date.now(), text, tone } }),

  reset: () => set({ ...initial, authStatus: 'anon' }),
}));

export const toast = (text: string, tone: 'info' | 'error' = 'info') => useStore.getState().showToast(text, tone);
export const toastError = (err: unknown) => toast(err instanceof Error ? err.message : 'Something went wrong', 'error');
