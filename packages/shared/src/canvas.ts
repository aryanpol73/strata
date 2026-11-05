import { z } from 'zod';
import { LIMITS, objectId } from './common.js';

export const CANVAS_KINDS = ['text', 'link', 'decision', 'quote', 'live'] as const;
export type CanvasKind = (typeof CANVAS_KINDS)[number];

const section = z.string().min(1).max(40);
const body = z.string().max(LIMITS.canvasText);

export const canvasContent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: body }),
  z.object({ kind: z.literal('quote'), text: body }),
  z.object({
    kind: z.literal('link'),
    url: z.string().url().max(2000).refine((u) => /^https?:/i.test(u), 'Only http(s) links'),
    title: z.string().max(200).default(''),
  }),
  z.object({ kind: z.literal('decision'), text: body, status: z.enum(['proposed', 'decided', 'superseded']).default('decided') }),
  z.object({ kind: z.literal('live'), blockId: objectId }),
]);
export type CanvasContent = z.infer<typeof canvasContent>;

export const createCanvasBlockInput = z
  .object({
    sectionId: section.optional(),
    content: canvasContent.optional(),
    fromMessageId: objectId.optional(),
    /** When extracting a message, the kind to file it as. */
    asKind: z.enum(['quote', 'decision', 'text']).optional(),
  })
  .refine((v) => !!v.content || !!v.fromMessageId, 'Provide content or a source message');
export type CreateCanvasBlockInput = z.input<typeof createCanvasBlockInput>;

export const updateCanvasBlockInput = z.object({ content: canvasContent, version: z.number().int().positive() });
export const moveCanvasBlockInput = z.object({
  sectionId: section,
  afterId: objectId.nullable(),
  beforeId: objectId.nullable(),
});
export const sectionInput = z.object({ title: z.string().trim().min(1).max(120) });

export interface CanvasSourceDTO {
  messageId: string;
  roomId: string;
  seq: number;
  senderName: string;
  excerpt: string;
  sentAt: string;
  /** False when the source has since been deleted. */
  available: boolean;
}
export interface CanvasBlockDTO {
  id: string;
  roomId: string;
  sectionId: string;
  order: string;
  content: CanvasContent;
  source: CanvasSourceDTO | null;
  version: number;
  createdBy: string;
  updatedAt: string;
}
export interface CanvasSectionDTO {
  id: string;
  title: string;
  order: string;
}
export interface CanvasDTO {
  roomId: string;
  sections: CanvasSectionDTO[];
  blocks: CanvasBlockDTO[];
}
