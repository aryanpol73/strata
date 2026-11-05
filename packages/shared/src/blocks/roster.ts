import * as Y from 'yjs';
import { z } from 'zod';
import { BLOCK_LIMITS, newId, type BlockChange, type BlockDefinition } from './definition.js';

export interface RosterClaim {
  key: string;
  slotId: string;
  principalId: string;
  name: string;
  at: number;
}
export interface RosterSlot {
  id: string;
  label: string;
  capacity: number;
  order: number;
  confirmed: RosterClaim[];
  waitlist: RosterClaim[];
}
export interface RosterSummary {
  title: string;
  slots: RosterSlot[];
  claims: RosterClaim[];
}
const input = z.object({
  title: z.string().trim().min(1).max(BLOCK_LIMITS.title),
  slots: z
    .array(z.object({ label: z.string().trim().min(1).max(200), capacity: z.number().int().min(1).max(500) }))
    .min(1)
    .max(BLOCK_LIMITS.slots),
});
export type RosterInput = z.input<typeof input>;

const slotsOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('slots');
const claimsOf = (doc: Y.Doc) => doc.getMap<Omit<RosterClaim, 'key'>>('claims');
const claimKey = (slotId: string, principalId: string) => `${slotId}|${principalId}`;

function makeSlot(label: string, capacity: number, order: number): Y.Map<unknown> {
  const slot = new Y.Map<unknown>();
  slot.set('label', label);
  slot.set('capacity', capacity);
  slot.set('order', order);
  return slot;
}

export const rosterOps = {
  addSlot(doc: Y.Doc, label: string, capacity: number): string {
    const id = newId();
    const max = [...slotsOf(doc).values()].reduce((m, s) => Math.max(m, (s.get('order') as number) ?? 0), 0);
    slotsOf(doc).set(id, makeSlot(label, capacity, max + 1));
    return id;
  },
  removeSlot(doc: Y.Doc, slotId: string): void {
    doc.transact(() => {
      slotsOf(doc).delete(slotId);
      for (const key of [...claimsOf(doc).keys()]) if (key.startsWith(`${slotId}|`)) claimsOf(doc).delete(key);
    });
  },
  claim(doc: Y.Doc, slotId: string, principal: { id: string; name: string }, at = Date.now()): void {
    claimsOf(doc).set(claimKey(slotId, principal.id), { slotId, principalId: principal.id, name: principal.name, at });
  },
  release(doc: Y.Doc, slotId: string, principalId: string): void {
    claimsOf(doc).delete(claimKey(slotId, principalId));
  },
};

export const roster: BlockDefinition<RosterInput, RosterSummary> = {
  type: 'roster',
  label: 'Sign-up roster',
  // `creator` means only the creator manages slots. Everyone can still claim and release their own place.
  defaultPolicy: 'creator',
  input,
  init(doc, { title, slots }) {
    doc.transact(() => {
      doc.getMap('meta').set('title', title);
      slots.forEach((s, i) => slotsOf(doc).set(newId(), makeSlot(s.label, s.capacity, i + 1)));
    });
  },
  summarize(doc) {
    const claims: RosterClaim[] = [...claimsOf(doc).entries()]
      .map(([key, c]) => ({ ...c, key }))
      // Deterministic on every replica, so concurrent claims for the last place agree on the winner.
      .sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
    const slots: RosterSlot[] = [...slotsOf(doc).entries()]
      .map(([id, s]) => {
        const capacity = Number(s.get('capacity') ?? 1);
        const mine = claims.filter((c) => c.slotId === id);
        return {
          id,
          label: String(s.get('label') ?? ''),
          capacity,
          order: Number(s.get('order') ?? 0),
          confirmed: mine.slice(0, capacity),
          waitlist: mine.slice(capacity),
        };
      })
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    return { title: String(doc.getMap('meta').get('title') ?? ''), slots, claims };
  },
  validate(before, after, ctx) {
    if (after.title.length > BLOCK_LIMITS.title) return 'Title is too long';
    if (after.slots.length > BLOCK_LIMITS.slots) return 'Too many slots';
    if (after.claims.length > BLOCK_LIMITS.claims) return 'Too many sign-ups';

    const slotIds = new Set(after.slots.map((s) => s.id));
    const prev = new Map(before.claims.map((c) => [c.key, c]));
    const next = new Map(after.claims.map((c) => [c.key, c]));

    for (const claim of after.claims) {
      const old = prev.get(claim.key);
      if (old && old.at === claim.at && old.name === claim.name) continue;
      if (claim.key !== claimKey(claim.slotId, claim.principalId)) return 'Malformed sign-up';
      if (!slotIds.has(claim.slotId)) return 'That slot no longer exists';
      if (!ctx.canManage && claim.principalId !== ctx.actor.id) return 'You can only sign yourself up';
      // Claim order decides who gets a place, so a client can't backdate its way up the queue.
      if (Math.abs(claim.at - ctx.now) > 5 * 60_000) return 'Sign-up time is out of range';
    }
    if (ctx.canManage) return null;

    for (const claim of before.claims) {
      if (!next.has(claim.key) && claim.principalId !== ctx.actor.id) return 'You can only remove your own sign-up';
    }
    const shape = (s: RosterSummary) => JSON.stringify([s.title, s.slots.map((x) => [x.id, x.label, x.capacity, x.order])]);
    if (shape(before) !== shape(after)) return 'Only the creator can change the slots';
    return null;
  },
  describe(before, after) {
    const changes: BlockChange[] = [];
    const label = (s: RosterSummary, id: string) => s.slots.find((x) => x.id === id)?.label ?? 'a slot';
    const prev = new Set(before.claims.map((c) => c.key));
    const next = new Set(after.claims.map((c) => c.key));
    for (const c of after.claims) if (!prev.has(c.key)) changes.push({ action: 'signed up', detail: `${c.name} for ${label(after, c.slotId)}` });
    for (const c of before.claims) if (!next.has(c.key)) changes.push({ action: 'withdrew', detail: `${c.name} from ${label(before, c.slotId)}` });
    const prevSlots = new Set(before.slots.map((s) => s.id));
    const nextSlots = new Set(after.slots.map((s) => s.id));
    for (const s of after.slots) if (!prevSlots.has(s.id)) changes.push({ action: 'added slot', detail: s.label });
    for (const s of before.slots) if (!nextSlots.has(s.id)) changes.push({ action: 'removed slot', detail: s.label });
    return changes;
  },
};
