import { expect, test, type Page } from '@playwright/test';
import { RunCoordinator } from '../../server/runner.js';

test('discovery passes attached filenames as structured data without leaking its runtime helper', async ({ page }) => {
  await page.setContent(`
    <main>
      <h1>Discovery fixture</h1>
      <button id="safe-action">Show details</button>
      <input type="file" aria-label="Upload fixture">
    </main>
  `);

  const coordinator = new RunCoordinator({} as never);
  const discoverActions = (coordinator as unknown as {
    discoverActions(page: Page, includeInstructionLinks: boolean, fileNames: string[]): Promise<Array<{ kind: string }>>;
  }).discoverActions.bind(coordinator);
  const injectionShapedName = `fixture'); globalThis.__pathproofInjected = true; ('file.txt`;

  const actions = await discoverActions(page, true, [injectionShapedName]);
  const pageState = await page.evaluate(() => ({
    injected: Boolean((globalThis as typeof globalThis & { __pathproofInjected?: boolean }).__pathproofInjected),
    helperRemaining: typeof (globalThis as typeof globalThis & { __name?: unknown }).__name !== 'undefined',
  }));

  expect(actions.some((action) => action.kind === 'file')).toBe(true);
  expect(pageState).toEqual({ injected: false, helperRemaining: false });
});
