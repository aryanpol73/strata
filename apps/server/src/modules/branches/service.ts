import { Types } from 'mongoose';
import {
  LIMITS,
  payloadExcerpt,
  type BranchInfoDTO,
  type BranchStatus,
  type BranchSummaryDTO,
  type CreateBranchInput,
  type RoomDTO,
  type TranscriptPolicy,
} from '@strata/shared';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { GuestCapability, GuestSession } from '../../models/guests.js';
import { Message, MessageCitation } from '../../models/messages.js';
import { Room, RoomMember, type IRoom } from '../../models/rooms.js';
import { hub } from '../../realtime/hub.js';
import { activeMember, assertAcceptsMessages, canManageBranch, requireMember, requireRead } from '../access.js';
import type { AuthedUser } from '../auth/middleware.js';
import { postMessage } from '../messages/service.js';
import { reviseMessage } from '../messages/store.js';
import { addMemberRow, getRoom, toBranchInfo } from '../rooms/service.js';

const SYSTEM = { type: 'system' as const, id: 'system', name: 'Strata' };

const announce = (room: IRoom, text: string) => postMessage({ room, sender: SYSTEM, clientMessageId: null, payload: { type: 'system', text } });

async function assertParentMembers(parentRoomId: Types.ObjectId, userIds: string[]) {
  const count = await RoomMember.countDocuments({ roomId: parentRoomId, userId: { $in: userIds }, leftAt: null });
  if (count !== new Set(userIds).size) throw badRequest('Everyone in a branch must be a member of the original conversation');
}

/** Tells the parent room about a branch only when it's allowed to know, so private branches stay silent. */
function broadcast(room: IRoom) {
  const roomId = String(room._id);
  const parentRoomId = room.parentRoomId ? String(room.parentRoomId) : null;
  const info = toBranchInfo(room)!;
  hub.toRoom(roomId, 'branch:updated', { roomId, parentRoomId, branch: info });
  if (parentRoomId && room.branch?.visibility === 'listed') {
    const { title, status, mergedAt } = info;
    hub.toRoom(parentRoomId, 'branch:updated', { roomId, parentRoomId, branch: { title, status, mergedAt } });
  }
}

export async function createBranch(user: AuthedUser, messageId: string, input: Required<CreateBranchInput>): Promise<RoomDTO> {
  const message = await Message.findById(messageId).lean();
  if (!message) throw notFound('Message');
  const { room: parent } = await requireMember(String(message.roomId), user.id);
  if (message.deletedAt) throw conflict('This message has been deleted');
  if (parent.depth >= LIMITS.branchDepth) throw new AppError(409, 'BRANCH_DEPTH_EXCEEDED', 'Branches can only nest three deep');

  const participants = [...new Set([user.id, ...input.participantIds])];
  await assertParentMembers(parent._id, participants);

  const branch = await Room.create({
    kind: 'branch',
    name: input.title,
    createdBy: user.id,
    parentRoomId: parent._id,
    parentMessageId: message._id,
    rootRoomId: parent.rootRoomId ?? parent._id,
    depth: parent.depth + 1,
    encrypted: parent.encrypted && input.encrypted,
    branch: {
      title: input.title,
      status: 'open',
      visibility: input.visibility,
      origin: { excerpt: payloadExcerpt(message.payload, 240), senderName: message.sender.name, seq: message.seq },
    },
  });
  await Promise.all(participants.map((id) => addMemberRow(branch._id, id, id === user.id ? 'owner' : 'member')));

  await MessageCitation.create({
    fromKind: 'branch',
    fromId: branch._id,
    fromRoomId: branch._id,
    toMessageId: message._id,
    toRoomId: parent._id,
    label: input.title,
    createdBy: user.id,
  });
  // A private branch leaves no mark on the parent, not even a count, until it merges.
  if (input.visibility === 'listed') await reviseMessage(message._id, parent._id, { $inc: { branchCount: 1 } });

  const room = branch.toObject() as IRoom;
  await announce(room, `${user.name} started this branch`);
  broadcast(room);
  return getRoom(String(branch._id), user.id);
}

