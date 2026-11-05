import { Schema, model, type Types } from 'mongoose';
import type { CanvasContent } from '@strata/shared';

export interface ICanvasDocument {
  _id: Types.ObjectId;
  roomId: Types.ObjectId;
  sections: { id: string; title: string; order: string }[];
}

const canvasDocumentSchema = new Schema<ICanvasDocument>(
  {
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true, unique: true },
    sections: { type: [{ _id: false, id: String, title: String, order: String }], default: [] },
  },
  { timestamps: true },
);

export const CanvasDocument = model<ICanvasDocument>('CanvasDocument', canvasDocumentSchema);

export interface ICanvasBlock {
  _id: Types.ObjectId;
  roomId: Types.ObjectId;
  sectionId: string;
  order: string;
  content: CanvasContent;
  source: {
    messageId: Types.ObjectId;
    roomId: Types.ObjectId;
    seq: number;
    senderName: string;
    excerpt: string;
    sentAt: Date;
  } | null;
  version: number;
  createdBy: string;
  updatedBy: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const canvasBlockSchema = new Schema<ICanvasBlock>(
  {
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
    sectionId: { type: String, required: true },
    order: { type: String, required: true },
    content: { type: Schema.Types.Mixed, required: true },
    source: {
      type: {
        messageId: Schema.Types.ObjectId,
        roomId: Schema.Types.ObjectId,
        seq: Number,
        senderName: String,
        excerpt: String,
        sentAt: Date,
      },
      default: null,
      _id: false,
    },
    version: { type: Number, default: 1 },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
canvasBlockSchema.index({ roomId: 1, deletedAt: 1, sectionId: 1, order: 1 });
canvasBlockSchema.index({ 'source.messageId': 1 });

export const CanvasBlock = model<ICanvasBlock>('CanvasBlock', canvasBlockSchema);
