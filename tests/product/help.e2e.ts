import { expect, test, type APIRequestContext } from '@playwright/test';
import { randomInt } from 'node:crypto';

const uniquePublicOrigin = () => `https://example.com:${randomInt(10_000, 65_535)}`;

async function createProject(request: APIRequestContext, name: string) {
  const response = await request.post('/api/projects', {
    data: { name, origin: uniquePublicOrigin() },
  });
  expect(response.status()).toBe(201);
  return response.json() as Promise<{ id: string; name: string; origin: string }>;
}

test.describe('contextual help', () => {
  test('global help explains the product and Escape restores focus', async ({ page }) => {
    await page.goto('/');
    const trigger = page.getByRole('banner').getByRole('button', { name: 'Help: How Pathproof works' });

    await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await trigger.focus();
    await trigger.click();

    const dialog = page.getByRole('dialog', { name: 'How Pathproof works', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('learns a safe browser journey once');
    await expect(page.getByRole('button', { name: 'Close help' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('persists the hidden START HERE guide and restores it from global Help', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Three steps to a repeatable website check', { exact: true })).toHaveCount(0);
    await expect(page.getByText('You are ready to rerun saved checks after the next release.', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Set up journey(s) with AI or the Chrome Extension once, then rerun the same checks after every release.', { exact: true })).toBeVisible();
    const guide = page.getByRole('region', { name: 'START HERE', exact: true });
    await expect(guide).toBeVisible();
    await guide.getByRole('button', { name: 'Hide START HERE', exact: true }).click();
    await expect(guide).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('pathproof-start-here-hidden'))).toBe('true');
    await page.reload();
    await expect(page.getByRole('region', { name: 'START HERE', exact: true })).toHaveCount(0);

    await page.getByRole('banner').getByRole('button', { name: 'Help: How Pathproof works' }).click();
    await page.getByRole('dialog', { name: 'How Pathproof works', exact: true }).getByRole('button', { name: 'Show START HERE', exact: true }).click();
    await expect(page.getByRole('region', { name: 'START HERE', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('pathproof-start-here-hidden'))).toBeNull();
  });

  test('a help icon does not activate its neighboring action', async ({ page, request }) => {
    const project = await createProject(request, `Import help ${Date.now()}-${test.info().parallelIndex}`);
    await page.goto(`/projects/${project.id}`);
    const importRecording = page.getByRole('button', { name: 'Import recording', exact: true });
    const help = page.getByRole('button', { name: 'Help: Import recording from Chrome', exact: true });

    await help.click();

    await expect(page.getByRole('dialog', { name: 'Import recording from Chrome', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Import browser recording', exact: true })).toHaveCount(0);
    await expect(importRecording).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
  });

  test('help targets are keyboard accessible and expose dialog semantics', async ({ page }) => {
    await page.goto('/');
    const trigger = page.getByRole('banner').getByRole('button', { name: 'Help: How Pathproof works' });

    await expect(trigger).toHaveAccessibleName('Help: How Pathproof works');
    await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await trigger.focus();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('dialog', { name: 'How Pathproof works', exact: true })).toBeVisible();
  });

  test('opens help as a right drawer and closes it from the outside backdrop', async ({ page }) => {
    await page.goto('/');
    const trigger = page.getByRole('banner').getByRole('button', { name: 'Help: How Pathproof works' });
    await trigger.click();

    const drawer = page.getByRole('dialog', { name: 'How Pathproof works', exact: true });
    const bounds = await drawer.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x + bounds!.width).toBeGreaterThanOrEqual((await page.evaluate(() => innerWidth)) - 1);

    await page.locator('.help-backdrop').click({ position: { x: 8, y: 100 } });
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('help inside automated-test setup preserves the draft and underlying dialog', async ({ page, request }) => {
    const suffix = `${Date.now()}-${test.info().parallelIndex}`;
    const project = await createProject(request, `Help draft ${suffix}`);
    const testName = 'Pricing and navigation draft';
    const startingUrls = `${project.origin}/pricing\n${project.origin}/docs`;

    await page.goto(`/projects/${project.id}`);
    const setupTrigger = page.getByRole('button', { name: 'Create automated test', exact: true });
    await setupTrigger.click();

    const setupDialog = page.getByRole('dialog', { name: 'Create automated test', exact: true });
    await expect(setupDialog).toBeVisible();
    const nameInput = setupDialog.getByRole('textbox', { name: 'Test name prefix', exact: true });
    const urlsInput = setupDialog.getByRole('textbox', { name: 'Starting URLs', exact: true });
    await nameInput.fill(testName);
    await urlsInput.fill(startingUrls);

    const helpTrigger = setupDialog.getByRole('button', { name: 'Help: Starting URLs' });
    await helpTrigger.click();
    const helpDialog = page.getByRole('dialog', { name: 'Starting URLs', exact: true });

    await expect(helpDialog).toBeVisible();
    await expect(helpDialog).toContainText('complete HTTP(S) pages');
    await expect(setupDialog).toBeVisible();
    await expect(nameInput).toHaveValue(testName);
    await expect(urlsInput).toHaveValue(startingUrls);

    await page.keyboard.press('Escape');
    await expect(helpDialog).toBeHidden();
    await expect(setupDialog).toBeVisible();
    await expect(helpTrigger).toBeFocused();
    await expect(nameInput).toHaveValue(testName);
    await expect(urlsInput).toHaveValue(startingUrls);
  });

  test('reviews starting URLs before setup and skips unsafe entries clearly', async ({ page, request }) => {
    const project = await createProject(request, `URL review ${Date.now()}-${test.info().parallelIndex}`);
    await page.goto(`/projects/${project.id}`);
    await page.getByRole('button', { name: 'Create automated test', exact: true }).click();
    const setupDialog = page.getByRole('dialog', { name: 'Create automated test', exact: true });
    await setupDialog.getByRole('textbox', { name: 'Starting URLs', exact: true }).fill([
      `${project.origin}/pricing`,
      `${project.origin}/pricing`,
      'https://different.example/pricing',
      'not-a-url',
    ].join('\n'));

    await expect(setupDialog.getByText('1 ready to use · 3 skipped')).toBeVisible();
    await expect(setupDialog.getByText('Duplicate', { exact: true })).toBeVisible();
    await expect(setupDialog.getByText('Different domain', { exact: true })).toBeVisible();
    await expect(setupDialog.getByText('Invalid URL', { exact: true })).toBeVisible();
    const createButton = setupDialog.getByRole('button', { name: 'Create automated test', exact: true });
    await expect(createButton).toBeDisabled();
    await setupDialog.getByRole('textbox', { name: 'AI instructions', exact: true }).fill('Verify that pricing details are visible.');
    await expect(createButton).toBeEnabled();
  });
});
