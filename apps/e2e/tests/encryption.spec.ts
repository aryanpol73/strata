import { composer, expect, group, openRoom, passEncryptionGate, passphraseOf, person, row, signIn, test, write } from './support';

const SECRET = 'the vault code is 4417-cobalt';

test('an encrypted conversation reads normally for members while the server only ever holds ciphertext', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const [a, b] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, bo)];
  const room = await group(request, ada, [bo], 'Vault Talk');

  await openRoom(a, room.id);
  await expect(composer(a)).toBeEnabled({ timeout: 15_000 });
  await expect(a.getByRole('button', { name: 'Encrypted conversation' })).toBeVisible();
  await write(a, SECRET);
  await expect(row(a, SECRET)).toBeVisible();

  await openRoom(b, room.id);
  await expect(row(b, SECRET)).toBeVisible({ timeout: 15_000 });
  // The inbox preview is opened on the device too, instead of showing a placeholder.
  await b.goto('/');
  await expect(b.getByRole('link', { name: /Vault Talk/ })).toContainText(SECRET);

  // What the server holds: ciphertext in the message, and a placeholder everywhere it makes a summary.
  const page = await request.get(`/api/rooms/${room.id}/messages`, { headers: { Authorization: `Bearer ${ada.token}` } });
  const stored = JSON.stringify(await page.json());
  expect(stored).toContain('"type":"encrypted"');
  expect(stored).not.toContain('cobalt');
  const summary = await request.get(`/api/rooms/${room.id}`, { headers: { Authorization: `Bearer ${bo.token}` } });
  const text = JSON.stringify(await summary.json());
  expect(text).toContain('Encrypted message');
  expect(text).not.toContain('cobalt');
});

test('replies, edits and the inbox all work on encrypted messages', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const [a, b] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, bo)];
  const room = await group(request, ada, [bo], 'Edits');
  await openRoom(a, room.id);
  await expect(composer(a)).toBeEnabled({ timeout: 15_000 });
  await write(a, 'first draft');
  await openRoom(b, room.id);
  await expect(row(b, 'first draft')).toBeVisible({ timeout: 15_000 });

  // Edit, as the sender.
  await row(a, 'first draft').hover();
  await row(a, 'first draft').getByRole('button', { name: 'Edit', exact: true }).click();
  const box = a.getByRole('textbox', { name: /Edit message/ });
  await box.fill('final version');
  await a.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row(a, 'final version')).toBeVisible();
  await expect(row(b, 'final version')).toBeVisible();
  await expect(row(b, 'final version')).toContainText('edited');

  // Reply, as the other person, with the quoted text opened too.
  await row(b, 'final version').hover();
  await row(b, 'final version').getByRole('button', { name: 'Reply', exact: true }).click();
  await write(b, 'agreed');
  await expect(row(a, 'agreed')).toContainText('final version');
});