/** Branches of a room that this reader is allowed to know about. */
export async function listBranches(parentRoomId: string, userId: string): Promise<BranchSummaryDTO[]> {
  await requireRead(parentRoomId, userId);
  const branches = await Room.find({ parentRoomId }).sort({ createdAt: -1 }).lean();
  const ids = branches.map((b) => b._id);
  const [mine, counts] = await Promise.all([
    RoomMember.find({ roomId: { $in: ids }, userId, leftAt: null }).select('roomId').lean(),
    RoomMember.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { roomId: { $in: ids }, leftAt: null } },
      { $group: { _id: '$roomId', n: { $sum: 1 } } },
    ]),
  ]);
  const participantOf = new Set(mine.map((m) => String(m.roomId)));
  const countOf = new Map(counts.map((c) => [String(c._id), c.n]));

  return branches.flatMap((b): BranchSummaryDTO[] => {
    const id = String(b._id);
    const isParticipant = participantOf.has(id);
    if (!isParticipant && b.branch?.visibility === 'private') return [];
    const info = toBranchInfo(b)!;
    const transcriptOpen = !!info.mergedAt && info.transcriptPolicy === 'parent_members';
    return [
      {
        roomId: id,
        parentRoomId,
        parentMessageId: String(b.parentMessageId),
        title: info.title,
        status: info.status,
        visibility: info.visibility,
        participantCount: countOf.get(id) ?? 0,
        isParticipant,
        canReadTranscript: isParticipant || transcriptOpen,
        // The summary of an unmerged branch is still private to its participants.
        resolution: isParticipant || info.mergedAt ? info.resolution : null,
        mergedAt: info.mergedAt,
        lastActivityAt: (b.lastMessage?.at ?? b.updatedAt).toISOString(),
      },
    ];
  });
}

async function requireBranch(branchId: string, userId: string) {
  const { room } = await requireMember(branchId, userId);
  if (room.kind !== 'branch' || !room.branch) throw notFound('Branch');
  return room as IRoom & { branch: NonNullable<IRoom['branch']> };
}

/**
 * A parent admin can steer a listed branch without being in it. A private branch stays hidden even from them, so to
 * anyone outside it this answers exactly as if it didn't exist.
 */
async function requireManagedBranch(branchId: string, userId: string) {
  const room = await Room.findOne({ _id: branchId, kind: 'branch' }).lean();
  if (!room?.branch) throw notFound('Branch');
  const participant = await activeMember(room._id, userId);
  const manager = await canManageBranch(room, userId);

  if (!participant && (!manager || room.branch.visibility === 'private')) throw notFound('Branch');
  if (!manager) throw forbidden('Only the branch owner or a conversation admin can do that');
  return room as IRoom & { branch: NonNullable<IRoom['branch']> };
}

export async function addParticipants(actorId: string, branchId: string, userIds: string[]) {
  const room = await requireManagedBranch(branchId, actorId);
  assertAcceptsMessages(room);
  await assertParentMembers(room.parentRoomId!, userIds);
  await Promise.all(userIds.map((id) => addMemberRow(room._id, id, 'member', room.rev)));
  userIds.forEach((userId) => hub.toRoom(branchId, 'member:updated', { roomId: branchId, userId }));
  return toBranchInfo(room)!;
}

async function transition(branchId: string, from: BranchStatus, update: Record<string, unknown>): Promise<IRoom> {
  const updated = await Room.findOneAndUpdate(
    { _id: new Types.ObjectId(branchId), 'branch.status': from, 'branch.mergedAt': null },
    { $set: update },
    { returnDocument: 'after' },
  ).lean<IRoom>();
  if (!updated) throw conflict('This branch can no longer make that change', 'BRANCH_NOT_OPEN');
  broadcast(updated);
  return updated;
}

export async function resolveBranch(user: AuthedUser, branchId: string, summary: string) {
  await requireManagedBranch(branchId, user.id);
  const room = await transition(branchId, 'open', {
    'branch.status': 'resolved',
    'branch.resolution': { summary, resolvedBy: user.name, resolvedAt: new Date() },
  });
  await announce(room, `${user.name} resolved this branch`);
  return toBranchInfo(room)!;
}

