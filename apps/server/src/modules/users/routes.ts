import { Router } from 'express';
import { z } from 'zod';
import { objectId, updateProfileInput, type UserDTO } from '@strata/shared';
import { notFound } from '../../lib/errors.js';
import { param, parse } from '../../lib/http.js';
import { User, type IUser } from '../../models/identity.js';
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
  const user = await User.findByIdAndUpdate(currentUser(req).id, parse(updateProfileInput, req.body), {
    returnDocument: 'after',
    runValidators: true,
  }).lean();
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
    .select('displayName handle avatarUrl bio')
    .limit(10)
    .lean();
  res.json({ users: users.map(toUser) });
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
  const online = await hub.onlineUsers([id]);
  res.json({ user: toUser(user), online: online.length > 0 });
});
