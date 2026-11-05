import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { getEnv } from '../config/env.js';
import { unauthenticated } from './errors.js';

export const USER_AUDIENCE = 'strata:user';
export const GUEST_AUDIENCE = 'strata:guest';
const ISSUER = 'strata';

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const secretKey = () => new TextEncoder().encode(getEnv().JWT_SECRET);

export interface UserClaims {
  sub: string;
  sid: string;
}
export interface GuestClaims {
  sub: string;
  cap: string;
}

async function sign(claims: Record<string, unknown>, sub: string, audience: string, ttlSeconds: number) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(secretKey());
}

export const signUserToken = (userId: string, sessionId: string) =>
  sign({ sid: sessionId }, userId, USER_AUDIENCE, getEnv().ACCESS_TOKEN_TTL_SECONDS);

export const signGuestToken = (guestSessionId: string, capabilityId: string) =>
  sign({ cap: capabilityId }, guestSessionId, GUEST_AUDIENCE, getEnv().ACCESS_TOKEN_TTL_SECONDS);

async function verify(token: string, audience: string) {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: ISSUER, audience, algorithms: ['HS256'] });
    return payload;
  } catch {
    throw unauthenticated('Your session has expired');
  }
}

export async function verifyUserToken(token: string): Promise<UserClaims> {
  const p = await verify(token, USER_AUDIENCE);
  if (typeof p.sub !== 'string' || typeof p.sid !== 'string') throw unauthenticated();
  return { sub: p.sub, sid: p.sid };
}

export async function verifyGuestToken(token: string): Promise<GuestClaims> {
  const p = await verify(token, GUEST_AUDIENCE);
  if (typeof p.sub !== 'string' || typeof p.cap !== 'string') throw unauthenticated();
  return { sub: p.sub, cap: p.cap };
}

/** The audience of a token, without trusting it. Used only to choose which verifier to run. */
export function peekAudience(token: string): string | null {
  try {
    const part = token.split('.')[1] ?? '';
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString()) as { aud?: string };
    return payload.aud ?? null;
  } catch {
    return null;
  }
}

/** Short-lived signature for URLs used in `<img src>`, where an Authorization header isn't possible. */
export function signMediaUrl(assetId: string, expiresAt: number): string {
  return createHmac('sha256', getEnv().MEDIA_SIGNING_SECRET).update(`${assetId}.${expiresAt}`).digest('base64url');
}

export function verifyMediaUrl(assetId: string, expiresAt: number, signature: string): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = Buffer.from(signMediaUrl(assetId, expiresAt));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
