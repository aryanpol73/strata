import { Schema, model, type Types } from 'mongoose';

export interface IBlock {
  _id: Types.ObjectId;
  roomId: Types.ObjectId;
  messageId: Types.ObjectId | null;
  type: string;
  createdBy: string;
  policy: { edit: 'everyone' | 'creator' };
  snapshot: Buffer;
  /** Updates up to and including this sequence number are already inside `snapshot`. */
  snapshotSeq: number;
  seq: number;
  summary: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const blockSchema = new Schema<IBlock>(
  {
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
    messageId: { type: Schema.Types.ObjectId, default: null, index: true },
    type: { type: String, required: true },
    createdBy: { type: String, required: true },
    policy: { edit: { type: String, enum: ['everyone', 'creator'], default: 'everyone' } },
    snapshot: { type: Buffer, required: true },
    snapshotSeq: { type: Number, default: 0 },
    seq: { type: Number, default: 0 },
    summary: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false },
);

export const Block = model<IBlock>('Block', blockSchema);

export interface IBlockUpdate {
  _id: Types.ObjectId;
  blockId: Types.ObjectId;
  seq: number;
  update: Buffer;
  clientUpdateId: string;
  actor: { id: string; name: string };
}

const blockUpdateSchema = new Schema<IBlockUpdate>({
  blockId: { type: Schema.Types.ObjectId, required: true },
  seq: { type: Number, required: true },
  update: { type: Buffer, required: true },
  clientUpdateId: { type: String, required: true },
  actor: { id: String, name: String },
});
blockUpdateSchema.index({ blockId: 1, seq: 1 }, { unique: true });
blockUpdateSchema.index({ blockId: 1, clientUpdateId: 1 }, { unique: true });

export const BlockUpdate = model<IBlockUpdate>('BlockUpdate', blockUpdateSchema);

export interface IBlockActivity {
  _id: Types.ObjectId;
  blockId: Types.ObjectId;
  actorName: string;
  action: string;
  detail: string;
  at: Date;
}

const blockActivitySchema = new Schema<IBlockActivity>({
  blockId: { type: Schema.Types.ObjectId, required: true },
  actorName: { type: String, required: true },
  action: { type: String, required: true },
  detail: { type: String, default: '' },
  at: { type: Date, default: () => new Date() },
});
blockActivitySchema.index({ blockId: 1, at: -1 });

export const BlockActivity = model<IBlockActivity>('BlockActivity', blockActivitySchema);
