import { Router, type RequestHandler } from 'express';
import {
  editMessageInput,
  messagesQuery,
  objectId,
  reactionInput,
  searchQuery,
  sendMessageInput,
  syncQuery,
} from '@strata/shared';
import { param, parse } from '../../lib/http.js';
import { limits } from '../../lib/rateLimit.js';
import { currentUser, requireUser } from '../auth/middleware.js';
import * as delivery from '../delivery/service.js';
import { requireRead } from '../access.js';
import * as messages from './service.js';

/** Blocking acknowledgement carries its own, tighter limit, so it can't be used to pester people. */
const limitBlockingAck: RequestHandler = (req, res, next) => {
  if ((req.body as { posture?: string })?.posture === 'blocking_ack') return limits.blockingAck(req, res, next);
  next();
};

const id = (req: Parameters<typeof param>[0], name = 'id') => parse(objectId, param(req, name));

/** Mounted under /rooms. */
export const roomMessageRoutes = Router();

roomMessageRoutes.get('/:id/messages', async (req, res) => {
  res.json(await messages.listMessages(id(req), currentUser(req).id, parse(messagesQuery, req.query)));
});

roomMessageRoutes.get('/:id/sync', async (req, res) => {
  const roomId = id(req);
  await requireRead(roomId, currentUser(req).id);
  res.json(await messages.syncMessages(roomId, parse(syncQuery, req.query).sinceRev));
});

roomMessageRoutes.post('/:id/messages', limits.send, limitBlockingAck, async (req, res) => {
  const result = await messages.sendUserMessage(currentUser(req), id(req), parse(sendMessageInput, req.body));
  res.status(result.created ? 201 : 200).json({ message: result.message });
});

/** Mounted under /messages. */
export const messageRoutes = Router();

messageRoutes.patch('/:id', async (req, res) => {
  const { text } = parse(editMessageInput, req.body);
  res.json({ message: await messages.editMessage(id(req), currentUser(req).id, text) });
});

messageRoutes.delete('/:id', async (req, res) => {
  await messages.deleteMessage(id(req), currentUser(req).id);
  res.status(204).end();
});

messageRoutes.post('/:id/reactions', async (req, res) => {
  const { emoji } = parse(reactionInput, req.body);
  res.json({ message: await messages.toggleReaction(id(req), currentUser(req).id, emoji) });
});

messageRoutes.get('/:id/references', async (req, res) => {
  res.json({ references: await messages.references(id(req), currentUser(req).id) });
});

messageRoutes.post('/:id/ack', async (req, res) => {
  res.json({ status: await delivery.acknowledge(id(req), currentUser(req).id) });
});

messageRoutes.get('/:id/delivery', async (req, res) => {
  res.json({ status: await delivery.deliveryStatus(id(req), currentUser(req).id) });
});

export const searchRoutes = Router();
searchRoutes.use(requireUser);

searchRoutes.get('/', limits.search, async (req, res) => {
  const { q, roomId, limit } = parse(searchQuery, req.query);
  res.json({ hits: await messages.search(currentUser(req).id, q, roomId, limit) });
});
