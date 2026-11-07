import { Schema, model, type Types } from 'mongoose';
import {
  BRANCH_STATUSES,
  BRANCH_VISIBILITIES,
  MEMBER_ROLES,
  POSTURES,
  ROOM_KINDS,
  TRANSCRIPT_POLICIES,
  type BranchStatus,
  type BranchVisibility,
  type MemberRole,
  type Posture,
  type RoomKind,
  type TranscriptPolicy,
} from '@strata/shared';

export interface IBranch {
  title: string;
  status: BranchStatus;
  visibility: BranchVisibility;
  transcriptPolicy: TranscriptPolicy;
  /** Parent excerpt shown to members. Never sent to guests. */
  origin: { excerpt: string; senderName: string; seq: number };
  resolution: { summary: string; resolvedBy: string; resolvedAt: Date } | null;
  mergedAt: Date | null;
  mergedMessageId: Types.ObjectId | null;
}

export interface IRoom {
  _id: Types.ObjectId;
  kind: RoomKind;
  name: string;
  avatarUrl: string | null;
  directKey: string | null;
  rev: number;
  lastMessage: { seq: number; senderName: string; text: string; posture: Posture; at: Date } | null;
  createdBy: Types.ObjectId;
  settings: { blockingAck: 'admins' | 'members' };
  encrypted: boolean;
  keyVersion: number;
  needsRotation: boolean;
  parentRoomId: Types.ObjectId | null;
  parentMessageId: Types.ObjectId | null;
  rootRoomId: Types.ObjectId | null;
  depth: number;
  branch: IBranch | null;
  createdAt: Date;
  updatedAt: Date;
}

const branchSchema = new Schema<IBranch>(
  {
    title: { type: String, required: true },
    status: { type: String, enum: BRANCH_STATUSES, default: 'open' },
    visibility: { type: String, enum: BRANCH_VISIBILITIES, default: 'listed' },
    transcriptPolicy: { type: String, enum: TRANSCRIPT_POLICIES, default: 'participants' },
    origin: { excerpt: String, senderName: String, seq: Number },
    resolution: { type: { summary: String, resolvedBy: String, resolvedAt: Date }, default: null, _id: false },
    mergedAt: { type: Date, default: null },
    mergedMessageId: { type: Schema.Types.ObjectId, default: null },
  },
  { _id: false },
);

const roomSchema = new Schema<IRoom>(
  {
    kind: { type: String, enum: ROOM_KINDS, required: true },
    name: { type: String, default: '', maxlength: 80 },
    avatarUrl: { type: String, default: null },
    directKey: { type: String, default: null },
    rev: { type: Number, default: 0 },
    lastMessage: {
      type: { seq: Number, senderName: String, text: String, posture: { type: String, enum: POSTURES }, at: Date },
      default: null,
      _id: false,
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    settings: { blockingAck: { type: String, enum: ['admins', 'members'], default: 'members' } },
    encrypted: { type: Boolean, default: false },
    keyVersion: { type: Number, default: 0 },
    needsRotation: { type: Boolean, default: false },
    parentRoomId: { type: Schema.Types.ObjectId, default: null },
    parentMessageId: { type: Schema.Types.ObjectId, default: null },
    rootRoomId: { type: Schema.Types.ObjectId, default: null },
    depth: { type: Number, default: 0 },
    branch: { type: branchSchema, default: null },
  },
  { timestamps: true },
);
// A pair of people has one direct room, and the unique index is what guarantees it under concurrency.
roomSchema.index({ directKey: 1 }, { unique: true, partialFilterExpression: { directKey: { $type: 'string' } } });
roomSchema.index({ parentRoomId: 1, 'branch.status': 1 });
roomSchema.index({ parentMessageId: 1 });

export const Room = model<IRoom>('Room', roomSchema);

export interface IRoomMember {
  _id: Types.ObjectId;
  roomId: Types.ObjectId;
  userId: Types.ObjectId;
  role: MemberRole;
  lastDeliveredSeq: number;
  lastReadSeq: number;
  mutedUntil: Date | null;
  joinedAt: Date;
  leftAt: Date | null;
}

const roomMemberSchema = new Schema<IRoomMember>({
  roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: MEMBER_ROLES, default: 'member' },
  lastDeliveredSeq: { type: Number, default: 0 },
  lastReadSeq: { type: Number, default: 0 },
  mutedUntil: { type: Date, default: null },
  joinedAt: { type: Date, default: () => new Date() },
  leftAt: { type: Date, default: null },
});
roomMemberSchema.index({ roomId: 1, userId: 1 }, { unique: true });
roomMemberSchema.index({ userId: 1, leftAt: 1 });

export const RoomMember = model<IRoomMember>('RoomMember', roomMemberSchema);
