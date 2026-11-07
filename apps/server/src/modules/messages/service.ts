import type { Types } from 'mongoose';
import {
  messagePayload,
  payloadExcerpt,
  sendMessageInput,
  type EncryptedBody,
  type MessageDTO,
  type MessagePage,
  type MessagePayload,
  type MessageReferenceDTO,
  type Posture,
  type PrincipalRef,
  type SearchHit,
  type SyncResponse,
} from '@strata/shared';
import type { z } from 'zod';
import { badRequest, conflict, forbidden, isDuplicateKey, notFound } from '../../lib/errors.js';
import { CanvasBlock } from '../../models/canvas.js';
import { MediaAsset } from '../../models/media.js';
import { Message, MessageCitation, type IMessage } from '../../models/messages.js';
import { Room, RoomMember, type IRoom } from '../../models/rooms.js';
import { hub } from '../../realtime/hub.js';
import { assertAcceptsMessages, isAdmin, requireMember, requireRead, resolveAccess } from '../access.js';
import type { AuthedUser } from '../auth/middleware.js';
import { onMessagePosted } from '../delivery/service.js';
import { removeAsset } from '../media/service.js';
import { allocateRev, reviseMessage, searchTextFor, toMessageDTO, toMessageDTOs } from './store.js';

export interface PostParams {
  room: IRoom;
  sender: PrincipalRef;
  clientMessageId: string | null;
  payload: MessagePayload;
  replyTo?: IMessage['replyTo'];
  posture?: Posture;
  ackDeadline?: Date;
  /** The person acting, when `sender` is not a user: they aren't notified about their own action. */
  actorId?: string;
}

const findDuplicate = (room: IRoom, sender: PrincipalRef, clientMessageId: string | null) =>
  clientMessageId ? Message.findOne({ roomId: room._id, 'sender.id': sender.id, clientMessageId }).lean() : null;

/**
 * The single path by which any message comes into existence. The order is the guarantee: persist, record the delivery
 * contract, and only then tell anyone. If the process dies midway a retry finds the same `clientMessageId`.
 */
export async function postMessage(p: PostParams): Promise<{ message: MessageDTO; created: boolean }> {
  const { room, sender, clientMessageId } = p;
  const payload = messagePayload.parse(p.payload);

  const existing = await findDuplicate(room, sender, clientMessageId);
  if (existing) return { message: (await toMessageDTOs([existing]))[0]!, created: false };

  const seq = await allocateRev(room._id);
  let created;
  try {
    created = await Message.create({
      roomId: room._id,
      seq,
      rev: seq,
      sender,
      clientMessageId,
      payload,
      replyTo: p.replyTo ?? null,
      posture: p.posture ?? 'standard',
      searchText: searchTextFor(payload),
    });
  } catch (err) {
    // Two copies of the same send raced past the check above. The index let exactly one through.
    if (!isDuplicateKey(err)) throw err;
    const winner = await findDuplicate(room, sender, clientMessageId);
    if (!winner) throw err;
    return { message: (await toMessageDTOs([winner]))[0]!, created: false };
  }
  const message = created.toObject() as IMessage;

  await Room.updateOne(
    { _id: room._id, $or: [{ lastMessage: null }, { 'lastMessage.seq': { $lt: seq } }] },
    {
      lastMessage: {
        seq,
        senderName: sender.name,
        text: payloadExcerpt(payload),
        posture: message.posture,
        at: message.createdAt,
      },
    },
  );

  const contract = await onMessagePosted(message, room, p.ackDeadline, p.actorId);
  const dto = toMessageDTO(message, contract);
  hub.toRoom(String(room._id), 'message:new', { message: dto });
  return { message: dto, created: true };
}

/** A reply can only point inside its own room, which keeps branch and parent content from crossing by reference. */
export async function resolveReply(roomId: Types.ObjectId, replyToId?: string): Promise<IMessage['replyTo']> {
  if (!replyToId) return null;
  const target = await Message.findOne({ _id: replyToId, roomId, deletedAt: null }).lean();
  if (!target) throw badRequest('The message you are replying to is not in this conversation');
  return {
    messageId: target._id,
    seq: target.seq,
    excerpt: payloadExcerpt(target.payload, 120),
    senderName: target.sender.name,
  };
}

/**
 * Encrypted conversations take ciphertext only. Refusing plaintext here is what keeps an old or modified client from
 * quietly writing readable messages into a conversation that promises they're sealed.
 */
function assertEncryption(room: IRoom, content: { type: string; kv?: number; caption?: string }) {
  if (!room.encrypted) {
    if (content.type === 'encrypted') throw badRequest('This conversation is not encrypted');
    return;
  }
  if (content.type === 'text') throw badRequest('This conversation is end-to-end encrypted. Reload Strata to update it, then try again.');
  if (content.type === 'media' && content.caption) throw badRequest('Captions are not supported in encrypted conversations');
  if (content.type === 'encrypted' && (!room.keyVersion || content.kv! > room.keyVersion)) throw badRequest('Encryption keys are not ready yet');
}

