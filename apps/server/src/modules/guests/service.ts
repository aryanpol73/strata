import { hash, verify } from '@node-rs/argon2';
import type { RequestHandler } from 'express';
import {
  createGuestLinkInput,
  type GuestLinkCreated,
  type GuestLinkDTO,
  type GuestRedeemResponse,
  type GuestRoomDTO,
  type RedeemGuestInput,
} from '@strata/shared';
import type { z } from 'zod';
import { AppError, badRequest, forbidden, notFound, unauthenticated } from '../../lib/errors.js';
import { randomToken, sha256, signGuestToken, verifyGuestToken } from '../../lib/tokens.js';
import { GuestCapability, GuestSession, type IGuestCapability, type IGuestSession } from '../../models/guests.js';
import { User } from '../../models/identity.js';
import { Room, RoomMember } from '../../models/rooms.js';
import { hub } from '../../realtime/hub.js';
import { assertAcceptsMessages, canManageBranch, requireMember } from '../access.js';
import { bearer, type GuestContext } from '../auth/middleware.js';
import { postMessage, resolveReply } from '../messages/service.js';

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MS = 15 * 60_000;

/** One message for every way a link can be bad, so a caller can't tell a revoked link from a mistyped one. */
const invalidLink = () => new AppError(404, 'GUEST_LINK_INVALID', 'This link is not valid. Ask for a new one.');

