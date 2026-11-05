import * as Y from 'yjs';
import { Types } from 'mongoose';
import {
  BLOCK_REGISTRY,
  LIMITS,
  type BlockActivityDTO,
  type BlockDTO,
  type BlockDefinition,
  type BlockJoinResult,
  type CreateBlockInput,
} from '@strata/shared';
import { getEnv } from '../../config/env.js';
import { AppError, forbidden, isDuplicateKey, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { Block, BlockActivity, BlockUpdate, type IBlock } from '../../models/blocks.js';
import { Room } from '../../models/rooms.js';
import { assertAcceptsMessages, isAdmin, requireMember, requireRead, resolveAccess } from '../access.js';
import type { AuthedUser, GuestContext } from '../auth/middleware.js';
import { postMessage } from '../messages/service.js';

/** Who is touching a block. Members and guests reach here by different routes but follow the same rules. */
export type BlockPrincipal =
  | { kind: 'user'; id: string; name: string }
  | { kind: 'guest'; id: string; name: string; guest: GuestContext };

const rejected = (message: string) => new AppError(422, 'BLOCK_UPDATE_REJECTED', message);

/** Lean queries hand back BSON Binary rather than a Buffer. */
const bytes = (value: Buffer | { buffer: Uint8Array }): Uint8Array => (value instanceof Uint8Array ? value : value.buffer);

const definitionOf = (block: Pick<IBlock, 'type'>): BlockDefinition<unknown, { title: string }> => {
  const def = BLOCK_REGISTRY[block.type];
  if (!def) throw rejected('Unknown block type');
  return def;
};

const toDTO = (b: IBlock): BlockDTO => ({
  id: String(b._id),
  roomId: String(b.roomId),
  messageId: b.messageId ? String(b.messageId) : '',
  type: b.type,
  policy: { edit: b.policy.edit },
  createdBy: b.createdBy,
  summary: b.summary,
});

let scheduleCompaction: (blockId: string) => void = () => {};
export const setCompactionScheduler = (fn: (blockId: string) => void) => {
  scheduleCompaction = fn;
};

export async function createBlock(user: AuthedUser, roomId: string, input: CreateBlockInput): Promise<BlockDTO> {
  const { room } = await requireMember(roomId, user.id);
  assertAcceptsMessages(room);
  const def = BLOCK_REGISTRY[input.type]!;
  const data = parse(def.input, input.data);

  const doc = new Y.Doc();
  def.init(doc, data);
  const summary = def.summarize(doc);

  const block = await Block.create({
    roomId: room._id,
    type: def.type,
    createdBy: user.id,
    policy: { edit: input.policy ?? def.defaultPolicy },
    snapshot: Buffer.from(Y.encodeStateAsUpdate(doc)),
    summary,
  });
  const { message, created } = await postMessage({
    room,
    sender: { type: 'user', id: user.id, name: user.name },
    clientMessageId: input.clientMessageId,
    payload: { type: 'block', blockId: String(block._id), blockType: def.type, title: summary.title },
  });
  if (!created) {
    // A retried request. The first attempt's block is the real one.
    await Block.deleteOne({ _id: block._id });
    const original = message.payload.type === 'block' ? await Block.findById(message.payload.blockId).lean() : null;
    if (!original) throw notFound('Block');
    return toDTO(original);
  }
  await Block.updateOne({ _id: block._id }, { messageId: message.id });
  await BlockActivity.create({ blockId: block._id, actorName: user.name, action: 'created', detail: summary.title });
  return toDTO({ ...block.toObject(), messageId: new Types.ObjectId(message.id) });
}

async function assertCanSee(block: IBlock, principal: BlockPrincipal) {
  if (principal.kind === 'guest') {
    if (!principal.guest.scope.blocks || String(block.roomId) !== String(principal.guest.roomId)) throw notFound('Block');
    return;
  }
  await requireRead(String(block.roomId), principal.id);
}

async function loadBlock(blockId: string): Promise<IBlock> {
  if (!Types.ObjectId.isValid(blockId)) throw notFound('Block');
  const block = await Block.findById(blockId).lean();
  if (!block) throw notFound('Block');
  return block;
}

export async function getBlock(blockId: string, userId: string): Promise<BlockDTO> {
  const block = await loadBlock(blockId);
  await requireRead(String(block.roomId), userId);
  return toDTO(block);
}

export async function getActivity(blockId: string, userId: string): Promise<BlockActivityDTO[]> {
  const block = await loadBlock(blockId);
  await requireRead(String(block.roomId), userId);
  const rows = await BlockActivity.find({ blockId }).sort({ at: -1 }).limit(100).lean();
  return rows.map((a) => ({ id: String(a._id), actorName: a.actorName, action: a.action, detail: a.detail, at: a.at.toISOString() }));
}

export async function setPolicy(blockId: string, userId: string, edit: 'everyone' | 'creator') {
  const block = await loadBlock(blockId);
  const { member } = await requireMember(String(block.roomId), userId);
  if (block.createdBy !== userId && !isAdmin(member)) throw forbidden('Only the creator can change who can edit');
  await Block.updateOne({ _id: block._id }, { 'policy.edit': edit });
  return toDTO({ ...block, policy: { edit } });
}

interface CachedDoc {
  doc: Y.Doc;
  /**
   * Everything up to here is definitely in `doc`. This must never pass a gap: sequence numbers are allocated before
   * their rows are written, so another node's lower number can land after a higher one has been read.
   */
  seq: number;
  type: string;
}

/** Applies updates, moving the watermark only through a run with no gaps. Reapplying is harmless, because Yjs is idempotent. */
function absorb(entry: CachedDoc, updates: { seq: number; update: Buffer | { buffer: Uint8Array } }[]) {
  for (const u of updates) {
    Y.applyUpdate(entry.doc, bytes(u.update));
    if (u.seq === entry.seq + 1) entry.seq = u.seq;
  }
}

/**
 * Per-node cache of live documents. It's only an optimization: before every use it catches up from the log, so nodes
 * don't need to share memory or sticky sessions.
 */
const CACHE_LIMIT = 256;
const cache = new Map<string, CachedDoc>();

function remember(blockId: string, entry: CachedDoc) {
  cache.delete(blockId);
  cache.set(blockId, entry);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value!;
    cache.get(oldest)?.doc.destroy();
    cache.delete(oldest);
  }
}

