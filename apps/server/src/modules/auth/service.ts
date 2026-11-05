import { hash, verify } from '@node-rs/argon2';
import type { ChangePasswordInput, DeviceSessionDTO, LoginInput, RegisterInput, SelfDTO } from '@strata/shared';
import { getEnv } from '../../config/env.js';
import { AppError, conflict, isDuplicateKey, notFound, unauthenticated } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { randomToken, sha256, signUserToken } from '../../lib/tokens.js';
import { DeviceSession, User, type IDeviceSession, type IUser } from '../../models/identity.js';
import { hub } from '../../realtime/hub.js';

/** A superseded refresh token is honoured this long, so two tabs racing to refresh don't sign the user out. */
const ROTATION_GRACE_MS = 10_000;
/** Compared against when the account doesn't exist, so that response time doesn't reveal which emails are registered. */
const DUMMY_HASH = hash('strata-timing-equalizer');

export interface ClientInfo {
  deviceName?: string;
  userAgent: string;
  ip: string;
}

export const toSelf = (u: Pick<IUser, '_id' | 'email' | 'displayName' | 'handle' | 'avatarUrl' | 'avatarPrivate' | 'showOnline' | 'appearance' | 'bio'>): SelfDTO => ({
  id: String(u._id),
  email: u.email,
  displayName: u.displayName,
  handle: u.handle,
  avatarUrl: u.avatarUrl,
  avatarPrivate: u.avatarPrivate ?? false,
  showOnline: u.showOnline ?? true,
  appearance: u.appearance ?? null,
  bio: u.bio,
});

const refreshExpiry = () => new Date(Date.now() + getEnv().REFRESH_TOKEN_TTL_DAYS * 86_400_000);

async function startSession(user: IUser, client: ClientInfo) {
  const refreshToken = randomToken();
  const now = new Date();
  const session = await DeviceSession.create({
    userId: user._id,
    tokenHash: sha256(refreshToken),
    rotatedAt: now,
    deviceName: client.deviceName || 'Web browser',
    userAgent: client.userAgent.slice(0, 300),
    ip: client.ip,
    lastSeenAt: now,
    expiresAt: refreshExpiry(),
  });
  const accessToken = await signUserToken(String(user._id), String(session._id));
  return { accessToken, refreshToken, user: toSelf(user), sessionId: String(session._id) };
}

export async function register(input: RegisterInput, client: ClientInfo) {
  try {
    const user = await User.create({
      email: input.email,
      passwordHash: await hash(input.password),
      displayName: input.displayName,
      handle: input.handle,
    });
    return await startSession(user, { ...client, deviceName: input.deviceName });
  } catch (err) {
    if (isDuplicateKey(err)) throw conflict('That email or handle is already taken');
    throw err;
  }
}

export async function login(input: LoginInput, client: ClientInfo) {
  const user = await User.findOne({ email: input.email }).select('+passwordHash');
  const ok = await verify(user?.passwordHash ?? (await DUMMY_HASH), input.password);
  if (!user || !ok) throw new AppError(401, 'UNAUTHENTICATED', 'Incorrect email or password');
  return startSession(user, { ...client, deviceName: input.deviceName });
}

/** Someone changing a password may be locking out a thief, so every other device is signed out with it. */
export async function changePassword(userId: string, currentSessionId: string, input: ChangePasswordInput) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw unauthenticated();
  if (!(await verify(user.passwordHash, input.currentPassword))) throw new AppError(403, 'FORBIDDEN', 'Your current password is incorrect');
  user.passwordHash = await hash(input.newPassword);
  await user.save();
  const others = await DeviceSession.find({ userId, revokedAt: null, _id: { $ne: currentSessionId } }).select('_id');
  await Promise.all(others.map((s) => revokeSession(s, 'password_changed')));
}

export async function revokeSession(session: Pick<IDeviceSession, '_id'>, reason: string) {
  await DeviceSession.updateOne({ _id: session._id, revokedAt: null }, { revokedAt: new Date(), revokeReason: reason });
  hub.disconnectSession(String(session._id), reason);
}

async function issueAccess(session: IDeviceSession, refreshToken: string | null) {
  if (session.revokedAt || session.expiresAt < new Date()) throw unauthenticated('Your session has ended');
  const user = await User.findById(session.userId);
  if (!user) throw unauthenticated();
  const accessToken = await signUserToken(String(user._id), String(session._id));
  return { accessToken, refreshToken, user: toSelf(user), sessionId: String(session._id) };
}

/**
 * Rotates a refresh token. Presenting a token that was replaced a while ago means it leaked or a client misbehaved,
 * and nobody can tell the thief from the owner, so the whole session ends.
 *
 * Two tabs opening together will race, and that's normal. Exactly one request rotates. The others get an access token
 * and no new refresh token, so the browser keeps the cookie the winner set, whatever order the responses arrive in.
 */
export async function refresh(token: string) {
  const tokenHash = sha256(token);
  const now = new Date();
  const current = await DeviceSession.findOne({ tokenHash });

  if (!current) {
    const superseded = await DeviceSession.findOne({ prevTokenHash: tokenHash });
    if (!superseded) throw unauthenticated();
    if (now.getTime() - superseded.rotatedAt.getTime() > ROTATION_GRACE_MS) {
      logger.warn({ sessionId: String(superseded._id) }, 'refresh token reuse detected');
      await revokeSession(superseded, 'refresh_reuse');
      throw new AppError(401, 'SESSION_REVOKED', 'This session was ended for your security. Sign in again.');
    }
    return issueAccess(superseded, null);
  }
  if (current.revokedAt || current.expiresAt < now) throw unauthenticated('Your session has ended');

  const next = randomToken();
  const rotated = await DeviceSession.findOneAndUpdate(
    { _id: current._id, tokenHash },
    { tokenHash: sha256(next), prevTokenHash: tokenHash, rotatedAt: now, lastSeenAt: now, expiresAt: refreshExpiry() },
    { returnDocument: 'after' },
  );
  return issueAccess(current, rotated ? next : null);
}

export async function logoutByToken(token: string | undefined) {
  if (!token) return;
  const session = await DeviceSession.findOne({ tokenHash: sha256(token) });
  if (session) await revokeSession(session, 'logout');
}

export async function listSessions(userId: string, currentId: string): Promise<DeviceSessionDTO[]> {
  const sessions = await DeviceSession.find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ lastSeenAt: -1 })
    .lean();
  return sessions.map((s) => ({
    id: String(s._id),
    deviceName: s.deviceName,
    userAgent: s.userAgent,
    ip: s.ip,
    createdAt: s.createdAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    current: String(s._id) === currentId,
  }));
}

export async function revokeOwnSession(userId: string, sessionId: string) {
  const session = await DeviceSession.findOne({ _id: sessionId, userId, revokedAt: null });
  if (!session) throw notFound('Session');
  await revokeSession(session, 'user_revoked');
}
