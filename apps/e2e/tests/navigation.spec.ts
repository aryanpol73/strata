import { branchFrom, composer, expect, group, openRoom, person, say, signIn, test } from './support';

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
  await a.goto('/settings');
  await a.getByRole('radio', { name: 'Day' }).click();
  await expect(a.locator('html')).toHaveAttribute('data-theme', 'day');
  await a.reload();
  await expect(a.locator('html')).toHaveAttribute('data-theme', 'day');
});