export const clearBlockCache = () => {
  cache.forEach((c) => c.doc.destroy());
  cache.clear();
};

async function fullLoad(blockId: string): Promise<CachedDoc> {
  // Compaction may run between our two reads. Re-checking `snapshotSeq` tells us the pair was consistent.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const block = await loadBlock(blockId);
    const updates = await BlockUpdate.find({ blockId, seq: { $gt: block.snapshotSeq } }).sort({ seq: 1 }).lean();
    const check = await Block.findById(blockId).select('snapshotSeq').lean();
    if (check?.snapshotSeq !== block.snapshotSeq) continue;

    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes(block.snapshot));
    const entry: CachedDoc = { doc, seq: block.snapshotSeq, type: block.type };
    absorb(entry, updates);
    return entry;
  }
  throw new AppError(503, 'INTERNAL', 'Block is busy, try again');
}

async function currentDoc(blockId: string): Promise<CachedDoc> {
  const cached = cache.get(blockId);
  if (cached) {
    const block = await Block.findById(blockId).select('snapshotSeq').lean();
    if (block && block.snapshotSeq <= cached.seq) {
      absorb(cached, await BlockUpdate.find({ blockId, seq: { $gt: cached.seq } }).sort({ seq: 1 }).lean());
      remember(blockId, cached);
      return cached;
    }
    cached.doc.destroy();
    cache.delete(blockId);
  }
  const loaded = await fullLoad(blockId);
  remember(blockId, loaded);
  return loaded;
}

/** Updates to one block run one at a time on this node, so each is validated against the result of the last. */
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(blockId: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(blockId) ?? Promise.resolve()).then(task, task);
  const tail = run.catch(() => {}).finally(() => {
    if (queues.get(blockId) === tail) queues.delete(blockId);
  });
  queues.set(blockId, tail);
  return run;
}

async function writeAccess(block: IBlock, principal: BlockPrincipal): Promise<{ canEdit: boolean; canManage: boolean }> {
  const room = await Room.findById(block.roomId).select('kind branch.status').lean();
  const open = !(room?.kind === 'branch' && room.branch?.status !== 'open');
  const everyone = block.policy.edit === 'everyone';

  if (principal.kind === 'guest') {
    return { canEdit: open && principal.guest.scope.write, canManage: everyone };
  }
  const access = await resolveAccess(String(block.roomId), principal.id);
  if (!access) throw notFound('Block');
  return {
    canEdit: open && !!access.member,
    canManage: everyone || block.createdBy === principal.id || isAdmin(access.member),
  };
}

export async function joinBlock(blockId: string, principal: BlockPrincipal, stateVector?: Uint8Array): Promise<BlockJoinResult & { roomId: string }> {
  const block = await loadBlock(blockId);
  await assertCanSee(block, principal);
  const { canEdit } = await writeAccess(block, principal);
  return serialized(blockId, async () => {
    const { doc, seq } = await currentDoc(blockId);
    return {
      roomId: String(block.roomId),
      diff: Y.encodeStateAsUpdate(doc, stateVector),
      stateVector: Y.encodeStateVector(doc),
      canEdit,
      seq,
    };
  });
}

/** Keystrokes arrive as many updates, but they're one edit to a reader. Everything else is a separate event. */
const TYPING_ACTIONS = new Set(['edited', 'updated']);
const TYPING_WINDOW_MS = 60_000;

