import { branchFrom, composer, expect, group, openRoom, person, row, say, signIn, test } from './support';

test('a blocking request waits under Needs You until it is acknowledged', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo], 'Approvals');
  await say(request, ada, room.id, 'Sign off the budget', { posture: 'blocking_ack', ackDeadline: new Date(Date.now() + 3_600_000).toISOString() });

  const b = await signIn(browser, baseURL!, bo);
  await b.goto('/attention');
  const needs = b.getByRole('region', { name: 'Needs you' });
  await expect(needs.getByText('Sign off the budget')).toBeVisible();

  await needs.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(needs).toBeHidden();

  // It stays settled across a reload, so this came from the server and not just the local list.
  await b.reload();
  await expect(b.getByRole('heading', { name: 'Attention' }).first()).toBeAttached();
  await expect(b.getByRole('region', { name: 'Needs you' })).toBeHidden();
});

test('the Branches screen lists branches by state and opens them', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  await say(request, bo, room.id, 'Which venue?');

  const a = await signIn(browser, baseURL!, ada);
  await openRoom(a, room.id);
  await branchFrom(a, 'Which venue?', 'Venue shortlist', ['Bo']);

  await a.goto('/branches');
  await a.getByRole('link', { name: /Venue shortlist/ }).first().click();
  await expect(a).toHaveURL(/\/r\//);
});

test('a press answers from where it landed, then cleans up after itself', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  const a = await signIn(browser, baseURL!, ada);
  await openRoom(a, room.id);

  const details = a.getByRole('button', { name: 'Conversation details' });
  const box = (await details.boundingBox())!;
  await a.mouse.move(box.x + 6, box.y + 6);
  await a.mouse.down();
  const ripple = details.locator('.st-ripple');
  await expect(ripple).toHaveCount(1);
  expect(parseFloat(await ripple.evaluate((el) => el.style.left))).toBeLessThan(box.width / 2);
  await a.mouse.up();
  await expect(ripple).toHaveCount(0);
  await a.keyboard.press('Escape');

  // Send is quiet until there's something to send.
  const send = a.getByRole('button', { name: 'Send' });
  await expect(send).toBeDisabled();
  await composer(a).fill('ready');
  await expect(send).toBeEnabled();
  await expect(send).toHaveClass(/st-primary/);
});

test('with reduced motion, buttons stay still and leave nothing behind', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  const a = await signIn(browser, baseURL!, ada, { reducedMotion: 'reduce' });
  await openRoom(a, room.id);

  const details = a.getByRole('button', { name: 'Conversation details' });
  await details.hover();
  expect(await details.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
  await details.click();
  await expect(details.locator('.st-ripple')).toHaveCount(0);
});

test('the chosen theme survives a reload', async ({ browser, baseURL, request }) => {
  const a = await signIn(browser, baseURL!, await person(request, 'Ada'));
  await a.goto('/settings/appearance');
  await a.getByRole('radio', { name: 'Light' }).click();
  await a.getByRole('radiogroup', { name: 'Colour theme' }).getByRole('radio', { name: 'Emerald' }).click();
  await expect(a.locator('html')).toHaveAttribute('data-theme', 'day');
  await expect(a.locator('html')).toHaveAttribute('data-accent', 'emerald');
  await a.reload();
  await expect(a.locator('html')).toHaveAttribute('data-accent', 'emerald');
});

