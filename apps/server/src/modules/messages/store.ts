import type { Types, UpdateQuery } from 'mongoose';
import { payloadExcerpt, type MessageAckDTO, type MessageDTO, type MessagePayload } from '@strata/shared';
import { notFound } from '../../lib/errors.js';
import { AckContract, type IAckContract } from '../../models/delivery.js';
import { Message, type IMessage } from '../../models/messages.js';
import { Room } from '../../models/rooms.js';
import { hub } from '../../realtime/hub.js';

/** Every persisted change in a room takes the next value of this counter (see ADR-3). */
export async function allocateRev(roomId: Types.ObjectId | string): Promise<number> {
  const room = await Room.findByIdAndUpdate(roomId, { $inc: { rev: 1 } }, { returnDocument: 'after', projection: { rev: 1 } }).lean();
  if (!room) throw notFound('Conversation');
  return room.rev;
}

export const searchTextFor = (payload: MessagePayload): string => {
  switch (payload.type) {
    case 'text':
      return payload.text;
    case 'media':
      return [payload.caption, payload.name].filter(Boolean).join(' ');
    case 'block':
      return payload.title;
    case 'resolution':
      return `${payload.branchTitle} ${payload.summary}`;
    default:
      return '';
  }
};

const toAck = (c: IAckContract): MessageAckDTO => ({
  deadline: c.deadline.toISOString(),
  state: c.state,
  requiredIds: c.required.map(String),
  ackedIds: c.acks.map((a) => String(a.userId)),
});

export function toMessageDTO(m: IMessage, ack?: IAckContract | null): MessageDTO {
  return {
    id: String(m._id),
    roomId: String(m.roomId),
    seq: m.seq,
    rev: m.rev,
    sender: { type: m.sender.type, id: m.sender.id, name: m.sender.name },
    clientMessageId: m.clientMessageId,
    payload: m.payload,
    replyTo: m.replyTo
      ? { messageId: String(m.replyTo.messageId), seq: m.replyTo.seq, excerpt: m.replyTo.excerpt, senderName: m.replyTo.senderName }
      : null,
    reactions: m.reactions.map((r) => ({ emoji: r.emoji, principalIds: r.principalIds })),
    posture: m.posture,
    ack: ack ? toAck(ack) : null,
    branchCount: m.branchCount,
    refCount: m.refCount,
    createdAt: m.createdAt.toISOString(),
    editedAt: m.editedAt?.toISOString() ?? null,
    deletedAt: m.deletedAt?.toISOString() ?? null,
  };
}

/** Serializes a batch, loading acknowledgement state in one query. */
export async function toMessageDTOs(messages: IMessage[]): Promise<MessageDTO[]> {
  const blocking = messages.filter((m) => m.posture === 'blocking_ack').map((m) => m._id);
  const contracts = blocking.length ? await AckContract.find({ messageId: { $in: blocking } }).lean() : [];
  const byMessage = new Map(contracts.map((c) => [String(c.messageId), c]));
  return messages.map((m) => toMessageDTO(m, byMessage.get(String(m._id))));
}

/**
 * Applies a change to an existing message and tells the room. `$max` keeps `rev` monotonic when two changes race, so
 * a slower write can't move the message backwards in the change feed.
 */
export async function reviseMessage(
  messageId: Types.ObjectId | string,
  roomId: Types.ObjectId | string,
  update: UpdateQuery<IMessage> = {},
): Promise<MessageDTO> {
  const rev = await allocateRev(roomId);
  const updated = await Message.findByIdAndUpdate(messageId, { ...update, $max: { rev } }, { returnDocument: 'after' }).lean();
  if (!updated) throw notFound('Message');
  const [dto] = await toMessageDTOs([updated]);
  hub.toRoom(String(roomId), 'message:updated', { message: dto! });

  await Room.updateOne(
    { _id: roomId, 'lastMessage.seq': updated.seq },
    { $set: { 'lastMessage.text': payloadExcerpt(updated.payload) } },
  );
  return dto!;
}
