import { Router } from 'express';
import {
  addMembersInput,
  createDirectInput,
  createGroupInput,
  markReadInput,
  muteInput,
  objectId,
  updateMemberInput,
  updateRoomInput,
} from '@strata/shared';
import { param, parse } from '../../lib/http.js';
import { currentUser } from '../auth/middleware.js';
import * as rooms from './service.js';

export const roomRoutes = Router();

const roomId = (req: Parameters<typeof param>[0]) => parse(objectId, param(req, 'id'));

roomRoutes.get('/', async (req, res) => {
  res.json({ rooms: await rooms.listRooms(currentUser(req).id) });
});

roomRoutes.post('/direct', async (req, res) => {
  const { userId } = parse(createDirectInput, req.body);
  res.status(201).json({ room: await rooms.findOrCreateDirect(currentUser(req).id, userId) });
});

roomRoutes.post('/group', async (req, res) => {
  res.status(201).json({ room: await rooms.createGroup(currentUser(req).id, parse(createGroupInput, req.body)) });
});

roomRoutes.get('/:id', async (req, res) => {
  res.json({ room: await rooms.getRoom(roomId(req), currentUser(req).id) });
});

roomRoutes.patch('/:id', async (req, res) => {
  res.json({ room: await rooms.updateRoom(roomId(req), currentUser(req).id, parse(updateRoomInput, req.body)) });
});

roomRoutes.post('/:id/members', async (req, res) => {
  const { userIds } = parse(addMembersInput, req.body);
  res.json({ room: await rooms.addMembers(roomId(req), currentUser(req).id, userIds) });
});

roomRoutes.patch('/:id/members/:userId', async (req, res) => {
  const { role } = parse(updateMemberInput, req.body);
  await rooms.setRole(roomId(req), currentUser(req).id, parse(objectId, param(req, 'userId')), role);
  res.status(204).end();
});

roomRoutes.delete('/:id/members/:userId', async (req, res) => {
  await rooms.removeMember(roomId(req), currentUser(req).id, parse(objectId, param(req, 'userId')));
  res.status(204).end();
});

roomRoutes.post('/:id/read', async (req, res) => {
  await rooms.markRead(roomId(req), currentUser(req).id, parse(markReadInput, req.body).seq);
  res.status(204).end();
});

roomRoutes.patch('/:id/mute', async (req, res) => {
  await rooms.setMute(roomId(req), currentUser(req).id, parse(muteInput, req.body).until);
  res.status(204).end();
});