async function recordActivity(blockId: string, actorName: string, changes: { action: string; detail: string }[]) {
  for (const change of changes) {
    if (TYPING_ACTIONS.has(change.action)) {
      const merged = await BlockActivity.findOneAndUpdate(
        {
          blockId,
          actorName,
          action: change.action,
          at: { $gt: new Date(Date.now() - TYPING_WINDOW_MS) },
          // `updated` names a field, so typing in a different field is a different edit.
          ...(change.action === 'updated' ? { detail: change.detail } : {}),
        },
        { detail: change.detail, at: new Date() },
        { sort: { at: -1 } },
      );
      if (merged) continue;
    }
    await BlockActivity.create({ blockId, actorName, ...change });
  }
}

export interface AppliedUpdate {
  seq: number;
  roomId: string;
  duplicate: boolean;
}

/**
 * Accepts one CRDT update. An update is opaque binary from a client, so it's applied to a copy of the document, and
 * the block type judges the resulting state. Only then is it persisted, and only after that acknowledged and relayed.
 */
export async function applyBlockUpdate(
  blockId: string,
  principal: BlockPrincipal,
  update: Uint8Array,
  clientUpdateId: string,
): Promise<AppliedUpdate> {
  if (update.byteLength === 0 || update.byteLength > LIMITS.blockUpdateBytes) throw rejected('Update is too large');
  const block = await loadBlock(blockId);
  await assertCanSee(block, principal);
  const { canEdit, canManage } = await writeAccess(block, principal);
  if (!canEdit) throw forbidden('You cannot edit this block');

  return serialized(blockId, async () => {
    const existing = await BlockUpdate.findOne({ blockId, clientUpdateId }).select('seq').lean();
    if (existing) return { seq: existing.seq, roomId: String(block.roomId), duplicate: true };

    const def = definitionOf(block);
    const current = await currentDoc(blockId);
    const before = def.summarize(current.doc);

    const candidate = new Y.Doc();
    let after: { title: string };
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(current.doc));
      Y.applyUpdate(candidate, update);
      // Pending structs mean this update builds on one we never received, so the client must resync first.
      if (candidate.store.pendingStructs) throw new Error('out of sync');
      after = def.summarize(candidate);
    } catch (err) {
      logger.debug({ err }, 'block update failed to apply');
      throw rejected('That update could not be applied');
    } finally {
      candidate.destroy();
    }

    const problem = def.validate(before, after, {
      actor: { id: principal.id, name: principal.name },
      canManage,
      now: Date.now(),
    });
    if (problem) throw rejected(problem);

    const allocated = await Block.findByIdAndUpdate(
      blockId,
      { $inc: { seq: 1 }, $set: { summary: after } },
      { returnDocument: 'after', projection: { seq: 1, snapshotSeq: 1 } },
    ).lean();
    if (!allocated) throw notFound('Block');

    try {
      await BlockUpdate.create({
        blockId,
        seq: allocated.seq,
        update: Buffer.from(update),
        clientUpdateId,
        actor: { id: principal.id, name: principal.name },
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const winner = await BlockUpdate.findOne({ blockId, clientUpdateId }).select('seq').lean();
      return { seq: winner?.seq ?? allocated.seq, roomId: String(block.roomId), duplicate: true };
    }

    // The watermark stays put here. A lower number from another node may still be in flight, so the next read settles it.
    Y.applyUpdate(current.doc, update);
    await recordActivity(blockId, principal.name, def.describe(before, after));

    if (allocated.seq - allocated.snapshotSeq >= getEnv().BLOCK_COMPACT_THRESHOLD) scheduleCompaction(blockId);
    return { seq: allocated.seq, roomId: String(block.roomId), duplicate: false };
  });
}

/** How long an update must have existed before compaction folds it in. Writes in flight finish well within this. */
const COMPACTION_MIN_AGE_MS = 30_000;

/**
 * Folds logged updates into the snapshot. Sequence numbers are allocated before their row is written, so a young row
 * could still appear below the highest seq we can see. Waiting for updates to age rules that out, and the conditional
 * write means that two compactors can't both succeed.
 */
export async function compactBlock(blockId: string, minAgeMs = COMPACTION_MIN_AGE_MS): Promise<number> {
  const block = await loadBlock(blockId);
  const cutoff = Date.now() - minAgeMs;
  const updates = await BlockUpdate.find({ blockId, seq: { $gt: block.snapshotSeq } }).sort({ seq: 1 }).lean();
  const firstYoung = updates.findIndex((u) => u._id.getTimestamp().getTime() > cutoff);
  const eligible = firstYoung === -1 ? updates : updates.slice(0, firstYoung);
  if (!eligible.length) return 0;

  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes(block.snapshot));
  eligible.forEach((u) => Y.applyUpdate(doc, bytes(u.update)));
  const target = eligible.at(-1)!.seq;

  const written = await Block.updateOne(
    { _id: blockId, snapshotSeq: block.snapshotSeq },
    { snapshot: Buffer.from(Y.encodeStateAsUpdate(doc)), snapshotSeq: target },
  );
  doc.destroy();
  if (written.modifiedCount === 0) return 0;

  await BlockUpdate.deleteMany({ blockId, seq: { $lte: target } });
  return eligible.length;
}