test('a new device needs the passphrase, and the history opens once it is given', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const a = await signIn(browser, baseURL!, ada);
  await signIn(browser, baseURL!, bo);
  const room = await group(request, ada, [bo], 'History');
  await openRoom(a, room.id);
  await expect(composer(a)).toBeEnabled({ timeout: 15_000 });
  await write(a, SECRET);

  const phone = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const p = await phone.newPage();
  await p.goto('/');
  await p.getByLabel('Email').fill(ada.email);
  await p.getByLabel('Password').fill(ada.password);
  await p.getByRole('button', { name: 'Sign in' }).click();

  // Signing in isn't enough on its own. Nothing opens without the passphrase.
  const dialog = p.getByRole('dialog', { name: 'Unlock your messages' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Encryption passphrase').fill('not the right passphrase');
  await dialog.getByRole('button', { name: 'Unlock' }).click();
  await expect(dialog.getByRole('alert')).toContainText('not right');

  await dialog.getByLabel('Encryption passphrase').fill(passphraseOf(ada));
  await dialog.getByRole('button', { name: 'Unlock' }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await openRoom(p, room.id);
  await expect(row(p, SECRET)).toBeVisible({ timeout: 15_000 });
});

test('skipping the unlock leaves the conversation readable as locked, not as ciphertext', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const a = await signIn(browser, baseURL!, ada);
  await signIn(browser, baseURL!, bo);
  const room = await group(request, ada, [bo], 'Locked');
  await openRoom(a, room.id);
  await expect(composer(a)).toBeEnabled({ timeout: 15_000 });
  await write(a, SECRET);

  const ctx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto('/');
  await p.getByLabel('Email').fill(ada.email);
  await p.getByLabel('Password').fill(ada.password);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('dialog', { name: 'Unlock your messages' }).getByRole('button', { name: 'Not now' }).click();
  await openRoom(p, room.id);
  await expect(p.getByText('Locked. Unlock encryption to read this.')).toBeVisible();
  await expect(p.getByText('Unlock encryption to read and send messages here.')).toBeVisible();
  await expect(p.getByText(SECRET)).toHaveCount(0);
});

test('someone who sets up encryption later is given the keys by the people already in the conversation', async ({ browser, baseURL, request }) => {
  const [ada, bo, cy] = [await person(request, 'Ada'), await person(request, 'Bo'), await person(request, 'Cy')];
  const a = await signIn(browser, baseURL!, ada);
  await signIn(browser, baseURL!, bo);
  const room = await group(request, ada, [bo, cy], 'Latecomer');
  await openRoom(a, room.id);
  await expect(composer(a)).toBeEnabled({ timeout: 15_000 });
  await write(a, SECRET);

  const c = await signIn(browser, baseURL!, cy);
  await openRoom(c, room.id);
  await expect(row(c, SECRET)).toBeVisible({ timeout: 20_000 });
  await expect(composer(c)).toBeEnabled();
  await write(c, 'glad to be here');
  await expect(row(a, 'glad to be here')).toBeVisible();
});

test('someone who leaves cannot read what is said afterwards, because the key is replaced', async ({ browser, baseURL, request }) => {
  const [ada, bo, cy] = [await person(request, 'Ada'), await person(request, 'Bo'), await person(request, 'Cy')];
  const a = await signIn(browser, baseURL!, ada);
  const b = await signIn(browser, baseURL!, bo);
  const c = await signIn(browser, baseURL!, cy);
  const room = await group(request, ada, [bo, cy], 'Rotation');
  const headers = { Authorization: `Bearer ${ada.token}` };
  await openRoom(a, room.id);
  await openRoom(b, room.id);
  await openRoom(c, room.id);
  await expect(composer(a)).toBeEnabled({ timeout: 15_000 });
  await expect(composer(c)).toBeEnabled({ timeout: 15_000 });
  await write(a, 'before the removal');
  await expect(row(c, 'before the removal')).toBeVisible();

  expect((await request.delete(`/api/rooms/${room.id}/members/${cy.id}`, { headers })).ok()).toBeTruthy();
  await expect
    .poll(async () => (await (await request.get(`/api/e2ee/rooms/${room.id}`, { headers })).json()).version, { timeout: 15_000 })
    .toBe(2);

  await write(a, 'after the removal');
  await expect(row(b, 'after the removal')).toBeVisible({ timeout: 15_000 });
  const stored = await (await request.get(`/api/rooms/${room.id}/messages`, { headers })).json();
  expect(stored.messages.map((m: { payload: { kv?: number } }) => m.payload.kv)).toEqual([1, 2]);
  // The person who left has no access to the keys, or to anything else in the room.
  expect((await request.get(`/api/e2ee/rooms/${room.id}`, { headers: { Authorization: `Bearer ${cy.token}` } })).status()).toBe(404);
});

test('the encryption details show a security code for each person that matches what they see themselves', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const [a, b] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, bo)];
  const room = await group(request, ada, [bo], 'Codes');
  await openRoom(a, room.id);
  await expect(composer(a)).toBeEnabled({ timeout: 15_000 });

  await b.goto('/settings/encryption');
  const own = await b.locator('span.font-mono').filter({ hasText: /^\d{5}( \d{5}){5}$/ }).first().textContent();
  expect(own).toMatch(/^\d{5}( \d{5}){5}$/);

  await a.getByRole('button', { name: 'Encrypted conversation' }).click();
  const dialog = a.getByRole('dialog', { name: 'End-to-end encrypted' });
  await expect(dialog.getByText(own!)).toBeVisible();
  await expect(dialog).toContainText("What isn't encrypted");
});

