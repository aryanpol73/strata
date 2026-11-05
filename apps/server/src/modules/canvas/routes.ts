import { Router } from 'express';
import {
  createCanvasBlockInput,
  moveCanvasBlockInput,
  objectId,
  sectionInput,
  updateCanvasBlockInput,
} from '@strata/shared';
import { param, parse } from '../../lib/http.js';
import { currentUser } from '../auth/middleware.js';
import * as canvas from './service.js';

const id = (req: Parameters<typeof param>[0], name = 'id') => parse(objectId, param(req, name));

/** Mounted under /rooms. */
export const roomCanvasRoutes = Router();

roomCanvasRoutes.get('/:id/canvas', async (req, res) => {
  res.json({ canvas: await canvas.getMemberCanvas(id(req), currentUser(req).id) });
});

roomCanvasRoutes.post('/:id/canvas/sections', async (req, res) => {
  const { title } = parse(sectionInput, req.body);
  res.status(201).json({ canvas: await canvas.addSection(id(req), currentUser(req).id, title) });
});

roomCanvasRoutes.patch('/:id/canvas/sections/:sectionId', async (req, res) => {
  const { title } = parse(sectionInput, req.body);
  res.json({ canvas: await canvas.renameSection(id(req), currentUser(req).id, param(req, 'sectionId'), title) });
});

roomCanvasRoutes.delete('/:id/canvas/sections/:sectionId', async (req, res) => {
  res.json({ canvas: await canvas.deleteSection(id(req), currentUser(req).id, param(req, 'sectionId')) });
});

roomCanvasRoutes.post('/:id/canvas/blocks', async (req, res) => {
  const block = await canvas.createBlock(currentUser(req), id(req), parse(createCanvasBlockInput, req.body));
  res.status(201).json({ block });
});

/** Mounted under /canvas. */
export const canvasRoutes = Router();

canvasRoutes.patch('/blocks/:id', async (req, res) => {
  const { content, version } = parse(updateCanvasBlockInput, req.body);
  res.json({ block: await canvas.updateBlock(id(req), currentUser(req).id, content, version) });
});

canvasRoutes.post('/blocks/:id/move', async (req, res) => {
  res.json({ block: await canvas.moveBlock(id(req), currentUser(req).id, parse(moveCanvasBlockInput, req.body)) });
});

canvasRoutes.delete('/blocks/:id', async (req, res) => {
  await canvas.deleteBlock(id(req), currentUser(req).id);
  res.status(204).end();
});
