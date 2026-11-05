import express, { Router } from 'express';
import { ALLOWED_MIME, completeUploadInput, objectId, signUploadInput } from '@strata/shared';
import { notFound } from '../../lib/errors.js';
import { param, parse } from '../../lib/http.js';
import { limits } from '../../lib/rateLimit.js';
import { verifyMediaUrl } from '../../lib/tokens.js';
import { currentUser, requireUser } from '../auth/middleware.js';
import * as media from './service.js';

export const mediaRoutes = Router();

const id = (req: Parameters<typeof param>[0]) => parse(objectId, param(req, 'id'));
const maxUpload = Math.max(...Object.values(ALLOWED_MIME).map((r) => r.maxBytes));

mediaRoutes.post('/sign', requireUser, limits.media, async (req, res) => {
  res.status(201).json(await media.signUpload(currentUser(req).id, parse(signUploadInput, req.body)));
});

mediaRoutes.put(
  '/:id/upload',
  requireUser,
  limits.media,
  express.raw({ type: () => true, limit: maxUpload }),
  async (req, res) => {
    await media.storeDiskUpload(id(req), currentUser(req).id, req.body as Buffer);
    res.status(204).end();
  },
);

mediaRoutes.post('/:id/complete', requireUser, async (req, res) => {
  res.json(await media.completeUpload(id(req), currentUser(req).id, parse(completeUploadInput, req.body)));
});

mediaRoutes.get('/:id/url', requireUser, async (req, res) => {
  res.json(await media.mediaUrl(id(req), currentUser(req).id));
});

/** Authorized by the short-lived signature that `/url` issued after checking room access. */
mediaRoutes.get('/:id/file', async (req, res) => {
  const assetId = id(req);
  const exp = Number(req.query.exp);
  if (!verifyMediaUrl(assetId, exp, String(req.query.sig ?? ''))) throw notFound('File');

  const { asset, bytes } = await media.readDiskFile(assetId);
  const isImage = ALLOWED_MIME[asset.mime]?.image;
  res.set({
    'content-type': asset.mime,
    'content-disposition': `${isImage ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cross-origin-resource-policy': 'cross-origin',
    'cache-control': 'private, max-age=300',
  });
  res.send(bytes);
});
