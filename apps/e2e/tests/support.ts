import { randomUUID } from 'node:crypto';
import { expect, test as base, type APIRequestContext, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';

export { expect };

export interface Person {
  id: string;
  name: string;
  handle: string;
  email: string;
  password: string;
  token: string;
}

const run = Date.now().toString(36).slice(-6);
let counter = 0;

/** Anything here means the page broke in a way no assertion would notice, so every test fails on it. */
const problems: string[] = [];

export function watch(page: Page) {
  page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
  page.on('console', (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to (load|connect|execute|apply)/i.test(text)) problems.push(`csp: ${text}`);
  });
  return page;
}

export const test = base.extend<{ guard: void }>({
  guard: [
    async ({}, use) => {
      problems.length = 0;
      await use();
      expect(problems, 'page errors or CSP violations').toEqual([]);
    },
    { auto: true },
  ],
});

export async function person(request: APIRequestContext, name: string): Promise<Person> {
  counter += 1;
  const handle = `${name.toLowerCase()}_${run}_${counter}`;
  const email = `${handle}@e2e.test`;
  const password = randomUUID();
  const res = await request.post('/api/auth/register', { data: { email, password, displayName: name, handle } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = await res.json();
  return { id: body.user.id, token: body.accessToken, name, handle, email, password };
}

const auth = (p: Person) => ({ Authorization: `Bearer ${p.token}` });

export async function group(request: APIRequestContext, owner: Person, members: Person[], name = 'Launch Crew') {
  const res = await request.post('/api/rooms/group', { headers: auth(owner), data: { name, memberIds: members.map((m) => m.id) } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).room as { id: string; name: string };
}

export async function say(request: APIRequestContext, who: Person, roomId: string, text: string, extra: object = {}) {
  const res = await request.post(`/api/rooms/${roomId}/messages`, {
    headers: auth(who),
    data: { clientMessageId: randomUUID(), content: { type: 'text', text }, ...extra },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).message as { id: string; seq: number };
}

/** Each person gets their own browser context, so they share nothing, exactly like two separate machines. */
/** Everyone sets up encryption once, and unlocks it on each new device, with the same passphrase. */
export const passphraseOf = (who: Person) => `passphrase for ${who.handle}`;

export async function passEncryptionGate(page: Page, who: Person) {
  const dialog = page.getByRole('dialog', { name: /Protect your conversations|Unlock your messages/ });
  // The app only renders once encryption's state is known, so if the screen is going to appear it's there by now.
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeVisible({ timeout: 15_000 });
  if (!(await dialog.isVisible())) return;
  await dialog.getByLabel('Encryption passphrase').fill(passphraseOf(who));
  const repeat = dialog.getByLabel('Repeat passphrase');
  if (await repeat.count()) await repeat.fill(passphraseOf(who));
  await dialog.getByRole('button', { name: /Set up encryption|Unlock/ }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

export async function signIn(browser: Browser, baseURL: string, who: Person, options: BrowserContextOptions = {}) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 }, ...options });
  const page = watch(await context.newPage());
  await page.goto('/');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await passEncryptionGate(page, who);
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
  return page;
}

export const openRoom = async (page: Page, roomId: string) => {
  await page.goto(`/r/${roomId}`);
  await expect(page.getByRole('log', { name: 'Messages' })).toBeVisible();
};

export const composer = (page: Page) => page.getByRole('textbox', { name: 'Message' });

export async function write(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

export const row = (page: Page, text: string) => page.getByRole('article').filter({ hasText: text });

/** Desktop message actions appear on hover. */
export async function action(page: Page, text: string, name: string) {
  await row(page, text).hover();
  await row(page, text).getByRole('button', { name, exact: true }).click();
}

export async function branchFrom(page: Page, text: string, title: string, participants: string[], priv = false) {
  await action(page, text, 'Branch from here');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel("What's this branch about?").fill(title);
  for (const name of participants) await dialog.getByRole('checkbox', { name }).check();
  if (priv) await dialog.getByRole('checkbox', { name: /Private branch/ }).check();
  await dialog.getByRole('button', { name: 'Start branch' }).click();
  await expect(page.getByRole('button', { name: 'Resolve' })).toBeVisible();
}

export async function resolveAndMerge(page: Page, summary: string, shareTranscript = false) {
  await page.getByRole('button', { name: 'Resolve' }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(summary);
  await page.getByRole('button', { name: 'Mark resolved' }).click();
  await page.getByRole('button', { name: 'Merge resolution' }).click();
  const dialog = page.getByRole('dialog');
  if (shareTranscript) await dialog.getByRole('checkbox', { name: /transcript/ }).check();
  await dialog.getByRole('button', { name: /^Post to/ }).click();
  await expect(page.getByText('This branch was merged.')).toBeVisible();
}

export async function addChecklist(page: Page, title: string, items: string[]) {
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Checklist' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Items').fill(items.join('\n'));
  await dialog.getByRole('button', { name: 'Add to conversation' }).click();
  await expect(page.getByRole('region', { name: new RegExp(title) })).toBeVisible();
}
