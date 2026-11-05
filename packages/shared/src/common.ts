import { z } from 'zod';

export const objectId = z.string().regex(/^[a-f0-9]{24}$/, 'Invalid id');

export const POSTURES = ['whisper', 'digest', 'standard', 'blocking_ack'] as const;
export const postureSchema = z.enum(POSTURES);
export type Posture = z.infer<typeof postureSchema>;

export const PRINCIPAL_TYPES = ['user', 'guest', 'system'] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

/** Who did something. Everything that attributes an action uses this shape, so new identity kinds stay additive. */
export interface PrincipalRef {
  type: PrincipalType;
  id: string;
  name: string;
}

export const clientId = z.string().min(8).max(64).regex(/^[\w-]+$/);

export const LIMITS = {
  messageText: 8000,
  displayName: 60,
  roomName: 80,
  groupMembers: 256,
  branchDepth: 3,
  branchSummary: 4000,
  canvasText: 20000,
  blockUpdateBytes: 64 * 1024,
  pageSize: 50,
  maxPageSize: 100,
} as const;
