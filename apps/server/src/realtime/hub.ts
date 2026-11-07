import type { Server } from 'socket.io';
import type { ClientToServerEvents, MessageDTO, ServerToClientEvents } from '@strata/shared';

type Io = Server<ClientToServerEvents, ServerToClientEvents>;
type EventName = keyof ServerToClientEvents;
type Payload<E extends EventName> = Parameters<ServerToClientEvents[E]>[0];

export const channels = {
  user: (id: string) => `user:${id}`,
  session: (id: string) => `session:${id}`,
  room: (id: string) => `room:${id}`,
  guestAll: (roomId: string) => `guest:${roomId}`,
  guestBlocks: (roomId: string) => `guest:${roomId}:blocks`,
  guestNoBlocks: (roomId: string) => `guest:${roomId}:noblocks`,
  guestCanvas: (roomId: string) => `guest:${roomId}:canvas`,
  guestCapability: (capabilityId: string) => `guestcap:${capabilityId}`,
  guestSession: (sessionId: string) => `guestsession:${sessionId}`,
};

/** A guest never sees how a message connects to anything beyond the branch. */
export function toGuestMessage(message: MessageDTO, canSeeBlocks: boolean): MessageDTO {
  const base: MessageDTO = { ...message, branchCount: 0, refCount: 0, ack: null, clientMessageId: null };
  if (message.payload.type === 'resolution') {
    // The sender id of a resolution card names the branch it came from, so it goes as well as the payload.
    return {
      ...base,
      sender: { type: 'system', id: 'system', name: 'Strata' },
      payload: { type: 'system', text: 'A side discussion was resolved.' },
    };
  }
  if (message.payload.type === 'block' && !canSeeBlocks) {
    return { ...base, payload: { type: 'system', text: 'A shared block was added.' } };
  }
  return base;
}

interface GuestRoute {
  channel: (roomId: string) => string;
  transform: (payload: never) => unknown;
}

const messageRoutes = (event: 'message:new' | 'message:updated'): [EventName, GuestRoute[]] => [
  event,
  [
    {
      channel: channels.guestBlocks,
      transform: (e: Payload<typeof event>) => ({ message: toGuestMessage(e.message, true) }),
    },
    {
      channel: channels.guestNoBlocks,
      transform: (e: Payload<typeof event>) => ({ message: toGuestMessage(e.message, false) }),
    },
  ] as GuestRoute[],
];

/**
 * The complete list of what guests receive. It is an allowlist on purpose: an event added to the product later
 * reaches guests only if someone writes a route for it here, along with what to strip from it.
 */
const GUEST_ROUTES = new Map<EventName, GuestRoute[]>([
  messageRoutes('message:new'),
  messageRoutes('message:updated'),
  ['typing', [{ channel: channels.guestAll, transform: (e: never) => e }]],
  [
    'branch:updated',
    [
      {
        channel: channels.guestAll,
        transform: (e: Payload<'branch:updated'>) => ({
          roomId: e.roomId,
          parentRoomId: null,
          branch: { status: e.branch.status, title: e.branch.title },
        }),
      },
    ],
  ],
  ['block:update', [{ channel: channels.guestBlocks, transform: (e: never) => e }]],
  ['canvas:changed', [{ channel: channels.guestCanvas, transform: (e: never) => e }]],
] as [EventName, GuestRoute[]][]);

let io: Io | null = null;

export const hub = {
  attach(server: Io) {
    io = server;
  },
  detach() {
    io = null;
  },

  /** Reaches room members, plus guests for allowlisted events only. */
  toRoom<E extends EventName>(roomId: string, event: E, payload: Payload<E>) {
    if (!io) return;
    (io.to(channels.room(roomId)) as unknown as { emit: (e: string, p: unknown) => void }).emit(event, payload);
    for (const route of GUEST_ROUTES.get(event) ?? []) {
      (io.to(route.channel(roomId)) as unknown as { emit: (e: string, p: unknown) => void }).emit(
        event,
        route.transform(payload as never),
      );
    }
  },

  /** Reaches room members except one socket: the sender of a block update already has its own change. */
  toRoomExcept<E extends EventName>(roomId: string, exceptSocketId: string, event: E, payload: Payload<E>) {
    if (!io) return;
    const emitTo = (channel: string, body: unknown) =>
      (io!.to(channel).except(exceptSocketId) as unknown as { emit: (e: string, p: unknown) => void }).emit(event, body);
    emitTo(channels.room(roomId), payload);
    for (const route of GUEST_ROUTES.get(event) ?? []) emitTo(route.channel(roomId), route.transform(payload as never));
  },

  toUser<E extends EventName>(userId: string, event: E, payload: Payload<E>) {
    if (!io) return;
    (io.to(channels.user(userId)) as unknown as { emit: (e: string, p: unknown) => void }).emit(event, payload);
  },

  joinRoom(userId: string, roomId: string) {
    io?.in(channels.user(userId)).socketsJoin(channels.room(roomId));
    this.toUser(userId, 'room:joined', { roomId });
  },

  leaveRoom(userId: string, roomId: string) {
    io?.in(channels.user(userId)).socketsLeave(channels.room(roomId));
    this.toUser(userId, 'room:left', { roomId });
  },

  disconnectSession(sessionId: string, reason: string) {
    if (!io) return;
    io.to(channels.session(sessionId)).emit('session:revoked', { reason });
    io.in(channels.session(sessionId)).disconnectSockets(true);
  },

  disconnectCapability(capabilityId: string, reason: string) {
    if (!io) return;
    io.to(channels.guestCapability(capabilityId)).emit('session:revoked', { reason });
    io.in(channels.guestCapability(capabilityId)).disconnectSockets(true);
  },

  disconnectGuestSession(sessionId: string, reason: string) {
    if (!io) return;
    io.to(channels.guestSession(sessionId)).emit('session:revoked', { reason });
    io.in(channels.guestSession(sessionId)).disconnectSockets(true);
  },

  /** People with at least one window open and in front. A tab left in the background doesn't count. */
  async activeUsers(userIds: string[]): Promise<string[]> {
    if (!io || userIds.length === 0) return [];
    const sockets = await io.in(userIds.map(channels.user)).fetchSockets();
    const active = sockets.filter((s) => (s.data as { visible?: boolean }).visible === true);
    return [...new Set(active.map((s) => (s.data as { userId?: string }).userId).filter((id): id is string => !!id))];
  },

  async onlineUsers(userIds: string[]): Promise<string[]> {
    if (!io || userIds.length === 0) return [];
    const sockets = await io.in(userIds.map(channels.user)).fetchSockets();
    return [...new Set(sockets.map((s) => (s.data as { userId?: string }).userId).filter((id): id is string => !!id))];
  },
};