async function resolveContent(
  content: z.output<typeof sendMessageInput>['content'],
  room: IRoom,
  userId: string,
): Promise<MessagePayload> {
  if (content.type === 'text') return content;
  if (content.type === 'encrypted') return content;
  const asset = await MediaAsset.findOne({ _id: content.assetId, roomId: room._id, uploaderId: userId, status: 'ready' }).lean();
  if (!asset) throw badRequest('That file is not available in this conversation');
  return {
    type: 'media',
    assetId: String(asset._id),
    name: asset.name,
    mime: asset.mime,
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    caption: content.caption,
  };
}

function assertBlockingAllowed(room: IRoom, role: string, deadline: Date) {
  if (room.settings?.blockingAck === 'admins' && role === 'member') {
    throw forbidden('Only admins can request acknowledgement in this conversation');
  }
  const ahead = deadline.getTime() - Date.now();
  if (ahead < 60_000) throw badRequest('The deadline must be at least a minute away');
  if (ahead > 30 * 86_400_000) throw badRequest('The deadline must be within 30 days');
}

export async function sendUserMessage(user: AuthedUser, roomId: string, input: z.output<typeof sendMessageInput>) {
  const { room, member } = await requireMember(roomId, user.id);
  assertAcceptsMessages(room);
  assertEncryption(room, input.content);

  const deadline = input.ackDeadline ? new Date(input.ackDeadline) : undefined;
  if (input.posture === 'blocking_ack') assertBlockingAllowed(room, member.role, deadline!);

  return postMessage({
    room,
    sender: { type: 'user', id: user.id, name: user.name },
    clientMessageId: input.clientMessageId,
    payload: await resolveContent(input.content, room, user.id),
    replyTo: await resolveReply(room._id, input.replyToId),
    posture: input.posture,
    ackDeadline: deadline,
  });
}

