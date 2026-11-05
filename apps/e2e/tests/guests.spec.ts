import { addChecklist, branchFrom, expect, group, openRoom, person, row, say, signIn, test, watch, write, type Person } from './support';
import type { Browser, Page } from '@playwright/test';

const SECRET = 'PARENT-ONLY acquisition target';

async function setup(browser: Browser, baseURL: string, ada: Person, roomId: string) {
  const a = await signIn(browser, baseURL, ada);
  await openRoom(a, roomId);
  await branchFrom(a, SECRET, 'Vendor call', []);
  return a;
}

async function makeLink(a: Page, options: { pin?: string; blocks?: boolean; write?: boolean } = {}) {
  await a.getByRole('button', { name: 'Invite guest' }).click();
  const dialog = a.getByRole('dialog');
  await dialog.getByLabel('Who is this for?').fill('Vendor');
  if (options.pin) await dialog.getByLabel('PIN (optional)').fill(options.pin);
  if (options.blocks) await dialog.getByRole('checkbox', { name: 'Use shared blocks' }).check();
  if (options.write === false) await dialog.getByRole('checkbox', { name: 'Send messages' }).uncheck();
  await dialog.getByRole('button', { name: 'Create link' }).click();
  const url = await dialog.getByLabel('Guest link').inputValue();
  return url;
}

async function joinAsGuest(browser: Browser, url: string, pin?: string) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const g = watch(await context.newPage());
  await g.goto(url);
  await g.getByLabel('Your name').fill('Vic Vendor');
  if (pin) {
    await g.getByRole('button', { name: 'Join discussion' }).click();
    await g.getByLabel('PIN').fill(pin);
  }
  await g.getByRole('button', { name: 'Join discussion' }).click();
  await expect(g.getByRole('log', { name: 'Messages' })).toBeVisible();
  return g;
}

test('a guest joins with a PIN, talks, and sees only the branch', async ({ browser, baseURL, request }) => {
  const ada = await person(request, 'Ada');
  const room = await group(request, ada, []);
  await say(request, ada, room.id, SECRET);
  const a = await setup(browser, baseURL!, ada, room.id);
  await write(a, 'Welcome to the call');
  const url = await makeLink(a, { pin: '4417' });

  const g = await joinAsGuest(browser, url, '4417');

  expect(g.url()).not.toContain('#t=');
  await expect(g.getByText('Welcome to the call')).toBeVisible();
  await expect(g.getByText(SECRET)).toHaveCount(0);
  await expect(g.locator('body')).not.toContainText(room.name);
  expect(await g.evaluate(() => document.cookie)).toBe('');

  await g.getByRole('textbox', { name: 'Message' }).fill('Hello from outside');
  await g.getByRole('textbox', { name: 'Message' }).press('Enter');
  await expect(row(a, 'Hello from outside').getByText('Guest')).toBeVisible();

  await write(a, 'Reply to the guest');
  await expect(g.getByText('Reply to the guest')).toBeVisible();
});

test('a wrong PIN is refused, and the link can be used after getting it right', async ({ browser, baseURL, request }) => {
  const ada = await person(request, 'Ada');
  const room = await group(request, ada, []);
  await say(request, ada, room.id, SECRET);
  const a = await setup(browser, baseURL!, ada, room.id);
  const url = await makeLink(a, { pin: '4417' });

  const context = await browser.newContext();
  const g = watch(await context.newPage());
  await g.goto(url);
  await g.getByLabel('Your name').fill('Vic');
  await g.getByRole('button', { name: 'Join discussion' }).click();
  await g.getByLabel('PIN').fill('0000');
  await g.getByRole('button', { name: 'Join discussion' }).click();
  await expect(g.getByText('That PIN is not right')).toBeVisible();
  await g.getByLabel('PIN').fill('4417');
  await g.getByRole('button', { name: 'Join discussion' }).click();
  await expect(g.getByRole('log', { name: 'Messages' })).toBeVisible();
});

test('a guest reload keeps the session, and revoking ends it on the spot', async ({ browser, baseURL, request }) => {
  const ada = await person(request, 'Ada');
  const room = await group(request, ada, []);
  await say(request, ada, room.id, SECRET);
  const a = await setup(browser, baseURL!, ada, room.id);
  const url = await makeLink(a);
  const g = await joinAsGuest(browser, url);

  await g.reload();
  await expect(g.getByRole('log', { name: 'Messages' })).toBeVisible();

  await a.getByRole('button', { name: 'Revoke' }).click();
  await expect(g.getByText('Access ended')).toBeVisible();

  await g.reload();
  await expect(g.getByText('This link is not valid.')).toBeVisible();

  const stranger = watch(await (await browser.newContext()).newPage());
  await stranger.goto(url);
  await stranger.getByLabel('Your name').fill('Second try');
  await stranger.getByRole('button', { name: 'Join discussion' }).click();
  await expect(stranger.getByText('This link is not valid.')).toBeVisible();
});

test('a read-only guest can read but has no way to reply', async ({ browser, baseURL, request }) => {
  const ada = await person(request, 'Ada');
  const room = await group(request, ada, []);
  await say(request, ada, room.id, SECRET);
  const a = await setup(browser, baseURL!, ada, room.id);
  const url = await makeLink(a, { write: false });
  const g = await joinAsGuest(browser, url);
  await expect(g.getByText('You can read this discussion but not reply.')).toBeVisible();
  await expect(g.getByRole('textbox', { name: 'Message' })).toHaveCount(0);
});

test('a guest with block access edits a live block alongside a member', async ({ browser, baseURL, request }) => {
  const ada = await person(request, 'Ada');
  const room = await group(request, ada, []);
  await say(request, ada, room.id, SECRET);
  const a = await setup(browser, baseURL!, ada, room.id);
  await addChecklist(a, 'Vendor tasks', ['Confirm date']);
  const url = await makeLink(a, { blocks: true });
  await a.keyboard.press('Escape');

  const g = await joinAsGuest(browser, url);
  await g.getByRole('checkbox', { name: /Confirm date/ }).click();
  await expect(a.getByRole('checkbox', { name: /Confirm date/ })).toHaveAttribute('aria-checked', 'true');
  await expect(a.getByRole('region', { name: /Vendor tasks/ }).getByText('Vic Vendor')).toBeVisible();
});

test('a guest without block access never sees a block', async ({ browser, baseURL, request }) => {
  const ada = await person(request, 'Ada');
  const room = await group(request, ada, []);
  await say(request, ada, room.id, SECRET);
  const a = await setup(browser, baseURL!, ada, room.id);
  await addChecklist(a, 'Internal only', ['Margin target']);
  const url = await makeLink(a);

  const g = await joinAsGuest(browser, url);
  await expect(g.getByText('A shared block was added.')).toBeVisible();
  await expect(g.getByText('Internal only')).toHaveCount(0);
  await expect(g.getByText('Margin target')).toHaveCount(0);
});

test('a guest cannot use the member app', async ({ browser, baseURL, request }) => {
  const ada = await person(request, 'Ada');
  const room = await group(request, ada, []);
  await say(request, ada, room.id, SECRET);
  const a = await setup(browser, baseURL!, ada, room.id);
  const url = await makeLink(a);
  const g = await joinAsGuest(browser, url);

  await g.goto(`/r/${room.id}`);
  await expect(g.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(g.locator('body')).not.toContainText(SECRET);
});
