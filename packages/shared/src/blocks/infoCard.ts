import * as Y from 'yjs';
import { z } from 'zod';
import { BLOCK_LIMITS, newId, type BlockChange, type BlockDefinition } from './definition.js';

export interface InfoField {
  id: string;
  label: string;
  value: string;
  order: number;
}
export interface InfoCardSummary {
  title: string;
  fields: InfoField[];
}
const input = z.object({
  title: z.string().trim().min(1).max(BLOCK_LIMITS.title),
  fields: z
    .array(z.object({ label: z.string().trim().min(1).max(120), value: z.string().max(BLOCK_LIMITS.fieldValue).default('') }))
    .max(BLOCK_LIMITS.fields)
    .default([]),
});
export type InfoCardInput = z.input<typeof input>;

const fieldsOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('fields');

function makeField(label: string, value: string, order: number): Y.Map<unknown> {
  const field = new Y.Map<unknown>();
  field.set('label', label);
  field.set('value', new Y.Text(value));
  field.set('order', order);
  return field;
}

export const infoCardOps = {
  add(doc: Y.Doc, label: string, value = ''): string {
    const id = newId();
    const max = [...fieldsOf(doc).values()].reduce((m, f) => Math.max(m, (f.get('order') as number) ?? 0), 0);
    fieldsOf(doc).set(id, makeField(label, value, max + 1));
    return id;
  },
  remove(doc: Y.Doc, id: string): void {
    fieldsOf(doc).delete(id);
  },
  value(doc: Y.Doc, id: string): Y.Text | undefined {
    return fieldsOf(doc).get(id)?.get('value') as Y.Text | undefined;
  },
  setLabel(doc: Y.Doc, id: string, label: string): void {
    fieldsOf(doc).get(id)?.set('label', label);
  },
};

export const infoCard: BlockDefinition<InfoCardInput, InfoCardSummary> = {
  type: 'info',
  label: 'Info card',
  defaultPolicy: 'everyone',
  input,
  init(doc, { title, fields = [] }) {
    doc.transact(() => {
      doc.getMap('meta').set('title', title);
      fields.forEach((f, i) => fieldsOf(doc).set(newId(), makeField(f.label, f.value ?? '', i + 1)));
    });
  },
  summarize(doc) {
    const fields: InfoField[] = [...fieldsOf(doc).entries()]
      .map(([id, m]) => ({
        id,
        label: String(m.get('label') ?? ''),
        value: String(m.get('value') ?? ''),
        order: Number(m.get('order') ?? 0),
      }))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    return { title: String(doc.getMap('meta').get('title') ?? ''), fields };
  },
  validate(_before, after, ctx) {
    if (!ctx.canManage) return 'Only the creator can edit this card';
    if (after.title.length > BLOCK_LIMITS.title) return 'Title is too long';
    if (after.fields.length > BLOCK_LIMITS.fields) return 'Too many fields';
    if (after.fields.some((f) => f.value.length > BLOCK_LIMITS.fieldValue)) return 'Field is too long';
    return null;
  },
  describe(before, after) {
    const changes: BlockChange[] = [];
    const prev = new Map(before.fields.map((f) => [f.id, f]));
    const next = new Set(after.fields.map((f) => f.id));
    for (const f of after.fields) {
      const old = prev.get(f.id);
      if (!old) changes.push({ action: 'added', detail: f.label });
      else if (old.value !== f.value || old.label !== f.label) changes.push({ action: 'updated', detail: f.label });
    }
    for (const f of before.fields) if (!next.has(f.id)) changes.push({ action: 'removed', detail: f.label });
    return changes;
  },
};
