import { z } from 'zod';
import { LIMITS, objectId, type Posture } from './common.js';

export const ROOM_KINDS = ['direct', 'group', 'branch'] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];
export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const BRANCH_STATUSES = ['open', 'resolved', 'archived'] as const;
export type BranchStatus = (typeof BRANCH_STATUSES)[number];
export const BRANCH_VISIBILITIES = ['listed', 'private'] as const;
export type BranchVisibility = (typeof BRANCH_VISIBILITIES)[number];
export const TRANSCRIPT_POLICIES = ['participants', 'parent_members'] as const;
export type TranscriptPolicy = (typeof TRANSCRIPT_POLICIES)[number];

export const createDirectInput = z.object({ userId: objectId });
export const createGroupInput = z.object({
  name: z.string().trim().min(1).max(LIMITS.roomName),
  memberIds: z.array(objectId).max(LIMITS.groupMembers),
});
export type CreateGroupInput = z.infer<typeof createGroupInput>;

export const updateRoomInput = z.object({
  name: z.string().trim().min(1).max(LIMITS.roomName).optional(),
  blockingAck: z.enum(['admins', 'members']).optional(),
});
export const addMembersInput = z.object({ userIds: z.array(objectId).min(1).max(50) });
export const updateMemberInput = z.object({ role: z.enum(['admin', 'member']) });
export const markReadInput = z.object({ seq: z.number().int().nonnegative() });
export const muteInput = z.object({ until: z.string().datetime().nullable() });

export const createBranchInput = z.object({
  title: z.string().trim().min(1).max(LIMITS.roomName),
  participantIds: z.array(objectId).max(LIMITS.groupMembers),
  visibility: z.enum(BRANCH_VISIBILITIES).default('listed'),
  /** Branches inherit encryption. Turning it off is how a branch can take guests, who have no keys. */
  encrypted: z.boolean().default(true),
});
export type CreateBranchInput = z.input<typeof createBranchInput>;
export const addParticipantsInput = z.object({ userIds: z.array(objectId).min(1).max(50) });
export const resolveBranchInput = z.object({
  summary: z.string().trim().min(1).max(LIMITS.branchSummary),
});
export const mergeBranchInput = z.object({
  transcriptPolicy: z.enum(TRANSCRIPT_POLICIES).default('participants'),
});

export interface MemberDTO {
  userId: string;
  displayName: string;
  handle: string;
  avatarUrl: string | null;
  role: MemberRole;
  lastDeliveredSeq: number;
  lastReadSeq: number;
}

export interface BranchResolutionDTO {
  summary: string;
  resolvedBy: string;
  resolvedAt: string;
}

export interface BranchInfoDTO {
  title: string;
  status: BranchStatus;
  visibility: BranchVisibility;
  transcriptPolicy: TranscriptPolicy;
  /** Excerpt of the parent message, for members only. */
  origin: { excerpt: string; senderName: string; seq: number } | null;
  resolution: BranchResolutionDTO | null;
  mergedAt: string | null;
  mergedMessageId: string | null;
  createdBy: string;
}

export interface RoomPreviewDTO {
  seq: number;
  senderName: string;
  text: string;
  posture: Posture;
  at: string;
}

export interface RoomDTO {
  id: string;
  kind: RoomKind;
  name: string;
  avatarUrl: string | null;
  rev: number;
  lastMessage: RoomPreviewDTO | null;
  parentRoomId: string | null;
  parentMessageId: string | null;
  rootRoomId: string | null;
  depth: number;
  branch: BranchInfoDTO | null;
  settings: { blockingAck: 'admins' | 'members' };
  /** Whether messages here are end-to-end encrypted, and which key version is current. */
  encryption: { enabled: boolean; keyVersion: number; needsRotation: boolean };
  /** Calling member's state. `readOnly` marks a merged transcript opened to parent members. */
  me: {
    role: MemberRole | null;
    lastReadSeq: number;
    unread: number;
    quietUnread: number;
    mutedUntil: string | null;
    readOnly: boolean;
  };
  members: MemberDTO[];
  updatedAt: string;
}

/** What a non-participant of a listed branch may see. Deliberately has no transcript fields. */
export interface BranchSummaryDTO {
  roomId: string;
  parentRoomId: string;
  parentMessageId: string;
  title: string;
  status: BranchStatus;
  visibility: BranchVisibility;
  participantCount: number;
  isParticipant: boolean;
  canReadTranscript: boolean;
  resolution: BranchResolutionDTO | null;
  mergedAt: string | null;
  lastActivityAt: string;
}
