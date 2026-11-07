import { Types } from 'mongoose';
import webpush from 'web-push';
import {
  DEFAULT_PREFERENCES,
  payloadExcerpt,
  type AckStatusDTO,
  type DeliveryStatusDTO,
  type NeedsYouDTO,
  type NotificationDTO,
  type NotificationPreferences,
} from '@strata/shared';
import { getEnv } from '../../config/env.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { getVapid } from '../../lib/vapid.js';
import {
  AckContract,
  Notification,
  NotificationPreference,
  PushSubscriptionModel,
  type IAckContract,
  type INotification,
} from '../../models/delivery.js';
import { User } from '../../models/identity.js';
import { Message, type IMessage } from '../../models/messages.js';
import { Room, RoomMember, type IRoom } from '../../models/rooms.js';
import { hub } from '../../realtime/hub.js';
import { requireRead } from '../access.js';
import { reviseMessage } from '../messages/store.js';
import { MAX_ATTEMPTS, decide, isQuiet, nextDigestAt, quietEnd, retryDelayMs } from './policy.js';

const LEASE_MS = 60_000;
const SWEEP_BATCH = 500;

/** Push payloads pass through browser vendors' servers, so they never carry message content. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  /** Notifications with the same tag replace each other, so a busy room makes one entry and not twenty. */
  tag: string;
}
export type PushSender = (userId: string, payload: PushPayload) => Promise<void>;

let pushSender: PushSender = sendWebPush;
export const setPushSender = (sender: PushSender) => {
  pushSender = sender;
};
export const resetPushSender = () => {
  pushSender = sendWebPush;
};

async function sendWebPush(userId: string, payload: PushPayload): Promise<void> {
  const env = getEnv();
  const vapid = await getVapid();
  const subject = env.VAPID_SUBJECT ?? env.APP_URL;
  const subscriptions = await PushSubscriptionModel.find({ userId }).lean();
  const results = await Promise.allSettled(
    subscriptions.map((sub) =>
      webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), {
        vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: 3600,
      }),
    ),
  );
  let transient: unknown;
  await Promise.all(
    results.map(async (result, i) => {
      if (result.status === 'fulfilled') return;
      const status = (result.reason as { statusCode?: number }).statusCode;
      // 404 and 410 mean the browser has unsubscribed for good. Anything else is worth retrying.
      if (status === 404 || status === 410) await PushSubscriptionModel.deleteOne({ _id: subscriptions[i]!._id });
      else transient = result.reason;
    }),
  );
  if (transient) throw transient;
}

export async function getPreferences(userId: string | Types.ObjectId): Promise<NotificationPreferences> {
  const prefs = await NotificationPreference.findOne({ userId }).lean();
  if (!prefs) return DEFAULT_PREFERENCES;
  return {
    timezone: prefs.timezone,
    digestWindows: prefs.digestWindows,
    quietHours: prefs.quietHours,
    blockingBypassesQuiet: prefs.blockingBypassesQuiet,
    channels: prefs.channels,
    rules: prefs.rules,
  };
}

export async function savePreferences(userId: string, prefs: NotificationPreferences) {
  await NotificationPreference.updateOne({ userId }, { $set: prefs }, { upsert: true });
  return getPreferences(userId);
}

const titleFor = (room: IRoom, senderName: string) => (room.kind === 'direct' ? senderName : `${senderName} in ${room.name}`);

/** Requests the sweep immediately rather than waiting for its next tick. Set by the job layer. */
let kick: () => void = () => {};
export const setSweepKick = (fn: () => void) => {
  kick = fn;
};

async function insertNotifications(rows: Partial<INotification>[]) {
  if (!rows.length) return;
  // A retried send can reach here twice. The unique index absorbs it, and `ordered: false` keeps the other rows.
  await Notification.insertMany(rows, { ordered: false }).catch((err: { code?: number; writeErrors?: unknown[] }) => {
    if (err.code !== 11000) throw err;
  });
}

/**
 * Applies the policy to a persisted message, for each recipient. Every outcome is recorded, including suppression,
 * so that the sender's delivery view can say what happened and why.
 */
