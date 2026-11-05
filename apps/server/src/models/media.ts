import { Schema, model, type Types } from 'mongoose';

export interface IMediaAsset {
  _id: Types.ObjectId;
  roomId: Types.ObjectId;
  uploaderId: Types.ObjectId;
  provider: 'cloudinary' | 'disk';
  key: string;
  name: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  status: 'pending' | 'ready';
  createdAt: Date;
}

const mediaAssetSchema = new Schema<IMediaAsset>(
  {
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
    uploaderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: String, enum: ['cloudinary', 'disk'], required: true },
    key: { type: String, required: true },
    name: { type: String, required: true },
    mime: { type: String, required: true },
    bytes: { type: Number, required: true },
    width: Number,
    height: Number,
    status: { type: String, enum: ['pending', 'ready'], default: 'pending' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
mediaAssetSchema.index({ provider: 1, key: 1 }, { unique: true });
// Abandoned uploads clean themselves up after a day.
mediaAssetSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 86_400, partialFilterExpression: { status: 'pending' } },
);

export const MediaAsset = model<IMediaAsset>('MediaAsset', mediaAssetSchema);
