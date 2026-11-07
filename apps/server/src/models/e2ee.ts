import type { WrappedKey } from '@strata/shared';
import { Schema, model, type Types } from 'mongoose';

export interface IRoomKey {
  _id: Types.ObjectId;
  roomId: Types.ObjectId;
  userId: Types.ObjectId;
  version: number;
  wrapped: WrappedKey;
  wrappedBy: Types.ObjectId;
}

/** One room key version, sealed to one member. The server can store it and hand it back, and can't open it. */
const roomKeySchema = new Schema<IRoomKey>(
  {
    roomId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true },
    wrapped: { type: Schema.Types.Mixed, required: true },
    wrappedBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
roomKeySchema.index({ roomId: 1, userId: 1, version: 1 }, { unique: true });
roomKeySchema.index({ userId: 1 });

export const RoomKey = model<IRoomKey>('RoomKey', roomKeySchema);
