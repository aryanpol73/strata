import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server, type Socket } from 'socket.io';
import { LIMITS, type ClientToServerEvents, type ServerToClientEvents } from '@strata/shared';
import { getEnv } from '../config/env.js';
import { AppError, unauthenticated } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { connectRedis } from '../lib/redis.js';
import { TokenBucket } from '../lib/tokenBucket.js';
import { GUEST_AUDIENCE, USER_AUDIENCE, peekAudience } from '../lib/tokens.js';
import { RoomMember } from '../models/rooms.js';
import { authenticateUser, type AuthedUser, type GuestContext } from '../modules/auth/middleware.js';
import { applyBlockUpdate, joinBlock, type BlockPrincipal } from '../modules/blocks/service.js';
import { authenticateGuest } from '../modules/guests/service.js';
import { markDelivered } from '../modules/rooms/service.js';
import { channels, hub } from './hub.js';

interface SocketData {
  userId?: string;
  user?: AuthedUser;
  guest?: GuestContext;
  lastTypingAt?: number;
  budget?: TokenBucket;
}
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

const TYPING_INTERVAL_MS = 800;
/** The client sends at most about eight updates a second, so this only ever refuses something abnormal. */
const SOCKET_BURST = 60;
const SOCKET_REFILL_PER_SECOND = 20;

/** Throws when this connection has used up its budget. Every write that reaches the database passes through here. */
function spend(socket: AppSocket) {
  if (!getEnv().RATE_LIMITS_ENABLED) return;
  socket.data.budget ??= new TokenBucket(SOCKET_BURST, SOCKET_REFILL_PER_SECOND);
  if (!socket.data.budget.take()) throw new AppError(429, 'RATE_LIMITED', 'Slow down');
}

const asBytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
};

function principalOf(socket: AppSocket): BlockPrincipal {
  const { user, guest } = socket.data;
  if (user) return { kind: 'user', id: user.id, name: user.name };
  if (guest) return { kind: 'guest', id: guest.sessionId, name: guest.name, guest };
  throw unauthenticated();
}

/** Turns a failure into the ack shape, keeping internal errors out of client view. */
function failure(err: unknown) {
  if (err instanceof AppError) return { ok: false as const, code: err.code, message: err.message };
  logger.error({ err }, 'socket handler failed');
  return { ok: false as const, code: 'INTERNAL', message: 'Something went wrong' };
}

async function joinUserChannels(socket: AppSocket, user: AuthedUser) {
  const memberships = await RoomMember.find({ userId: user.id, leftAt: null }).select('roomId').lean();
  const roomIds = memberships.map((m) => String(m.roomId));
  await socket.join([channels.user(user.id), channels.session(user.sessionId), ...roomIds.map(channels.room)]);
  return roomIds;
}

async function announcePresence(io: Server, socket: AppSocket, user: AuthedUser, roomIds: string[]) {
  if (!roomIds.length) return;
  const peers = await RoomMember.find({ roomId: { $in: roomIds }, leftAt: null, userId: { $ne: user.id } }).distinct('userId');
  const online = await hub.onlineUsers(peers.map(String));
  online.forEach((userId) => socket.emit('presence', { userId, online: true }));
  io.to(roomIds.map(channels.room)).except(channels.user(user.id)).emit('presence', { userId: user.id, online: true });
}

function attachMemberEvents(io: Server, socket: AppSocket, user: AuthedUser, roomIds: string[]) {
  socket.on('receipt:delivered', ({ roomId, seq }) => {
    // Channel membership is maintained by the hub as people join and leave, so it reflects current access.
    if (!socket.rooms.has(channels.room(String(roomId))) || !Number.isInteger(seq)) return;
    try {
      spend(socket);
    } catch {
      return; // A receipt is only a watermark, and the next one covers this one.
    }
    markDelivered(roomId, user.id, seq).catch((err) => logger.warn({ err }, 'receipt failed'));
  });

  socket.on('disconnect', async () => {
    const remaining = await hub.onlineUsers([user.id]).catch(() => [user.id]);
    if (remaining.length === 0) {
      io.to(roomIds.map(channels.room)).emit('presence', { userId: user.id, online: false });
    }
  });
}

