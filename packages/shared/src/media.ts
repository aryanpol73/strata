import { z } from 'zod';
import { objectId } from './common.js';

/** SVG and HTML are excluded on purpose: both can carry script when opened directly. */
export const ALLOWED_MIME: Record<string, { maxBytes: number; image: boolean }> = {
  'image/jpeg': { maxBytes: 15_000_000, image: true },
  'image/png': { maxBytes: 15_000_000, image: true },
  'image/webp': { maxBytes: 15_000_000, image: true },
  'image/gif': { maxBytes: 15_000_000, image: true },
  'application/pdf': { maxBytes: 25_000_000, image: false },
  'text/plain': { maxBytes: 5_000_000, image: false },
  'application/zip': { maxBytes: 25_000_000, image: false },
};

export const signUploadInput = z.object({
  roomId: objectId,
  name: z.string().trim().min(1).max(255),
  mime: z.string().max(120),
  bytes: z.number().int().positive(),
});
export type SignUploadInput = z.infer<typeof signUploadInput>;

export interface SignedUpload {
  assetId: string;
  provider: 'cloudinary' | 'disk';
  url: string;
  /** Multipart fields, for Cloudinary. */
  fields: Record<string, string>;
  /** Extra headers, for the disk provider. */
  headers: Record<string, string>;
}
export const completeUploadInput = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export interface MediaUrlDTO {
  url: string;
  expiresAt: string;
}
