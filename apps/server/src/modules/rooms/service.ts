import type { Types } from 'mongoose';
import type { BranchInfoDTO, CreateGroupInput, MemberDTO, MemberRole, RoomDTO } from '@strata/shared';
import { badRequest, forbidden, isDuplicateKey, notFound } from '../../lib/errors.js';
import { User } from '../../models/identity.js';
import { Message } from '../../models/messages.js';
import { Room, RoomMember, type IRoom, type IRoomMember } from '../../models/rooms.js';
import { hub } from '../../realtime/hub.js';
import { isAdmin, requireAdmin, requireMember, requireRead, type RoomAccess } from '../access.js';

export const toBranchInfo = (room: IRoom): BranchInfoDTO | null => {
  const b = room.branch;
  if (!b) return null;
  return {
    title: b.title,
    status: b.status,
    visibility: b.visibility,
    transcriptPolicy: b.transcriptPolicy,
    origin: b.origin ?? null,
    resolution: b.resolution
      ? { summary: b.resolution.summary, resolvedBy: b.resolution.resolvedBy, resolvedAt: b.resolution.resolvedAt.toISOString() }
      : null,
    mergedAt: b.mergedAt?.toISOString() ?? null,
    mergedMessageId: b.mergedMessageId ? String(b.mergedMessageId) : null,
    createdBy: String(room.createdBy),
  };
};

async function loadMembers(roomId: Types.ObjectId): Promise<MemberDTO[]> {
  const rows = await RoomMember.find({ roomId, leftAt: null }).lean();
  const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } })
    .select('displayName handle avatarUrl')
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return rows.flatMap((r) => {
    const u = byId.get(String(r.userId));
    if (!u) return [];
    return [
      {
        userId: String(r.userId),
        displayName: u.displayName,
        handle: u.handle,
        avatarUrl: u.avatarUrl,
        role: r.role,
        lastDeliveredSeq: r.lastDeliveredSeq,
        lastReadSeq: r.lastReadSeq,
      },
    ];
  });
}

/** Whispers count separately: they're unread, but they never raise an alert. */
async function unreadCounts(room: IRoom, member: IRoomMember | null, userId: string) {
  if (!member || (room.lastMessage?.seq ?? 0) <= member.lastReadSeq) return { unread: 0, quietUnread: 0 };
  const base = { roomId: room._id, seq: { $gt: member.lastReadSeq }, 'sender.id': { $ne: userId }, deletedAt: null };
  const [unread, quietUnread] = await Promise.all([
    Message.countDocuments({ ...base, posture: { $ne: 'whisper' } }),
    Message.countDocuments({ ...base, posture: 'whisper' }),
  ]);
  return { unread, quietUnread };
}

export async function serializeRoom({ room, member, readOnly }: RoomAccess, userId: string): Promise<RoomDTO> {
  const [members, counts] = await Promise.all([loadMembers(room._id), unreadCounts(room, member, userId)]);
  const other = room.kind === 'direct' ? members.find((m) => m.userId !== userId) : undefined;
  return {
    id: String(room._id),
    kind: room.kind,
    name: other?.displayName ?? room.name,
    avatarUrl: other?.avatarUrl ?? room.avatarUrl,
    rev: room.rev,
    lastMessage: room.lastMessage ? { ...room.lastMessage, at: room.lastMessage.at.toISOString() } : null,
    parentRoomId: room.parentRoomId ? String(room.parentRoomId) : null,
    parentMessageId: room.parentMessageId ? String(room.parentMessageId) : null,
    rootRoomId: room.rootRoomId ? String(room.rootRoomId) : null,
    depth: room.depth,
    branch: toBranchInfo(room),
    settings: { blockingAck: room.settings?.blockingAck ?? 'members' },
    me: {
      role: member?.role ?? null,
      lastReadSeq: member?.lastReadSeq ?? 0,
      ...counts,
      mutedUntil: member?.mutedUntil?.toISOString() ?? null,
      readOnly,
    },
    members,
    updatedAt: room.updatedAt.toISOString(),
  };
}