export async function onMessagePosted(message: IMessage, room: IRoom, ackDeadline?: Date, actorId?: string): Promise<IAckContract | null> {
  if (message.payload.type === 'system') return null;

  const now = new Date();
  const senderId = actorId ?? message.sender.id;
  // Guests and system senders have no member row. Their ids aren't ObjectIds, so they mustn't reach this filter.
  const except = Types.ObjectId.isValid(senderId) ? { userId: { $ne: senderId } } : {};
  const members = await RoomMember.find({ roomId: room._id, leftAt: null, ...except }).lean();

  let contract: IAckContract | null = null;
  if (message.posture === 'blocking_ack' && ackDeadline) {
    const span = ackDeadline.getTime() - now.getTime();
    contract = (
      await AckContract.findOneAndUpdate(
        { messageId: message._id },
        {
          $setOnInsert: {
            roomId: room._id,
            senderId: new Types.ObjectId(message.sender.id),
            deadline: ackDeadline,
            required: members.map((m) => m.userId),
            reminderAt: new Date(now.getTime() + span * 0.75),
          },
        },
        { upsert: true, returnDocument: 'after' },
      )
    )?.toObject() ?? null;
  }

  const excerpt = payloadExcerpt(message.payload);
  const rows = await Promise.all(
    members.map(async (member): Promise<Partial<INotification> | null> => {
      const decision = decide({
        posture: message.posture,
        prefs: await getPreferences(member.userId),
        now,
        muted: !!member.mutedUntil && member.mutedUntil > now,
        roomId: String(room._id),
        senderId,
      });
      if (decision.action === 'none') return null;
      const base = {
        userId: member.userId,
        roomId: room._id,
        messageId: message._id,
        posture: message.posture,
        title: titleFor(room, message.sender.name),
        body: excerpt,
      };
      return decision.action === 'suppress'
        ? { ...base, state: 'suppressed', reason: decision.reason, dueAt: now }
        : { ...base, dueAt: decision.dueAt, digest: decision.digest, reason: decision.reason };
    }),
  );

  const toInsert = rows.filter((r): r is Partial<INotification> => r !== null);
  await insertNotifications(toInsert);
  if (toInsert.some((r) => r.state !== 'suppressed' && r.dueAt! <= now)) kick();
  return contract;
}

export const toNotificationDTO = (n: INotification): NotificationDTO => ({
  id: String(n._id),
  kind: n.kind,
  posture: n.posture,
  state: n.state,
  roomId: n.roomId ? String(n.roomId) : null,
  messageId: n.messageId ? String(n.messageId) : null,
  title: n.title,
  body: n.body,
  digestCount: n.digestCount,
  dueAt: n.dueAt.toISOString(),
  sentAt: n.sentAt?.toISOString() ?? null,
  readAt: n.readAt?.toISOString() ?? null,
});

async function alreadySeen(n: INotification): Promise<boolean> {
  if (n.kind !== 'message' || !n.messageId || n.posture === 'blocking_ack') return false;
  const [message, member] = await Promise.all([
    Message.findById(n.messageId).select('seq deletedAt').lean(),
    RoomMember.findOne({ roomId: n.roomId, userId: n.userId }).select('lastReadSeq leftAt').lean(),
  ]);
  if (!message || message.deletedAt || !member || member.leftAt) return true;
  return member.lastReadSeq >= message.seq;
}

const PUSH_BODY: Record<string, string> = {
  message: 'New message',
  ack_reminder: 'Please acknowledge before the deadline',
  ack_expired: 'An acknowledgement request has expired',
};

/**
 * Push payloads are encrypted to the browser, but they still pass through its vendor, so they carry who and where and
 * never what. That also means this works the same for end-to-end encrypted conversations.
 */
function pushFor(n: INotification): PushPayload {
  if (n.kind === 'digest') {
    return { title: 'Your Strata digest', body: n.body || `${n.digestCount} updates`, url: '/attention', tag: 'digest' };
  }
  const body = n.posture === 'blocking_ack' && n.kind === 'message' ? 'Needs your acknowledgement' : (PUSH_BODY[n.kind] ?? 'New activity');
  return { title: n.title || 'Strata', body, url: n.roomId ? `/r/${String(n.roomId)}` : '/', tag: n.roomId ? `room:${String(n.roomId)}` : n.kind };
}

async function transmit(n: INotification) {
  const prefs = await getPreferences(n.userId);
  const userId = String(n.userId);
  const sentAt = new Date();
  if (prefs.channels.inApp) hub.toUser(userId, 'notification:new', { notification: toNotificationDTO({ ...n, state: 'sent', sentAt }) });
  // Online isn't the right test: a phone in a pocket keeps its socket for a while. What matters is whether a window of
  // Strata is in front of the person, because that window shows its own alert and a second one would be noise.
  if (prefs.channels.push && !(await hub.activeUsers([userId])).length) await pushSender(userId, pushFor(n));
  return sentAt;
}

