import { Schema, model, type Types } from 'mongoose';
import { POSTURES, PRINCIPAL_TYPES, type MessagePayload, type Posture, type PrincipalType } from '@strata/shared';

export interface IMessage {
  _id: Types.ObjectId;
  roomId: Types.ObjectId;
  seq: number;
  rev: number;
  sender: { type: PrincipalType; id: string; name: string };
  clientMessageId: string | null;
  /** Validated against the shared `messagePayload` union before every write. */
  payload: MessagePayload;
  replyTo: { messageId: Types.ObjectId; seq: number; excerpt: string; senderName: string } | null;
  reactions: { emoji: string; principalIds: string[] }[];
  posture: Posture;
  searchText: string;
  branchCount: number;
  refCount: number;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
}

const messageSchema = new Schema<IMessage>(
  {
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
    seq: { type: Number, required: true },
    rev: { type: Number, required: true },
    sender: {
      type: { type: String, enum: PRINCIPAL_TYPES, required: true },
      id: { type: String, required: true },
      name: { type: String, required: true },
    },
    clientMessageId: { type: String, default: null },
    payload: { type: Schema.Types.Mixed, required: true },
    replyTo: {
      type: { messageId: Schema.Types.ObjectId, seq: Number, excerpt: String, senderName: String },
      default: null,
      _id: false,
    },
    reactions: { type: [{ _id: false, emoji: String, principalIds: [String] }], default: [] },
    posture: { type: String, enum: POSTURES, default: 'standard' },
    searchText: { type: String, default: '' },
    branchCount: { type: Number, default: 0 },
    refCount: { type: Number, default: 0 },
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
messageSchema.index({ roomId: 1, seq: 1 }, { unique: true });
messageSchema.index({ roomId: 1, rev: 1 });
messageSchema.index(
  { roomId: 1, 'sender.id': 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } },
);
messageSchema.index({ searchText: 'text' });
messageSchema.index({ 'replyTo.messageId': 1 }, { sparse: true });

export const Message = model<IMessage>('Message', messageSchema);

export const CITATION_KINDS = ['canvas', 'message', 'branch'] as const;
export type CitationKind = (typeof CITATION_KINDS)[number];

export interface IMessageCitation {
  _id: Types.ObjectId;
  fromKind: CitationKind;
  fromId: Types.ObjectId;
  fromRoomId: Types.ObjectId;
  toMessageId: Types.ObjectId;
  toRoomId: Types.ObjectId;
  label: string;
  createdBy: string;
}

const citationSchema = new Schema<IMessageCitation>(
  {
    fromKind: { type: String, enum: CITATION_KINDS, required: true },
    fromId: { type: Schema.Types.ObjectId, required: true },
    fromRoomId: { type: Schema.Types.ObjectId, required: true },
    toMessageId: { type: Schema.Types.ObjectId, required: true },
    toRoomId: { type: Schema.Types.ObjectId, required: true },
    label: { type: String, default: '' },
    createdBy: { type: String, required: true },
  },
  { timestamps: true },
);
citationSchema.index({ toMessageId: 1 });
citationSchema.index({ fromKind: 1, fromId: 1, toMessageId: 1 }, { unique: true });

export const MessageCitation = model<IMessageCitation>('MessageCitation', citationSchema);
