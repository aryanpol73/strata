import { z } from 'zod';
import { LIMITS, clientId, objectId, postureSchema, type Posture, type PrincipalRef } from './common.js';

/** Polymorphic payloads, as stored. Add a member here to introduce a new message type. */
export const textPayload = z.object({ type: z.literal('text'), text: z.string().min(1).max(LIMITS.messageText) });
export const mediaPayload = z.object({
  type: z.literal('media'),
  assetId: objectId,
  name: z.string().max(255),
  mime: z.string().max(120),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  caption: z.string().max(LIMITS.messageText).optional(),
});
export const blockPayload = z.object({
  type: z.literal('block'),
  blockId: objectId,
  blockType: z.string().max(40),
  title: z.string().max(200),
});
export const resolutionPayload = z.object({
  type: z.literal('resolution'),
  branchRoomId: objectId,
  branchTitle: z.string().max(LIMITS.roomName),
  summary: z.string().max(LIMITS.branchSummary),
  resolvedBy: z.string().max(LIMITS.displayName),
  participantCount: z.number().int().nonnegative(),
  transcriptOpen: z.boolean(),
});
export const systemPayload = z.object({ type: z.literal('system'), text: z.string().max(500) });
export const tombstonePayload = z.object({ type: z.literal('deleted') });

export const messagePayload = z.discriminatedUnion('type', [
  textPayload,
  mediaPayload,
  blockPayload,
  resolutionPayload,
  systemPayload,
  tombstonePayload,
]);
export type MessagePayload = z.infer<typeof messagePayload>;
export type MessageType = MessagePayload['type'];

/** What a client may submit. Blocks, resolutions and system messages are only ever created by the server. */
export const sendContent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(LIMITS.messageText) }),
  z.object({ type: z.literal('media'), assetId: objectId, caption: z.string().trim().max(LIMITS.messageText).optional() }),
]);

export const sendMessageInput = z
  .object({
    clientMessageId: clientId,
    content: sendContent,
    replyToId: objectId.optional(),
    posture: postureSchema.default('standard'),
    ackDeadline: z.string().datetime().optional(),
  })
  .refine((v) => v.posture !== 'blocking_ack' || !!v.ackDeadline, {
    path: ['ackDeadline'],
    message: 'A blocking acknowledgement needs a deadline',
  });
export type SendMessageInput = z.input<typeof sendMessageInput>;

export const editMessageInput = z.object({ text: z.string().trim().min(1).max(LIMITS.messageText) });
export const reactionInput = z.object({ emoji: z.string().min(1).max(16) });
export const messagesQuery = z.object({
  beforeSeq: z.coerce.number().int().positive().optional(),
  aroundSeq: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.maxPageSize).default(LIMITS.pageSize),
});
export const syncQuery = z.object({ sinceRev: z.coerce.number().int().nonnegative() });
export const searchQuery = z.object({
  q: z.string().trim().min(2).max(200),
  roomId: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

export interface ReactionDTO {
  emoji: string;
  principalIds: string[];
}
export interface ReplyRefDTO {
  messageId: string;
  seq: number;
  excerpt: string;
  senderName: string;
}
export interface MessageAckDTO {
  deadline: string;
  state: 'open' | 'satisfied' | 'expired';
  requiredIds: string[];
  ackedIds: string[];
}
export interface MessageDTO {
  id: string;
  roomId: string;
  seq: number;
  rev: number;
  sender: PrincipalRef;
  clientMessageId: string | null;
  payload: MessagePayload;
  replyTo: ReplyRefDTO | null;
  reactions: ReactionDTO[];
  posture: Posture;
  ack: MessageAckDTO | null;
  branchCount: number;
  refCount: number;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}
export interface MessagePage {
  messages: MessageDTO[];
  hasMore: boolean;
}
export interface SyncResponse {
  messages: MessageDTO[];
  rev: number;
  truncated: boolean;
}
export interface SearchHit {
  message: MessageDTO;
  roomName: string;
  roomKind: string;
}

export interface MessageReferenceDTO {
  kind: 'canvas' | 'message' | 'branch';
  id: string;
  roomId: string;
  label: string;
}

/** Short plain-text form of any payload, for previews, replies and notifications. */
export function payloadExcerpt(payload: MessagePayload, max = 140): string {
  const clip = (s: string) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  switch (payload.type) {
    case 'text':
      return clip(payload.text);
    case 'media':
      return clip(payload.caption || payload.name);
    case 'block':
      return clip(payload.title);
    case 'resolution':
      return clip(`Resolved: ${payload.summary}`);
    case 'system':
      return clip(payload.text);
    case 'deleted':
      return 'Message deleted';
  }
}
