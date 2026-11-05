import { Router } from 'express';
import {
  addParticipantsInput,
  createBranchInput,
  mergeBranchInput,
  objectId,
  resolveBranchInput,
} from '@strata/shared';
import { param, parse } from '../../lib/http.js';
import { currentUser } from '../auth/middleware.js';
import * as branches from './service.js';

const id = (req: Parameters<typeof param>[0]) => parse(objectId, param(req, 'id'));

/** Mounted under /messages. */
export const messageBranchRoutes = Router();
messageBranchRoutes.post('/:id/branches', async (req, res) => {
  const room = await branches.createBranch(currentUser(req), id(req), parse(createBranchInput, req.body));
  res.status(201).json({ room });
});

/** Mounted under /rooms. */
export const roomBranchRoutes = Router();
roomBranchRoutes.get('/:id/branches', async (req, res) => {
  res.json({ branches: await branches.listBranches(id(req), currentUser(req).id) });
});

/** Mounted under /branches. */
export const branchRoutes = Router();

branchRoutes.post('/:id/participants', async (req, res) => {
  const { userIds } = parse(addParticipantsInput, req.body);
  res.json({ branch: await branches.addParticipants(currentUser(req).id, id(req), userIds) });
});

branchRoutes.post('/:id/resolve', async (req, res) => {
  const { summary } = parse(resolveBranchInput, req.body);
  res.json({ branch: await branches.resolveBranch(currentUser(req), id(req), summary) });
});

branchRoutes.post('/:id/reopen', async (req, res) => {
  res.json({ branch: await branches.reopenBranch(currentUser(req), id(req)) });
});

branchRoutes.post('/:id/merge', async (req, res) => {
  const { transcriptPolicy } = parse(mergeBranchInput, req.body);
  res.json({ branch: await branches.mergeBranch(currentUser(req), id(req), transcriptPolicy) });
});

branchRoutes.post('/:id/archive', async (req, res) => {
  res.json({ branch: await branches.archiveBranch(currentUser(req), id(req)) });
});
