import { Schema, model, type Types } from 'mongoose';
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_STATES,
  POSTURES,
  type NotificationKind,
  type NotificationPreferences,
  type NotificationState,
  type Posture,
} from '@strata/shared';

export interface INotificationPreference extends NotificationPreferences {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
}

const preferenceSchema = new Schema<INotificationPreference>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  timezone: { type: String, default: 'UTC' },
  digestWindows: { type: [String], default: ['09:00', '17:30'] },
  quietHours: {
    enabled: { type: Boolean, default: false },
    start: { type: String, default: '22:00' },
    end: { type: String, default: '07:00' },
  },
  blockingBypassesQuiet: { type: Boolean, default: true },
  channels: { push: { type: Boolean, default: true }, inApp: { type: Boolean, default: true } },
  rules: {
    type: [
      {
        _id: false,
        id: String,
        roomId: String,
        senderId: String,
        posture: { type: String, enum: POSTURES },
        action: { type: String, enum: ['deliver', 'digest', 'mute'] },
      },
    ],
    default: [],
  },
});

export const NotificationPreference = model<INotificationPreference>('NotificationPreference', preferenceSchema);

export interface INotification {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  roomId: Types.ObjectId | null;
  messageId: Types.ObjectId | null;
  kind: NotificationKind;
  posture: Posture;
  /** True when this row waits for a digest window and goes out grouped rather than alone. */
  digest: boolean;
  state: NotificationState;
  reason: string | null;
  title: string;
  body: string;
  digestCount: number;
  dueAt: Date;
  attempts: number;
  leaseUntil: Date | null;
  sentAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    roomId: { type: Schema.Types.ObjectId, default: null },
    messageId: { type: Schema.Types.ObjectId, default: null },
    kind: { type: String, enum: NOTIFICATION_KINDS, default: 'message' },
    posture: { type: String, enum: POSTURES, default: 'standard' },
    digest: { type: Boolean, default: false },
    state: { type: String, enum: NOTIFICATION_STATES, default: 'pending' },
    reason: { type: String, default: null },
    title: { type: String, default: '' },
    body: { type: String, default: '' },
    digestCount: { type: Number, default: 0 },
    dueAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    leaseUntil: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
notificationSchema.index({ state: 1, dueAt: 1 });
notificationSchema.index({ userId: 1, createdAt: -1 });
// One notification of each kind per person per message, even if a retry runs the policy twice.
notificationSchema.index(
  { messageId: 1, userId: 1, kind: 1 },
  { unique: true, partialFilterExpression: { messageId: { $type: 'objectId' } } },
);

export const Notification = model<INotification>('Notification', notificationSchema);

export interface IAckContract {
  _id: Types.ObjectId;
  messageId: Types.ObjectId;
  roomId: Types.ObjectId;
  senderId: Types.ObjectId;
  deadline: Date;
  required: Types.ObjectId[];
  acks: { userId: Types.ObjectId; at: Date }[];
  state: 'open' | 'satisfied' | 'expired';
  reminderAt: Date;
  reminderSentAt: Date | null;
}

const ackContractSchema = new Schema<IAckContract>({
  messageId: { type: Schema.Types.ObjectId, required: true, unique: true },
  roomId: { type: Schema.Types.ObjectId, required: true, index: true },
  senderId: { type: Schema.Types.ObjectId, required: true },
  deadline: { type: Date, required: true },
  required: { type: [Schema.Types.ObjectId], default: [] },
  acks: { type: [{ _id: false, userId: Schema.Types.ObjectId, at: Date }], default: [] },
  state: { type: String, enum: ['open', 'satisfied', 'expired'], default: 'open' },
  reminderAt: { type: Date, required: true },
  reminderSentAt: { type: Date, default: null },
});
ackContractSchema.index({ state: 1, deadline: 1 });
ackContractSchema.index({ state: 1, reminderAt: 1 });

export const AckContract = model<IAckContract>('AckContract', ackContractSchema);

export interface IPushSubscription {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  failures: number;
}

const pushSubscriptionSchema = new Schema<IPushSubscription>({
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  endpoint: { type: String, required: true, unique: true },
  keys: { p256dh: String, auth: String },
  failures: { type: Number, default: 0 },
});

export const PushSubscriptionModel = model<IPushSubscription>('PushSubscription', pushSubscriptionSchema);
