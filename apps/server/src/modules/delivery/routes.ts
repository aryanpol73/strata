import { Router } from 'express';
import { z } from 'zod';
import { markNotificationsReadInput, notificationPreferences, pushSubscriptionInput } from '@strata/shared';
import { getEnv } from '../../config/env.js';
import { parse } from '../../lib/http.js';
import { currentUser, requireUser } from '../auth/middleware.js';
import * as delivery from './service.js';

export const notificationRoutes = Router();
notificationRoutes.use(requireUser);

notificationRoutes.get('/preferences', async (req, res) => {
  res.json({ preferences: await delivery.getPreferences(currentUser(req).id) });
});

notificationRoutes.put('/preferences', async (req, res) => {
  const prefs = parse(notificationPreferences, req.body);
  res.json({ preferences: await delivery.savePreferences(currentUser(req).id, prefs) });
});

notificationRoutes.get('/', async (req, res) => {
  res.json({ notifications: await delivery.listNotifications(currentUser(req).id) });
});

notificationRoutes.post('/read', async (req, res) => {
  await delivery.markNotificationsRead(currentUser(req).id, parse(markNotificationsReadInput, req.body).ids);
  res.status(204).end();
});

notificationRoutes.get('/push-key', (_req, res) => {
  res.json({ publicKey: getEnv().VAPID_PUBLIC_KEY ?? null });
});

notificationRoutes.post('/push-subscriptions', async (req, res) => {
  await delivery.savePushSubscription(currentUser(req).id, parse(pushSubscriptionInput, req.body));
  res.status(204).end();
});

notificationRoutes.delete('/push-subscriptions', async (req, res) => {
  const { endpoint } = parse(z.object({ endpoint: z.string().url() }), req.body);
  await delivery.removePushSubscription(currentUser(req).id, endpoint);
  res.status(204).end();
});