export async function reopenBranch(user: AuthedUser, branchId: string) {
  await requireManagedBranch(branchId, user.id);
  const room = await transition(branchId, 'resolved', { 'branch.status': 'open', 'branch.resolution': null });
  await announce(room, `${user.name} reopened this branch`);
  return toBranchInfo(room)!;
}

/**
 * Posts the outcome to the parent, exactly once, however many people press the button or however often a request is
 * retried. The card's identity derives from the branch, so its unique index is what enforces "once". The message goes
 * first: if we crash after posting, a retry finds the card and simply finishes recording the merge.
 */
export async function mergeBranch(user: AuthedUser, branchId: string, transcriptPolicy: TranscriptPolicy): Promise<BranchInfoDTO> {
  const room = await requireManagedBranch(branchId, user.id);
  if (room.branch.mergedAt) throw conflict('This branch has already been merged', 'BRANCH_ALREADY_MERGED');
  if (room.branch.status !== 'resolved' || !room.branch.resolution) throw conflict('Resolve the branch before merging it', 'BRANCH_NOT_OPEN');

  const parent = await Room.findById(room.parentRoomId).lean();
  if (!parent) throw notFound('Conversation');
  // People outside an encrypted branch have no key for it, so opening its transcript to them would show only ciphertext.
  if (room.encrypted && transcriptPolicy === 'parent_members') {
    throw badRequest('This branch is end-to-end encrypted, so its transcript cannot be shared outside it. Only the summary can be.');
  }
  const participantCount = await RoomMember.countDocuments({ roomId: room._id, leftAt: null });

  const { message } = await postMessage({
    room: parent,
    sender: { type: 'system', id: `branch-${branchId}`, name: user.name },
    actorId: user.id,
    clientMessageId: `merge-${branchId}`,
    payload: {
      type: 'resolution',
      branchRoomId: branchId,
      branchTitle: room.branch.title,
      summary: room.branch.resolution.summary,
      resolvedBy: room.branch.resolution.resolvedBy,
      participantCount,
      transcriptOpen: transcriptPolicy === 'parent_members',
    },
  });

  const merged = await Room.findOneAndUpdate(
    { _id: branchId, 'branch.mergedAt': null },
    { $set: { 'branch.mergedAt': new Date(), 'branch.mergedMessageId': message.id, 'branch.transcriptPolicy': transcriptPolicy } },
    { returnDocument: 'after' },
  ).lean();
  if (!merged) throw conflict('This branch has already been merged', 'BRANCH_ALREADY_MERGED');

  await MessageCitation.updateOne(
    { fromKind: 'branch', fromId: room._id, toMessageId: message.id },
    {
      $setOnInsert: { fromRoomId: room._id, toRoomId: parent._id, label: room.branch.title, createdBy: user.id },
    },
    { upsert: true },
  );
  await announce(merged, `${user.name} merged the resolution into the original conversation`);
  broadcast(merged);
  return toBranchInfo(merged)!;
}

export async function archiveBranch(user: AuthedUser, branchId: string) {
  const room = await requireManagedBranch(branchId, user.id);
  const updated = await Room.findOneAndUpdate(
    { _id: room._id, 'branch.status': { $ne: 'archived' } },
    { $set: { 'branch.status': 'archived' } },
    { returnDocument: 'after' },
  ).lean();
  if (!updated) return toBranchInfo(room)!;

  // Archiving closes the bridge: guests shouldn't outlive the discussion they were invited to.
  const capabilities = await GuestCapability.find({ roomId: room._id, revokedAt: null }).select('_id').lean();
  await GuestCapability.updateMany({ roomId: room._id, revokedAt: null }, { revokedAt: new Date() });
  await GuestSession.updateMany({ roomId: room._id, revokedAt: null }, { revokedAt: new Date() });
  capabilities.forEach((c) => hub.disconnectCapability(String(c._id), 'branch_archived'));

  broadcast(updated);
  return toBranchInfo(updated)!;
}

