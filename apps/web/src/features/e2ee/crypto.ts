import type { EncryptedBody, KeyBackup, WrappedKey } from '@strata/shared';

/**
 * Every cryptographic operation in Strata's end-to-end encryption, and nothing else. It uses only the browser's own
 * WebCrypto, with standard constructions and no homemade primitives:
 *
 * - Identity: an ECDH P-256 key pair per person.
 * - Room key: a random AES-256-GCM key per conversation and version, which every member holds.
 * - Sharing a room key: ECDH with a throwaway key, HKDF, then AES-GCM, so each copy can only be opened by one person.
 * - The private key is backed up under a passphrase with PBKDF2 and AES-GCM. The passphrase never leaves the browser.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PBKDF2_ITERATIONS = 600_000;
const BACKUP_CONTEXT = 'strata-e2ee-backup-v1';
const WRAP_INFO = 'strata-e2ee-wrap-v1';

export function toB64(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

const random = (bytes: number) => crypto.getRandomValues(new Uint8Array(bytes));

export interface Identity {
  privateKey: CryptoKey;
  /** The public key in raw form, which is what the server stores and other people seal keys to. */
  publicKey: string;
}

export async function generateIdentity(): Promise<Identity> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKey: toB64(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}

const importPublic = (raw: string) => crypto.subtle.importKey('raw', fromB64(raw), { name: 'ECDH', namedCurve: 'P-256' }, false, []);

async function passphraseKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealPrivateKey(privateKey: CryptoKey, passphrase: string): Promise<KeyBackup> {
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const salt = random(16);
  const iv = random(12);
  const key = await passphraseKey(passphrase, salt, PBKDF2_ITERATIONS);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(BACKUP_CONTEXT) }, key, encoder.encode(JSON.stringify(jwk)));
  return { salt: toB64(salt), iter: PBKDF2_ITERATIONS, iv: toB64(iv), ct: toB64(ct) };
}

export class WrongPassphrase extends Error {
  constructor() {
    super('That passphrase is not right');
  }
}

/** Opens the backup, and checks that what's inside really belongs to the public key the server holds. */
export async function openPrivateKey(backup: KeyBackup, passphrase: string, expectedPublic: string): Promise<CryptoKey> {
  const key = await passphraseKey(passphrase, fromB64(backup.salt), backup.iter);
  let jwk: JsonWebKey;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(backup.iv), additionalData: encoder.encode(BACKUP_CONTEXT) }, key, fromB64(backup.ct));
    jwk = JSON.parse(decoder.decode(plain)) as JsonWebKey;
  } catch {
    throw new WrongPassphrase();
  }
  const x = fromB64(jwk.x ?? '');
  const y = fromB64(jwk.y ?? '');
  const raw = new Uint8Array(1 + x.length + y.length);
  raw[0] = 4;
  raw.set(x, 1);
  raw.set(y, 1 + x.length);
  if (toB64(raw) !== expectedPublic) throw new Error('That backup does not match your account');
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

export const generateRoomKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const importRoomKey = (raw: ArrayBuffer) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

async function wrapKeyFor(privateKey: CryptoKey, publicKey: CryptoKey) {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(WRAP_INFO) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** The room, person and version are bound into every sealed copy, so one can't be replayed as another. */
export const wrapContext = (roomId: string, version: number, userId: string) => `${roomId}:${version}:${userId}`;

export async function wrapRoomKey(roomKey: CryptoKey, recipientPublic: string, context: string): Promise<WrappedKey> {
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const key = await wrapKeyFor(ephemeral.privateKey, await importPublic(recipientPublic));
  const iv = random(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, key, await crypto.subtle.exportKey('raw', roomKey));
  return { epk: toB64(await crypto.subtle.exportKey('raw', ephemeral.publicKey)), iv: toB64(iv), ct: toB64(ct) };
}

export async function unwrapRoomKey(wrapped: WrappedKey, privateKey: CryptoKey, context: string): Promise<CryptoKey> {
  const key = await wrapKeyFor(privateKey, await importPublic(wrapped.epk));
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(wrapped.iv), additionalData: encoder.encode(context) }, key, fromB64(wrapped.ct));
  return importRoomKey(raw);
}

const messageContext = (roomId: string, version: number) => `${roomId}:${version}`;

export async function encryptText(key: CryptoKey, roomId: string, version: number, text: string): Promise<EncryptedBody> {
  const iv = random(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(messageContext(roomId, version)) }, key, encoder.encode(JSON.stringify({ t: text })));
  return { v: 1, kv: version, iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptText(key: CryptoKey, roomId: string, body: Pick<EncryptedBody, 'kv' | 'iv' | 'ct'>): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(body.iv), additionalData: encoder.encode(messageContext(roomId, body.kv)) }, key, fromB64(body.ct));
  return (JSON.parse(decoder.decode(plain)) as { t: string }).t;
}

/**
 * A short code that identifies a public key, for comparing in person or over a call. If the code shown for someone is the
 * same on their own screen, nobody has swapped their key on the way.
 */
export async function securityCode(publicKey: string): Promise<string> {
  const digest = new DataView(await crypto.subtle.digest('SHA-256', fromB64(publicKey)));
  return Array.from({ length: 6 }, (_, i) => String(digest.getUint32(i * 4) % 100_000).padStart(5, '0')).join(' ');
}
