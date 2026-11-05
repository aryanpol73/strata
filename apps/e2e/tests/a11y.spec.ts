import AxeBuilder from '@axe-core/playwright';
import { addChecklist, branchFrom, expect, group, openRoom, person, say, signIn, test, watch } from './support';
import type { Page } from '@playwright/test';

async function audit(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = violations.map((v) => ({
    where,
    rule: v.id,
    impact: v.impact,
    examples: v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} :: ${(n.any[0]?.message ?? n.failureSummary ?? '').slice(0, 140)}`),
  }));
  expect(summary).toEqual([]);
}

/** The theme is the person's choice in Settings, kept in localStorage, not the system's colour scheme. */
const withTheme = (baseURL: string | undefined, theme: 'deep' | 'day') => ({
  storageState: { cookies: [], origins: [{ origin: baseURL!, localStorage: [{ name: 'strata:theme', value: theme }] }] },
});

for (const theme of ['deep', 'day'] as const) {
  test.describe(`${theme} theme`, () => {
    test('sign-in page', async ({ browser, baseURL }) => {
      const page = watch(await (await browser.newContext({ baseURL, ...withTheme(baseURL, theme) })).newPage());
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
      await audit(page, 'sign-in');
    });

    test('conversation with a Canvas, a block and a resolution', async ({ browser, baseURL, request }) => {
      const [ada, bo] = [await person(request, 'Ada'), await person(request, 'Bo')];
      const room = await group(request, ada, [bo]);
      await say(request, bo, room.id, 'A question for the group');
      await say(request, bo, room.id, 'Whispered note', { posture: 'whisper' });
      await say(request, bo, room.id, 'Please confirm', { posture: 'blocking_ack', ackDeadline: new Date(Date.now() + 3_600_000).toISOString() });

      const a = await signIn(browser, baseURL!, ada, withTheme(baseURL, theme));
      await openRoom(a, room.id);
      await addChecklist(a, 'Audit list', ['One thing']);
      await a.getByRole('article').filter({ hasText: 'A question for the group' }).hover();
      await a.getByRole('article').filter({ hasText: 'A question for the group' }).getByRole('button', { name: 'Add to Canvas' }).click();
      await expect(a.getByRole('textbox', { name: 'Canvas text' })).toBeVisible();
      await a.mouse.move(0, 0);
      await a.waitForTimeout(2200);
      await audit(a, 'conversation');
    });

    test('branch view and dialogs', async ({ browser, baseURL, request }) => {
      const ada = await person(request, 'Ada');
      const room = await group(request, ada, []);
      await say(request, ada, room.id, 'Branch source');
      const a = await signIn(browser, baseURL!, ada, withTheme(baseURL, theme));
      await openRoom(a, room.id);
      await branchFrom(a, 'Branch source', 'Audit branch', []);
      await audit(a, 'branch');

      await a.getByRole('button', { name: 'Invite guest' }).click();
      await expect(a.getByRole('dialog')).toBeVisible();
      await a.waitForTimeout(300);
      await audit(a, 'guest dialog');
    });

    test('settings', async ({ browser, baseURL, request }) => {
      const ada = await person(request, 'Ada');
      const a = await signIn(browser, baseURL!, ada, withTheme(baseURL, theme));
      await a.goto('/settings');
      await expect(a.getByText('This device', { exact: true })).toBeVisible();
      await audit(a, 'settings');
    });
  });
}