async function toLinkDTO(c: IGuestCapability): Promise<GuestLinkDTO> {
  const activeSessions = await GuestSession.countDocuments({ capabilityId: c._id, revokedAt: null, expiresAt: { $gt: new Date() } });
  return {
    id: String(c._id),
    label: c.label,
    scope: c.scope,
    hasPin: !!c.pinHash,
    expiresAt: c.expiresAt.toISOString(),
    revokedAt: c.revokedAt?.toISOString() ?? null,
    redemptions: c.redemptions,
    activeSessions,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function createLink(userId: string, branchId: string, input: z.output<typeof createGuestLinkInput>): Promise<GuestLinkCreated> {
  const { room } = await requireMember(branchId, userId);
  if (room.kind !== 'branch') throw badRequest('Guests can only be invited to a branch');
  if (room.encrypted) {
    throw new AppError(409, 'CONFLICT', 'This branch is end-to-end encrypted, so a guest could not read it. Start a branch with guests allowed instead.');
  }
  assertAcceptsMessages(room);

  const token = randomToken();
  const capability = await GuestCapability.create({
    roomId: room._id,
    createdBy: userId,
    tokenHash: sha256(token),
    label: input.label,
    scope: input.scope,
    pinHash: input.pin ? await hash(input.pin) : null,
    expiresAt: new Date(Date.now() + input.expiresInHours * 3_600_000),
  });
  return { ...(await toLinkDTO(capability.toObject())), token };
}

export async function listLinks(userId: string, branchId: string): Promise<GuestLinkDTO[]> {
  await requireMember(branchId, userId);
  const links = await GuestCapability.find({ roomId: branchId }).sort({ createdAt: -1 }).lean();
  return Promise.all(links.map(toLinkDTO));
}

export async function revokeLink(userId: string, linkId: string) {
  const capability = await GuestCapability.findById(linkId).lean();
  if (!capability) throw notFound('Link');
  const { room } = await requireMember(String(capability.roomId), userId);
  if (String(capability.createdBy) !== userId && !(await canManageBranch(room, userId))) {
    throw forbidden('Only the person who made this link can revoke it');
  }
  const now = new Date();
  await GuestCapability.updateOne({ _id: capability._id, revokedAt: null }, { revokedAt: now });
  await GuestSession.updateMany({ capabilityId: capability._id, revokedAt: null }, { revokedAt: now });
  hub.disconnectCapability(linkId, 'link_revoked');
}

const isLive = (c: IGuestCapability, now = new Date()) => !c.revokedAt && c.expiresAt > now;

async function checkPin(capability: IGuestCapability, pin: string | undefined) {
  if (!capability.pinHash) return;
  if (capability.lockedUntil && capability.lockedUntil > new Date()) {
    throw new AppError(429, 'GUEST_PIN_LOCKED', 'Too many attempts. Try again later.');
  }
  if (!pin) throw new AppError(401, 'GUEST_PIN_REQUIRED', 'Enter the PIN you were given');
  if (await verify(capability.pinHash, pin)) {
    await GuestCapability.updateOne({ _id: capability._id }, { pinAttempts: 0, lockedUntil: null });
    return;
  }
  const after = await GuestCapability.findOneAndUpdate({ _id: capability._id }, { $inc: { pinAttempts: 1 } }, { returnDocument: 'after' }).lean();
  if ((after?.pinAttempts ?? 0) >= MAX_PIN_ATTEMPTS) {
    await GuestCapability.updateOne({ _id: capability._id }, { pinAttempts: 0, lockedUntil: new Date(Date.now() + PIN_LOCK_MS) });
    throw new AppError(429, 'GUEST_PIN_LOCKED', 'Too many attempts. Try again later.');
  }
  throw new AppError(401, 'GUEST_PIN_REQUIRED', 'That PIN is not right');
}

export async function redeem(input: RedeemGuestInput): Promise<GuestRedeemResponse & { secret: string }> {
  const capability = await GuestCapability.findOne({ tokenHash: sha256(input.token) }).lean();
  if (!capability || !isLive(capability)) throw invalidLink();
  const room = await Room.findById(capability.roomId).select('branch.status').lean();
  if (!room || room.branch?.status === 'archived') throw invalidLink();

  await checkPin(capability, input.pin);

  const secret = randomToken();
  const session = await GuestSession.create({
    capabilityId: capability._id,
    roomId: capability.roomId,
    displayName: input.displayName,
    secretHash: sha256(secret),
    lastSeenAt: new Date(),
    expiresAt: capability.expiresAt,
  });
  await GuestCapability.updateOne({ _id: capability._id }, { $inc: { redemptions: 1 } });

  return {
    secret,
    accessToken: await signGuestToken(String(session._id), String(capability._id)),
    guest: { id: String(session._id), displayName: session.displayName },
    scope: capability.scope,
    expiresAt: capability.expiresAt.toISOString(),
  };
}

async function contextFor(session: IGuestSession | null): Promise<GuestContext> {
  const now = new Date();
  if (!session || session.revokedAt || session.expiresAt <= now) throw unauthenticated('This guest session has ended');
  const capability = await GuestCapability.findById(session.capabilityId).lean();
  if (!capability || !isLive(capability, now)) throw unauthenticated('This guest link is no longer active');
  return {
    sessionId: String(session._id),
    capabilityId: String(capability._id),
    roomId: capability.roomId,
    name: session.displayName,
    scope: capability.scope,
    expiresAt: capability.expiresAt,
  };
}

/** Runs on every guest request and connection, so expiry and revocation apply immediately. */
export async function authenticateGuest(token: string): Promise<GuestContext> {
  const claims = await verifyGuestToken(token);
  const session = await GuestSession.findOne({ _id: claims.sub, capabilityId: claims.cap }).lean();
  return contextFor(session);
}

export async function renewFromSecret(secret: string): Promise<GuestRedeemResponse> {
  const session = await GuestSession.findOne({ secretHash: sha256(secret) }).lean();
  const guest = await contextFor(session);
  await GuestSession.updateOne({ _id: guest.sessionId }, { lastSeenAt: new Date() });
  return {
    accessToken: await signGuestToken(guest.sessionId, guest.capabilityId),
    guest: { id: guest.sessionId, displayName: guest.name },
    scope: guest.scope,
    expiresAt: guest.expiresAt.toISOString(),
  };
}

export const requireGuest: RequestHandler = async (req, _res, next) => {
  const token = bearer(req);
  if (!token) throw unauthenticated();
  req.guest = await authenticateGuest(token);
  next();
};

export async function guestRoom(guest: GuestContext): Promise<GuestRoomDTO> {
  const room = await Room.findById(guest.roomId).select('branch.title branch.status rev').lean();
  if (!room?.branch) throw notFound('Conversation');
  const [members, guests] = await Promise.all([
    RoomMember.find({ roomId: guest.roomId, leftAt: null }).select('userId').lean(),
    GuestSession.find({ roomId: guest.roomId, revokedAt: null, expiresAt: { $gt: new Date() } }).select('displayName').lean(),
  ]);
  const users = await User.find({ _id: { $in: members.map((m) => m.userId) } }).select('displayName').lean();
  return {
    title: room.branch.title,
    status: room.branch.status,
    participants: [
      ...users.map((u) => ({ name: u.displayName, kind: 'member' as const })),
      ...guests.map((g) => ({ name: g.displayName, kind: 'guest' as const })),
    ],
    scope: guest.scope,
    rev: room.rev,
    expiresAt: guest.expiresAt.toISOString(),
  };
}

export async function guestSend(guest: GuestContext, input: { clientMessageId: string; text: string; replyToId?: string }) {
  if (!guest.scope.write) throw forbidden('This link is read-only');
  const room = await Room.findById(guest.roomId).lean();
  if (!room) throw notFound('Conversation');
  assertAcceptsMessages(room);
  return postMessage({
    room,
    sender: { type: 'guest', id: guest.sessionId, name: guest.name },
    clientMessageId: input.clientMessageId,
    payload: { type: 'text', text: input.text },
    replyTo: await resolveReply(room._id, input.replyToId),
  });
}

export async function leave(guest: GuestContext) {
  await GuestSession.updateOne({ _id: guest.sessionId }, { revokedAt: new Date() });
  hub.disconnectGuestSession(guest.sessionId, 'left');
}
