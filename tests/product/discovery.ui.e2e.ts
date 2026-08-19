import { expect, test, type APIRequestContext } from '@playwright/test';
import { randomBytes } from 'node:crypto';

const discoveryEnabled = process.env.RUN_DISCOVERY_E2E === '1';

function uniqueFixtureOrigin() {
  const octets = [...randomBytes(3)].map((value) => 1 + (value % 254));
  return `http://127.${octets.join('.')}:4317`;
}

type CreatedProject = { id: string; name: string; origin: string };
type CreatedRun = { id: string; status: string };

async function createProject(request: APIRequestContext, name: string, origin = uniqueFixtureOrigin()): Promise<CreatedProject> {
  const response = await request.post('/api/projects', {
    data: { name, origin },
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<CreatedProject>;
}

async function createReadyTest(request: APIRequestContext, project: CreatedProject) {
  const response = await request.post(`/api/projects/${project.id}/tests`, {
    data: { name: `${project.name} regression`, seedUrls: [`${project.origin}/seed`] },
  });
  expect(response.status()).toBe(202);
  const payload = await response.json() as { run: CreatedRun };
  let latestStatus = payload.run.status;

  await expect.poll(async () => {
    const runResponse = await request.get(`/api/runs/${payload.run.id}`);
    expect(runResponse.ok()).toBeTruthy();
    latestStatus = ((await runResponse.json()) as CreatedRun).status;
    return latestStatus;
  }, { timeout: 40_000, intervals: [250, 500, 1_000] }).toMatch(/passed|failed/);
  expect(latestStatus).toBe('passed');
}

test.describe('AI setup to deterministic replay', () => {
  test.skip(!discoveryEnabled, 'Set RUN_DISCOVERY_E2E=1 and PATHPROOF_ALLOW_LOCALHOST=1 to enable active localhost discovery.');

  test('creates a test in the workspace, shows the live browser, and reruns the saved plan', async ({ page, request }) => {
    const suffix = `${Date.now()}-${test.info().parallelIndex}`;
    const project = await createProject(request, `Workspace discovery ${suffix}`);

    await page.goto(`/projects/${project.id}`);
    await page.getByRole('button', { name: 'Create automated test', exact: true }).click();
    const setupDialog = page.getByRole('dialog', { name: 'Create automated test', exact: true });
    await setupDialog.getByRole('textbox', { name: 'Test name prefix', exact: true }).fill('Seed catalog regression');
    await setupDialog.getByRole('textbox', { name: 'Starting URLs', exact: true }).fill(`${project.origin}/seed`);
    await setupDialog.getByRole('textbox', { name: 'AI instructions', exact: true }).fill('Verify catalog sorting and filtering controls.');
    await setupDialog.getByRole('button', { name: 'Create automated test', exact: true }).click();

    const liveDialog = page.getByRole('dialog', { name: 'Live browser' });
    await expect(liveDialog).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close run panel' })).toBeFocused();
    const expandReplay = liveDialog.getByRole('button', { name: 'Expand replay view in this tab' });
    await expandReplay.click();
    await expect(liveDialog).toHaveClass(/is-player-expanded/);
    await expect(liveDialog.getByRole('button', { name: 'Exit expanded replay view' })).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    await page.keyboard.press('Escape');
    await expect(liveDialog).toBeVisible();
    await expect(liveDialog).not.toHaveClass(/is-player-expanded/);
    const followLogs = liveDialog.getByRole('button', { name: 'Follow logs', exact: true });
    await expect(followLogs).toHaveAttribute('aria-pressed', 'false');
    await followLogs.click();
    const unfollowLogs = liveDialog.getByRole('button', { name: 'Unfollow logs', exact: true });
    await expect(unfollowLogs).toHaveAttribute('aria-pressed', 'true');
    await unfollowLogs.click();
    await expect(followLogs).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Shift+Tab');
    expect(await liveDialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    const testCard = page.locator('.test-card').filter({ hasText: 'Seed catalog regression' });
    if (process.env.PATHPROOF_DISABLE_AI === '1') {
      await expect(testCard.getByText('Setup failed', { exact: true })).toBeVisible({ timeout: 40_000 });
      await expect(testCard.getByText('Latest: failed', { exact: true })).toBeVisible();
      await expect(testCard.getByRole('button', { name: 'Run saved test', exact: true })).toHaveCount(0);
      await expect(testCard.getByRole('button', { name: 'Create replacement', exact: true })).toBeEnabled();
      return;
    }
    await expect(testCard.getByText('Ready to rerun', { exact: true })).toBeVisible({ timeout: 40_000 });

    const runTest = testCard.getByRole('button', { name: 'Run saved test', exact: true });
    await expect(runTest).toBeEnabled();
    await runTest.click();
    await expect(page.getByRole('dialog', { name: 'Live browser' })).toBeVisible();
    await expect(runTest).toBeEnabled({ timeout: 40_000 });
  });

  test('starts ready tests across multiple selected projects', async ({ page, request }) => {
    test.setTimeout(100_000);
    const suffix = `${Date.now()}-${test.info().parallelIndex}`;
    const projects = await Promise.all([
      createProject(request, `Fleet alpha ${suffix}`),
      createProject(request, `Fleet beta ${suffix}`),
    ]);

    for (const project of projects) {
      await createReadyTest(request, project);
    }

    await page.goto('/');
    for (const project of projects) {
      await page.getByRole('checkbox', { name: `Select ${project.name}` }).check();
    }

    const runSelected = page.getByRole('button', { name: /^Run selected \(/ });
    await expect(runSelected).toBeEnabled();
    await runSelected.click();

    await expect(page.getByRole('progressbar').first()).toBeVisible();
    await expect.poll(async () => {
      const dashboardResponse = await request.get('/api/projects');
      const payload = await dashboardResponse.json() as Array<{
        id: string;
        lastRun?: { kind: string; status: string };
      }> | { projects: Array<{ id: string; lastRun?: { kind: string; status: string } }> };
      const dashboard = Array.isArray(payload) ? payload : payload.projects;
      return projects.every((project) => {
        const item = dashboard.find((candidate) => candidate.id === project.id);
        return item?.lastRun?.kind === 'replay';
      });
    }, { timeout: 20_000 }).toBe(true);
  });
});
