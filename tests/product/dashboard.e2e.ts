import { expect, test } from '@playwright/test';
import { randomInt } from 'node:crypto';

const publicFixtureHosts = ['example.com', 'example.net', 'example.org', 'www.example.com', 'www.example.net', 'www.example.org'];
const uniquePublicOrigin = () => {
  const protocol = randomInt(0, 2) === 0 ? 'http' : 'https';
  const hostname = publicFixtureHosts[randomInt(0, publicFixtureHosts.length)];
  return `${protocol}://${hostname}:${randomInt(10_000, 65_535)}`;
};

test.describe('dashboard essentials', () => {
  test('creates a domain project and opens its workspace', async ({ page, request }) => {
    const projectName = `Acme docs ${Date.now()}`;
    await page.route('**/api/origins/resolve', async (route) => {
      const { input } = route.request().postDataJSON() as { input: string };
      await route.fulfill({ json: { origin: input } });
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Add website', exact: true }).click();
    await page.getByRole('textbox', { name: 'Project name', exact: true }).fill(projectName);
    await page.getByRole('textbox', { name: 'Root domain', exact: true }).fill(uniquePublicOrigin());
    await page.getByRole('button', { name: 'Create project', exact: true }).click();

    await expect(page).toHaveURL(/\/projects\/[\w-]+$/);
    await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create automated test', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Chrome Extension', exact: true }).click();
    const extensionDialog = page.getByRole('dialog', { name: 'Chrome Extension', exact: true });
    const download = extensionDialog.getByRole('link', { name: 'Download extension ZIP', exact: true });
    await expect(download).toHaveAttribute('href', '/pathproof-chrome-extension.zip');
    await expect(download).toHaveAttribute('download', 'pathproof-chrome-extension.zip');
    const zipResponse = await request.get('/pathproof-chrome-extension.zip');
    expect(zipResponse.ok()).toBeTruthy();
    expect((await zipResponse.body()).subarray(0, 2).toString()).toBe('PK');
    await extensionDialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Help: Import recording from Chrome', exact: true })).toBeVisible();
  });

  test('lets users correct a project name and www domain before creating tests', async ({ page, request }) => {
    const initialOrigin = uniquePublicOrigin();
    const initialUrl = new URL(initialOrigin);
    const correctedOrigin = `https://www.example.com:${initialUrl.port}`;
    await page.route('**/api/origins/resolve', async (route) => {
      await route.fulfill({ json: { origin: correctedOrigin } });
    });
    const response = await request.post('/api/projects', {
      data: { name: `Domain correction ${Date.now()}`, origin: initialOrigin },
    });
    expect(response.status()).toBe(201);
    const project = await response.json() as { id: string };

    await page.goto(`/projects/${project.id}`);
    await page.getByRole('button', { name: 'Edit project', exact: true }).click();
    const editDialog = page.getByRole('dialog', { name: 'Edit project', exact: true });
    await editDialog.getByRole('textbox', { name: 'Project name', exact: true }).fill('Acme Ltd. website');
    await editDialog.getByRole('textbox', { name: 'Root domain', exact: true }).fill(`www.example.com:${initialUrl.port}`);
    await editDialog.getByRole('button', { name: 'Save changes', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Acme Ltd. website' })).toBeVisible();
    await expect(page.getByRole('link', { name: correctedOrigin })).toBeVisible();
    await page.getByRole('button', { name: 'Create automated test', exact: true }).click();
    const setupDialog = page.getByRole('dialog', { name: 'Create automated test', exact: true });
    await setupDialog.getByRole('textbox', { name: 'Starting URLs', exact: true }).fill(`${correctedOrigin}/products\n${correctedOrigin}/contact`);
    await expect(setupDialog.getByText('2 ready to use')).toBeVisible();
    await expect(setupDialog.getByText('Different domain', { exact: true })).toHaveCount(0);
    const aiInstructions = setupDialog.getByRole('textbox', { name: 'AI instructions', exact: true });
    await expect(aiInstructions).toHaveAttribute('placeholder', 'Navigate to the contact page from the footer menu and verify that the support form is available');
    const customInstructions = 'Open the footer contact page and check that the support form is available.';
    await aiInstructions.fill(customInstructions);
    const importCookiesButton = setupDialog.getByRole('button', { name: 'Import cookies', exact: true });
    await importCookiesButton.click();
    const cookieEditor = setupDialog.locator('#setup-cookie-editor');
    await expect(cookieEditor.getByText('Browser cookies', { exact: true })).toBeVisible();
    const importButtonBox = await importCookiesButton.boundingBox();
    const cookieEditorBox = await cookieEditor.boundingBox();
    const startingUrlsBox = await setupDialog.getByRole('textbox', { name: 'Starting URLs', exact: true }).boundingBox();
    expect(importButtonBox && cookieEditorBox && cookieEditorBox.y).toBeGreaterThanOrEqual((importButtonBox?.y ?? 0) + (importButtonBox?.height ?? 0));
    expect(cookieEditorBox && startingUrlsBox && cookieEditorBox.y).toBeLessThan(startingUrlsBox?.y ?? 0);
    const cookieGuideButton = cookieEditor.getByRole('button', { name: 'Guide for Cookie export', exact: true });
    const addCookieButton = cookieEditor.getByRole('button', { name: 'Add individual cookie', exact: true });
    const guideButtonBox = await cookieGuideButton.boundingBox();
    const addCookieButtonBox = await addCookieButton.boundingBox();
    expect(guideButtonBox && addCookieButtonBox && guideButtonBox.x).toBeLessThan(addCookieButtonBox?.x ?? 0);
    await cookieGuideButton.click();
    const cookieCode = cookieEditor.getByRole('textbox', { name: 'Cookie export JavaScript code', exact: true });
    await expect(cookieCode).toHaveValue(/document\.cookie\.split\(';'/);
    await expect(cookieCode).toHaveValue(/Import_cookie_set_/);
    await expect(cookieCode).toHaveValue(/download\.click\(\)/);
    await expect(cookieEditor.getByText('It logs the JSON and downloads', { exact: false })).toBeVisible();
    await cookieEditor.getByRole('button', { name: 'Copy JS Code', exact: true }).click();
    await expect(cookieEditor.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
    await setupDialog.locator('input[accept*=".json"]').setInputFiles({
      name: 'consent-cookies.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify([{ name: 'cookie_consent', value: 'accepted', domain: '.example.com', path: '/', secure: true }])),
    });
    await expect(setupDialog.getByRole('textbox', { name: 'Setup cookie 1 name', exact: true })).toHaveValue('cookie_consent');
    await setupDialog.getByRole('button', { name: 'Add individual cookie', exact: true }).click();
    await setupDialog.getByRole('textbox', { name: 'Setup cookie 2 name', exact: true }).fill('locale');
    await setupDialog.getByLabel('Setup cookie 2 value', { exact: true }).fill('de');
    await setupDialog.locator('#setup-cookie-header').fill('banner_seen=true');
    await setupDialog.locator('#setup-test-files').setInputFiles({ name: 'profile.txt', mimeType: 'text/plain', buffer: Buffer.from('Example profile') });
    await expect(setupDialog.getByText('profile.txt', { exact: true })).toBeVisible();
    const createTestBodies: Array<{ name: string; seedUrls: string[]; aiInstructions?: string; files?: Array<{ name: string; mimeType: string; dataBase64: string; size: number }>; browserState?: { cookies: Array<{ name: string; value: string }>; cookieHeader?: string } }> = [];
    await page.route(`**/api/projects/${project.id}/tests`, async (route) => {
      const body = route.request().postDataJSON() as typeof createTestBodies[number];
      createTestBodies.push(body);
      const createdAt = new Date().toISOString();
      await route.fulfill({ status: 202, json: { run: {
        id: `ai-instructions-preview-${createTestBodies.length}`, projectId: project.id, testId: `ai-instructions-test-${createTestBodies.length}`, kind: 'discovery', aiUsed: false,
        status: 'queued', progress: 0, createdAt, events: [], frameVersion: 0,
      } } });
    });
    await setupDialog.getByRole('button', { name: 'Create 2 automated tests', exact: true }).click();
    expect(createTestBodies).toHaveLength(2);
    expect(createTestBodies.map((body) => body.seedUrls)).toEqual([
      [`${correctedOrigin}/products`],
      [`${correctedOrigin}/contact`],
    ]);
    expect(createTestBodies.every((body) => body.aiInstructions === customInstructions)).toBe(true);
    expect(createTestBodies.every((body) => body.browserState?.cookieHeader === 'banner_seen=true')).toBe(true);
    expect(createTestBodies.every((body) => body.browserState?.cookies.map((cookie) => cookie.name).join(',') === 'cookie_consent,locale')).toBe(true);
    expect(createTestBodies.every((body) => body.files?.[0]?.name === 'profile.txt' && Buffer.from(body.files[0].dataBase64, 'base64').toString() === 'Example profile')).toBe(true);
    expect(createTestBodies.map((body) => body.name)).toEqual([
      'Acme Ltd. website regression — 1: /products',
      'Acme Ltd. website regression — 2: /contact',
    ]);
  });

  test('resolves a plain domain to its canonical website before creating the project', async ({ page }) => {
    let resolveInput = '';
    let createdOrigin = '';
    await page.route('**/api/origins/resolve', async (route) => {
      resolveInput = (route.request().postDataJSON() as { input: string }).input;
      await route.fulfill({ json: { origin: 'https://example.com' } });
    });
    await page.route('**/api/projects', async (route) => {
      const body = route.request().postDataJSON() as { name: string; origin: string };
      createdOrigin = body.origin;
      await route.fulfill({ status: 201, json: {
        id: 'canonical-domain-project', name: body.name, origin: body.origin,
        createdAt: new Date().toISOString(), status: 'empty',
      } });
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Add website', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a website' });
    await dialog.getByRole('textbox', { name: 'Project name', exact: true }).fill('Acme Ltd.');
    const domain = dialog.getByRole('textbox', { name: 'Root domain', exact: true });
    await domain.fill('example.com');
    await domain.press('Tab');

    await expect(domain).toHaveValue('https://example.com');
    await expect(dialog.getByText('Website found:', { exact: false })).toContainText('https://example.com');
    expect(resolveInput).toBe('example.com');

    await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/canonical-domain-project$/);
    expect(createdOrigin).toBe('https://example.com');
  });

  test('replaces technical resolver failures with helpful domain guidance', async ({ page }) => {
    await page.route('**/api/origins/resolve', async (route) => {
      await route.fulfill({
        status: 422,
        json: { error: { code: 'TARGET_BLOCKED', message: 'A valid absolute URL is required.' } },
      });
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Add website', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a website' });
    await dialog.getByRole('textbox', { name: 'Project name', exact: true }).fill('Typo example');
    const domain = dialog.getByRole('textbox', { name: 'Root domain', exact: true });
    await domain.fill('not a host');
    await domain.press('Tab');

    await expect(dialog.getByRole('alert')).toContainText('We couldn’t find a working website for that domain.');
    await expect(dialog.getByText('A valid absolute URL is required.', { exact: true })).toHaveCount(0);
    await expect(dialog.getByText(/target hostname|host issue/i)).toHaveCount(0);
  });

  test('exposes accessible bulk-selection controls', async ({ page, request }) => {
    const suffix = `${Date.now()}-${test.info().parallelIndex}`;
    const names = [`Bulk alpha ${suffix}`, `Bulk beta ${suffix}`];

    for (const name of names) {
      const response = await request.post('/api/projects', {
        data: { name, origin: uniquePublicOrigin() },
      });
      expect(response.ok()).toBeTruthy();
    }

    await page.goto('/');
    const selectAll = page.getByRole('checkbox', { name: 'Select all visible projects' });
    await expect(selectAll).toBeVisible();
    await selectAll.check();
    for (const name of names) {
      await expect(page.getByRole('checkbox', { name: `Select ${name}` })).toBeChecked();
    }
    await expect(page.getByRole('button', { name: /^Run selected/ })).toBeVisible();
  });

  test('renames one selected project and deletes multiple selected projects from the homepage', async ({ page, request }) => {
    const suffix = `${Date.now()}-${test.info().parallelIndex}`;
    const firstName = `Manage alpha ${suffix}`;
    const secondName = `Manage beta ${suffix}`;
    const renamed = `Renamed alpha ${suffix}`;
    const projects: Array<{ id: string; name: string }> = [];

    for (const name of [firstName, secondName]) {
      const response = await request.post('/api/projects', { data: { name, origin: uniquePublicOrigin() } });
      expect(response.status()).toBe(201);
      projects.push(await response.json() as { id: string; name: string });
    }

    await page.goto('/');
    await page.getByRole('textbox', { name: 'Search projects' }).fill(suffix);
    const desktopProjects = page.locator('.desktop-project-list');
    await page.getByRole('checkbox', { name: `Select ${firstName}` }).check();
    await page.getByRole('button', { name: 'Rename', exact: true }).click();

    const renameDialog = page.getByRole('dialog', { name: 'Rename project', exact: true });
    await renameDialog.getByRole('textbox', { name: 'Project name', exact: true }).fill(renamed);
    await renameDialog.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(desktopProjects.getByText(renamed, { exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: `Select ${renamed}` })).toBeChecked();

    await page.getByRole('checkbox', { name: `Select ${secondName}` }).check();
    await expect(page.getByRole('button', { name: 'Rename', exact: true })).toHaveCount(0);
    const deleteSelected = page.getByRole('button', { name: 'Delete (2)', exact: true });
    await deleteSelected.click();

    const deleteDialog = page.getByRole('dialog', { name: 'Delete selected projects', exact: true });
    await expect(deleteDialog.getByText(renamed, { exact: true })).toBeVisible();
    await expect(deleteDialog.getByText(secondName, { exact: true })).toBeVisible();
    await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(desktopProjects.getByText(renamed, { exact: true })).toBeVisible();

    await deleteSelected.click();
    await page.getByRole('dialog', { name: 'Delete selected projects', exact: true }).getByRole('button', { name: 'Delete 2 projects', exact: true }).click();
    await expect(desktopProjects.getByText(renamed, { exact: true })).toHaveCount(0);
    await expect(desktopProjects.getByText(secondName, { exact: true })).toHaveCount(0);
    for (const project of projects) expect((await request.get(`/api/projects/${project.id}`)).status()).toBe(404);
  });

  test('keeps keyboard focus inside dialogs and restores it on close', async ({ page }) => {
    await page.goto('/');
    const trigger = page.getByRole('button', { name: 'Add website', exact: true });
    await trigger.focus();
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Add a website' });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toBeFocused();
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('imports an extension recording as a ready Playwright test', async ({ page, request }) => {
    const origin = uniquePublicOrigin();
    const projectResponse = await request.post('/api/projects', { data: { name: `Recorded app ${Date.now()}`, origin } });
    expect(projectResponse.status()).toBe(201);
    const project = await projectResponse.json() as { id: string };
    const now = new Date().toISOString();
    const recording = {
      format: 'pathproof-recording', version: 1, id: `recording-${Date.now()}`, name: 'Recorded checkout',
      createdAt: now, startedAt: now, stoppedAt: new Date(Date.now() + 2_000).toISOString(), durationMs: 2_000,
      target: { tabId: 42, initialUrl: `${origin}/catalog`, finalUrl: `${origin}/catalog`, title: 'Catalog' },
      browser: { viewport: { width: 1280, height: 720 }, locale: 'en-US', timezoneId: 'UTC' },
      events: [{ id: 'click-1', sequence: 1, at: now, offsetMs: 900, kind: 'click', url: `${origin}/catalog`, selector: '#checkout', role: 'button', accessibleName: 'Checkout' }],
    };

    await page.goto(`/projects/${project.id}`);
    await page.getByRole('button', { name: 'Import recording', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Import browser recording', exact: true });
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'checkout.pathproof.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(recording)),
    });
    await expect(dialog.getByText('1 captured signals')).toBeVisible();
    await dialog.getByRole('button', { name: 'Import & create test', exact: true }).click();

    const card = page.locator('.test-card').filter({ hasText: 'Recorded checkout' });
    await expect(card).toBeVisible();
    await expect(card.getByText('Recorded journey', { exact: false })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Run saved test', exact: true })).toBeVisible();
    const speed = card.getByRole('combobox', { name: 'Playback speed for Recorded checkout', exact: true });
    await expect(speed.locator('option')).toHaveText(['0.25×', '0.5×', '0.75×', '1×', '1.25×', '1.5×', '1.75×', '2×']);
    await speed.selectOption('1.75');
    await expect(speed).toHaveValue('1.75');

    let requestedSpeed = 0;
    await page.route('**/api/tests/*/run', async (route) => {
      requestedSpeed = (route.request().postDataJSON() as { playbackSpeed: number }).playbackSpeed;
      await route.fulfill({ status: 202, json: {
        id: 'speed-preview-run', projectId: project.id, testId: 'speed-preview-test', kind: 'replay', aiUsed: false,
        status: 'queued', progress: 0, createdAt: now, events: [], frameVersion: 0, playbackSpeed: requestedSpeed,
      } });
    });
    await card.getByRole('button', { name: 'Run saved test', exact: true }).click();
    expect(requestedSpeed).toBe(1.75);
  });

  test('edits cookies from the imported recording entry', async ({ page, request }) => {
    const origin = uniquePublicOrigin();
    const projectResponse = await request.post('/api/projects', { data: { name: `Cookie recording ${Date.now()}`, origin } });
    expect(projectResponse.status()).toBe(201);
    const project = await projectResponse.json() as { id: string };
    const now = new Date().toISOString();
    const recordingName = `Authenticated checkout ${Date.now()}`;
    const importResponse = await request.post(`/api/projects/${project.id}/recordings`, { data: {
      name: recordingName,
      cookieHeader: 'tenant=old',
      recording: {
        format: 'pathproof-recording', version: 1, id: `cookies-${Date.now()}`, name: recordingName,
        createdAt: now, startedAt: now, stoppedAt: new Date(Date.now() + 1_000).toISOString(), durationMs: 1_000,
        target: { initialUrl: `${origin}/checkout`, finalUrl: `${origin}/checkout`, title: 'Checkout' },
        browser: {
          viewport: { width: 1280, height: 720 }, locale: 'en-US',
          cookies: [{ name: 'session', value: 'old-secret', domain: new URL(origin).hostname, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }],
        },
        events: [{ id: 'click-cookie', sequence: 1, at: now, offsetMs: 500, kind: 'click', url: `${origin}/checkout`, selector: '#pay', role: 'button', accessibleName: 'Pay' }],
      },
    } });
    expect(importResponse.status()).toBe(201);
    const recording = await importResponse.json() as { id: string };

    await page.goto(`/projects/${project.id}`);
    const card = page.locator('.test-card').filter({ hasText: recordingName });
    const cookieButton = card.getByRole('button', { name: `Edit cookies for ${recordingName}`, exact: true });
    await expect(cookieButton).toBeVisible();
    await expect(cookieButton.locator('span')).toHaveText('2');
    await cookieButton.click();

    const dialog = page.getByRole('dialog', { name: 'Edit recording cookies', exact: true });
    await expect(dialog.getByText('1 cookie attached', { exact: true })).toBeVisible();
    await dialog.getByLabel('Cookie 1 value', { exact: true }).fill('new-secret');
    await dialog.getByLabel(/^Fixed cookie header/).fill('tenant=new; feature=beta');
    await dialog.getByRole('button', { name: 'Add cookie', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Cookie 2 name', exact: true }).fill('region');
    await dialog.getByLabel('Cookie 2 value', { exact: true }).fill('eu');
    await dialog.getByRole('button', { name: 'Save cookies', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(cookieButton.locator('span')).toHaveText('4');

    const savedResponse = await request.get(`/api/tests/${recording.id}`);
    expect(savedResponse.status()).toBe(200);
    const saved = await savedResponse.json() as { test: { browserState: { cookies: Array<{ name: string; value: string; httpOnly?: boolean }>; cookieHeader: string }; recording: { hasCookies: boolean } } };
    expect(saved.test.browserState.cookies).toHaveLength(2);
    expect(saved.test.browserState.cookies[0]).toMatchObject({ name: 'session', value: 'new-secret', httpOnly: true });
    expect(saved.test.browserState.cookies[1]).toMatchObject({ name: 'region', value: 'eu' });
    expect(saved.test.browserState.cookieHeader).toBe('tenant=new; feature=beta');
    expect(saved.test.recording.hasCookies).toBe(true);
  });

  test('deletes an imported recording and its generated test', async ({ page, request }) => {
    const origin = uniquePublicOrigin();
    const projectResponse = await request.post('/api/projects', { data: { name: `Delete recording ${Date.now()}`, origin } });
    expect(projectResponse.status()).toBe(201);
    const project = await projectResponse.json() as { id: string };
    const now = new Date().toISOString();
    const recordingName = `Disposable journey ${Date.now()}`;
    const importResponse = await request.post(`/api/projects/${project.id}/recordings`, { data: {
      name: recordingName,
      recording: {
        format: 'pathproof-recording', version: 1, id: `disposable-${Date.now()}`, name: recordingName,
        createdAt: now, startedAt: now, stoppedAt: new Date(Date.now() + 1_000).toISOString(), durationMs: 1_000,
        target: { initialUrl: `${origin}/account`, finalUrl: `${origin}/account`, title: 'Account' },
        browser: { viewport: { width: 1280, height: 720 }, locale: 'en-US' },
        events: [{ id: 'click-1', sequence: 1, at: now, offsetMs: 500, kind: 'click', url: `${origin}/account`, selector: '#profile', role: 'button', accessibleName: 'Open profile' }],
      },
    } });
    expect(importResponse.status()).toBe(201);
    const recording = await importResponse.json() as { id: string };

    await page.goto(`/projects/${project.id}`);
    const card = page.locator('.test-card').filter({ hasText: recordingName });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: `Delete ${recordingName}`, exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'Delete', exact: true });
    await expect(dialog.getByText('The original .pathproof.json file on your computer is not changed.', { exact: false })).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(card).toHaveCount(0);
    expect((await request.get(`/api/tests/${recording.id}`)).status()).toBe(404);

    const projectDelete = await request.delete(`/api/projects/${project.id}`);
    expect(projectDelete.status()).toBe(204);
  });

  test('switches recording layouts, renames inline, and bulk deletes across views', async ({ page, request }) => {
    const origin = uniquePublicOrigin();
    const projectResponse = await request.post('/api/projects', { data: { name: `Recording library ${Date.now()}`, origin } });
    expect(projectResponse.status()).toBe(201);
    const project = await projectResponse.json() as { id: string };
    const now = new Date().toISOString();
    const recordingIds: string[] = [];

    for (const [index, name] of ['Checkout draft', 'Account draft'].entries()) {
      const importResponse = await request.post(`/api/projects/${project.id}/recordings`, { data: {
        name,
        recording: {
          format: 'pathproof-recording', version: 1, id: `library-${Date.now()}-${index}`, name,
          createdAt: now, startedAt: now, stoppedAt: new Date(Date.now() + 1_000).toISOString(), durationMs: 1_000,
          target: { initialUrl: `${origin}/flow-${index}`, finalUrl: `${origin}/flow-${index}`, title: name },
          browser: { viewport: { width: 1280, height: 720 }, locale: 'en-US' },
          events: [{ id: `click-${index}`, sequence: 1, at: now, offsetMs: 500, kind: 'click', url: `${origin}/flow-${index}`, selector: '#continue', role: 'button', accessibleName: 'Continue' }],
        },
      } });
      expect(importResponse.status()).toBe(201);
      recordingIds.push((await importResponse.json() as { id: string }).id);
    }

    await page.goto(`/projects/${project.id}`);
    const collection = page.locator('.test-list');
    const runAll = page.getByRole('button', { name: 'Run selected tests', exact: true });
    const deleteSelected = page.getByRole('button', { name: 'Delete selected', exact: true });
    await expect(runAll).toBeDisabled();
    await expect(deleteSelected).toBeDisabled();
    await expect(runAll).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(deleteSelected).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(collection).toHaveClass(/boxed-view/);
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await expect(collection).toHaveClass(/list-view/);

    const checkout = page.locator('.test-card').filter({ hasText: 'Checkout draft' });
    await checkout.getByRole('button', { name: 'Rename Checkout draft', exact: true }).click();
    await checkout.getByRole('textbox', { name: 'Recording name', exact: true }).fill('Checkout release path');
    await checkout.getByRole('button', { name: 'Save recording name', exact: true }).click();
    const renamedCheckout = page.locator('.test-card').filter({ hasText: 'Checkout release path' });
    await expect(renamedCheckout.getByRole('heading', { name: 'Checkout release path', exact: true })).toBeVisible();
    await renamedCheckout.getByRole('combobox', { name: 'Playback speed for Checkout release path', exact: true }).selectOption('1.5');

    await page.getByRole('checkbox', { name: 'Select all automated tests', exact: true }).check();
    await expect(page.getByRole('checkbox', { name: 'Select test Checkout release path', exact: true })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Select test Account draft', exact: true })).toBeChecked();
    await expect(runAll).toBeEnabled();
    let bulkRunBody: { testIds: string[]; playbackSpeeds: Record<string, number> } | undefined;
    await page.route('**/api/runs/bulk', async (route) => {
      bulkRunBody = route.request().postDataJSON() as typeof bulkRunBody;
      await route.fulfill({ status: 202, json: { runs: recordingIds.map((recordingId, index) => ({
        id: `bulk-preview-${index}`, projectId: project.id, testId: recordingId, kind: 'replay', aiUsed: false,
        status: 'passed', progress: 100, createdAt: now, completedAt: now, events: [], frameVersion: 0,
        playbackSpeed: index === 0 ? 1.5 : 1,
      })) } });
    });
    await runAll.click();
    expect(new Set(bulkRunBody?.testIds)).toEqual(new Set(recordingIds));
    expect(bulkRunBody?.playbackSpeeds[recordingIds[0]]).toBe(1.5);
    expect(bulkRunBody?.playbackSpeeds[recordingIds[1]]).toBe(1);
    const runReport = page.getByRole('dialog', { name: 'Run report', exact: true });
    const pathfinderDownload = runReport.getByRole('link', { name: 'Download pathfinder steps', exact: true });
    await expect(pathfinderDownload).toHaveAttribute('title', 'Download pathfinder steps');
    await expect(pathfinderDownload).toHaveAttribute('href', '/api/runs/bulk-preview-0/pathfinder-steps');
    const logsDownload = runReport.getByRole('link', { name: 'Download logs', exact: true });
    await expect(logsDownload).toHaveAttribute('href', '/api/runs/bulk-preview-0/logs');
    await expect(runReport.locator('.watching-badge')).toContainText('Finished');
    await runReport.getByRole('button', { name: 'Expand replay view in this tab', exact: true }).click();
    await expect(runReport.locator('.expanded-progress')).toHaveText('100%');
    await expect(runReport.locator('.watching-badge')).toContainText('Finished');
    await runReport.getByRole('button', { name: 'Exit expanded replay view', exact: true }).click();

    const replayPreview = {
      id: 'replay-again-preview', projectId: project.id, testId: recordingIds[0], kind: 'replay' as const, aiUsed: false,
      status: 'queued', progress: 0, createdAt: now, events: [], frameVersion: 0, playbackSpeed: 1.5, controlState: 'running',
    };
    await page.route(`**/api/tests/${recordingIds[0]}/run`, async (route) => route.fulfill({ status: 202, json: replayPreview }));
    const controlActions: string[] = [];
    await page.route('**/api/runs/replay-again-preview/control', async (route) => {
      const { action } = route.request().postDataJSON() as { action: 'pause' | 'resume' | 'stop' };
      controlActions.push(action);
      if (action === 'pause') await route.fulfill({ json: { ...replayPreview, status: 'running', progress: 15, currentAction: 'Paused', controlState: 'paused' } });
      else if (action === 'resume') await route.fulfill({ json: { ...replayPreview, status: 'running', progress: 15, currentAction: 'Resuming run', controlState: 'running' } });
      else await route.fulfill({ json: { ...replayPreview, status: 'interrupted', progress: 15, currentAction: 'Run stopped', controlState: undefined, completedAt: now } });
    });
    await runReport.getByRole('button', { name: 'Re-play again', exact: true }).click();
    const liveReplay = page.getByRole('dialog', { name: 'Live browser', exact: true });
    await expect(liveReplay.getByText('RUNNING', { exact: true })).toBeVisible();
    await liveReplay.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(liveReplay.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    await liveReplay.getByRole('button', { name: 'Resume', exact: true }).click();
    await liveReplay.getByRole('button', { name: 'Stop', exact: true }).click();
    expect(controlActions).toEqual(['pause', 'resume', 'stop']);
    await expect(page.getByRole('dialog', { name: 'Run report', exact: true }).locator('.watching-badge')).toContainText('Stopped');
    await page.getByRole('button', { name: 'Close run panel', exact: true }).click();
    await page.getByRole('button', { name: 'Grid', exact: true }).click();
    await expect(collection).toHaveClass(/boxed-view/);
    await expect(page.getByRole('checkbox', { name: 'Select test Checkout release path', exact: true })).toBeChecked();

    await deleteSelected.click();
    const dialog = page.getByRole('dialog', { name: 'Delete selected tests', exact: true });
    await expect(dialog.getByText('Checkout release path', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Account draft', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete 2 tests', exact: true }).click();
    await expect(collection.locator('.test-card')).toHaveCount(0);
    for (const recordingId of recordingIds) expect((await request.get(`/api/tests/${recordingId}`)).status()).toBe(404);
  });

  test('reveals a hover edit action and persists a custom saved replay name', async ({ page, request }) => {
    const origin = uniquePublicOrigin();
    const projectResponse = await request.post('/api/projects', { data: { name: `Run rename ${Date.now()}`, origin } });
    const project = await projectResponse.json() as { id: string };
    const now = new Date().toISOString();
    const importResponse = await request.post(`/api/projects/${project.id}/recordings`, { data: {
      name: 'Rename run recording',
      recording: {
        format: 'pathproof-recording', version: 1, id: `rename-run-${Date.now()}`, name: 'Rename run recording',
        createdAt: now, startedAt: now, stoppedAt: now, durationMs: 500,
        target: { initialUrl: `${origin}/rename`, finalUrl: `${origin}/rename`, title: 'Rename' },
        browser: { viewport: { width: 1280, height: 720 }, locale: 'en-US' },
        events: [{ id: 'rename-click', sequence: 1, at: now, offsetMs: 250, kind: 'click', url: `${origin}/rename`, selector: '#continue', role: 'button', accessibleName: 'Continue' }],
      },
    } });
    const testDefinition = await importResponse.json() as { id: string };
    expect((await request.post(`/api/tests/${testDefinition.id}/run`, { data: { playbackSpeed: 1 } })).status()).toBe(202);

    await page.goto(`/projects/${project.id}`);
    const replayRow = page.locator('.run-row').first();
    await expect(replayRow).toContainText('Saved test replay 1');
    const renameButton = replayRow.getByRole('button', { name: 'Rename Saved test replay 1', exact: true });
    await expect(renameButton).toHaveCSS('opacity', '0');
    await replayRow.hover();
    await expect(renameButton).toHaveCSS('opacity', '1');
    const titleBox = await replayRow.getByText('Saved test replay 1', { exact: true }).boundingBox();
    const renameBox = await renameButton.boundingBox();
    const arrowBox = await replayRow.locator('.run-main-button > svg').last().boundingBox();
    expect(titleBox && renameBox && renameBox.x - (titleBox.x + titleBox.width)).toBeLessThan(12);
    expect(renameBox && arrowBox && renameBox.x).toBeLessThan(arrowBox?.x ?? 0);
    await renameButton.click();
    await replayRow.getByRole('textbox', { name: 'Run name', exact: true }).fill('Release candidate replay');
    await replayRow.getByRole('button', { name: 'Save run name', exact: true }).click();
    await expect(page.locator('.run-row').filter({ hasText: 'Release candidate replay' })).toBeVisible();
    await page.reload();
    await expect(page.locator('.run-row').filter({ hasText: 'Release candidate replay' })).toBeVisible();
  });

  test('renames a failed AI test and its first-run setup', async ({ page, request }) => {
    const origin = uniquePublicOrigin();
    const projectResponse = await request.post('/api/projects', { data: { name: `Failed AI naming ${Date.now()}`, origin } });
    const project = await projectResponse.json() as { id: string; name: string; origin: string; createdAt: string };
    const now = new Date().toISOString();
    const failedTest = {
      id: 'failed-ai-test', projectId: project.id, name: 'Acme Ltd. regression', seedUrls: [`${origin}/support`],
      status: 'failed', coverage: 0, createdAt: now, lastRunId: 'failed-first-run', aiInstructions: 'Inspect the page.',
    };
    const failedRun = {
      id: 'failed-first-run', projectId: project.id, testId: failedTest.id, kind: 'discovery', aiUsed: true,
      status: 'failed', progress: 25, currentAction: 'Run failed', createdAt: now, completedAt: now,
      events: [], frameVersion: 1, error: 'Setup failed',
    };
    await page.route(`**/api/projects/${project.id}`, async (route) => route.fulfill({ json: {
      project: { ...project, status: 'attention' }, tests: [failedTest], runs: [failedRun],
    } }));
    await page.route('**/api/tests/failed-ai-test', async (route) => {
      const body = route.request().postDataJSON() as { name: string };
      await route.fulfill({ json: { ...failedTest, name: body.name } });
    });
    await page.route('**/api/runs/failed-first-run', async (route) => {
      const body = route.request().postDataJSON() as { name: string };
      await route.fulfill({ json: { ...failedRun, name: body.name } });
    });

    await page.goto(`/projects/${project.id}`);
    const testCard = page.locator('.test-card').filter({ hasText: 'Acme Ltd. regression' });
    await expect(testCard.getByText('Setup failed', { exact: true })).toBeVisible();
    await expect(testCard.getByText('Latest: failed', { exact: true })).toBeVisible();
    const renameTest = testCard.getByRole('button', { name: 'Rename Acme Ltd. regression', exact: true });
    const deleteTest = testCard.getByRole('button', { name: 'Delete Acme Ltd. regression', exact: true });
    const renameTestBox = await renameTest.boundingBox();
    const deleteTestBox = await deleteTest.boundingBox();
    expect(renameTestBox && deleteTestBox && renameTestBox.x).toBeLessThan(deleteTestBox?.x ?? 0);
    await renameTest.click();
    await testCard.getByRole('textbox', { name: 'Automated test name', exact: true }).fill('Acme Ltd. support regression');
    await testCard.getByRole('button', { name: 'Save automated test name', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Acme Ltd. support regression', exact: true })).toBeVisible();

    const setupRow = page.locator('.run-row').filter({ hasText: 'First-run setup' });
    const renameSetup = setupRow.getByRole('button', { name: 'Rename First-run setup', exact: true });
    await setupRow.hover();
    await renameSetup.click();
    await setupRow.getByRole('textbox', { name: 'Run name', exact: true }).fill('Failed support setup');
    await setupRow.getByRole('button', { name: 'Save run name', exact: true }).click();
    await expect(page.locator('.run-row').filter({ hasText: 'Failed support setup' })).toBeVisible();
  });

  test('selects and deletes recent runs individually and in bulk without deleting the automated test', async ({ page, request }) => {
    const origin = uniquePublicOrigin();
    const projectResponse = await request.post('/api/projects', { data: { name: `Run history deletion ${Date.now()}`, origin } });
    const project = await projectResponse.json() as { id: string; name: string; origin: string; createdAt: string };
    const now = new Date().toISOString();
    const testId = 'run-history-test';
    const runs = [3, 2, 1].map((number) => ({
      id: `run-history-${number}`, name: `Saved test replay ${number}`, projectId: project.id, testId, kind: 'replay', aiUsed: false,
      status: 'passed', progress: 100, currentAction: 'Run complete', createdAt: new Date(Date.now() + number * 1_000).toISOString(), completedAt: now,
      events: [], frameVersion: 1, playbackSpeed: 1,
    }));
    await page.route(`**/api/projects/${project.id}`, async (route) => route.fulfill({ json: {
      project: { ...project, status: 'ready' },
      tests: [{ id: testId, projectId: project.id, name: 'Persistent automated test', seedUrls: [`${origin}/history`], status: 'passed', coverage: 100, createdAt: now, lastRunId: runs[0].id, plan: { version: 1, pages: [`${origin}/history`], steps: [], generatedBy: 'browser-recording' } }],
      runs,
    } }));
    let bulkDeleteBody: { runIds: string[] } | undefined;
    await page.route('**/api/runs/bulk-delete', async (route) => {
      bulkDeleteBody = route.request().postDataJSON() as { runIds: string[] };
      await route.fulfill({ json: { deleted: bulkDeleteBody.runIds.length } });
    });
    let individuallyDeleted = '';
    await page.route('**/api/runs/run-history-*', async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue();
      individuallyDeleted = new URL(route.request().url()).pathname.split('/').pop() || '';
      await route.fulfill({ status: 204 });
    });

    await page.goto(`/projects/${project.id}`);
    await expect(page.getByRole('checkbox', { name: 'Select all recent runs', exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Select run Saved test replay 3', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Select run Saved test replay 2', exact: true }).check();
    await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Delete selected runs', exact: true }).click();
    const bulkDialog = page.getByRole('dialog', { name: 'Delete selected runs', exact: true });
    await expect(bulkDialog.getByText('Saved test replay 3', { exact: true })).toBeVisible();
    await expect(bulkDialog.getByText('Saved test replay 2', { exact: true })).toBeVisible();
    await bulkDialog.getByRole('button', { name: 'Delete 2 runs', exact: true }).click();
    expect(new Set(bulkDeleteBody?.runIds)).toEqual(new Set(['run-history-3', 'run-history-2']));
    await expect(page.locator('.run-row')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Persistent automated test', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Delete Saved test replay 1', exact: true }).click();
    const singleDialog = page.getByRole('dialog', { name: 'Delete run', exact: true });
    await expect(singleDialog.getByText('Delete “Saved test replay 1”?', { exact: true })).toBeVisible();
    await singleDialog.getByRole('button', { name: 'Delete run', exact: true }).click();
    expect(individuallyDeleted).toBe('run-history-1');
    await expect(page.getByRole('heading', { name: 'Recent runs', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Persistent automated test', exact: true })).toBeVisible();
  });

  test('selects and deletes an AI-generated automated test', async ({ page, request }) => {
    const origin = uniquePublicOrigin();
    const projectResponse = await request.post('/api/projects', { data: { name: `AI deletion ${Date.now()}`, origin } });
    expect(projectResponse.status()).toBe(201);
    const project = await projectResponse.json() as { id: string; name: string; origin: string; createdAt: string; status: string };
    const now = new Date().toISOString();
    const aiTestId = '11111111-1111-4111-8111-111111111111';
    const aiRunId = '22222222-2222-4222-8222-222222222222';
    const aiName = 'AI restaurant navigation';

    await page.route(`**/api/projects/${project.id}`, async (route) => {
      await route.fulfill({ json: {
        project,
        tests: [{
          id: aiTestId, projectId: project.id, name: aiName, seedUrls: [origin], status: 'ready', coverage: 75,
          createdAt: now, lastRunId: aiRunId, aiInstructions: 'Open Restaurants.',
          plan: { version: 1, pages: [origin], generatedBy: 'ai-assisted', steps: [{ id: 'step-1', kind: 'navigate', label: 'Open /', url: origin }] },
        }],
        runs: [{ id: aiRunId, projectId: project.id, testId: aiTestId, kind: 'discovery', aiUsed: true, status: 'passed', progress: 100, createdAt: now, completedAt: now, events: [], frameVersion: 0 }],
      } });
    });
    let deletedTestId = '';
    await page.route(`**/api/tests/${aiTestId}`, async (route) => {
      deletedTestId = aiTestId;
      await route.fulfill({ status: 204, body: '' });
    });

    await page.goto(`/projects/${project.id}`);
    const card = page.locator('.test-card').filter({ hasText: aiName });
    await card.getByRole('checkbox', { name: `Select test ${aiName}`, exact: true }).check();
    await page.getByRole('button', { name: 'Delete selected', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete', exact: true });
    await expect(dialog).toContainText('saved Pathfinder steps');
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

    expect(deletedTestId).toBe(aiTestId);
    await expect(card).toHaveCount(0);
  });

  test('keeps the primary dashboard actions usable on a phone viewport', async ({ page, request }) => {
    const projectName = `Mobile project ${Date.now()}`;
    const response = await request.post('/api/projects', {
      data: { name: projectName, origin: uniquePublicOrigin() },
    });
    expect(response.ok()).toBeTruthy();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Add website', exact: true })).toBeVisible();

    const card = page.locator('.mobile-project-card').filter({ hasText: projectName });
    await expect(card).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Select all visible projects' })).toBeVisible();
    await expect(card.locator('.status-badge')).toHaveText('Needs setup');
    await expect(card.getByText('0 of 0 tests ready', { exact: true })).toBeVisible();
    await expect(card.getByRole('checkbox', { name: `Select ${projectName}` })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Open project', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Help: Project overview' })).toHaveCount(0);
    await card.getByRole('checkbox', { name: `Select ${projectName}` }).check();
    await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();

    const horizontalOverflow = await page.evaluate(() => {
      window.scrollTo({ left: 10_000 });
      return {
        overflow: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - window.innerWidth,
        pageScroll: window.scrollX,
      };
    });
    expect(horizontalOverflow.overflow).toBeLessThanOrEqual(1);
    expect(horizontalOverflow.pageScroll).toBe(0);
  });
});