async function dispatchOne(n: INotification) {
  try {
    if (await alreadySeen(n)) {
      await Notification.updateOne({ _id: n._id }, { state: 'suppressed', reason: 'already_read', leaseUntil: null });
      return;
    }
    const sentAt = await transmit(n);
    await Notification.updateOne({ _id: n._id }, { state: 'sent', sentAt, leaseUntil: null, reason: n.reason });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'delivery failed';
    logger.warn({ id: String(n._id), attempts: n.attempts, message }, 'notification delivery failed');
    await Notification.updateOne(
      { _id: n._id },
      n.attempts >= MAX_ATTEMPTS
        ? { state: 'failed', reason: message.slice(0, 200), leaseUntil: null }
        : { dueAt: new Date(Date.now() + retryDelayMs(n.attempts)), leaseUntil: null, reason: message.slice(0, 200) },
    );
  }
}

/** "Launch Crew (3), Design (1)": who to look at, without repeating what was said. */
async function summariseByRoom(rows: INotification[]): Promise<string> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(String(row.roomId), (counts.get(String(row.roomId)) ?? 0) + 1);
  const rooms = await Room.find({ _id: { $in: [...counts.keys()] } }).select('name kind').lean();
  const names = new Map(rooms.map((r) => [String(r._id), r.kind === 'direct' ? 'Direct messages' : r.name]));
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${names.get(id) ?? 'A conversation'} (${n})`);
  return parts.length > 3 ? `${parts.slice(0, 3).join(', ')} and ${parts.length - 3} more` : parts.join(', ');
}

/** What's being held for the next digest, by conversation, so that waiting is never a mystery. */
export async function digestQueue(userId: string) {
  const rows = await Notification.aggregate<{ _id: Types.ObjectId; count: number; latestAt: Date }>([
    { $match: { userId: new Types.ObjectId(userId), digest: true, state: 'pending' } },
    { $group: { _id: '$roomId', count: { $sum: 1 }, latestAt: { $max: '$createdAt' } } },
    { $sort: { latestAt: -1 } },
  ]);
  const rooms = await Room.find({ _id: { $in: rows.map((r) => r._id) } }).select('name kind').lean();
  const names = new Map(rooms.map((r) => [String(r._id), r.name]));
  const prefs = await getPreferences(userId);
  return {
    total: rows.reduce((sum, r) => sum + r.count, 0),
    nextAt: rows.length ? nextDigestAt(prefs, new Date()).toISOString() : null,
    items: rows.map((r) => ({ roomId: String(r._id), roomName: names.get(String(r._id)) ?? 'A conversation', count: r.count, latestAt: r.latestAt.toISOString() })),
  };
}

/** Delivers everything held for the digest now, as one notification, instead of waiting for the next window. */
export async function flushDigest(userId: string) {
  const { modifiedCount } = await Notification.updateMany({ userId, digest: true, state: 'pending' }, { dueAt: new Date() });
  if (modifiedCount) kick();
  return modifiedCount;
}

/** Replaces a user's due digest rows with a single notification, so a batch interrupts once. */
async function dispatchDigest(first: INotification, now: Date) {
  const lease = new Date(now.getTime() + LEASE_MS);
  await Notification.updateMany(
    { userId: first.userId, digest: true, state: 'pending', dueAt: { $lte: now }, _id: { $ne: first._id }, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
    { leaseUntil: lease },
  );
  const claimed = await Notification.find({ userId: first.userId, digest: true, state: 'pending', leaseUntil: lease }).lean();
  const rows = [first, ...claimed.filter((r) => String(r._id) !== String(first._id))];

  const unseen: INotification[] = [];
  for (const row of rows) {
    if (await alreadySeen(row)) await Notification.updateOne({ _id: row._id }, { state: 'suppressed', reason: 'already_read', leaseUntil: null });
    else unseen.push(row);
  }
  if (!unseen.length) return;

  const digest = await Notification.create({
    userId: first.userId,
    kind: 'digest',
    posture: 'digest',
    title: `${unseen.length} update${unseen.length === 1 ? '' : 's'} while you were away`,
    body: await summariseByRoom(unseen),
    digestCount: unseen.length,
    dueAt: now,
    leaseUntil: lease,
    attempts: 1,
  });
  await dispatchOne(digest.toObject());
  await Notification.updateMany(
    { _id: { $in: unseen.map((r) => r._id) } },
    { state: 'sent', sentAt: new Date(), leaseUntil: null, reason: 'delivered_in_digest' },
  );
}

async function claimNext(now: Date): Promise<INotification | null> {
  // The lease means a crashed worker's rows return to the pool, and two workers can't take the same row.
  return Notification.findOneAndUpdate(
    { state: 'pending', dueAt: { $lte: now }, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
    { $set: { leaseUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
    { sort: { dueAt: 1 }, returnDocument: 'after' },
  ).lean();
}

async function processAckReminders(now: Date) {
  for (;;) {
    const contract = await AckContract.findOneAndUpdate(
      { state: 'open', reminderAt: { $lte: now }, reminderSentAt: null },
      { reminderSentAt: now },
      { returnDocument: 'after' },
    ).lean();
    if (!contract) return;

    const message = await Message.findById(contract.messageId).lean();
    const room = await Room.findById(contract.roomId).lean();
    if (!message || !room) continue;
    const acked = new Set(contract.acks.map((a) => String(a.userId)));
    const pending = contract.required.filter((id) => !acked.has(String(id)));

    const rows = await Promise.all(
      pending.map(async (userId) => {
        const prefs = await getPreferences(userId);
        const held = isQuiet(prefs, now) && !prefs.blockingBypassesQuiet;
        return {
          userId,
          roomId: room._id,
          messageId: message._id,
          kind: 'ack_reminder' as const,
          posture: 'blocking_ack' as const,
          title: `Acknowledgement needed: ${titleFor(room, message.sender.name)}`,
          body: payloadExcerpt(message.payload),
          dueAt: held ? quietEnd(prefs, now) : now,
        };
      }),
    );
    await insertNotifications(rows);
  }
}

async function processAckDeadlines(now: Date) {
  for (;;) {
    const contract = await AckContract.findOneAndUpdate(
      { state: 'open', deadline: { $lte: now } },
      { state: 'expired' },
      { returnDocument: 'after' },
    ).lean();
    if (!contract) return;

    const message = await Message.findById(contract.messageId).lean();
    if (!message) continue;
    const status = await toAckStatus(contract);
    hub.toRoom(String(contract.roomId), 'ack:updated', { roomId: String(contract.roomId), status });
    await reviseMessage(message._id, contract.roomId);

    const missing = status.required.filter((r) => !r.ackedAt).map((r) => r.name);
    await insertNotifications([
      {
        userId: contract.senderId,
        roomId: contract.roomId,
        messageId: message._id,
        kind: 'ack_expired',
        posture: 'blocking_ack',
        title: 'Acknowledgement deadline passed',
        body: `Still waiting on ${missing.join(', ') || 'nobody'}.`,
        dueAt: now,
      },
    ]);
  }
}

/** One pass over everything that's due. Safe to run concurrently, because each piece of work is claimed atomically. */
export async function sweep(now = new Date()): Promise<number> {
  await processAckDeadlines(now);
  await processAckReminders(now);
  let handled = 0;
  while (handled < SWEEP_BATCH) {
    const next = await claimNext(now);
    if (!next) break;
    handled += 1;
    if (next.digest) await dispatchDigest(next, now);
    else await dispatchOne(next);
  }
  return handled;
}

async function toAckStatus(contract: IAckContract): Promise<AckStatusDTO> {
  const users = await User.find({ _id: { $in: contract.required } }).select('displayName').lean();
  const names = new Map(users.map((u) => [String(u._id), u.displayName]));
  const acks = new Map(contract.acks.map((a) => [String(a.userId), a.at]));
  return {
    messageId: String(contract.messageId),
    deadline: contract.deadline.toISOString(),
    state: contract.state,
    required: contract.required.map((id) => ({
      userId: String(id),
      name: names.get(String(id)) ?? 'Former member',
      ackedAt: acks.get(String(id))?.toISOString() ?? null,
    })),
  };
}

export async function acknowledge(messageId: string, userId: string): Promise<AckStatusDTO> {
  const message = await Message.findById(messageId).lean();
  if (!message) throw notFound('Message');
  await requireRead(String(message.roomId), userId);

  const existing = await AckContract.findOne({ messageId }).lean();
  if (!existing) throw new AppError(409, 'CONFLICT', 'This message does not need acknowledgement');
  if (!existing.required.some((id) => String(id) === userId)) throw forbidden('You are not asked to acknowledge this');

  const uid = new Types.ObjectId(userId);
  // A late acknowledgement is still recorded, because knowing it happened is useful. It just can't satisfy the contract.
  const updated = await AckContract.findOneAndUpdate(
    { messageId, 'acks.userId': { $ne: uid } },
    { $push: { acks: { userId: uid, at: new Date() } } },
    { returnDocument: 'after' },
  ).lean();
  let contract = updated ?? existing;

  if (updated) {
    if (updated.state === 'open' && updated.acks.length >= updated.required.length) {
      contract = (await AckContract.findOneAndUpdate({ _id: updated._id, state: 'open' }, { state: 'satisfied' }, { returnDocument: 'after' }).lean()) ?? updated;
    }
    await Notification.updateMany(
      { messageId, userId, state: 'pending' },
      { state: 'suppressed', reason: 'acknowledged', leaseUntil: null },
    );
    await reviseMessage(message._id, message.roomId);
  }
  const status = await toAckStatus(contract);
  hub.toRoom(String(message.roomId), 'ack:updated', { roomId: String(message.roomId), status });
  return status;
}

export async function deliveryStatus(messageId: string, userId: string): Promise<DeliveryStatusDTO> {
  const message = await Message.findById(messageId).lean();
  if (!message) throw notFound('Message');
  await requireRead(String(message.roomId), userId);
  if (message.sender.id !== userId) throw forbidden('Only the sender can see delivery details');

  const [members, rows, contract] = await Promise.all([
    RoomMember.find({ roomId: message.roomId, leftAt: null, userId: { $ne: userId } }).lean(),
    Notification.find({ messageId, kind: 'message' }).lean(),
    AckContract.findOne({ messageId }).lean(),
  ]);
  const users = await User.find({ _id: { $in: members.map((m) => m.userId) } }).select('displayName').lean();
  const names = new Map(users.map((u) => [String(u._id), u.displayName]));
  const byUser = new Map(rows.map((r) => [String(r.userId), r]));

  return {
    messageId,
    posture: message.posture,
    recipients: members.map((m) => {
      const id = String(m.userId);
      const row = byUser.get(id);
      // A recipient's mute is theirs. The sender learns it was held back, not why.
      const reason = row?.state === 'suppressed' && row.reason !== 'already_read' && row.reason !== 'acknowledged' ? 'held_by_recipient' : (row?.reason ?? null);
      return {
        userId: id,
        name: names.get(id) ?? 'Member',
        state: row?.state ?? 'none',
        dueAt: row?.dueAt.toISOString() ?? null,
        sentAt: row?.sentAt?.toISOString() ?? null,
        reason,
      };
    }),
    ack: contract ? await toAckStatus(contract) : null,
  };
}

export async function needsYou(userId: string): Promise<NeedsYouDTO[]> {
  const uid = new Types.ObjectId(userId);
  const contracts = await AckContract.find({ state: 'open', required: uid, 'acks.userId': { $ne: uid } }).sort({ deadline: 1 }).limit(20).lean();
  const [messages, rooms] = await Promise.all([
    Message.find({ _id: { $in: contracts.map((c) => c.messageId) }, deletedAt: null }).lean(),
    Room.find({ _id: { $in: contracts.map((c) => c.roomId) } }).select('name').lean(),
  ]);
  const byMessage = new Map(messages.map((m) => [String(m._id), m]));
  const names = new Map(rooms.map((r) => [String(r._id), r.name]));
  return contracts.flatMap((c) => {
    const message = byMessage.get(String(c.messageId));
    if (!message) return [];
    return [
      {
        messageId: String(c.messageId),
        roomId: String(c.roomId),
        seq: message.seq,
        roomName: names.get(String(c.roomId)) || message.sender.name,
        senderName: message.sender.name,
        excerpt: payloadExcerpt(message.payload),
        deadline: c.deadline.toISOString(),
      },
    ];
  });
}

export async function listNotifications(userId: string) {
  const rows = await Notification.find({ userId, state: 'sent', digest: false }).sort({ createdAt: -1 }).limit(50).lean();
  return rows.map(toNotificationDTO);
}

export async function markNotificationsRead(userId: string, ids?: string[]) {
  await Notification.updateMany({ userId, readAt: null, ...(ids ? { _id: { $in: ids } } : {}) }, { readAt: new Date() });
}

export async function savePushSubscription(userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  await PushSubscriptionModel.updateOne({ endpoint: sub.endpoint }, { $set: { userId, keys: sub.keys, failures: 0 } }, { upsert: true });
}

export async function removePushSubscription(userId: string, endpoint: string) {
  await PushSubscriptionModel.deleteOne({ endpoint, userId });
}
