import { expect, group, openRoom, person, say, signIn, test } from './support';

test('the prompt to turn on notifications is offered, and stays dismissed once refused', async ({ browser, baseURL, request }) => {
  const ada = await person(request, 'Ada');
  const a = await signIn(browser, baseURL!, ada);
  // A fresh browser hasn't been asked yet, which is the state that shows the prompt.
  await a.addInitScript(() => Object.defineProperty(Notification, 'permission', { get: () => 'default' }));
  await a.reload();

  const prompt = a.getByRole('region', { name: 'Turn on notifications' });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Not now' }).click();
  await expect(prompt).toBeHidden();
  await a.reload();
  await expect(a.getByRole('navigation', { name: 'Conversations' })).toBeVisible();
  await expect(prompt).toBeHidden();
});

test('a conversation set to Digest only holds its messages, and they can be delivered early', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo], 'Busy Channel');
  const b = await signIn(browser, baseURL!, bo);
  await openRoom(b, room.id);

  await b.getByRole('button', { name: 'Conversation details' }).click();
  await b.getByRole('radio', { name: 'Digest only' }).click();
  await expect(b.getByText('Messages wait for your next digest')).toBeVisible();
  const headers = { Authorization: `Bearer ${bo.token}` };
  await expect.poll(async () => (await (await request.get('/api/notifications/preferences', { headers })).json()).preferences.rules).toMatchObject([{ roomId: room.id, action: 'digest' }]);
  await b.keyboard.press('Escape');
  // Messages read while the room is open are dropped from a digest, so be somewhere else when they arrive.
  await b.goto('/');

  // An ordinary message from someone else is held, and the Attention screen says exactly what is waiting.
  await say(request, ada, room.id, 'first thing');
  await say(request, ada, room.id, 'second thing');
  await b.goto('/attention');
  const held = b.getByRole('region', { name: 'Held for your digest' });
  await expect(held).toContainText('2 messages held for your digest');
  await expect(held).toContainText('Busy Channel');

  await held.getByRole('button', { name: 'Send now' }).click();
  await expect(held).toContainText('Nothing is waiting', { timeout: 15_000 });
  await expect(b.getByText('2 updates while you were away').first()).toBeVisible({ timeout: 15_000 });
});

test('a message that arrives while you are in another conversation raises an alert', async ({ browser, baseURL, request }) => {
  const [ada, bo, cy] = [await person(request, 'Ada'), await person(request, 'Bo'), await person(request, 'Cy')];
  const quiet = await group(request, ada, [bo], 'Elsewhere');
  const lively = await group(request, cy, [bo], 'Lively');
  const b = await signIn(browser, baseURL!, bo);
  await openRoom(b, quiet.id);
  await expect(b.getByRole('log', { name: 'Messages' })).toBeVisible();

  await say(request, cy, lively.id, 'did you see the update?');
  await expect(b.getByText('Cy in Lively: did you see the update?')).toBeVisible({ timeout: 15_000 });
  await expect(b).toHaveTitle(/^\(1\) Strata/);
});
