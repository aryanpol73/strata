import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { checklist, checklistOps, infoCard, infoCardOps, roster, rosterOps } from '../src/index.js';

const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
};
const fork = (doc: Y.Doc) => {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
};
const ctx = (id: string, canManage: boolean) => ({ actor: { id, name: id }, canManage, now: Date.now() });

describe('checklist', () => {
  it('converges when two people add and toggle at once', () => {
    const a = new Y.Doc();
    checklist.init(a, { title: 'Trip', items: ['Tickets'] });
    const b = fork(a);
    const firstId = checklist.summarize(a).items[0]!.id;

    checklistOps.add(a, 'Hotel');
    checklistOps.add(b, 'Visa');
    checklistOps.toggle(a, firstId, 'Ada');
    checklistOps.text(b, firstId)!.insert(0, 'Train ');
    sync(a, b);

    expect(checklist.summarize(a)).toEqual(checklist.summarize(b));
    const s = checklist.summarize(a);
    expect(s.items).toHaveLength(3);
    expect(s.items.find((i) => i.id === firstId)).toMatchObject({ text: 'Train Tickets', done: true, doneBy: 'Ada' });
  });

  it('merges concurrent character edits in the same item', () => {
    const a = new Y.Doc();
    checklist.init(a, { title: 'T', items: ['ab'] });
    const b = fork(a);
    const id = checklist.summarize(a).items[0]!.id;
    checklistOps.text(a, id)!.insert(1, 'X');
    checklistOps.text(b, id)!.insert(2, 'Y');
    sync(a, b);
    expect(checklist.summarize(a).items[0]!.text).toBe('aXbY');
  });

  it('refuses edits from someone without manage rights', () => {
    const doc = new Y.Doc();
    checklist.init(doc, { title: 'T', items: [] });
    const s = checklist.summarize(doc);
    expect(checklist.validate(s, s, ctx('u', false))).toMatch(/creator/);
  });

  it('describes changes for the activity log', () => {
    const doc = new Y.Doc();
    checklist.init(doc, { title: 'T', items: ['One'] });
    const before = checklist.summarize(doc);
    checklistOps.toggle(doc, before.items[0]!.id, 'Ada');
    checklistOps.add(doc, 'Two');
    const actions = checklist.describe(before, checklist.summarize(doc)).map((c) => c.action);
    expect(actions.sort()).toEqual(['added', 'checked']);
  });
});

describe('roster', () => {
  const setup = () => {
    const doc = new Y.Doc();
    roster.init(doc, { title: 'Shifts', slots: [{ label: 'Morning', capacity: 1 }] });
    return { doc, slotId: roster.summarize(doc).slots[0]!.id };
  };

  it('agrees on who gets the last place when claims race', () => {
    const { doc: a, slotId } = setup();
    const b = fork(a);
    rosterOps.claim(a, slotId, { id: 'u1', name: 'Ada' }, 1000);
    rosterOps.claim(b, slotId, { id: 'u2', name: 'Bo' }, 1000);
    sync(a, b);
    const sa = roster.summarize(a).slots[0]!;
    expect(sa).toEqual(roster.summarize(b).slots[0]);
    expect(sa.confirmed).toHaveLength(1);
    expect(sa.waitlist).toHaveLength(1);
  });

  it('lets a member claim for themselves but not for someone else', () => {
    const { doc, slotId } = setup();
    const before = roster.summarize(doc);
    const mine = fork(doc);
    rosterOps.claim(mine, slotId, { id: 'me', name: 'Me' });
    expect(roster.validate(before, roster.summarize(mine), ctx('me', false))).toBeNull();

    const theirs = fork(doc);
    rosterOps.claim(theirs, slotId, { id: 'other', name: 'Other' });
    expect(roster.validate(before, roster.summarize(theirs), ctx('me', false))).toMatch(/yourself/);
  });

  it('stops a member removing someone else or changing slots', () => {
    const { doc, slotId } = setup();
    rosterOps.claim(doc, slotId, { id: 'other', name: 'Other' });
    const before = roster.summarize(doc);

    const removed = fork(doc);
    rosterOps.release(removed, slotId, 'other');
    expect(roster.validate(before, roster.summarize(removed), ctx('me', false))).toMatch(/your own/);

    const added = fork(doc);
    rosterOps.addSlot(added, 'Evening', 2);
    expect(roster.validate(before, roster.summarize(added), ctx('me', false))).toMatch(/creator/);
    expect(roster.validate(before, roster.summarize(added), ctx('boss', true))).toBeNull();
  });

  it('refuses a backdated claim', () => {
    const { doc, slotId } = setup();
    const before = roster.summarize(doc);
    const forged = fork(doc);
    rosterOps.claim(forged, slotId, { id: 'me', name: 'Me' }, 1);
    expect(roster.validate(before, roster.summarize(forged), ctx('me', false))).toMatch(/out of range/);
  });
});

describe('info card', () => {
  it('merges concurrent edits to different fields', () => {
    const a = new Y.Doc();
    infoCard.init(a, { title: 'Venue', fields: [{ label: 'Address', value: '' }, { label: 'Door code', value: '' }] });
    const b = fork(a);
    const [f1, f2] = infoCard.summarize(a).fields;
    infoCardOps.value(a, f1!.id)!.insert(0, '12 Elm St');
    infoCardOps.value(b, f2!.id)!.insert(0, '4417');
    sync(a, b);
    expect(infoCard.summarize(b).fields.map((f) => f.value)).toEqual(['12 Elm St', '4417']);
  });
});
