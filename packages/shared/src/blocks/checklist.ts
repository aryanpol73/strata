import * as Y from 'yjs';
import { z } from 'zod';
import { BLOCK_LIMITS, newId, type BlockChange, type BlockDefinition } from './definition.js';

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  doneBy: string | null;
  order: number;
}
export interface ChecklistSummary {
  title: string;
  items: ChecklistItem[];
  doneCount: number;
}
const input = z.object({
  title: z.string().trim().min(1).max(BLOCK_LIMITS.title),
  items: z.array(z.string().trim().min(1).max(BLOCK_LIMITS.itemText)).max(BLOCK_LIMITS.items).default([]),
});
export type ChecklistInput = z.input<typeof input>;

const itemsOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('items');

function makeItem(text: string, order: number): Y.Map<unknown> {
  const item = new Y.Map<unknown>();
  item.set('text', new Y.Text(text));
  item.set('done', false);
  item.set('doneBy', null);
  item.set('order', order);
  return item;
}

/** Client-side operations. They mutate the Y.Doc, and sync takes care of the rest. */
export const checklistOps = {
  add(doc: Y.Doc, text: string): string {
    const id = newId();
    const max = [...itemsOf(doc).values()].reduce((m, i) => Math.max(m, (i.get('order') as number) ?? 0), 0);
    itemsOf(doc).set(id, makeItem(text, max + 1));
    return id;
  },
  toggle(doc: Y.Doc, id: string, actorName: string): void {
    const item = itemsOf(doc).get(id);
    if (!item) return;
    doc.transact(() => {
      const next = !item.get('done');
      item.set('done', next);
      item.set('doneBy', next ? actorName : null);
    });
  },
  remove(doc: Y.Doc, id: string): void {
    itemsOf(doc).delete(id);
  },
  text(doc: Y.Doc, id: string): Y.Text | undefined {
    return itemsOf(doc).get(id)?.get('text') as Y.Text | undefined;
  },
  setTitle(doc: Y.Doc, title: string): void {
    doc.getMap('meta').set('title', title);
  },
};

export const checklist: BlockDefinition<ChecklistInput, ChecklistSummary> = {
  type: 'checklist',
  label: 'Checklist',
  defaultPolicy: 'everyone',
  input,
  init(doc, { title, items = [] }) {
    doc.transact(() => {
      doc.getMap('meta').set('title', title);
      items.forEach((text, i) => itemsOf(doc).set(newId(), makeItem(text, i + 1)));
    });
  },
  summarize(doc) {
    const items: ChecklistItem[] = [...itemsOf(doc).entries()]
      .map(([id, m]) => ({
        id,
        text: String(m.get('text') ?? ''),
        done: m.get('done') === true,
        doneBy: (m.get('doneBy') as string | null) ?? null,
        order: Number(m.get('order') ?? 0),
      }))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    return { title: String(doc.getMap('meta').get('title') ?? ''), items, doneCount: items.filter((i) => i.done).length };
  },
  validate(_before, after, ctx) {
    if (!ctx.canManage) return 'Only the creator can edit this checklist';
    if (after.title.length > BLOCK_LIMITS.title) return 'Title is too long';
    if (after.items.length > BLOCK_LIMITS.items) return 'Too many items';
    if (after.items.some((i) => i.text.length > BLOCK_LIMITS.itemText)) return 'Item is too long';
    return null;
  },
  describe(before, after) {
    const changes: BlockChange[] = [];
    const prev = new Map(before.items.map((i) => [i.id, i]));
    const next = new Map(after.items.map((i) => [i.id, i]));
    for (const item of after.items) {
      const old = prev.get(item.id);
      if (!old) changes.push({ action: 'added', detail: item.text || 'an item' });
      else if (old.done !== item.done) changes.push({ action: item.done ? 'checked' : 'unchecked', detail: item.text });
      else if (old.text !== item.text) changes.push({ action: 'edited', detail: item.text });
    }
    for (const item of before.items) if (!next.has(item.id)) changes.push({ action: 'removed', detail: item.text });
    if (before.title !== after.title) changes.push({ action: 'renamed', detail: after.title });
    return changes;
  },
};
