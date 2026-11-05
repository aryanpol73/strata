import { action, composer, expect, group, openRoom, person, row, say, signIn, test, watch, write } from './support';

test('messages, typing and read receipts travel live between two people', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  const [a, b] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, bo)];
  await Promise.all([openRoom(a, room.id), openRoom(b, room.id)]);

  await composer(a).pressSequentially('hel');
  await expect(b.getByText('Ada is typing')).toBeVisible();

  await composer(a).fill('hello from Ada');
  await composer(a).press('Enter');
  await expect(row(b, 'hello from Ada')).toBeVisible();
  await expect(row(a, 'hello from Ada').getByText('Read', { exact: true })).toBeVisible();
});

test('an unread count appears live and clears on reading', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo], 'Unread Room');
  const b = await signIn(browser, baseURL!, bo);
  await say(request, ada, room.id, 'are you there?');

  const link = b.getByRole('link', { name: /Unread Room/ });
  await expect(link.getByLabel('1 unread')).toBeVisible();
  await link.click();
  await expect(row(b, 'are you there?')).toBeVisible();
  await expect(link.getByLabel('1 unread')).toHaveCount(0);
});

test('edit, react, reply and delete all reach the other person', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  const [a, b] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, bo)];
  await Promise.all([openRoom(a, room.id), openRoom(b, room.id)]);

  await write(a, 'first draft');
  await expect(row(b, 'first draft')).toBeVisible();

  await action(a, 'first draft', 'Edit');
  await a.getByLabel('Edit message').fill('final wording');
  await a.getByRole('button', { name: 'Save' }).click();
  await expect(row(b, 'final wording').getByText('edited')).toBeVisible();

  await row(b, 'final wording').hover();
  await row(b, 'final wording').getByRole('button', { name: 'React', exact: true }).click();
  await b.getByRole('button', { name: 'React with 🎉' }).click();
  await expect(row(a, 'final wording').getByRole('button', { name: /🎉/ })).toBeVisible();

  await action(b, 'final wording', 'Reply');
  await write(b, 'agreed');
  await expect(row(a, 'agreed').getByRole('link', { name: /final wording/ })).toBeVisible();

  a.once('dialog', (d) => d.accept());
  const original = a.getByRole('article', { name: /^Ada/ }).filter({ hasText: 'final wording' });
  await original.hover();
  await original.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(b.getByText('Message deleted').first()).toBeVisible();
});

test('search finds a message and jumps to it', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  const marker = `zeppelin${Date.now()}`;
  await say(request, bo, room.id, `the ${marker} forecast`);
  for (let i = 0; i < 40; i += 1) await say(request, ada, room.id, `filler ${i}`);

  const a = await signIn(browser, baseURL!, ada);
  await a.keyboard.press('Control+k');
  await a.getByRole('textbox', { name: 'Search' }).fill(marker);
  await a.getByRole('dialog').getByRole('button', { name: new RegExp(marker) }).click();
  await expect(row(a, marker)).toBeInViewport();
});

test('a session survives repeated reloads', async ({ browser, baseURL, request }) => {
  const ada = await person(request, 'Ada');
  const a = await signIn(browser, baseURL!, ada);
  for (let i = 0; i < 3; i += 1) {
    await a.reload();
    await expect(a.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
  }
});

test('tabs opening together stay signed in, and stay so after the grace window', async ({ browser, baseURL, request }) => {
  const ada = await person(request, 'Ada');
  const first = await signIn(browser, baseURL!, ada);
  const context = first.context();
  const pages = [watch(await context.newPage()), watch(await context.newPage()), watch(await context.newPage())];

  await Promise.all(pages.map((p) => p.goto('/')));
  for (const page of pages) await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeVisible();

  await first.waitForTimeout(11_000);
  await pages[0]!.reload();
  await expect(pages[0]!.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
});

test('signing out a device from Settings ends it on the spot', async ({ browser, baseURL, request }) => {
  const ada = await person(request, 'Ada');
  const [laptop, phone] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, ada)];

  await laptop.goto('/settings');
  await laptop.getByRole('button', { name: 'Sign out', exact: true }).first().click();
  await expect(phone.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(laptop.getByText('This device', { exact: true })).toBeVisible();
});

test('uploads a file and shows it to the other person', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  const [a, b] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, bo)];
  await Promise.all([openRoom(a, room.id), openRoom(b, room.id)]);

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  await a.locator('input[type=file]').setInputFiles({ name: 'floorplan.png', mimeType: 'image/png', buffer: png });
  const image = b.getByRole('img', { name: 'floorplan.png' });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
});
