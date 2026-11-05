import { z } from 'zod';
import { objectId, postureSchema, type Posture } from './common.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

export const isValidTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const notificationRule = z.object({
  id: z.string().min(1).max(40),
  roomId: objectId.optional(),
  senderId: objectId.optional(),
  posture: postureSchema.optional(),
  action: z.enum(['deliver', 'digest', 'mute']),
});
export type NotificationRule = z.infer<typeof notificationRule>;

export const notificationPreferences = z.object({
  timezone: z.string().refine(isValidTimezone, 'Unknown timezone'),
  digestWindows: z.array(hhmm).min(1).max(6),
  quietHours: z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }),
  blockingBypassesQuiet: z.boolean(),
  channels: z.object({ push: z.boolean(), inApp: z.boolean() }),
  rules: z.array(notificationRule).max(50),
});
export type NotificationPreferences = z.infer<typeof notificationPreferences>;

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  timezone: 'UTC',
  digestWindows: ['09:00', '17:30'],
  quietHours: { enabled: false, start: '22:00', end: '07:00' },
  blockingBypassesQuiet: true,
  channels: { push: true, inApp: true },
  rules: [],
};

export const NOTIFICATION_STATES = ['pending', 'sent', 'suppressed', 'failed'] as const;
export type NotificationState = (typeof NOTIFICATION_STATES)[number];
export const NOTIFICATION_KINDS = ['message', 'ack_reminder', 'ack_expired', 'digest'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationDTO {
  id: string;
  kind: NotificationKind;
  posture: Posture;
  state: NotificationState;
  roomId: string | null;
  messageId: string | null;
  title: string;
  body: string;
  digestCount: number;
  dueAt: string;
  sentAt: string | null;
  readAt: string | null;
}

/** Something waiting on this person, for the Needs You strip. */
export interface NeedsYouDTO {
  messageId: string;
  roomId: string;
  seq: number;
  roomName: string;
  senderName: string;
  excerpt: string;
  deadline: string;
}

export interface AckStatusDTO {
  messageId: string;
  deadline: string;
  state: 'open' | 'satisfied' | 'expired';
  required: { userId: string; name: string; ackedAt: string | null }[];
}

export interface RecipientDeliveryDTO {
  userId: string;
  name: string;
  state: NotificationState | 'none';
  dueAt: string | null;
  sentAt: string | null;
  reason: string | null;
}
export interface DeliveryStatusDTO {
  messageId: string;
  posture: Posture;
  recipients: RecipientDeliveryDTO[];
  ack: AckStatusDTO | null;
}

export const pushSubscriptionInput = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});
export const markNotificationsReadInput = z.object({ ids: z.array(objectId).max(200).optional() });
