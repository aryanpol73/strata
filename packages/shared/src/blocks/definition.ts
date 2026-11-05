import type * as Y from 'yjs';
import type { z } from 'zod';

export const BLOCK_LIMITS = { title: 200, itemText: 2000, items: 200, slots: 50, claims: 500, fields: 40, fieldValue: 4000 } as const;

export interface BlockValidationContext {
  actor: { id: string; name: string };
  /** True for the block's creator, room admins, or anyone when the edit policy is `everyone`. */
  canManage: boolean;
  now: number;
}

export interface BlockChange {
  action: string;
  detail: string;
}

/**
 * Everything a block type must provide. Adding a type means adding one definition: the server's sync,
 * persistence, validation and history all work through this interface.
 */
export interface BlockDefinition<Input = unknown, Summary extends { title: string } = { title: string }> {
  type: string;
  label: string;
  defaultPolicy: 'everyone' | 'creator';
  input: z.ZodType<unknown, Input>;
  init(doc: Y.Doc, input: Input): void;
  summarize(doc: Y.Doc): Summary;
  /** Returns an error message to reject the transition, or null to accept it. */
  validate(before: Summary, after: Summary, ctx: BlockValidationContext): string | null;
  describe(before: Summary, after: Summary): BlockChange[];
}

export const newId = (): string => globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16);
