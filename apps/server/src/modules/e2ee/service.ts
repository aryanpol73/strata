import { Types } from 'mongoose';
import type { IdentityDTO, PostRoomKeysInput, RoomKeysDTO, SetIdentityInput } from '@strata/shared';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { RoomKey } from '../../models/e2ee.js';
import { User } from '../../models/identity.js';
import { Room, RoomMember } from '../../models/rooms.js';
import { hub } from '../../realtime/hub.js';
import { requireMember } from '../access.js';
import { toSelf } from '../auth/service.js';

/** Tells everyone who shares a room with this person that keys may have changed, so they can seal keys for them. */
async function announceKeys(userId: string) {
  const rooms = await RoomMember.find({ userId, leftAt: null }).distinct('roomId');
  rooms.forEach((roomId) => hub.toRoom(String(roomId), 'keys:updated', { roomId: String(roomId) }));
}

/**
 * Stores a person's public key and their passphrase-protected backup. A different public key means a new identity,
 * so every room key sealed to the old one is dropped, and the people they talk to seal fresh ones.
 */
export async function setIdentity(userId: string, input: SetIdentityInput) {
  const before = await User.findById(userId).select('e2ee').lean();
  if (!before) throw notFound('User');
  const changed = before.e2ee?.publicKey !== input.publicKey;
  const user = await User.findByIdAndUpdate(
    userId,
    { e2ee: { publicKey: input.publicKey, backup: input.backup, updatedAt: new Date() } },
    { returnDocument: 'after' },
  ).lean();
  if (!user) throw notFound('User');
  if (changed) {
    await RoomKey.deleteMany({ userId });
    await announceKeys(userId);
  }
  return toSelf(user);
}

export async function getIdentity(userId: string): Promise<IdentityDTO> {
  const user = await User.findById(userId).select('e2ee').lean();
  if (!user?.e2ee) throw notFound('Encryption keys');
  return { publicKey: user.e2ee.publicKey, backup: user.e2ee.backup };
}

export async function roomKeys(userId: string, roomId: string): Promise<RoomKeysDTO> {
  const { room } = await requireMember(roomId, userId);
  const [members, rows] = await Promise.all([
    RoomMember.find({ roomId: room._id, leftAt: null }).select('userId').lean(),
    RoomKey.find({ roomId: room._id }).select('userId version wrapped').lean(),
  ]);
  const users = await User.find({ _id: { $in: members.map((m) => m.userId) } }).select('displayName e2ee.publicKey').lean();
  const byUser = new Map<string, number[]>();
  for (const row of rows) byUser.set(String(row.userId), [...(byUser.get(String(row.userId)) ?? []), row.version]);
  return {
    version: room.keyVersion ?? 0,
    needsRotation: room.needsRotation ?? false,
    mine: rows.filter((r) => String(r.userId) === userId).map((r) => ({ version: r.version, wrapped: r.wrapped })),
    members: users.map((u) => ({
      userId: String(u._id),
      displayName: u.displayName,
      publicKey: u.e2ee?.publicKey ?? null,
      versions: (byUser.get(String(u._id)) ?? []).sort((a, b) => a - b),
    })),
  };
}

/**
 * Members seal keys for each other. The server's part is limited to keeping that fair: only members can add keys, only
 * for current members, only for versions that exist, and a key already sealed to someone is never overwritten.
 */
export async function postRoomKeys(userId: string, roomId: string, input: PostRoomKeysInput) {
  const { room } = await requireMember(roomId, userId);
  if (!room.encrypted) throw badRequest('This conversation is not end-to-end encrypted');

  const current = room.keyVersion ?? 0;
  const creating = input.newVersion !== undefined;
  const version = creating ? input.newVersion! : current;

  // Everything is checked before anything changes, so a refused request can never leave a room half-moved.
  const members = new Set((await RoomMember.find({ roomId: room._id, leftAt: null }).distinct('userId')).map(String));
  for (const w of input.wraps) {
    if (!members.has(w.userId)) throw badRequest('Keys can only be shared with people in the conversation');
    if (w.version > version) throw badRequest('That key version does not exist yet');
  }
  if (creating && !input.wraps.some((w) => w.version === version && w.userId === userId)) {
    throw badRequest('A new key version has to include a copy for the person creating it');
  }

  if (creating) {
    if (version === current + 1) {
      // Exactly one request can move the version forward. Anyone else is told to use the winner's key.
      const won = await Room.updateOne({ _id: room._id, keyVersion: current }, { keyVersion: version, needsRotation: false });
      if (won.modifiedCount === 0) throw conflict('Someone else just created this key. Fetch it and use that one.');
    } else if (!(version === current && (await RoomKey.countDocuments({ roomId: room._id, version })) === 0)) {
      // Anything else is stale, except finishing a version whose creator died before storing a single copy.
      throw conflict('That key version is out of date. Fetch the current keys and try again.');
    }
  }

  const me = new Types.ObjectId(userId);
  await RoomKey.bulkWrite(
    input.wraps.map((w) => ({
      updateOne: {
        filter: { roomId: room._id, userId: new Types.ObjectId(w.userId), version: w.version },
        update: { $setOnInsert: { wrapped: w.wrapped, wrappedBy: me } },
        upsert: true,
      },
    })),
    { ordered: false },
  ).catch((err: { code?: number }) => {
    // Two members sealed the same key for the same person at once. One copy is all that's needed.
    if (err.code !== 11000) throw err;
  });

  hub.toRoom(roomId, 'keys:updated', { roomId });
  return { version };
}
