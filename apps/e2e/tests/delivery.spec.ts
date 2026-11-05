import { action, composer, expect, group, openRoom, person, row, say, signIn, test, write } from './support';
import type { Page } from '@playwright/test';

async function pick(page: Page, label: string) {
  await page.getByRole('button', { name: /^Delivery:/ }).click();
  await page.getByRole('menuitemradio', { name: new RegExp(label) }).click();
}

test('a whisper appears in the conversation without any interruption', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo], 'Quiet Room');
  const [a, b] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, bo)];
  await openRoom(a, room.id);

  await pick(a, 'Whisper');
  await write(a, 'no rush on this');

  const link = b.getByRole('link', { name: /Quiet Room/ });
  await expect(link.getByLabel('1 quiet messages')).toBeVisible();
  await expect(link.getByLabel(/unread/)).toHaveCount(0);
  await expect(b.getByRole('link', { name: 'Attention', exact: true }).first()).toBeVisible();

  await link.click();
  await expect(row(b, 'no rush on this').getByText('Whisper')).toBeVisible();

  // Postures are per message, so the composer goes back to normal.
  await expect(a.getByRole('button', { name: 'Delivery: Standard. Change' })).toBeVisible();
});

test('a standard message rings the bell, live', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  const b = await signIn(browser, baseURL!, bo);
  await say(request, ada, room.id, 'Are you free?');
  await expect(b.getByRole('link', { name: /Attention, 1 new/ }).first()).toBeVisible();
});

test('a digest stays out of the bell, and the sender can see when it will land', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  const [a, b] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, bo)];
  await openRoom(a, room.id);

  await pick(a, 'Digest');
  await write(a, 'weekly numbers');
  await expect(row(a, 'weekly numbers').getByText('Digest')).toBeVisible();
  await b.waitForTimeout(2500);
  await expect(b.getByRole('link', { name: 'Attention', exact: true }).first()).toBeVisible();

  await action(a, 'weekly numbers', 'Delivery status');
  await expect(a.getByRole('dialog').getByText(/In their digest/)).toBeVisible();
});

test('a blocking request tracks every acknowledgement', async ({ browser, baseURL, request }) => {
  const [ada, bo, cy] = [await person(request, 'Ada'), await person(request, 'Bo'), await person(request, 'Cy')];
  const room = await group(request, ada, [bo, cy]);
  const [a, b] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, bo)];
  await Promise.all([openRoom(a, room.id), openRoom(b, room.id)]);

  await pick(a, 'Needs acknowledgement');
  await a.getByRole('button', { name: '4 hours' }).click();
  await a.getByRole('button', { name: 'Use this deadline' }).click();
  await expect(a.getByText(/Everyone must acknowledge by/)).toBeVisible();
  await write(a, 'Read the safety briefing');

  await expect(row(a, 'Read the safety briefing').getByText(/0 of 2 acknowledged/)).toBeVisible();
  // The sender isn't asked to acknowledge their own request.
  await expect(row(a, 'Read the safety briefing').getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);

  await row(b, 'Read the safety briefing').getByRole('button', { name: 'Acknowledge' }).click();
  await expect(row(a, 'Read the safety briefing').getByText(/1 of 2 acknowledged/)).toBeVisible();
  await expect(row(b, 'Read the safety briefing').getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);

  await action(a, 'Read the safety briefing', 'Delivery status');
  const dialog = a.getByRole('dialog');
  await expect(dialog.getByText('Acknowledged', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Waiting', { exact: true })).toBeVisible();
});

test('quiet hours and rules saved in Settings change what happens next', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo], 'Rules Room');
  const b = await signIn(browser, baseURL!, bo);

  await b.goto('/settings/notifications');
  await b.getByLabel('Rule conversation').selectOption({ label: 'Rules Room' });
  await b.getByLabel('Rule action').selectOption({ label: 'Never notify me' });
  await b.getByRole('button', { name: 'Add rule' }).click();
  await b.getByRole('button', { name: 'Save preferences' }).click();
  await expect(b.getByText('Saved')).toBeVisible();

  await say(request, ada, room.id, 'muted by rule');
  await b.goto('/');
  await b.waitForTimeout(2500);
  await expect(b.getByRole('link', { name: 'Attention', exact: true }).first()).toBeVisible();

  await b.getByRole('link', { name: /Rules Room/ }).click();
  await expect(row(b, 'muted by rule')).toBeVisible();
});

test('the deadline presets are offered and the composer can be cancelled back to standard', async ({ browser, baseURL, request }) => {
  const ada = await person(request, 'Ada');
  const room = await group(request, ada, []);
  const a = await signIn(browser, baseURL!, ada);
  await openRoom(a, room.id);

  await pick(a, 'Needs acknowledgement');
  await expect(a.getByRole('button', { name: 'Tomorrow 9am' })).toBeVisible();
  await a.getByRole('menuitemradio', { name: /Standard/ }).click();
  await expect(a.getByRole('button', { name: 'Delivery: Standard. Change' })).toBeVisible();
  await expect(composer(a)).toBeEnabled();
});