export async function listRooms(userId: string): Promise<RoomDTO[]> {
  const memberships = await RoomMember.find({ userId, leftAt: null }).lean();
  const rooms = await Room.find({ _id: { $in: memberships.map((m) => m.roomId) } }).lean();
  const byRoom = new Map(memberships.map((m) => [String(m.roomId), m]));
  const result = await Promise.all(
    rooms.map((room) => serializeRoom({ room, member: byRoom.get(String(room._id)) ?? null, readOnly: false }, userId)),
  );
  const activity = (r: RoomDTO) => r.lastMessage?.at ?? r.updatedAt;
  return result.sort((a, b) => activity(b).localeCompare(activity(a)));
}

export async function getRoom(roomId: string, userId: string): Promise<RoomDTO> {
  return serializeRoom(await requireRead(roomId, userId), userId);
}

async function addMemberRow(roomId: Types.ObjectId, userId: string, role: MemberRole = 'member', seq = 0) {
  try {
    await RoomMember.updateOne(
      { roomId, userId },
      { $set: { leftAt: null, role }, $setOnInsert: { joinedAt: new Date(), lastDeliveredSeq: seq, lastReadSeq: seq } },
      { upsert: true },
    );
  } catch (err) {
    // Two upserts raced to insert the same row, and that row now exists, which is all this function promises.
    if (!isDuplicateKey(err)) throw err;
  }
  hub.joinRoom(userId, String(roomId));
}

export async function findOrCreateDirect(userId: string, otherId: string): Promise<RoomDTO> {
  if (userId === otherId) throw badRequest('You cannot start a conversation with yourself');
  if (!(await User.exists({ _id: otherId }))) throw notFound('User');

  const directKey = [userId, otherId].sort().join(':');
  let room = await Room.findOne({ directKey }).lean();
  if (!room) {
    try {
      room = (await Room.create({ kind: 'direct', directKey, createdBy: userId })).toObject();
    } catch (err) {
      // Both people opened the conversation at the same moment. The other request won, so use its room.
      if (!isDuplicateKey(err)) throw err;
      room = await Room.findOne({ directKey }).lean();
      if (!room) throw err;
    }
  }
  // Runs on every path: a request that lost the race can arrive before the winner has added the members.
  const roomId = room._id;
  if ((await RoomMember.countDocuments({ roomId })) < 2) {
    await Promise.all([userId, otherId].map((id) => addMemberRow(roomId, id)));
  }
  return getRoom(String(roomId), userId);
}

export async function createGroup(userId: string, input: CreateGroupInput): Promise<RoomDTO> {
  const memberIds = [...new Set(input.memberIds.filter((id) => id !== userId))];
  if ((await User.countDocuments({ _id: { $in: memberIds } })) !== memberIds.length) throw notFound('User');
  const room = await Room.create({ kind: 'group', name: input.name, createdBy: userId });
  await Promise.all([addMemberRow(room._id, userId, 'owner'), ...memberIds.map((id) => addMemberRow(room._id, id))]);
  return getRoom(String(room._id), userId);
}

export async function updateRoom(roomId: string, userId: string, input: { name?: string; blockingAck?: 'admins' | 'members' }) {
  const { room } = await requireAdmin(roomId, userId);
  if (room.kind === 'direct') throw forbidden('Direct conversations cannot be changed');
  const update: Record<string, unknown> = {};
  if (input.name) update.name = input.name;
  if (input.blockingAck) update['settings.blockingAck'] = input.blockingAck;
  await Room.updateOne({ _id: room._id }, update);
  hub.toRoom(roomId, 'room:updated', { room: { id: roomId, name: input.name } });
  return getRoom(roomId, userId);
}

export async function addMembers(roomId: string, actorId: string, userIds: string[]) {
  const { room } = await requireAdmin(roomId, actorId);
  if (room.kind !== 'group') throw forbidden('Members can only be added to groups');
  if ((await User.countDocuments({ _id: { $in: userIds } })) !== new Set(userIds).size) throw notFound('User');
  // New members start from the present. History before they joined stays readable but isn't counted as unread.
  await Promise.all(userIds.map((id) => addMemberRow(room._id, id, 'member', room.rev)));
  userIds.forEach((userId) => hub.toRoom(roomId, 'member:updated', { roomId, userId }));
  return getRoom(roomId, actorId);
}

