import { Router, type CookieOptions, type Request } from 'express';
import {
  createGuestLinkInput,
  guestSendInput,
  messagesQuery,
  objectId,
  redeemGuestInput,
  syncQuery,
} from '@strata/shared';
import { getEnv } from '../../config/env.js';
import { forbidden, unauthenticated } from '../../lib/errors.js';
import { param, parse, requireClientHeader } from '../../lib/http.js';
import { limits } from '../../lib/rateLimit.js';
import { toGuestMessage } from '../../realtime/hub.js';
import { currentUser, requireUser, type GuestContext } from '../auth/middleware.js';
import { getCanvas } from '../canvas/service.js';
import { guestMediaUrl } from '../media/service.js';
import { pageMessages, syncMessages } from '../messages/service.js';
import * as guests from './service.js';

const COOKIE = 'strata_gs';

const cookieOptions = (expiresAt: string): CookieOptions => ({
  httpOnly: true,
  secure: getEnv().NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/api/guest',
  expires: new Date(expiresAt),
});

const guestOf = (req: Request): GuestContext => {
  if (!req.guest) throw unauthenticated();
  return req.guest;
};

/** Mounted under /branches: members managing a bridge. */
export const branchGuestRoutes = Router();

branchGuestRoutes.post('/:id/guest-links', requireUser, async (req, res) => {
  const branchId = parse(objectId, param(req, 'id'));
  res.status(201).json({ link: await guests.createLink(currentUser(req).id, branchId, parse(createGuestLinkInput, req.body)) });
});

branchGuestRoutes.get('/:id/guest-links', requireUser, async (req, res) => {
  res.json({ links: await guests.listLinks(currentUser(req).id, parse(objectId, param(req, 'id'))) });
});

export const guestLinkRoutes = Router();

guestLinkRoutes.delete('/:id', requireUser, async (req, res) => {
  await guests.revokeLink(currentUser(req).id, parse(objectId, param(req, 'id')));
  res.status(204).end();
});

/**
 * The entire guest surface. Guests have no other routes, and the room id comes from their capability, never from a
 * parameter, so there's nothing here for a guest to point at a different room.
 */
export const guestRoutes = Router();

guestRoutes.post('/redeem', limits.guestRedeem, async (req, res) => {
  const { secret, ...response } = await guests.redeem(parse(redeemGuestInput, req.body));
  res.cookie(COOKIE, secret, cookieOptions(response.expiresAt));
  res.status(201).json(response);
});

guestRoutes.post('/token', limits.refresh, requireClientHeader, async (req, res) => {
  const secret = req.cookies?.[COOKIE] as string | undefined;
  if (!secret) throw unauthenticated();
  res.json(await guests.renewFromSecret(secret));
});

guestRoutes.get('/room', guests.requireGuest, async (req, res) => {
  res.json({ room: await guests.guestRoom(guestOf(req)) });
});

guestRoutes.get('/messages', guests.requireGuest, async (req, res) => {
  const guest = guestOf(req);
  const page = await pageMessages(guest.roomId, parse(messagesQuery, req.query));
  res.json({ ...page, messages: page.messages.map((m) => toGuestMessage(m, guest.scope.blocks)) });
});

guestRoutes.get('/sync', guests.requireGuest, async (req, res) => {
  const guest = guestOf(req);
  const result = await syncMessages(guest.roomId, parse(syncQuery, req.query).sinceRev);
  res.json({ ...result, messages: result.messages.map((m) => toGuestMessage(m, guest.scope.blocks)) });
});

guestRoutes.post('/messages', guests.requireGuest, limits.guestSend, async (req, res) => {
  const guest = guestOf(req);
  const result = await guests.guestSend(guest, parse(guestSendInput, req.body));
  res.status(result.created ? 201 : 200).json({ message: toGuestMessage(result.message, guest.scope.blocks) });
});

guestRoutes.get('/canvas', guests.requireGuest, async (req, res) => {
  const guest = guestOf(req);
  if (!guest.scope.canvas) throw forbidden('This link does not include the Canvas');
  res.json({ canvas: await getCanvas(guest.roomId) });
});

guestRoutes.get('/media/:id/url', guests.requireGuest, async (req, res) => {
  res.json(await guestMediaUrl(parse(objectId, param(req, 'id')), guestOf(req).roomId));
});

guestRoutes.post('/leave', guests.requireGuest, async (req, res) => {
  await guests.leave(guestOf(req));
  res.clearCookie(COOKIE, { path: '/api/guest' });
  res.status(204).end();
});
