import { z } from 'zod';
import { LIMITS } from './common.js';

const email = z.string().trim().toLowerCase().email().max(254);
const handle = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,24}$/, 'Use 3-24 letters, numbers or underscores');

export const registerInput = z.object({
  email,
  password: z.string().min(10, 'Use at least 10 characters').max(200),
  displayName: z.string().trim().min(1).max(LIMITS.displayName),
  handle,
  deviceName: z.string().trim().max(80).optional(),
});
export type RegisterInput = z.infer<typeof registerInput>;

export const loginInput = z.object({
  email,
  password: z.string().min(1).max(200),
  deviceName: z.string().trim().max(80).optional(),
});
export type LoginInput = z.infer<typeof loginInput>;

export const updateProfileInput = z.object({
  displayName: z.string().trim().min(1).max(LIMITS.displayName).optional(),
  bio: z.string().trim().max(280).optional(),
  avatarPrivate: z.boolean().optional(),
  showOnline: z.boolean().optional(),
  appearance: z
    .object({
      accent: z.enum(['violet', 'emerald']),
      mode: z.enum(['dark', 'light', 'system']),
      appIcon: z.enum(['violet', 'emerald']),
      textSize: z.enum(['small', 'default', 'large']),
      reduceMotion: z.boolean(),
    })
    .optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileInput>;

export interface UserDTO {
  id: string;
  displayName: string;
  handle: string;
  avatarUrl: string | null;
  bio: string;
}
export type Appearance = NonNullable<UpdateProfileInput['appearance']>;

export interface SelfDTO extends UserDTO {
  email: string;
  avatarPrivate: boolean;
  showOnline: boolean;
  /** Null until the person chooses, so a device keeps its own look until then. */
  appearance: Appearance | null;
}

export const changePasswordInput = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: registerInput.shape.password,
});
export type ChangePasswordInput = z.infer<typeof changePasswordInput>;
export interface AuthResponse {
  accessToken: string;
  user: SelfDTO;
  sessionId: string;
}
export interface DeviceSessionDTO {
  id: string;
  deviceName: string;
  userAgent: string;
  ip: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}
