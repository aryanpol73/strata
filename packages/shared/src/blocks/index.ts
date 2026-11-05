import { z } from 'zod';
import { checklist } from './checklist.js';
import type { BlockDefinition } from './definition.js';
import { infoCard } from './infoCard.js';
import { roster } from './roster.js';

export * from './checklist.js';
export * from './definition.js';
export * from './infoCard.js';
export * from './roster.js';

// Each definition is typed precisely in its own file. The registry is where they meet as one heterogeneous map.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const BLOCK_REGISTRY: Record<string, BlockDefinition<any, any>> = {
  [checklist.type]: checklist,
  [roster.type]: roster,
  [infoCard.type]: infoCard,
};
export const BLOCK_TYPES = Object.keys(BLOCK_REGISTRY);

export const createBlockInput = z.object({
  type: z.string().refine((t) => t in BLOCK_REGISTRY, 'Unknown block type'),
  clientMessageId: z.string().min(8).max(64),
  data: z.unknown(),
  policy: z.enum(['everyone', 'creator']).optional(),
});
export type CreateBlockInput = z.infer<typeof createBlockInput>;
export const blockPolicyInput = z.object({ edit: z.enum(['everyone', 'creator']) });

export interface BlockDTO {
  id: string;
  roomId: string;
  messageId: string;
  type: string;
  policy: { edit: 'everyone' | 'creator' };
  createdBy: string;
  summary: unknown;
}
export interface BlockActivityDTO {
  id: string;
  actorName: string;
  action: string;
  detail: string;
  at: string;
}
