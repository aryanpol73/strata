import { Router } from 'express';
import { blockPolicyInput, createBlockInput, objectId } from '@strata/shared';
import { param, parse } from '../../lib/http.js';
import { currentUser } from '../auth/middleware.js';
import * as blocks from './service.js';

const id = (req: Parameters<typeof param>[0]) => parse(objectId, param(req, 'id'));

/** Mounted under /rooms. */
export const roomBlockRoutes = Router();
roomBlockRoutes.post('/:id/blocks', async (req, res) => {
  const block = await blocks.createBlock(currentUser(req), id(req), parse(createBlockInput, req.body));
  res.status(201).json({ block });
});

/** Mounted under /blocks. */
export const blockRoutes = Router();

blockRoutes.get('/:id', async (req, res) => {
  res.json({ block: await blocks.getBlock(id(req), currentUser(req).id) });
});

blockRoutes.get('/:id/activity', async (req, res) => {
  res.json({ activity: await blocks.getActivity(id(req), currentUser(req).id) });
});

blockRoutes.patch('/:id/policy', async (req, res) => {
  const { edit } = parse(blockPolicyInput, req.body);
  res.json({ block: await blocks.setPolicy(id(req), currentUser(req).id, edit) });
});