/** Paging shared by members and guests, so that there's one definition of a page. */
export async function pageMessages(
  roomId: Types.ObjectId | string,
  query: { beforeSeq?: number; aroundSeq?: number; limit: number },
): Promise<MessagePage> {
  const { beforeSeq, aroundSeq, limit } = query;
  if (aroundSeq) {
    const half = Math.ceil(limit / 2);
    const [older, newer] = await Promise.all([
      Message.find({ roomId, seq: { $lte: aroundSeq } }).sort({ seq: -1 }).limit(half + 1).lean(),
      Message.find({ roomId, seq: { $gt: aroundSeq } }).sort({ seq: 1 }).limit(half).lean(),
    ]);
    const hasMore = older.length > half;
    const rows = [...older.slice(0, half).reverse(), ...newer];
    return { messages: await toMessageDTOs(rows), hasMore };
  }
  const rows = await Message.find({ roomId, ...(beforeSeq ? { seq: { $lt: beforeSeq } } : {}) })
    .sort({ seq: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  return { messages: await toMessageDTOs(rows.slice(0, limit).reverse()), hasMore };
}

export async function listMessages(roomId: string, userId: string, query: Parameters<typeof pageMessages>[1]) {
  await requireRead(roomId, userId);
  return pageMessages(roomId, query);
}

const SYNC_LIMIT = 500;

/** Everything that changed since a revision: the repair path for any missed socket events (ADR-3). */
export async function syncMessages(roomId: Types.ObjectId | string, sinceRev: number): Promise<SyncResponse> {
  const [room, rows] = await Promise.all([
    Room.findById(roomId).select('rev').lean(),
    Message.find({ roomId, rev: { $gt: sinceRev } }).sort({ rev: 1 }).limit(SYNC_LIMIT + 1).lean(),
  ]);
  const truncated = rows.length > SYNC_LIMIT;
  return { messages: await toMessageDTOs(rows.slice(0, SYNC_LIMIT)), rev: room?.rev ?? sinceRev, truncated };
}

async function loadOwnedRoomMessage(messageId: string, userId: string) {
  const message = await Message.findById(messageId).lean();
  if (!message) throw notFound('Message');
  const access = await requireMember(String(message.roomId), userId);
  return { message, ...access };
}

export type MessageEdit = { text: string } | { encrypted: EncryptedBody };

export async function editMessage(messageId: string, userId: string, edit: MessageEdit) {
  const { message, room } = await loadOwnedRoomMessage(messageId, userId);
  assertAcceptsMessages(room);
  if (message.sender.id !== userId) throw forbidden('You can only edit your own messages');
  if (message.deletedAt) throw conflict('This message has been deleted');
  if (message.payload.type !== 'text' && message.payload.type !== 'encrypted') throw badRequest('Only text messages can be edited');

  let payload: MessagePayload;
  if ('encrypted' in edit) {
    if (!room.encrypted) throw badRequest('This conversation is not encrypted');
    if (edit.encrypted.kv > (room.keyVersion ?? 0)) throw badRequest('Encryption keys are not ready yet');
    payload = { type: 'encrypted', ...edit.encrypted };
  } else {
    if (room.encrypted) throw badRequest('This conversation is end-to-end encrypted. Reload Strata to update it, then try again.');
    payload = { type: 'text', text: edit.text };
  }
  return reviseMessage(message._id, message.roomId, {
    $set: { payload, searchText: searchTextFor(payload), editedAt: new Date() },
  });
}

export async function deleteMessage(messageId: string, userId: string) {
  const { message, member } = await loadOwnedRoomMessage(messageId, userId);
  if (message.deletedAt) return;
  if (message.payload.type === 'system') throw forbidden('System messages cannot be deleted');
  if (message.sender.id !== userId && !isAdmin(member)) throw forbidden('You can only delete your own messages');

  if (message.payload.type === 'media') await removeAsset(message.payload.assetId);
  // The row stays as a tombstone, so ordering, replies and citations stay valid (ADR-10).
  await reviseMessage(message._id, message.roomId, {
    $set: { payload: { type: 'deleted' }, searchText: '', reactions: [], deletedAt: new Date() },
  });
}

const MAX_DISTINCT_REACTIONS = 20;

export async function toggleReaction(messageId: string, userId: string, emoji: string) {
  const { message } = await loadOwnedRoomMessage(messageId, userId);
  if (message.deletedAt) throw conflict('This message has been deleted');

  const entry = message.reactions.find((r) => r.emoji === emoji);
  if (entry?.principalIds.includes(userId)) {
    await Message.updateOne({ _id: message._id, 'reactions.emoji': emoji }, { $pull: { 'reactions.$.principalIds': userId } });
    await Message.updateOne({ _id: message._id }, { $pull: { reactions: { principalIds: { $size: 0 } } } });
  } else if (entry) {
    await Message.updateOne({ _id: message._id, 'reactions.emoji': emoji }, { $addToSet: { 'reactions.$.principalIds': userId } });
  } else {
    if (message.reactions.length >= MAX_DISTINCT_REACTIONS) throw conflict('This message has too many reactions');
    const added = await Message.updateOne(
      { _id: message._id, 'reactions.emoji': { $ne: emoji } },
      { $push: { reactions: { emoji, principalIds: [userId] } } },
    );
    // Someone else added this emoji first, so join their entry.
    if (added.modifiedCount === 0) {
      await Message.updateOne({ _id: message._id, 'reactions.emoji': emoji }, { $addToSet: { 'reactions.$.principalIds': userId } });
    }
  }
  return reviseMessage(message._id, message.roomId);
}

/**
 * Everything pointing at a message, filtered for this reader. An edge from a private branch they can't see is omitted
 * entirely, because even knowing it exists would be a leak.
 */
export async function references(messageId: string, userId: string): Promise<MessageReferenceDTO[]> {
  const message = await Message.findById(messageId).select('roomId').lean();
  if (!message) throw notFound('Message');
  await requireRead(String(message.roomId), userId);

  const [edges, replies] = await Promise.all([
    MessageCitation.find({ toMessageId: messageId }).lean(),
    Message.find({ 'replyTo.messageId': messageId, deletedAt: null }).select('roomId sender payload').limit(50).lean(),
  ]);

  const visible = await Promise.all(
    edges.map(async (edge): Promise<MessageReferenceDTO | null> => {
      const roomId = String(edge.fromRoomId);
      const ref = { kind: edge.fromKind, id: String(edge.fromId), roomId, label: edge.label };
      if (await resolveAccess(roomId, userId)) return ref;
      if (edge.fromKind !== 'branch') return null;
      const room = await Room.findById(roomId).select('branch.visibility').lean();
      return room?.branch?.visibility === 'listed' ? ref : null;
    }),
  );

  const liveCanvas = new Set(
    (await CanvasBlock.find({ _id: { $in: edges.filter((e) => e.fromKind === 'canvas').map((e) => e.fromId) }, deletedAt: null }).select('_id').lean()).map((b) => String(b._id)),
  );

  return [
    ...visible.filter((r): r is MessageReferenceDTO => r !== null && (r.kind !== 'canvas' || liveCanvas.has(r.id))),
    ...replies.map((m) => ({
      kind: 'message' as const,
      id: String(m._id),
      roomId: String(m.roomId),
      label: `${m.sender.name}: ${payloadExcerpt(m.payload, 80)}`,
    })),
  ];
}

export async function search(userId: string, q: string, roomId: string | undefined, limit: number): Promise<SearchHit[]> {
  let roomIds: (Types.ObjectId | string)[];
  if (roomId) {
    await requireRead(roomId, userId);
    roomIds = [roomId];
  } else {
    // Scoping to the reader's own memberships is what keeps branch content out of everyone else's results.
    roomIds = await RoomMember.find({ userId, leftAt: null }).distinct('roomId');
  }
  const rows = await Message.find({ $text: { $search: q }, roomId: { $in: roomIds }, deletedAt: null })
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .lean();
  const rooms = await Room.find({ _id: { $in: rows.map((r) => r.roomId) } }).select('name kind').lean();
  const byId = new Map(rooms.map((r) => [String(r._id), r]));
  const dtos = await toMessageDTOs(rows);
  return dtos.map((message) => {
    const room = byId.get(message.roomId);
    return { message, roomName: room?.name || 'Direct message', roomKind: room?.kind ?? 'direct' };
  });
}