function attachSharedEvents(socket: AppSocket) {
  const typingRoom = (roomId: string) => {
    const { guest } = socket.data;
    if (guest) return String(guest.roomId) === roomId ? roomId : null;
    return socket.rooms.has(channels.room(roomId)) ? roomId : null;
  };

  socket.on('typing', ({ roomId, active }) => {
    const target = typingRoom(String(roomId));
    if (!target) return;
    const now = Date.now();
    if (active && now - (socket.data.lastTypingAt ?? 0) < TYPING_INTERVAL_MS) return;
    socket.data.lastTypingAt = now;
    const { id, name } = principalOf(socket);
    hub.toRoomExcept(target, socket.id, 'typing', { roomId: target, principalId: id, name, active: !!active });
  });

  socket.on('block:join', async ({ blockId, stateVector }, ack) => {
    if (typeof ack !== 'function') return;
    try {
      spend(socket);
      const vector = stateVector ? (asBytes(stateVector) ?? undefined) : undefined;
      const { roomId: _roomId, ...result } = await joinBlock(String(blockId), principalOf(socket), vector);
      ack({ ok: true, data: result });
    } catch (err) {
      ack(failure(err));
    }
  });

  socket.on('block:update', async ({ blockId, update, clientUpdateId }, ack) => {
    if (typeof ack !== 'function') return;
    try {
      spend(socket);
      const bytes = asBytes(update);
      if (!bytes || bytes.byteLength > LIMITS.blockUpdateBytes || typeof clientUpdateId !== 'string') {
        throw new AppError(422, 'BLOCK_UPDATE_REJECTED', 'Invalid update');
      }
      const principal = principalOf(socket);
      const result = await applyBlockUpdate(String(blockId), principal, bytes, clientUpdateId);
      ack({ ok: true, data: { seq: result.seq } });
      if (!result.duplicate) {
        hub.toRoomExcept(result.roomId, socket.id, 'block:update', {
          blockId: String(blockId),
          seq: result.seq,
          update: bytes,
          origin: principal.id,
        });
      }
    } catch (err) {
      ack(failure(err));
    }
  });
}

export function createGateway(httpServer: HttpServer) {
  const env = getEnv();
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
    cors: { origin: env.CORS_ORIGINS.split(','), credentials: true },
    maxHttpBufferSize: LIMITS.blockUpdateBytes + 4096,
  });

  const pub = connectRedis();
  const sub = connectRedis();
  if (pub && sub) io.adapter(createAdapter(pub, sub));

  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: string }).token;
      if (!token) throw unauthenticated();
      const audience = peekAudience(token);
      if (audience === USER_AUDIENCE) {
        const user = await authenticateUser(token);
        socket.data.user = user;
        socket.data.userId = user.id;
      } else if (audience === GUEST_AUDIENCE) {
        socket.data.guest = await authenticateGuest(token);
      } else {
        throw unauthenticated();
      }
      next();
    } catch {
      next(new Error('unauthenticated'));
    }
  });

  io.on('connection', async (socket: AppSocket) => {
    try {
      const { user, guest } = socket.data;
      attachSharedEvents(socket);
      if (user) {
        const roomIds = await joinUserChannels(socket, user);
        attachMemberEvents(io as unknown as Server, socket, user, roomIds);
        await announcePresence(io as unknown as Server, socket, user, roomIds);
      } else if (guest) {
        const roomId = String(guest.roomId);
        await socket.join([
          channels.guestAll(roomId),
          guest.scope.blocks ? channels.guestBlocks(roomId) : channels.guestNoBlocks(roomId),
          ...(guest.scope.canvas ? [channels.guestCanvas(roomId)] : []),
          channels.guestCapability(guest.capabilityId),
          channels.guestSession(guest.sessionId),
        ]);
      }
    } catch (err) {
      logger.error({ err }, 'socket setup failed');
      socket.disconnect(true);
    }
  });

  hub.attach(io);
  return io;
}