test('a chosen look follows the person to a new device', async ({ browser, baseURL, request }) => {
  const ada = await person(request, 'Ada');
  const laptop = await signIn(browser, baseURL!, ada);
  await laptop.goto('/settings/appearance');
  await laptop.getByRole('radiogroup', { name: 'Colour theme' }).getByRole('radio', { name: 'Emerald' }).click();
  await laptop.getByRole('radiogroup', { name: 'App icon' }).getByRole('radio', { name: 'Emerald' }).click();
  await expect(laptop.getByRole('radiogroup', { name: 'App icon' }).getByRole('radio', { name: 'Emerald' })).toBeChecked();
  await expect(laptop.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest-emerald.webmanifest');
  await expect.poll(() => laptop.evaluate(() => fetch('/manifest-emerald.webmanifest').then((r) => r.ok))).toBe(true);
  await laptop.waitForTimeout(400);

  const phone = await signIn(browser, baseURL!, ada);
  await expect(phone.locator('html')).toHaveAttribute('data-accent', 'emerald');
  await expect(phone.locator('link[rel="icon"]')).toHaveAttribute('href', '/icons/emerald-64.png');
});

test('a profile photo reaches people in the conversation, and private keeps it from everyone else', async ({ browser, baseURL, request }) => {
  const [ada, bo, cy] = [await person(request, 'Ada'), await person(request, 'Bo'), await person(request, 'Cy')];
  const room = await group(request, ada, [bo]);
  await say(request, ada, room.id, 'hello with a face');

  const a = await signIn(browser, baseURL!, ada);
  await a.goto('/settings/profile');
  const picture = await a.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 300;
    const g = c.getContext('2d')!;
    g.fillStyle = '#c33';
    g.fillRect(0, 0, 400, 300);
    return c.toDataURL('image/png').split(',')[1]!;
  });
  await a.getByLabel('Choose a profile photo').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: Buffer.from(picture, 'base64') });
  await a.getByRole('button', { name: 'Save photo' }).click();
  await expect(a.getByRole('dialog')).toBeHidden();
  await expect(a.getByRole('button', { name: 'Change photo' })).toBeVisible();

  const b = await signIn(browser, baseURL!, bo);
  await openRoom(b, room.id);
  const photo = row(b, 'hello with a face').locator('img');
  await expect(photo).toBeVisible();
  const oldUrl = await photo.getAttribute('src');
  expect((await request.get(oldUrl!)).ok()).toBe(true);

  const found = async () => (await (await request.get(`/api/users/search?q=${ada.handle}`, { headers: { Authorization: `Bearer ${cy.token}` } })).json()).users[0].avatarUrl;
  expect(await found()).toBeTruthy();

  await a.goto('/settings/privacy');
  await a.getByRole('radio', { name: /Private/ }).click();
  await expect(a.getByRole('radio', { name: /Private/ })).toBeChecked();

  expect(await found()).toBeNull();
  expect((await request.get(oldUrl!)).status()).toBe(404);

  await b.reload();
  await expect(row(b, 'hello with a face').locator('img')).toBeVisible();
});

test('only real images are accepted as a profile photo', async ({ request }) => {
  const ada = await person(request, 'Ada');
  const res = await request.post('/api/users/me/avatar', {
    headers: { Authorization: `Bearer ${ada.token}`, 'content-type': 'image/png' },
    data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  });
  expect(res.status()).toBe(400);
});

test('changing a password keeps this device and signs out the others', async ({ browser, baseURL, request }) => {
  const ada = await person(request, 'Ada');
  const [laptop, phone] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, ada)];
  await laptop.goto('/settings/security');
  await laptop.getByLabel('Current password').fill(ada.password);
  await laptop.getByLabel(/^New password/).fill('a-brand-new-password');
  await laptop.getByLabel('Repeat new password').fill('a-brand-new-password');
  await laptop.getByRole('button', { name: 'Change password' }).click();
  await expect(phone.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(laptop.getByText('This device', { exact: true })).toBeVisible();
});

test('appearing offline hides presence from others', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  const a = await signIn(browser, baseURL!, ada);
  await a.goto('/settings/privacy');
  await a.getByRole('switch', { name: "Show when I'm online" }).click();
  await expect(a.getByRole('switch', { name: "Show when I'm online" })).toHaveAttribute('aria-checked', 'false');

  const b = await signIn(browser, baseURL!, bo);
  await openRoom(b, room.id);
  await expect(b.getByText('2 people · 1 online')).toBeVisible();
});
