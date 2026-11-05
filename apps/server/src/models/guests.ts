import { Schema, model, type Types } from 'mongoose';
import type { GuestScope } from '@strata/shared';

export interface IGuestCapability {
  _id: Types.ObjectId;
  roomId: Types.ObjectId;
  createdBy: Types.ObjectId;
  tokenHash: string;
  label: string;
  scope: GuestScope;
  pinHash: string | null;
  pinAttempts: number;
  lockedUntil: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
  redemptions: number;
  createdAt: Date;
}

const capabilitySchema = new Schema<IGuestCapability>(
  {
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true, unique: true },
    label: { type: String, required: true, maxlength: 80 },
    scope: { write: Boolean, blocks: Boolean, canvas: Boolean },
    pinHash: { type: String, default: null },
    pinAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    redemptions: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
capabilitySchema.index({ roomId: 1, revokedAt: 1 });

export const GuestCapability = model<IGuestCapability>('GuestCapability', capabilitySchema);

export interface IGuestSession {
  _id: Types.ObjectId;
  capabilityId: Types.ObjectId;
  roomId: Types.ObjectId;
  displayName: string;
  secretHash: string;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

const guestSessionSchema = new Schema<IGuestSession>({
  capabilityId: { type: Schema.Types.ObjectId, ref: 'GuestCapability', required: true, index: true },
  roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
  displayName: { type: String, required: true, maxlength: 60 },
  secretHash: { type: String, required: true, unique: true },
  lastSeenAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
});
guestSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const GuestSession = model<IGuestSession>('GuestSession', guestSessionSchema);
