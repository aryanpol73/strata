import { Types } from 'mongoose';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { Room, RoomMember, type IRoom, type IRoomMember } from '../models/rooms.js';

/**
 * The one place that decides who may touch a room. Everything else asks this module.
 *
 * Refusals are 404s rather than 403s, so that probing an id reveals nothing about whether a private branch exists.
 */
export interface RoomAccess {
  room: IRoom;
  member: IRoomMember | null;
  /** True for parent members reading a merged branch whose transcript was opened to them. */
  readOnly: boolean;
}

const isId = (id: string) => Types.ObjectId.isValid(id);

export async function activeMember(roomId: string | Types.ObjectId, userId: string): Promise<IRoomMember | null> {
  return RoomMember.findOne({ roomId, userId, leftAt: null }).lean();
}

/** Access to a room, or null. Does not throw, so that lists can filter with it. */
export async function resolveAccess(roomId: string, userId: string): Promise<RoomAccess | null> {
  if (!isId(roomId)) return null;
  const [room, member] = await Promise.all([Room.findById(roomId).lean(), activeMember(roomId, userId)]);
  if (!room) return null;
  if (member) return { room, member, readOnly: false };

  const opened =
    room.kind === 'branch' &&
    !!room.branch?.mergedAt &&
    room.branch.transcriptPolicy === 'parent_members' &&
    !!room.parentRoomId;
  if (opened) {
    const parent = await resolveAccess(String(room.parentRoomId), userId);
    if (parent) return { room, member: null, readOnly: true };
  }
  return null;
}

export async function requireRead(roomId: string, userId: string): Promise<RoomAccess> {
  const access = await resolveAccess(roomId, userId);
  if (!access) throw notFound('Conversation');
  return access;
}

/** Membership that can act. Read-only viewers of a merged transcript are refused. */
export async function requireMember(roomId: string, userId: string): Promise<RoomAccess & { member: IRoomMember }> {
  const access = await requireRead(roomId, userId);
  if (!access.member) throw forbidden('This transcript is read-only');
  return access as RoomAccess & { member: IRoomMember };
}

export const isAdmin = (member: IRoomMember | null): boolean => member?.role === 'owner' || member?.role === 'admin';

export async function requireAdmin(roomId: string, userId: string) {
  const access = await requireMember(roomId, userId);
  if (!isAdmin(access.member)) throw forbidden('Only admins can do that');
  return access;
}

/** New content can only go into an open branch. Direct rooms and groups are always open. */
export function assertAcceptsMessages(room: IRoom): void {
  if (room.kind === 'branch' && room.branch?.status !== 'open') {
    throw new AppError(409, 'BRANCH_NOT_OPEN', 'This branch is closed to new messages');
  }
}

/** Branch lifecycle belongs to its owner, or to admins of the conversation it came from. */
export async function canManageBranch(room: IRoom, userId: string): Promise<boolean> {
  const own = await activeMember(room._id, userId);
  if (own?.role === 'owner') return true;
  if (!room.parentRoomId) return false;
  return isAdmin(await activeMember(room.parentRoomId, userId));
}

/** Members of a room, as ids. Used for fan-out decisions. */
export async function activeMemberIds(roomId: Types.ObjectId | string): Promise<string[]> {
  const rows = await RoomMember.find({ roomId, leftAt: null }).select('userId').lean();
  return rows.map((r) => String(r.userId));
}
