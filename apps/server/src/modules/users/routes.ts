import { randomBytes } from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import { objectId, updateProfileInput, type UserDTO } from '@strata/shared';
import { badRequest, notFound } from '../../lib/errors.js';
import { param, parse } from '../../lib/http.js';
import { limits } from '../../lib/rateLimit.js';
import { AvatarImage, User, type IUser } from '../../models/identity.js';
import { RoomMember } from '../../models/rooms.js';
import { currentUser, requireUser } from '../auth/middleware.js';
import { toSelf } from '../auth/service.js';
import { hub } from '../../realtime/hub.js';

const toUser = (u: Pick<IUser, '_id' | 'displayName' | 'handle' | 'avatarUrl' | 'bio'>): UserDTO => ({
  id: String(u._id),
  displayName: u.displayName,
  handle: u.handle,
  avatarUrl: u.avatarUrl,
  bio: u.bio,
});

const AVATAR_MAX_BYTES = 300 * 1024;

/** Goes by the bytes, not the declared type. SVG is refused here on purpose, because it can carry script. */
function imageType(b: Buffer): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const newKey = () => randomBytes(16).toString('hex');
const avatarPath = (userId: string, key: string) => `/api/avatars/${userId}/${key}`;

/** Unauthenticated because an `<img>` can't send a token. The random key in the URL is the permission. */
export const avatarRoutes = Router();
avatarRoutes.get('/:userId/:key', async (req, res) => {
  const image = await AvatarImage.findOne({ _id: parse(objectId, param(req, 'userId')), key: param(req, 'key') }).lean();
  if (!image) throw notFound('Photo');
  res.set({
    'content-type': image.mime,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'private, max-age=31536000, immutable',
  });
  res.send(Buffer.from(image.bytes.buffer ?? image.bytes));
});

const searchQuery = z.object({ q: z.string().trim().min(2).max(40) });

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const userRoutes = Router();
userRoutes.use(requireUser);

userRoutes.get('/me', async (req, res) => {
  const user = await User.findById(currentUser(req).id).lean();
  if (!user) throw notFound('User');
  res.json({ user: toSelf(user) });
});

userRoutes.patch('/me', async (req, res) => {
  const id = currentUser(req).id;
  const input = parse(updateProfileInput, req.body);
  const before = await User.findById(id).select('avatarUrl avatarPrivate').lean();
  if (!before) throw notFound('User');

  // Going private retires the old address, since anyone may have seen it while the photo was public.
  const patch: Record<string, unknown> = { ...input };
  if (input.avatarPrivate && !before.avatarPrivate && before.avatarUrl) {
    const key = newKey();
    await AvatarImage.updateOne({ _id: id }, { key });
    patch.avatarUrl = avatarPath(id, key);
  }
  const user = await User.findByIdAndUpdate(id, patch, { returnDocument: 'after', runValidators: true }).lean();
  if (!user) throw notFound('User');
  res.json({ user: toSelf(user) });
});

userRoutes.post('/me/avatar', limits.media, express.raw({ type: () => true, limit: AVATAR_MAX_BYTES }), async (req, res) => {
  const id = currentUser(req).id;
  const bytes = req.body as Buffer;
  const mime = Buffer.isBuffer(bytes) ? imageType(bytes) : null;
  if (!mime) throw badRequest('That has to be a JPEG, PNG or WebP image');
  const key = newKey();
  await AvatarImage.updateOne({ _id: id }, { key, mime, bytes }, { upsert: true });
  const user = await User.findByIdAndUpdate(id, { avatarUrl: avatarPath(id, key) }, { returnDocument: 'after' }).lean();
  if (!user) throw notFound('User');
  res.json({ user: toSelf(user) });
});

userRoutes.delete('/me/avatar', async (req, res) => {
  const id = currentUser(req).id;
  await AvatarImage.deleteOne({ _id: id });
  const user = await User.findByIdAndUpdate(id, { avatarUrl: null }, { returnDocument: 'after' }).lean();
  if (!user) throw notFound('User');
  res.json({ user: toSelf(user) });
});

/**
 * People are found by handle prefix and nothing broader, so the endpoint can't be used to list every account.
 */
userRoutes.get('/search', async (req, res) => {
  const { q } = parse(searchQuery, req.query);
  const handle = q.replace(/^@/, '').toLowerCase();
  const users = await User.find({ handle: { $regex: `^${escapeRegex(handle)}` }, _id: { $ne: currentUser(req).id } })
    .select('displayName handle avatarUrl avatarPrivate bio')
    .limit(10)
    .lean();
  // A private photo is for people you already share a conversation with, so search only shows it to them.
  const mine = await RoomMember.find({ userId: currentUser(req).id, leftAt: null }).distinct('roomId');
  const known = new Set(
    (await RoomMember.find({ roomId: { $in: mine }, userId: { $in: users.map((u) => u._id) }, leftAt: null }).distinct('userId')).map(String),
  );
  res.json({ users: users.map((u) => toUser(u.avatarPrivate && !known.has(String(u._id)) ? { ...u, avatarUrl: null } : u)) });
});

/** Profiles are visible to people who share a room, and to nobody else. */
userRoutes.get('/:id', async (req, res) => {
  const id = parse(objectId, param(req, 'id'));
  const me = currentUser(req).id;
  if (id !== me) {
    const mine = await RoomMember.find({ userId: me, leftAt: null }).distinct('roomId');
    const shared = await RoomMember.exists({ userId: id, leftAt: null, roomId: { $in: mine } });
    if (!shared) throw notFound('User');
  }
  const user = await User.findById(id).lean();
  if (!user) throw notFound('User');
  const online = user.showOnline === false && id !== me ? [] : await hub.onlineUsers([id]);
  res.json({ user: toUser(user), online: online.length > 0 });
});