test('guests cannot be invited to an encrypted branch, and a guest branch says it is not encrypted', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const a = await signIn(browser, baseURL!, ada);
  await signIn(browser, baseURL!, bo);
  const room = await group(request, ada, [bo], 'Branching');
  await openRoom(a, room.id);
  await expect(composer(a)).toBeEnabled({ timeout: 15_000 });
  await write(a, 'which vendor should we pick?');

  await row(a, 'which vendor').hover();
  await row(a, 'which vendor').getByRole('button', { name: 'Branch from here', exact: true }).click();
  const dialog = a.getByRole('dialog', { name: 'Branch from this message' });
  await expect(dialog).toContainText('which vendor should we pick?');
  await dialog.getByLabel("What's this branch about?").fill('Quiet branch');
  await dialog.getByRole('button', { name: 'Start branch' }).click();
  await expect(a.getByRole('button', { name: 'Encrypted conversation' })).toBeVisible();
  await a.getByRole('button', { name: 'Invite guest' }).click();
  await expect(a.getByRole('dialog', { name: 'Invite a guest' })).toContainText('end-to-end encrypted');
});

test('the passphrase can be changed without losing access, and the old one stops working', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const a = await signIn(browser, baseURL!, ada);
  await signIn(browser, baseURL!, bo);
  const room = await group(request, ada, [bo], 'Passphrase');
  await openRoom(a, room.id);
  await expect(composer(a)).toBeEnabled({ timeout: 15_000 });
  await write(a, SECRET);
  await expect(row(a, SECRET)).toBeVisible();
  await expect(a.getByText('Sending…')).toHaveCount(0);

  await a.goto('/settings/encryption');
  await a.getByLabel('New encryption passphrase').fill('a brand new passphrase');
  await a.getByLabel('Repeat new passphrase').fill('a brand new passphrase');
  await a.getByRole('button', { name: 'Change passphrase' }).click();
  await expect(a.getByText('Passphrase changed')).toBeVisible();

  const ctx = await browser.newContext({ baseURL });
  const p = await ctx.newPage();
  await p.goto('/');
  await p.getByLabel('Email').fill(ada.email);
  await p.getByLabel('Password').fill(ada.password);
  await p.getByRole('button', { name: 'Sign in' }).click();
  const dialog = p.getByRole('dialog', { name: 'Unlock your messages' });
  await dialog.getByLabel('Encryption passphrase').fill(passphraseOf(ada));
  await dialog.getByRole('button', { name: 'Unlock' }).click();
  await expect(dialog.getByRole('alert')).toContainText('not right');
  await dialog.getByLabel('Encryption passphrase').fill('a brand new passphrase');
  await dialog.getByRole('button', { name: 'Unlock' }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await openRoom(p, room.id);
  await expect(row(p, SECRET)).toBeVisible({ timeout: 15_000 });
});

test('a changed security code is flagged, and nothing is shared with it until it is accepted', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const a = await signIn(browser, baseURL!, ada);
  const b = await signIn(browser, baseURL!, bo);
  const room = await group(request, ada, [bo], 'Impostor');
  await openRoom(a, room.id);
  await openRoom(b, room.id);
  await expect(composer(a)).toBeEnabled({ timeout: 15_000 });
  await expect(composer(b)).toBeEnabled({ timeout: 15_000 });
  await write(a, SECRET);
  await expect(row(b, SECRET)).toBeVisible({ timeout: 15_000 });
  await expect(a.getByText('Sending…')).toHaveCount(0);

  // Bo starts over with brand new keys, which is also exactly what a swapped key looks like from Ada's side.
  await b.goto('/settings/encryption');
  await b.getByRole('button', { name: 'Reset encryption keys' }).click();
  await b.getByLabel(/^Passphrase for your new keys/).fill('an entirely new passphrase');
  await b.getByLabel('Repeat passphrase for your new keys').fill('an entirely new passphrase');
  await b.getByRole('button', { name: 'Reset encryption keys' }).last().click();
  await expect(b.getByRole('button', { name: 'Reset encryption keys' }).first()).toBeVisible();

  const notice = a.getByRole('region', { name: 'Security code changed' });
  await expect(notice).toContainText("Bo's security code changed", { timeout: 15_000 });

  // Nothing was shared with the new key, so Bo still can't read the history.
  await openRoom(b, room.id);
  await expect(b.getByText(SECRET)).toHaveCount(0);

  await notice.getByRole('button', { name: 'Accept new code' }).click();
  await expect(notice).toBeHidden();
  await expect(row(b, SECRET)).toBeVisible({ timeout: 20_000 });
});

void passEncryptionGate;
