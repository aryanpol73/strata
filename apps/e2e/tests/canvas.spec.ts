import { action, branchFrom, expect, group, openRoom, person, resolveAndMerge, row, say, signIn, test } from './support';

const canvas = (page: import('@playwright/test').Page) => page.getByRole('complementary', { name: 'Canvas' });

test('a message moves to the Canvas, and each side leads to the other', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  await say(request, bo, room.id, 'The caterer needs numbers by Friday');
  for (let i = 0; i < 40; i += 1) await say(request, ada, room.id, `chatter ${i}`);

  const [a, b] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, bo)];
  await Promise.all([openRoom(a, room.id), openRoom(b, room.id)]);

  await row(a, 'chatter 39').hover();
  await a.getByRole('log').evaluate((el) => (el.scrollTop = 0));
  await action(a, 'The caterer needs numbers by Friday', 'Add to Canvas');

  await expect(canvas(a).getByRole('textbox', { name: 'Canvas text' })).toHaveValue('The caterer needs numbers by Friday');
  // The other person's Canvas updates without a reload.
  await expect(canvas(b).getByRole('textbox', { name: 'Canvas text' })).toHaveValue('The caterer needs numbers by Friday');

  // Canvas to message: lands on the source, scrolled into view.
  await a.getByRole('log').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(row(a, 'The caterer needs numbers by Friday')).not.toBeInViewport();
  await canvas(a).getByRole('button', { name: /Bo/ }).click();
  await expect(row(a, 'The caterer needs numbers by Friday')).toBeInViewport();

  // Message to Canvas.
  await row(a, 'The caterer needs numbers by Friday').getByRole('button', { name: 'On Canvas' }).click();
  await expect(canvas(a).locator('li[id^="cb-"]')).toHaveClass(/animate-pulse-line/);
});

test('a resolution files as a decision, and edits persist', async ({ browser, baseURL, request }) => {
  const ada = await person(request, 'Ada');
  const room = await group(request, ada, []);
  await say(request, ada, room.id, 'Pricing?');
  const a = await signIn(browser, baseURL!, ada);
  await openRoom(a, room.id);

  await branchFrom(a, 'Pricing?', 'Pricing', []);
  await resolveAndMerge(a, 'Keep it at 20.');
  await a.getByRole('link', { name: room.name }).first().click();
  await a.getByRole('button', { name: 'Add to Canvas' }).first().click();

  const text = canvas(a).getByRole('textbox', { name: 'Canvas text' });
  await expect(text).toHaveValue('Pricing: Keep it at 20.');
  await expect(canvas(a).getByText('decided')).toBeVisible();

  await text.fill('Pricing: Keep it at 25.');
  await text.blur();
  await expect(a.getByRole('button', { name: 'Remove from Canvas' })).toBeVisible();
  await a.waitForLoadState('networkidle');
  await a.reload();
  await expect(canvas(a).getByRole('textbox', { name: 'Canvas text' })).toHaveValue('Pricing: Keep it at 25.');
});

test('blocks reorder by mouse, and the order sticks', async ({ browser, baseURL, request }) => {
  const ada = await person(request, 'Ada');
  const room = await group(request, ada, []);
  const a = await signIn(browser, baseURL!, ada);
  await openRoom(a, room.id);

  const fields = canvas(a).getByRole('textbox', { name: 'Canvas text' });
  for (const [i, text] of ['first', 'second', 'third'].entries()) {
    await canvas(a).getByRole('button', { name: 'Note' }).click();
    await expect(fields).toHaveCount(i + 1);
    await fields.last().fill(text);
    await fields.last().blur();
    await a.waitForLoadState('networkidle');
    await expect(fields.last()).toHaveValue(text);
  }

  const handles = canvas(a).getByRole('button', { name: 'Drag to reorder' });
  await canvas(a).locator('li[id^="cb-"]').nth(2).hover();
  const from = (await handles.nth(2).boundingBox())!;
  const to = (await canvas(a).locator('li[id^="cb-"]').nth(0).boundingBox())!;
  await a.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await a.mouse.down();
  await a.mouse.move(from.x, from.y - 20, { steps: 6 });
  await a.mouse.move(to.x + 40, to.y + 4, { steps: 12 });
  await a.mouse.up();

  const values = () => canvas(a).locator('textarea').evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value));
  await expect.poll(values).toEqual(['third', 'first', 'second']);
  await a.waitForLoadState('networkidle');
  await a.reload();
  await expect(canvas(a).locator('textarea').first()).toBeVisible();
  await expect.poll(values).toEqual(['third', 'first', 'second']);
});

test('two people editing the same note see a conflict, not a silent overwrite', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  const a = await signIn(browser, baseURL!, ada);
  await openRoom(a, room.id);
  await canvas(a).getByRole('button', { name: 'Note' }).click();
  await canvas(a).getByRole('textbox', { name: 'Canvas text' }).fill('shared note');
  await canvas(a).getByRole('textbox', { name: 'Canvas text' }).blur();
  await a.waitForLoadState('networkidle');

  const b = await signIn(browser, baseURL!, bo);
  await openRoom(b, room.id);
  const [noteA, noteB] = [canvas(a).getByRole('textbox', { name: 'Canvas text' }), canvas(b).getByRole('textbox', { name: 'Canvas text' })];
  await expect(noteB).toHaveValue('shared note');

  // Hold back Ada's live update so she edits a stale copy, which is the race this guards against.
  await a.route('**/canvas', (route) => route.abort());
  await noteB.fill('Bo got there first');
  await noteB.blur();
  await b.waitForLoadState('networkidle');
  await noteA.fill('Ada overwrites');
  await a.unroute('**/canvas');
  await noteA.blur();

  await expect(a.getByText('Someone else just edited this.')).toBeVisible();
  await expect(noteA).toHaveValue('Bo got there first');
});

test('sections can be added, renamed, and removed without losing blocks', async ({ browser, baseURL, request }) => {
  const ada = await person(request, 'Ada');
  const room = await group(request, ada, []);
  const a = await signIn(browser, baseURL!, ada);
  await openRoom(a, room.id);

  await canvas(a).getByRole('textbox', { name: 'New section title' }).fill('Decisions');
  await canvas(a).getByRole('textbox', { name: 'New section title' }).press('Enter');
  const titles = canvas(a).getByRole('textbox', { name: 'Section title', exact: true });
  await expect(titles).toHaveCount(2);

  await canvas(a).getByRole('button', { name: 'Note' }).last().click();
  await canvas(a).getByRole('textbox', { name: 'Canvas text' }).fill('keep me');
  await canvas(a).getByRole('textbox', { name: 'Canvas text' }).blur();
  await a.waitForLoadState('networkidle');

  await canvas(a).getByRole('button', { name: 'Delete section Decisions' }).click({ force: true });
  await expect(titles).toHaveCount(1);
  await expect(canvas(a).getByRole('textbox', { name: 'Canvas text' })).toHaveValue('keep me');
});