export async function setRole(roomId: string, actorId: string, userId: string, role: 'admin' | 'member') {
  const { member } = await requireAdmin(roomId, actorId);
  if (member.role !== 'owner') throw forbidden('Only the owner can change roles');
  const updated = await RoomMember.findOneAndUpdate(
    { roomId, userId, leftAt: null, role: { $ne: 'owner' } },
    { role },
    { returnDocument: 'after' },
  );
  if (!updated) throw notFound('Member');
  hub.toRoom(roomId, 'member:updated', { roomId, userId });
}

/**
 * Removing someone from a room also removes them from every branch under it. A branch participant must be a member
 * of the parent, so without this cascade a removed member would keep reading new branch messages.
 */
async function departRoom(roomId: Types.ObjectId, userId: string): Promise<void> {
  const left = await RoomMember.updateOne({ roomId, userId, leftAt: null }, { leftAt: new Date() });
  if (left.modifiedCount === 0) return;
  hub.leaveRoom(userId, String(roomId));
  hub.toRoom(String(roomId), 'member:updated', { roomId: String(roomId), userId });

  const branches = await Room.find({ parentRoomId: roomId }).select('_id').lean();
  await Promise.all(branches.map((b) => departRoom(b._id, userId)));
}

export async function removeMember(roomId: string, actorId: string, userId: string) {
  const { room, member } = await requireMember(roomId, actorId);
  if (room.kind === 'direct') throw forbidden('You cannot leave a direct conversation');
  const self = actorId === userId;
  if (!self && !isAdmin(member)) throw forbidden('Only admins can remove people');

  const target = await RoomMember.findOne({ roomId, userId, leftAt: null }).lean();
  if (!target) throw notFound('Member');
  if (target.role === 'owner' && !self) throw forbidden('The owner cannot be removed');
  if (!self && target.role === 'admin' && member.role !== 'owner') throw forbidden('Only the owner can remove an admin');

  await departRoom(room._id, userId);

  // A room shouldn't be left without an owner.
  if (target.role === 'owner') {
    const heir = await RoomMember.findOne({ roomId, leftAt: null }).sort({ role: 1, joinedAt: 1 });
    if (heir) {
      heir.role = 'owner';
      await heir.save();
      hub.toRoom(roomId, 'member:updated', { roomId, userId: String(heir.userId) });
    }
  }
}

export async function markRead(roomId: string, userId: string, seq: number) {
  const { room } = await requireMember(roomId, userId);
  const capped = Math.min(seq, room.rev);
  const updated = await RoomMember.findOneAndUpdate(
    { roomId, userId, lastReadSeq: { $lt: capped } },
    { $set: { lastReadSeq: capped }, $max: { lastDeliveredSeq: capped } },
    { returnDocument: 'after' },
  ).lean();
  if (updated) {
    hub.toRoom(roomId, 'receipt', {
      roomId,
      principalId: userId,
      deliveredSeq: updated.lastDeliveredSeq,
      readSeq: updated.lastReadSeq,
    });
  }
}

export async function markDelivered(roomId: string, userId: string, seq: number) {
  const room = await Room.findById(roomId).select('rev').lean();
  if (!room) return;
  const updated = await RoomMember.findOneAndUpdate(
    { roomId, userId, leftAt: null, lastDeliveredSeq: { $lt: Math.min(seq, room.rev) } },
    { $set: { lastDeliveredSeq: Math.min(seq, room.rev) } },
    { returnDocument: 'after' },
  ).lean();
  if (updated) {
    hub.toRoom(roomId, 'receipt', {
      roomId,
      principalId: userId,
      deliveredSeq: updated.lastDeliveredSeq,
      readSeq: updated.lastReadSeq,
    });
  }
}

export async function setMute(roomId: string, userId: string, until: string | null) {
  await requireMember(roomId, userId);
  await RoomMember.updateOne({ roomId, userId }, { mutedUntil: until ? new Date(until) : null });
}

export { addMemberRow };
