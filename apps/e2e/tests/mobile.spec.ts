import { composer, expect, group, person, row, say, test, watch, write, type Person } from './support';
import type { Page } from '@playwright/test';

async function signInOnPhone(page: Page, who: Person) {
  watch(page);
  await page.goto('/');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
}

const noSideScroll = async (page: Page) => {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
};

test('the list and the conversation are separate screens', async ({ page, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo], 'Phone Room');
  await say(request, bo, room.id, 'hello phone');
  await signInOnPhone(page, ada);

  await noSideScroll(page);
  await page.getByRole('link', { name: /Phone Room/ }).tap();
  await expect(row(page, 'hello phone')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeHidden();
  await noSideScroll(page);

  await page.getByRole('button', { name: 'Back to conversations' }).tap();
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
});

test('message actions use a sheet, since a phone has no hover', async ({ page, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  await say(request, bo, room.id, 'tap my menu');
  await signInOnPhone(page, ada);
  await page.goto(`/r/${room.id}`);

  await row(page, 'tap my menu').getByRole('button', { name: 'Message actions' }).tap();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('button', { name: 'Branch from here' })).toBeVisible();
  const box = (await sheet.boundingBox())!;
  expect(box.y + box.height).toBeGreaterThan(page.viewportSize()!.height - 4);

  await sheet.getByRole('button', { name: 'React with ✅' }).tap();
  await expect(row(page, 'tap my menu').getByRole('button', { name: /✅/ })).toBeVisible();
});

test('the Canvas is its own view, reached from the message and back to it', async ({ page, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  await say(request, bo, room.id, 'file this one');
  await signInOnPhone(page, ada);
  await page.goto(`/r/${room.id}`);

  await row(page, 'file this one').getByRole('button', { name: 'Message actions' }).tap();
  await page.getByRole('dialog').getByRole('button', { name: 'Add to Canvas' }).tap();

  const note = page.getByRole('textbox', { name: 'Canvas text' });
  await expect(note).toHaveValue('file this one');
  await expect(page.getByRole('tab', { name: 'canvas' })).toHaveAttribute('aria-selected', 'true');
  await expect(composer(page)).toBeHidden();
  await noSideScroll(page);

  await page.getByRole('button', { name: /Bo/ }).first().tap();
  await expect(row(page, 'file this one')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'stream' })).toHaveAttribute('aria-selected', 'true');
});

test('branching works from the sheet, and the back button returns to the parent', async ({ page, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  await say(request, bo, room.id, 'branch me');
  await signInOnPhone(page, ada);
  await page.goto(`/r/${room.id}`);

  await row(page, 'branch me').getByRole('button', { name: 'Message actions' }).tap();
  await page.getByRole('dialog').getByRole('button', { name: 'Branch from here' }).tap();
  await page.getByRole('dialog').getByLabel("What's this branch about?").fill('Phone branch');
  await page.getByRole('dialog').getByRole('button', { name: 'Start branch' }).tap();
  await expect(page.getByText('Branched from')).toBeVisible();
  await noSideScroll(page);

  await page.getByRole('button', { name: 'Back to conversations' }).tap();
  await expect(row(page, 'branch me').getByRole('button', { name: /Phone branch/ })).toBeVisible();
});

test('long unbroken text stays inside the screen', async ({ page, request }) => {
  const ada = await person(request, 'Ada');
  const room = await group(request, ada, []);
  await say(request, ada, room.id, `https://example.test/${'a'.repeat(300)}`);
  await say(request, ada, room.id, 'x'.repeat(400));
  await signInOnPhone(page, ada);
  await page.goto(`/r/${room.id}`);
  await expect(page.getByRole('article').first()).toBeVisible();
  await noSideScroll(page);
  const overflow = await page.getByRole('log').evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('sending from the phone works', async ({ page, request }) => {
  const ada = await person(request, 'Ada');
  const room = await group(request, ada, []);
  await signInOnPhone(page, ada);
  await page.goto(`/r/${room.id}`);
  await write(page, 'sent from a phone');
  await expect(row(page, 'sent from a phone')).toBeVisible();
});

