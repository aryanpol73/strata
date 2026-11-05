import { addChecklist, expect, group, openRoom, person, signIn, test } from './support';

test('two people edit one checklist at the same time', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  const [a, b] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, bo)];
  await Promise.all([openRoom(a, room.id), openRoom(b, room.id)]);

  await addChecklist(a, 'Packing', ['Tickets']);
  const [listA, listB] = [a.getByRole('region', { name: /Packing/ }), b.getByRole('region', { name: /Packing/ })];
  await expect(listB.getByLabel('Item text')).toHaveValue('Tickets');

  await Promise.all([
    listA.getByLabel('New item').fill('Hotel').then(() => listA.getByLabel('New item').press('Enter')),
    listB.getByLabel('New item').fill('Visa').then(() => listB.getByLabel('New item').press('Enter')),
  ]);
  await listB.getByRole('checkbox', { name: /Tickets/ }).click();

  for (const list of [listA, listB]) {
    await expect(list.getByLabel('Item text')).toHaveCount(3);
    await expect(list.getByRole('checkbox', { name: /Tickets/ })).toHaveAttribute('aria-checked', 'true');
    await expect(list.getByText('1/3')).toBeVisible();
  }

  // One message, however many edits: this is the point of a shared object.
  await expect(a.getByRole('region', { name: /Packing/ })).toHaveCount(1);
});

test('typing in the same item from two browsers keeps both edits', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  const [a, b] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, bo)];
  await Promise.all([openRoom(a, room.id), openRoom(b, room.id)]);

  await addChecklist(a, 'Shared text', ['middle']);
  const [itemA, itemB] = [a.getByLabel('Item text'), b.getByLabel('Item text')];
  await expect(itemB).toHaveValue('middle');

  await itemA.focus();
  await a.keyboard.press('Home');
  await itemB.focus();
  await b.keyboard.press('End');
  await Promise.all([a.keyboard.type('start '), b.keyboard.type(' end')]);

  await expect(itemA).toHaveValue('start middle end');
  await expect(itemB).toHaveValue('start middle end');
});

test('edits made offline survive and merge on reconnecting', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  const [a, b] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, bo)];
  await Promise.all([openRoom(a, room.id), openRoom(b, room.id)]);

  await addChecklist(a, 'Offline list', ['base']);
  const [listA, listB] = [a.getByRole('region', { name: /Offline list/ }), b.getByRole('region', { name: /Offline list/ })];
  await expect(listB.getByLabel('Item text')).toHaveValue('base');

  await b.context().setOffline(true);
  await expect(b.getByText("You're offline.")).toBeVisible({ timeout: 45_000 });

  await listB.getByLabel('New item').fill('made offline');
  await listB.getByLabel('New item').press('Enter');
  await listA.getByLabel('New item').fill('made online');
  await listA.getByLabel('New item').press('Enter');
  await expect(listB.getByLabel('Item text')).toHaveCount(2);

  await b.context().setOffline(false);
  for (const list of [listA, listB]) await expect(list.getByLabel('Item text')).toHaveCount(3, { timeout: 20_000 });
});

test('the history records who changed what', async ({ browser, baseURL, request }) => {
  const ada = await person(request, 'Ada');
  const room = await group(request, ada, []);
  const a = await signIn(browser, baseURL!, ada);
  await openRoom(a, room.id);
  await addChecklist(a, 'Tracked', ['One']);
  await a.getByRole('checkbox', { name: /One/ }).click();
  await expect(a.getByText('1/1')).toBeVisible();
  await a.waitForTimeout(600); // Edits are batched before they're sent, and the log follows the server.

  await a.getByRole('button', { name: 'Change history' }).click();
  await expect(a.getByRole('dialog').getByText('checked')).toBeVisible();
});
