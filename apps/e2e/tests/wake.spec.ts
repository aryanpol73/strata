import { composer, expect, group, openRoom, person, row, say, signIn, test, write } from './support';

test('the app opens from this device while a sleeping server wakes, then catches up', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo], 'Cold Start');
  await say(request, bo, room.id, 'saved before the server slept');
  const a = await signIn(browser, baseURL!, ada);
  await openRoom(a, room.id);
  await expect(row(a, 'saved before')).toBeVisible();

  // Once the page's own copy is saved, a visit shouldn't depend on the server being awake.
  await a.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await a.reload();
  await expect(row(a, 'saved before')).toBeVisible();

  // A sleeping server accepts the connection and then says nothing for a long while.
  let wake!: () => void;
  const asleep = new Promise<void>((resolve) => (wake = resolve));
  await a.route('**/api/**', async (route) => {
    await asleep;
    await route.continue().catch(() => {});
  });

  const started = Date.now();
  await a.goto('/');
  await expect(a.getByRole('link', { name: /Cold Start/ })).toBeVisible({ timeout: 10_000 });
  expect(Date.now() - started).toBeLessThan(10_000);
  await expect(a.getByRole('status').filter({ hasText: 'Waking the server' })).toBeVisible();
  // Nothing asks for the passphrase again, and nothing says the person is signed out.
  await expect(a.getByRole('dialog')).toHaveCount(0);
  await expect(a.getByRole('button', { name: 'Sign in' })).toHaveCount(0);

  wake();
  await expect(a.getByRole('status').filter({ hasText: 'Waking the server' })).toBeHidden({ timeout: 20_000 });
  await a.getByRole('link', { name: /Cold Start/ }).click();
  await expect(composer(a)).toBeEnabled({ timeout: 15_000 });
  await write(a, 'back online');
  await expect(row(a, 'back online')).toBeVisible();
});
