import type { Appearance } from '@strata/shared';
import { Schema, model, type Types } from 'mongoose';

export interface IUser {
  _id: Types.ObjectId;
  email: string;
  passwordHash: string;
  displayName: string;
  handle: string;
  avatarUrl: string | null;
  avatarPrivate: boolean;
  showOnline: boolean;
  appearance: Appearance | null;
  bio: string;
  createdAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    displayName: { type: String, required: true, trim: true, maxlength: 60 },
    handle: { type: String, required: true, unique: true, lowercase: true, trim: true },
    avatarUrl: { type: String, default: null },
    avatarPrivate: { type: Boolean, default: false },
    showOnline: { type: Boolean, default: true },
    appearance: { type: Schema.Types.Mixed, default: null },
    bio: { type: String, default: '', maxlength: 280 },
  },
  { timestamps: true },
);

export const User = model<IUser>('User', userSchema);

export interface IAvatarImage {
  _id: Types.ObjectId;
  key: string;
  mime: string;
  bytes: Buffer;
}

/** One small image per person, keyed by user id. `key` is what makes the URL unguessable, and replacing it revokes the URL. */
const avatarImageSchema = new Schema<IAvatarImage>({
  key: { type: String, required: true },
  mime: { type: String, required: true },
  bytes: { type: Buffer, required: true },
});

export const AvatarImage = model<IAvatarImage>('AvatarImage', avatarImageSchema);

export interface IDeviceSession {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  tokenHash: string;
  prevTokenHash: string | null;
  rotatedAt: Date;
  deviceName: string;
  userAgent: string;
  ip: string;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  createdAt: Date;
}

const deviceSessionSchema = new Schema<IDeviceSession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true, unique: true },
    prevTokenHash: { type: String, default: null, index: true },
    rotatedAt: { type: Date, required: true },
    deviceName: { type: String, default: 'Unknown device', maxlength: 80 },
    userAgent: { type: String, default: '', maxlength: 300 },
    ip: { type: String, default: '' },
    lastSeenAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
deviceSessionSchema.index({ userId: 1, revokedAt: 1 });
deviceSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const DeviceSession = model<IDeviceSession>('DeviceSession', deviceSessionSchema);
