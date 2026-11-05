import { composer, expect, group, openRoom, person, row, say, signIn, test, write } from './support';

test('a message written offline sends itself exactly once when the network returns', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  const [a, b] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, bo)];
  await Promise.all([openRoom(a, room.id), openRoom(b, room.id)]);

  await a.context().setOffline(true);
  await write(a, 'written on the train');
  await expect(a.getByText('Sending…')).toBeVisible();
  await expect(b.getByText('written on the train')).toHaveCount(0);

  await a.context().setOffline(false);
  await expect(row(b, 'written on the train')).toHaveCount(1, { timeout: 20_000 });
  await expect(a.getByText('Sending…')).toHaveCount(0);
  await expect(row(a, 'written on the train')).toHaveCount(1);
});

test('the outbox survives closing the app while offline', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  const a = await signIn(browser, baseURL!, ada);
  await openRoom(a, room.id);

  await a.context().setOffline(true);
  await write(a, 'kept through a restart');
  await expect(a.getByText('Sending…')).toBeVisible();
  await a.context().setOffline(false);
  await a.close();

  const reopened = await a.context().newPage();
  await openRoom(reopened, room.id);
  await expect(row(reopened, 'kept through a restart')).toHaveCount(1, { timeout: 15_000 });
  const page = await request.get(`/api/rooms/${room.id}/messages`, { headers: { Authorization: `Bearer ${bo.token}` } });
  const { messages } = await page.json();
  expect(messages.filter((m: { payload: { text?: string } }) => m.payload.text === 'kept through a restart')).toHaveLength(1);
});

test('messages missed while offline appear after reconnecting', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  const b = await signIn(browser, baseURL!, bo);
  await openRoom(b, room.id);
  const before = await say(request, ada, room.id, 'will be edited');
  await expect(row(b, 'will be edited')).toBeVisible();

  await b.context().setOffline(true);
  await expect(b.getByText("You're offline.")).toBeVisible({ timeout: 45_000 });
  await say(request, ada, room.id, 'sent while you were away');
  await request.patch(`/api/messages/${before.id}`, { headers: { Authorization: `Bearer ${ada.token}` }, data: { text: 'edited while away' } });

  await b.context().setOffline(false);
  await expect(row(b, 'sent while you were away')).toBeVisible({ timeout: 20_000 });
  await expect(row(b, 'edited while away')).toBeVisible();
  await expect(b.getByText("You're offline.")).toHaveCount(0);
});

test('the installed shell opens with no network, shows cached conversations, and recovers', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo], 'Cached Room');
  await say(request, bo, room.id, 'readable offline');

  const a = await signIn(browser, baseURL!, ada);
  await openRoom(a, room.id);
  await expect(row(a, 'readable offline')).toBeVisible();

  // Two loads: the first installs the worker, and the second runs under it so that it caches the assets.
  await a.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await a.reload();
  await expect(row(a, 'readable offline')).toBeVisible();
  await expect.poll(() => a.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await a.context().setOffline(true);
  await a.reload();
  await expect(a.getByRole('link', { name: /Cached Room/ })).toBeVisible();
  await expect(row(a, 'readable offline')).toBeVisible();

  await write(a, 'typed from a cold offline start');
  await expect(a.getByText('Sending…')).toBeVisible();

  await a.context().setOffline(false);
  await expect(row(a, 'typed from a cold offline start')).toBeVisible({ timeout: 20_000 });
  await expect(a.getByText('Sending…')).toHaveCount(0);
  await expect(composer(a)).toBeEnabled();
});

test('the manifest and icons a browser needs for install are all served', async ({ request }) => {
  for (const name of ['violet', 'emerald']) {
    const manifest = await (await request.get(`/manifest-${name}.webmanifest`)).json();
    expect(manifest.display).toBe('standalone');
    for (const icon of manifest.icons as { src: string; type: string }[]) {
      const res = await request.get(icon.src);
      expect(res.ok(), icon.src).toBeTruthy();
      expect(res.headers()['content-type']).toContain(icon.type);
    }
  }
});

test('signing out leaves no conversation data in the browser', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  await say(request, bo, room.id, 'private to Ada');
  const a = await signIn(browser, baseURL!, ada);
  await openRoom(a, room.id);
  await expect(row(a, 'private to Ada')).toBeVisible();

  await a.goto('/settings');
  await a.getByRole('button', { name: 'Sign out' }).last().click();
  await expect(a.getByRole('button', { name: 'Sign in' })).toBeVisible();

  const counts = await a.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const open = indexedDB.open('strata');
        open.onsuccess = () => {
          const tx = open.result.transaction(['rooms', 'messages', 'outbox']);
          const stores = ['rooms', 'messages', 'outbox'].map((n) => tx.objectStore(n).count());
          tx.oncomplete = () => resolve(stores.map((s) => s.result));
        };
      }),
  );
  expect(counts).toEqual([0, 0, 0]);
  expect(await a.evaluate(() => localStorage.getItem('strata:me'))).toBeNull();
});
