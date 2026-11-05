import { branchFrom, expect, group, openRoom, person, resolveAndMerge, row, say, signIn, test, write } from './support';

test('the whole branch journey, seen from inside and outside', async ({ browser, baseURL, request }) => {
  const [ada, cy, bo] = [await person(request, 'Ada'), await person(request, 'Cy'), await person(request, 'Bo')];
  const room = await group(request, ada, [cy, bo]);
  await say(request, cy, room.id, 'Should we move the launch?');

  const [a, c, b] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, cy), await signIn(browser, baseURL!, bo)];
  await Promise.all([openRoom(a, room.id), openRoom(b, room.id)]);

  await branchFrom(a, 'Should we move the launch?', 'Launch date', ['Cy']);
  await expect(a.getByText('Branched from')).toBeVisible();

  // Cy was added and is told live, with no reload.
  const branchLink = c.getByRole('link', { name: 'Launch date' });
  await expect(branchLink).toBeVisible();
  await branchLink.click();
  await write(c, 'The 7th avoids the conference.');
  await expect(row(a, 'The 7th avoids the conference.')).toBeVisible();

  // Bo sees that a branch exists, but can't open it or see what's inside.
  await expect(b.getByText('not in this branch')).toBeVisible();
  await expect(b.getByRole('button', { name: /Launch date/ })).toBeDisabled();
  await expect(b.getByText('The 7th avoids the conference.')).toHaveCount(0);

  await resolveAndMerge(a, 'We are moving to the 7th.');

  // The outcome reaches Bo live. The discussion doesn't.
  await expect(b.getByText('We are moving to the 7th.', { exact: true })).toBeVisible();
  await expect(b.getByText('Resolved in branch')).toBeVisible();
  await expect(b.getByRole('button', { name: 'Open branch' })).toHaveCount(0);
  await expect(b.getByText('The 7th avoids the conference.')).toHaveCount(0);

  // Breadcrumb back to the parent, and forward again from the card.
  await a.getByRole('link', { name: room.name }).first().click();
  await a.getByRole('button', { name: 'Open branch' }).click();
  await expect(a.getByText('The 7th avoids the conference.')).toBeVisible();
});

test('a private branch leaves no trace for outsiders until it merges', async ({ browser, baseURL, request }) => {
  const [ada, cy, bo] = [await person(request, 'Ada'), await person(request, 'Cy'), await person(request, 'Bo')];
  const room = await group(request, ada, [cy, bo]);
  await say(request, cy, room.id, 'Sensitive pricing question');

  const [a, b] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, bo)];
  await Promise.all([openRoom(a, room.id), openRoom(b, room.id)]);
  await branchFrom(a, 'Sensitive pricing question', 'Secret pricing', ['Cy'], true);

  await b.reload();
  await expect(row(b, 'Sensitive pricing question')).toBeVisible();
  await expect(b.getByText('Secret pricing')).toHaveCount(0);

  const url = a.url();
  await b.goto(url);
  await expect(b.getByText("This conversation isn't available")).toBeVisible();
});

test('a shared transcript is readable but closed to replies', async ({ browser, baseURL, request }) => {
  const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
  const room = await group(request, ada, [bo]);
  await say(request, ada, room.id, 'Topic');

  const [a, b] = [await signIn(browser, baseURL!, ada), await signIn(browser, baseURL!, bo)];
  await Promise.all([openRoom(a, room.id), openRoom(b, room.id)]);
  await branchFrom(a, 'Topic', 'Open record', []);
  await write(a, 'My reasoning');
  await expect(row(a, 'My reasoning')).toBeVisible();
  await resolveAndMerge(a, 'Decided.', true);

  await b.getByRole('button', { name: 'Open branch' }).click();
  await expect(b.getByText('My reasoning')).toBeVisible();
  await expect(b.getByText('This is a read-only transcript of a merged branch.')).toBeVisible();
  await expect(b.getByRole('textbox', { name: 'Message' })).toHaveCount(0);
});
