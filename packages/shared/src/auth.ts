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
  avatarUrl: z.string().url().max(500).nullable().optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileInput>;

export interface UserDTO {
  id: string;
  displayName: string;
  handle: string;
  avatarUrl: string | null;
  bio: string;
}
export interface SelfDTO extends UserDTO {
  email: string;
}
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
