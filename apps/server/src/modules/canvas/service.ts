import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { Types } from 'mongoose';
import {
  canvasContent,
  createCanvasBlockInput,
  moveCanvasBlockInput,
  newId,
  payloadExcerpt,
  type CanvasBlockDTO,
  type CanvasChange,
  type CanvasContent,
  type CanvasDTO,
  type CanvasSectionDTO,
} from '@strata/shared';
import type { z } from 'zod';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { Block } from '../../models/blocks.js';
import { CanvasBlock, CanvasDocument, type ICanvasBlock, type ICanvasDocument } from '../../models/canvas.js';
import { Message, MessageCitation, type IMessage } from '../../models/messages.js';
import { hub } from '../../realtime/hub.js';
import { requireMember, requireRead } from '../access.js';
import type { AuthedUser } from '../auth/middleware.js';
import { reviseMessage } from '../messages/store.js';

const DEFAULT_SECTION = 'Notes';

const notify = (roomId: string, change: CanvasChange) => hub.toRoom(roomId, 'canvas:changed', { roomId, change });

/** Every room has a Canvas from the first time anyone looks, so callers never handle "no canvas yet". */
async function ensureDocument(roomId: Types.ObjectId | string): Promise<ICanvasDocument> {
  const doc = await CanvasDocument.findOneAndUpdate(
    { roomId },
    { $setOnInsert: { sections: [{ id: newId(), title: DEFAULT_SECTION, order: generateKeyBetween(null, null) }] } },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  return doc!;
}

const sortedSections = (doc: ICanvasDocument): CanvasSectionDTO[] =>
  [...doc.sections].sort((a, b) => (a.order < b.order ? -1 : 1)).map((s) => ({ id: s.id, title: s.title, order: s.order }));

function toDTO(b: ICanvasBlock, deletedSources: Set<string>): CanvasBlockDTO {
  return {
    id: String(b._id),
    roomId: String(b.roomId),
    sectionId: b.sectionId,
    order: b.order,
    content: b.content,
    source: b.source
      ? {
          messageId: String(b.source.messageId),
          roomId: String(b.source.roomId),
          seq: b.source.seq,
          senderName: b.source.senderName,
          excerpt: b.source.excerpt,
          sentAt: b.source.sentAt.toISOString(),
          available: !deletedSources.has(String(b.source.messageId)),
        }
      : null,
    version: b.version,
    createdBy: b.createdBy,
    updatedAt: b.updatedAt.toISOString(),
  };
}

async function findDeletedSources(blocks: ICanvasBlock[]): Promise<Set<string>> {
  const ids = blocks.flatMap((b) => (b.source ? [b.source.messageId] : []));
  if (!ids.length) return new Set();
  const gone = await Message.find({ _id: { $in: ids }, deletedAt: { $ne: null } }).select('_id').lean();
  return new Set(gone.map((m) => String(m._id)));
}

/** Authorization is the caller's job: members and guests get here through different checks. */
export async function getCanvas(roomId: Types.ObjectId | string): Promise<CanvasDTO> {
  const [doc, blocks] = await Promise.all([
    ensureDocument(roomId),
    CanvasBlock.find({ roomId, deletedAt: null }).sort({ order: 1, _id: 1 }).lean(),
  ]);
  const deleted = await findDeletedSources(blocks);
  return { roomId: String(roomId), sections: sortedSections(doc), blocks: blocks.map((b) => toDTO(b, deleted)) };
}

export async function getMemberCanvas(roomId: string, userId: string): Promise<CanvasDTO> {
  await requireRead(roomId, userId);
  return getCanvas(roomId);
}

export async function addSection(roomId: string, userId: string, title: string): Promise<CanvasDTO> {
  await requireMember(roomId, userId);
  const doc = await ensureDocument(roomId);
  const last = sortedSections(doc).at(-1);
  await CanvasDocument.updateOne(
    { roomId },
    { $push: { sections: { id: newId(), title, order: generateKeyBetween(last?.order ?? null, null) } } },
  );
  notify(roomId, { kind: 'sections' });
  return getCanvas(roomId);
}

export async function renameSection(roomId: string, userId: string, sectionId: string, title: string): Promise<CanvasDTO> {
  await requireMember(roomId, userId);
  const updated = await CanvasDocument.updateOne({ roomId, 'sections.id': sectionId }, { $set: { 'sections.$.title': title } });
  if (updated.matchedCount === 0) throw notFound('Section');
  notify(roomId, { kind: 'sections' });
  return getCanvas(roomId);
}

/** Removing a section keeps its blocks, moving them to the first remaining section. */
export async function deleteSection(roomId: string, userId: string, sectionId: string): Promise<CanvasDTO> {
  await requireMember(roomId, userId);
  const doc = await ensureDocument(roomId);
  const sections = sortedSections(doc);
  if (!sections.some((s) => s.id === sectionId)) throw notFound('Section');
  const heir = sections.find((s) => s.id !== sectionId);
  if (!heir) throw conflict('A Canvas needs at least one section');

  const orphans = await CanvasBlock.find({ roomId, sectionId, deletedAt: null }).sort({ order: 1 }).lean();
  const tail = await lastOrder(roomId, heir.id);
  const keys = generateNKeysBetween(tail, null, orphans.length);
  await Promise.all(
    orphans.map((b, i) => CanvasBlock.updateOne({ _id: b._id }, { sectionId: heir.id, order: keys[i], $inc: { version: 1 } })),
  );
  await CanvasDocument.updateOne({ roomId }, { $pull: { sections: { id: sectionId } } });
  notify(roomId, { kind: 'sections' });
  return getCanvas(roomId);
}

async function lastOrder(roomId: string | Types.ObjectId, sectionId: string): Promise<string | null> {
  const last = await CanvasBlock.findOne({ roomId, sectionId, deletedAt: null }).sort({ order: -1 }).select('order').lean();
  return last?.order ?? null;
}

const URL_ONLY = /^https?:\/\/\S+$/i;

/** Turns a message into Canvas content, picking the kind that fits what the message actually is. */
function extract(message: IMessage, asKind: 'quote' | 'decision' | 'text' | undefined): CanvasContent {
  const { payload } = message;
  if (payload.type === 'block') return { kind: 'live', blockId: payload.blockId };
  if (payload.type === 'resolution') {
    return { kind: 'decision', text: `${payload.branchTitle}: ${payload.summary}`, status: 'decided' };
  }
  const text = payload.type === 'text' ? payload.text : payloadExcerpt(payload, 500);
  if (!asKind && URL_ONLY.test(text.trim())) return { kind: 'link', url: text.trim(), title: '' };
  if (asKind === 'decision') return { kind: 'decision', text, status: 'decided' };
  return { kind: asKind ?? 'quote', text };
}

export async function createBlock(user: AuthedUser, roomId: string, input: z.output<typeof createCanvasBlockInput>): Promise<CanvasBlockDTO> {
  await requireMember(roomId, user.id);
  const doc = await ensureDocument(roomId);
  const sectionId = input.sectionId ?? sortedSections(doc)[0]!.id;
  if (!doc.sections.some((s) => s.id === sectionId)) throw notFound('Section');

  let source: ICanvasBlock['source'] = null;
  let content = input.content;
  let message: IMessage | null = null;

  if (input.fromMessageId) {
    // Same room only. Filing a branch message on the parent's Canvas would show it to people outside the branch.
    message = await Message.findOne({ _id: input.fromMessageId, roomId, deletedAt: null }).lean();
    if (!message) throw badRequest('That message is not in this conversation');
    // The server can't read an encrypted message, so whoever files it has to supply the text, knowing the Canvas is plain.
    if (message.payload.type === 'encrypted' && !content) throw badRequest('Add the text yourself. The server cannot read encrypted messages.');
    content = content ?? extract(message, input.asKind);
    source = {
      messageId: message._id,
      roomId: message.roomId,
      seq: message.seq,
      senderName: message.sender.name,
      excerpt: payloadExcerpt(message.payload, 200),
      sentAt: message.createdAt,
    };
  }
  if (!content) throw badRequest('Nothing to add');
  if (content.kind === 'live' && !(await Block.exists({ _id: content.blockId, roomId }))) throw badRequest('That block is not in this conversation');

  const block = await CanvasBlock.create({
    roomId,
    sectionId,
    order: generateKeyBetween(await lastOrder(roomId, sectionId), null),
    content,
    source,
    createdBy: user.id,
    updatedBy: user.id,
  });

  if (message) {
    await MessageCitation.create({
      fromKind: 'canvas',
      fromId: block._id,
      fromRoomId: new Types.ObjectId(roomId),
      toMessageId: message._id,
      toRoomId: message.roomId,
      label: 'Canvas',
      createdBy: user.id,
    });
    await reviseMessage(message._id, roomId, { $inc: { refCount: 1 } });
  }
  notify(roomId, { kind: 'block', blockId: String(block._id) });
  return toDTO(block.toObject() as ICanvasBlock, new Set());
}

async function loadBlock(blockId: string, userId: string) {
  const block = await CanvasBlock.findOne({ _id: blockId, deletedAt: null }).lean();
  if (!block) throw notFound('Canvas block');
  await requireMember(String(block.roomId), userId);
  return block;
}

export async function updateBlock(blockId: string, userId: string, content: z.output<typeof canvasContent>, version: number) {
  const block = await loadBlock(blockId, userId);
  if (block.content.kind !== content.kind) throw badRequest('A block cannot change kind');
  if (content.kind === 'live') throw badRequest('Live blocks are edited in place');

  const updated = await CanvasBlock.findOneAndUpdate(
    { _id: blockId, version, deletedAt: null },
    { $set: { content, updatedBy: userId }, $inc: { version: 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (!updated) {
    const latest = await CanvasBlock.findById(blockId).lean();
    throw new AppError(409, 'VERSION_CONFLICT', 'Someone else just changed this. Review their edit and try again.', {
      latest: latest ? toDTO(latest, new Set()) : null,
    });
  }
  notify(String(block.roomId), { kind: 'block', blockId });
  return toDTO(updated, await findDeletedSources([updated]));
}

export async function moveBlock(blockId: string, userId: string, input: z.output<typeof moveCanvasBlockInput>) {
  const block = await loadBlock(blockId, userId);
  const roomId = String(block.roomId);
  const doc = await ensureDocument(roomId);
  if (!doc.sections.some((s) => s.id === input.sectionId)) throw notFound('Section');

  const neighbour = async (id: string | null) => {
    if (!id) return null;
    const n = await CanvasBlock.findOne({ _id: id, roomId, sectionId: input.sectionId, deletedAt: null }).select('order').lean();
    return n?.order ?? null;
  };
  const [after, before] = await Promise.all([neighbour(input.afterId), neighbour(input.beforeId)]);

  let order: string;
  try {
    order = generateKeyBetween(after, before);
  } catch {
    // Two concurrent moves produced equal keys. Respace the section, then place the block.
    const rows = await CanvasBlock.find({ roomId, sectionId: input.sectionId, deletedAt: null, _id: { $ne: blockId } }).sort({ order: 1, _id: 1 }).lean();
    const keys = generateNKeysBetween(null, null, rows.length + 1);
    const index = input.afterId ? rows.findIndex((r) => String(r._id) === input.afterId) + 1 : 0;
    await Promise.all(rows.map((r, i) => CanvasBlock.updateOne({ _id: r._id }, { order: keys[i < index ? i : i + 1] })));
    order = keys[index]!;
  }

  const updated = await CanvasBlock.findOneAndUpdate(
    { _id: blockId },
    { $set: { sectionId: input.sectionId, order, updatedBy: userId }, $inc: { version: 1 } },
    { returnDocument: 'after' },
  ).lean();
  notify(roomId, { kind: 'block', blockId });
  return toDTO(updated!, await findDeletedSources([updated!]));
}

export async function deleteBlock(blockId: string, userId: string) {
  const block = await loadBlock(blockId, userId);
  await CanvasBlock.updateOne({ _id: blockId }, { deletedAt: new Date() });
  if (block.source) {
    await MessageCitation.deleteOne({ fromKind: 'canvas', fromId: block._id });
    await reviseMessage(block.source.messageId, block.roomId, { $inc: { refCount: -1 } });
  }
  notify(String(block.roomId), { kind: 'block_removed', blockId });
}
