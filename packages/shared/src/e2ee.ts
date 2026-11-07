import { z } from 'zod';
import { LIMITS, objectId } from './common.js';

/**
 * End-to-end encryption contracts. Everything the server stores here is ciphertext or a public key, and none of these
 * shapes can carry a message in the clear. The cryptography itself runs only in the browser.
 */
const b64 = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/, 'Invalid encoding');

/** One message body, encrypted with a room key. `kv` says which version of the key, so rotation never breaks history. */
export const encryptedBody = z.object({
  v: z.literal(1),
  kv: z.number().int().positive(),
  iv: b64(24),
  ct: b64(LIMITS.messageText * 6),
});
export type EncryptedBody = z.infer<typeof encryptedBody>;

/** A room key sealed to one person's public key, so that only they can open it. */
export const wrappedKey = z.object({ epk: b64(120), iv: b64(24), ct: b64(120) });
export type WrappedKey = z.infer<typeof wrappedKey>;

/** The private key, encrypted in the browser under a passphrase the server never sees. */
export const keyBackup = z.object({
  salt: b64(48),
  iter: z.number().int().min(100_000).max(5_000_000),
  iv: b64(24),
  ct: b64(4000),
});
export type KeyBackup = z.infer<typeof keyBackup>;

export const setIdentityInput = z.object({ publicKey: b64(120), backup: keyBackup });
export type SetIdentityInput = z.infer<typeof setIdentityInput>;

export const roomKeyWrap = z.object({ userId: objectId, version: z.number().int().positive(), wrapped: wrappedKey });
export const postRoomKeysInput = z.object({
  /** Set when this request starts a new key version, which only one request can win. */
  newVersion: z.number().int().positive().optional(),
  wraps: z.array(roomKeyWrap).min(1).max(1000),
});
export type PostRoomKeysInput = z.infer<typeof postRoomKeysInput>;

export interface MemberKeysDTO {
  userId: string;
  displayName: string;
  /** Null until they've set up encryption. */
  publicKey: string | null;
  /** The key versions this person can already open. */
  versions: number[];
}
export interface RoomKeysDTO {
  version: number;
  needsRotation: boolean;
  mine: { version: number; wrapped: WrappedKey }[];
  members: MemberKeysDTO[];
}
export interface IdentityDTO {
  publicKey: string;
  backup: KeyBackup;
}
