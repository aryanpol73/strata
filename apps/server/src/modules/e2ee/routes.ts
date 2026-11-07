import { Router } from 'express';
import { objectId, postRoomKeysInput, setIdentityInput } from '@strata/shared';
import { param, parse } from '../../lib/http.js';
import { limits } from '../../lib/rateLimit.js';
import { currentUser, requireUser } from '../auth/middleware.js';
import * as e2ee from './service.js';

export const e2eeRoutes = Router();
e2eeRoutes.use(requireUser);

e2eeRoutes.get('/me', async (req, res) => {
  res.json(await e2ee.getIdentity(currentUser(req).id));
});

e2eeRoutes.put('/me', limits.login, async (req, res) => {
  res.json({ user: await e2ee.setIdentity(currentUser(req).id, parse(setIdentityInput, req.body)) });
});

e2eeRoutes.get('/rooms/:id', async (req, res) => {
  res.json(await e2ee.roomKeys(currentUser(req).id, parse(objectId, param(req, 'id'))));
});

e2eeRoutes.post('/rooms/:id/keys', async (req, res) => {
  res.json(await e2ee.postRoomKeys(currentUser(req).id, parse(objectId, param(req, 'id')), parse(postRoomKeysInput, req.body)));
});
