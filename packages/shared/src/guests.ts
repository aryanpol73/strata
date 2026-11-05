import { z } from 'zod';
import { LIMITS, clientId, objectId } from './common.js';

export const GUEST_MAX_DAYS = 30;

export const createGuestLinkInput = z.object({
  label: z.string().trim().min(1).max(80),
  scope: z
    .object({ write: z.boolean().default(true), blocks: z.boolean().default(false), canvas: z.boolean().default(false) })
    .default({ write: true, blocks: false, canvas: false }),
  pin: z.string().regex(/^\d{4,8}$/, 'Use a 4-8 digit PIN').optional(),
  expiresInHours: z.number().int().min(1).max(GUEST_MAX_DAYS * 24).default(7 * 24),
});
export type CreateGuestLinkInput = z.input<typeof createGuestLinkInput>;

export const redeemGuestInput = z.object({
  token: z.string().min(20).max(128),
  pin: z.string().regex(/^\d{4,8}$/).optional(),
  displayName: z.string().trim().min(1).max(LIMITS.displayName),
});
export type RedeemGuestInput = z.infer<typeof redeemGuestInput>;

/** Guests send plain text. Reply references are checked to stay inside the branch. */
export const guestSendInput = z.object({
  clientMessageId: clientId,
  text: z.string().trim().min(1).max(LIMITS.messageText),
  replyToId: objectId.optional(),
});

export interface GuestScope {
  write: boolean;
  blocks: boolean;
  canvas: boolean;
}
export interface GuestLinkDTO {
  id: string;
  label: string;
  scope: GuestScope;
  hasPin: boolean;
  expiresAt: string;
  revokedAt: string | null;
  redemptions: number;
  activeSessions: number;
  createdAt: string;
}
export interface GuestLinkCreated extends GuestLinkDTO {
  /** Shown once. The server stores only a hash. */
  token: string;
}
export interface GuestRedeemResponse {
  accessToken: string;
  guest: { id: string; displayName: string };
  scope: GuestScope;
  expiresAt: string;
}
/** The whole of what a guest learns about the room. No parent ids, no emails, no member records. */
export interface GuestRoomDTO {
  title: string;
  status: string;
  participants: { name: string; kind: 'member' | 'guest' }[];
  scope: GuestScope;
  rev: number;
  expiresAt: string;
}
