import { expect, test, type APIRequestContext } from '@playwright/test';
import { randomBytes } from 'node:crypto';

const discoveryEnabled = process.env.RUN_DISCOVERY_E2E === '1';

function uniqueFixtureOrigin() {
  const octets = [...randomBytes(3)].map((value) => 1 + (value % 254));
  return `http://127.${octets.join('.')}:4317`;
}

type Run = {
  id: string;
  kind: 'discovery' | 'replay';
  status: 'queued' | 'running' | 'passed' | 'failed' | 'interrupted';
  aiUsed: boolean;
  progress: number;
  currentUrl?: string;
  error?: string;
  events: Array<{ type: string; label: string; url?: string; expected?: string; actual?: string }>;
};

async function waitForRun(request: APIRequestContext, runId: string): Promise<Run> {
  let latest: Run | undefined;

  await expect.poll(async () => {
    const response = await request.get(`/api/runs/${runId}`);
    expect(response.ok()).toBeTruthy();
    latest = await response.json() as Run;
    return latest.status;
  }, {
    message: `run ${runId} should complete`,
    timeout: 40_000,
    intervals: [250, 500, 1_000],
  }).toMatch(/passed|failed/);

  return latest!;
}

test.describe('discovery and deterministic replay API', () => {
  test.skip(!discoveryEnabled, 'Set RUN_DISCOVERY_E2E=1 and PATHPROOF_ALLOW_LOCALHOST=1 to exercise localhost crawling.');

  test('fails instruction-driven setup when AI is unavailable instead of saving a partial baseline', async ({ request }) => {
    test.skip(process.env.PATHPROOF_DISABLE_AI !== '1', 'This regression exercises the explicitly disabled AI path.');
    const fixtureUrl = uniqueFixtureOrigin();
    const projectResponse = await request.post('/api/projects', {
      data: { name: `Unavailable AI ${Date.now()}`, origin: fixtureUrl },
    });
    expect(projectResponse.status()).toBe(201);
    const project = await projectResponse.json() as { id: string };

    const createResponse = await request.post(`/api/projects/${project.id}/tests`, {
      data: {
        name: 'Instruction-driven setup',
        seedUrls: [`${fixtureUrl}/seed`],
        aiInstructions: 'Hover over Products and click the first submenu item.',
      },
    });
    expect(createResponse.status()).toBe(202);
    const created = await createResponse.json() as { test: { id: string }; run: Run };

    const discovery = await waitForRun(request, created.run.id);
    expect(discovery.status).toBe('failed');
    expect(discovery.progress).toBeLessThan(100);
    expect(discovery.error).toContain('AI instruction planning could not start: AI is disabled by PATHPROOF_DISABLE_AI.');
    expect(discovery.events.at(-1)).toMatchObject({ type: 'complete', status: 'failed' });

    const detailResponse = await request.get(`/api/projects/${project.id}`);
    const detail = await detailResponse.json() as { tests: Array<{ id: string; status: string; plan?: unknown }> };
    expect(detail.tests.find((test) => test.id === created.test.id)).toMatchObject({ status: 'failed' });
    expect(detail.tests.find((test) => test.id === created.test.id)?.plan).toBeUndefined();
  });

  test('discovers only direct same-origin children, becomes ready, then replays without AI', async ({ request }) => {
    const suffix = `${Date.now()}-${test.info().parallelIndex}`;
    const fixtureUrl = uniqueFixtureOrigin();
    const projectResponse = await request.post('/api/projects', {
      data: {
        name: `Fixture project ${suffix}`,
        origin: fixtureUrl,
      },
    });
    expect(projectResponse.ok()).toBeTruthy();
    const project = await projectResponse.json() as { id: string };

    const createResponse = await request.post(`/api/projects/${project.id}/tests`, {
      data: {
        name: 'Seed catalog regression',
        seedUrls: [`${fixtureUrl}/seed`],
      },
    });
    expect(createResponse.status()).toBe(202);
    const created = await createResponse.json() as {
      test: { id: string; status: string };
      run: Run;
    };

    expect(created.run.kind).toBe('discovery');
    expect(typeof created.run.aiUsed).toBe('boolean');
    const discovery = await waitForRun(request, created.run.id);
    expect(discovery.status, discovery.error || discovery.events.at(-1)?.actual || 'Discovery did not pass').toBe('passed');
    expect(discovery.progress).toBe(100);
    expect(discovery.events.filter((event) => event.type === 'navigate')).toHaveLength(2);
    expect(discovery.events.some((event) => /Anrede|Use (Previous|Next)/i.test(event.label))).toBe(false);
    if (process.env.PATHPROOF_DISABLE_AI === '1') {
      expect(discovery.aiUsed).toBe(false);
      expect(discovery.events.some((event) => /Skipped unstable control: Use View status/i.test(event.label))).toBe(true);
    }

    const detailResponse = await request.get(`/api/projects/${project.id}`);
    expect(detailResponse.ok()).toBeTruthy();
    const detail = await detailResponse.json() as {
      tests: Array<{
        id: string;
        status: string;
        aiInstructions?: string;
        plan?: { pages: string[]; steps: Array<{ kind: string; label: string; metadata?: { x?: number; y?: number; pointerPath?: unknown[] } }> };
      }>;
    };
    const savedTest = detail.tests.find((candidate) => candidate.id === created.test.id);
    expect(savedTest?.status).toBe('ready');
    expect(savedTest?.aiInstructions).toBeUndefined();
    expect(savedTest?.plan?.pages).toContain(`${fixtureUrl}/seed`);
    expect(savedTest?.plan?.pages).toContain(`${fixtureUrl}/child`);
    expect(savedTest?.plan?.pages).not.toContain(`${fixtureUrl}/grandchild`);
    expect(savedTest?.plan?.steps.some((step) => /View status/i.test(step.label))).toBe(false);
    expect(savedTest?.plan?.steps.some((step) => /Anrede|Use (Previous|Next)/i.test(step.label))).toBe(false);
    const interactiveSteps = savedTest?.plan?.steps.filter((step) => ['click', 'sort', 'filter'].includes(step.kind)) ?? [];
    expect(interactiveSteps.length).toBeGreaterThan(0);
    for (const step of interactiveSteps) {
      expect(step.metadata?.x).toEqual(expect.any(Number));
      expect(step.metadata?.y).toEqual(expect.any(Number));
      expect(step.metadata?.pointerPath?.length).toBeGreaterThanOrEqual(6);
    }
    const smoothScrollSteps = savedTest?.plan?.steps.filter((step) => step.kind === 'scroll') ?? [];
    expect(smoothScrollSteps.length).toBeGreaterThan(0);
    for (const step of smoothScrollSteps) expect(step.metadata?.y).toEqual(expect.any(Number));

    const mutationState = await request.get(`${fixtureUrl}/mutation-state`);
    expect(mutationState.ok()).toBeTruthy();
    expect(await mutationState.json()).toEqual({ mutationCount: 0 });

    const destructiveEvents = discovery.events.filter((event) =>
      /delete|purchase|destructive action triggered/i.test(event.label),
    );
    expect(destructiveEvents).toEqual([]);

    const replayResponse = await request.post(`/api/tests/${created.test.id}/runs`);
    expect(replayResponse.status()).toBe(202);
    const replayCreated = await replayResponse.json() as Run | { run: Run };
    const replaySeed = 'run' in replayCreated ? replayCreated.run : replayCreated;
    expect(replaySeed.aiUsed).toBe(false);
    const replay = await waitForRun(request, replaySeed.id);
    expect(replay.status).toBe('passed');
    expect(replay.aiUsed).toBe(false);

    const frameResponse = await request.get(`/api/runs/${replay.id}/frame`);
    expect(frameResponse.ok()).toBeTruthy();

    const failedCreateResponse = await request.post(`/api/projects/${project.id}/tests`, {
      data: {
        name: 'Unavailable seed regression',
        seedUrls: [`${fixtureUrl}/missing`],
      },
    });
    expect(failedCreateResponse.status()).toBe(202);
    const failedCreated = await failedCreateResponse.json() as { run: Run };
    const failedRun = await waitForRun(request, failedCreated.run.id);
    expect(failedRun.status).toBe('failed');
    expect(failedRun.progress).toBeLessThan(100);
  });

  test('imports and replays a recorded browser journey with exact pointer coordinates and a live stream', async ({ request, browser }) => {
    const fixtureUrl = uniqueFixtureOrigin();
    const probeContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const probePage = await probeContext.newPage();
    await probePage.goto(`${fixtureUrl}/seed`);
    await probePage.locator('#filter').fill('amber');
    await probePage.locator('#sort').selectOption('desc');
    const incrementBox = await probePage.locator('#increment').boundingBox();
    expect(incrementBox).toBeTruthy();
    const clickX = incrementBox!.x + incrementBox!.width / 2;
    const clickY = incrementBox!.y + incrementBox!.height / 2;
    await probeContext.close();
    const projectResponse = await request.post('/api/projects', { data: { name: `Recorded fixture ${Date.now()}`, origin: fixtureUrl } });
    expect(projectResponse.status()).toBe(201);
    const project = await projectResponse.json() as { id: string };
    const now = new Date().toISOString();
    const importResponse = await request.post(`/api/projects/${project.id}/recordings`, { data: {
      name: 'Recorded catalog controls',
      recording: {
        format: 'pathproof-recording', version: 1, id: `fixture-recording-${Date.now()}`, name: 'Recorded catalog controls',
        createdAt: now, startedAt: now, stoppedAt: new Date(Date.now() + 1_500).toISOString(), durationMs: 1_500,
        target: { initialUrl: `${fixtureUrl}/seed`, finalUrl: `${fixtureUrl}/seed`, title: 'Seed catalog' },
        browser: { viewport: { width: 1280, height: 720 }, locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce' },
        events: [
          { id: 'input-1', sequence: 1, at: now, offsetMs: 300, kind: 'input', url: `${fixtureUrl}/seed`, selector: '#filter', role: 'searchbox', accessibleName: 'Filter products', tagName: 'input', value: 'amber' },
          { id: 'select-1', sequence: 2, at: now, offsetMs: 600, kind: 'change', url: `${fixtureUrl}/seed`, selector: '#sort', role: 'combobox', accessibleName: 'Sort products', tagName: 'select', value: 'desc', data: { inputType: 'select-one' } },
          { id: 'move-1', sequence: 3, at: now, offsetMs: 800, kind: 'mousemove', url: `${fixtureUrl}/seed`, x: clickX - 80, y: clickY - 40, width: 1280, height: 720 },
          { id: 'click-1', sequence: 4, at: now, offsetMs: 900, kind: 'click', url: `${fixtureUrl}/seed`, selector: '#increment', role: 'button', accessibleName: 'Add one to counter', tagName: 'button', x: clickX, y: clickY, width: 1280, height: 720 },
        ],
      },
    } });
    expect(importResponse.status()).toBe(201);
    const imported = await importResponse.json() as { id: string; source: string; browserState?: { reducedMotion?: string }; plan: { generatedBy: string; steps: Array<{ metadata?: { x?: number; y?: number; pointerPath?: unknown[] } }> } };
    expect(imported.source).toBe('recording');
    expect(imported.browserState?.reducedMotion).toBe('reduce');
    expect(imported.plan.generatedBy).toBe('browser-recording');
    expect(imported.plan.steps).toHaveLength(4);
    expect(imported.plan.steps.at(-1)?.metadata).toMatchObject({ x: clickX, y: clickY });
    expect(imported.plan.steps.at(-1)?.metadata?.pointerPath).toHaveLength(1);

    const replayResponse = await request.post(`/api/tests/${imported.id}/run`);
    expect(replayResponse.status()).toBe(202);
    const replaySeed = await replayResponse.json() as Run;
    const streamResponsePromise = request.get(`/api/runs/${replaySeed.id}/stream`, { timeout: 40_000 });
    const replay = await waitForRun(request, replaySeed.id);
    expect(replay.status).toBe('passed');
    expect(replay.events.filter((event) => event.type === 'action')).toHaveLength(3);
    const streamResponse = await streamResponsePromise;
    expect(streamResponse.ok()).toBeTruthy();
    expect(streamResponse.headers()['content-type']).toContain('multipart/x-mixed-replace');
    expect((await streamResponse.body()).indexOf(Buffer.from([0xff, 0xd8, 0xff]))).toBeGreaterThan(-1);
  });

  test('replays a timed hover path, reveals a delayed submenu, and tolerates coordinate drift', async ({ request, browser }) => {
    const fixtureUrl = uniqueFixtureOrigin();
    const probeContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const probePage = await probeContext.newPage();
    await probePage.goto(`${fixtureUrl}/hover-menu`);
    const menuBox = await probePage.locator('#products-menu').boundingBox();
    expect(menuBox).toBeTruthy();
    const menuPoint = { x: menuBox!.x + menuBox!.width / 2, y: menuBox!.y + menuBox!.height / 2 };
    await probePage.mouse.move(menuPoint.x, menuPoint.y);
    await probePage.waitForTimeout(380);
    const destination = probePage.locator('#hover-destination');
    await expect(destination).toBeVisible();
    const destinationBox = await destination.boundingBox();
    expect(destinationBox).toBeTruthy();
    const destinationPoint = { x: destinationBox!.x + destinationBox!.width / 2, y: destinationBox!.y + destinationBox!.height / 2 };
    await probeContext.close();

    const projectResponse = await request.post('/api/projects', { data: { name: `Hover fixture ${Date.now()}`, origin: fixtureUrl } });
    expect(projectResponse.status()).toBe(201);
    const project = await projectResponse.json() as { id: string };
    const now = new Date().toISOString();
    const drift = 180;
    const transitMoves = Array.from({ length: 140 }, (_value, index) => {
      const progress = (index + 1) / 141;
      return {
        id: `move-transit-${index}`, sequence: index + 3, at: now, offsetMs: 700 + index, kind: 'mousemove',
        url: `${fixtureUrl}/hover-menu`, x: menuPoint.x + (destinationPoint.x - menuPoint.x) * progress,
        y: menuPoint.y + (destinationPoint.y - menuPoint.y) * progress, width: 1280, height: 720,
      };
    });
    const importResponse = await request.post(`/api/projects/${project.id}/recordings`, { data: {
      name: 'Delayed product menu',
      recording: {
        format: 'pathproof-recording', version: 1, id: `hover-recording-${Date.now()}`, name: 'Delayed product menu',
        createdAt: now, startedAt: now, stoppedAt: new Date(Date.now() + 1_000).toISOString(), durationMs: 1_000,
        target: { initialUrl: `${fixtureUrl}/hover-menu`, finalUrl: `${fixtureUrl}/hover-result`, title: 'Hover menu' },
        browser: { viewport: { width: 1280, height: 720 }, locale: 'en-US', timezoneId: 'UTC' },
        events: [
          { id: 'move-start', sequence: 1, at: now, offsetMs: 100, kind: 'mousemove', url: `${fixtureUrl}/hover-menu`, x: 30, y: 30, width: 1280, height: 720 },
          { id: 'move-menu', sequence: 2, at: now, offsetMs: 250, kind: 'mousemove', url: `${fixtureUrl}/hover-menu`, selector: '#products-menu', role: 'button', accessibleName: 'Products', x: menuPoint.x, y: menuPoint.y, width: 1280, height: 720 },
          ...transitMoves,
          { id: 'move-child', sequence: 143, at: now, offsetMs: 850, kind: 'mousemove', url: `${fixtureUrl}/hover-menu`, selector: '#hover-destination', role: 'link', accessibleName: 'Technology details', x: destinationPoint.x, y: destinationPoint.y, width: 1280, height: 720 },
          { id: 'click-child', sequence: 144, at: now, offsetMs: 930, kind: 'click', url: `${fixtureUrl}/hover-menu`, selector: '#hover-destination', role: 'link', accessibleName: 'Technology details', tagName: 'a', x: destinationPoint.x + drift, y: destinationPoint.y, width: 1280, height: 720, data: { targetRect: { x: destinationBox!.x + drift, y: destinationBox!.y, width: destinationBox!.width, height: destinationBox!.height } } },
        ],
      },
    } });
    expect(importResponse.status()).toBe(201);
    const imported = await importResponse.json() as { id: string; plan: { steps: Array<{ metadata?: Record<string, unknown> }> } };
    expect(imported.plan.steps.at(-1)?.metadata).toMatchObject({ targetOffsetX: 0.5, targetOffsetY: 0.5, recordedOffsetMs: 930 });
    expect(imported.plan.steps.at(-1)?.metadata?.pointerPath).toEqual(expect.arrayContaining([expect.objectContaining({ selector: '#products-menu' })]));

    const replayResponse = await request.post(`/api/tests/${imported.id}/run`);
    expect(replayResponse.status()).toBe(202);
    const replaySeed = await replayResponse.json() as Run;
    const replay = await waitForRun(request, replaySeed.id);
    expect(replay.status).toBe('passed');
    expect(replay.currentUrl).toBe(`${fixtureUrl}/hover-result`);
    expect(replay.events.some((event) => event.type === 'warning' && /recorded position changed/i.test(event.label))).toBe(true);

    expect((await request.delete(`/api/projects/${project.id}`)).status()).toBe(204);
  });

  test('imports and replays a native text-selection drag with visible highlight evidence', async ({ request, browser }) => {
    const fixtureUrl = uniqueFixtureOrigin();
    const probeContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const probePage = await probeContext.newPage();
    await probePage.goto(`${fixtureUrl}/text-selection`);
    const drag = await probePage.locator('#selection-copy').evaluate((element) => {
      const text = element.firstChild;
      if (!text?.textContent) throw new Error('Selection fixture text is unavailable.');
      const characterRect = (index: number) => {
        const range = document.createRange();
        range.setStart(text, index);
        range.setEnd(text, index + 1);
        const rect = range.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      };
      const first = characterRect(0);
      const last = characterRect(15);
      return {
        start: { x: first.left + 2, y: (first.top + first.bottom) / 2 },
        end: { x: last.right - 2, y: (last.top + last.bottom) / 2 },
      };
    });
    await probePage.mouse.move(drag.start.x, drag.start.y);
    await probePage.mouse.down();
    await probePage.mouse.move(drag.end.x, drag.end.y, { steps: 24 });
    await probePage.mouse.up();
    const selection = await probePage.evaluate(() => {
      const value = document.getSelection();
      return {
        type: value?.type,
        direction: value?.direction,
        anchorOffset: value?.anchorOffset,
        focusOffset: value?.focusOffset,
        selectedTextLength: value?.toString().length ?? 0,
        fixtureState: document.body.dataset.selectedTextLength,
      };
    });
    expect(selection.selectedTextLength).toBeGreaterThan(0);
    expect(selection.fixtureState).toBe(String(selection.selectedTextLength));
    await probeContext.close();

    const projectResponse = await request.post('/api/projects', { data: { name: `Selection fixture ${Date.now()}`, origin: fixtureUrl } });
    expect(projectResponse.status()).toBe(201);
    const project = await projectResponse.json() as { id: string };
    const now = new Date().toISOString();
    const moveEvents = Array.from({ length: 18 }, (_value, index) => {
      const progress = (index + 1) / 18;
      return {
        id: `selection-move-${index}`,
        sequence: index + 2,
        at: now,
        offsetMs: 120 + index * 14,
        kind: 'mousemove',
        url: `${fixtureUrl}/text-selection`,
        selector: '#selection-copy',
        x: drag.start.x + (drag.end.x - drag.start.x) * progress,
        y: drag.start.y + (drag.end.y - drag.start.y) * progress,
        width: 1280,
        height: 720,
        data: { button: 0, buttons: 1, pointerType: 'mouse', cursor: 'text' },
      };
    });
    const pointerUpOffset = 120 + moveEvents.length * 14;
    const importResponse = await request.post(`/api/projects/${project.id}/recordings`, { data: {
      name: 'Native text-selection journey',
      recording: {
        format: 'pathproof-recording', version: 1, id: `selection-recording-${Date.now()}`, name: 'Native text-selection journey',
        createdAt: now, startedAt: now, stoppedAt: new Date(Date.now() + 1_000).toISOString(), durationMs: 1_000,
        target: { initialUrl: `${fixtureUrl}/text-selection`, finalUrl: `${fixtureUrl}/text-selection`, title: 'Text selection' },
        browser: { viewport: { width: 1280, height: 720 }, locale: 'en-US', timezoneId: 'UTC' },
        events: [
          { id: 'selection-down', sequence: 1, at: now, offsetMs: 100, kind: 'pointerdown', url: `${fixtureUrl}/text-selection`, selector: '#selection-copy', tagName: 'p', x: drag.start.x, y: drag.start.y, width: 1280, height: 720, data: { button: 0, buttons: 1, pointerType: 'mouse', cursor: 'text' } },
          ...moveEvents,
          { id: 'selection-up', sequence: 20, at: now, offsetMs: pointerUpOffset, kind: 'pointerup', url: `${fixtureUrl}/text-selection`, selector: '#selection-copy', tagName: 'p', x: drag.end.x, y: drag.end.y, width: 1280, height: 720, data: { button: 0, buttons: 0, pointerType: 'mouse', cursor: 'text', selection } },
          { id: 'selection-click-through', sequence: 21, at: now, offsetMs: pointerUpOffset + 1, kind: 'click', url: `${fixtureUrl}/text-selection`, selector: '#selection-copy', tagName: 'p', x: drag.end.x, y: drag.end.y, width: 1280, height: 720, data: { button: 0, buttons: 0, pointerType: 'mouse', cursor: 'text' } },
        ],
      },
    } });
    expect(importResponse.status()).toBe(201);
    const imported = await importResponse.json() as { id: string; plan: { steps: Array<{ kind: string; metadata?: Record<string, unknown> }> } };
    expect(imported.plan.steps).toHaveLength(2);
    expect(imported.plan.steps[1]).toMatchObject({
      kind: 'select-text',
      metadata: { expectedSelectedTextLength: selection.selectedTextLength },
    });
    expect(imported.plan.steps[1].metadata?.dragPath).toHaveLength(moveEvents.length);

    const replayResponse = await request.post(`/api/tests/${imported.id}/run`);
    expect(replayResponse.status()).toBe(202);
    const replaySeed = await replayResponse.json() as Run;
    const replay = await waitForRun(request, replaySeed.id);
    expect(replay.status).toBe('passed');
    expect(replay.events.find((item) => item.type === 'action' && /Select text/i.test(item.label))).toMatchObject({
      expected: `Native selection contains ${selection.selectedTextLength} characters`,
      actual: `Native document selection contains ${selection.selectedTextLength} characters`,
    });

    const frameResponse = await request.get(`/api/runs/${replay.id}/frame`);
    expect(frameResponse.ok()).toBeTruthy();
    const frameBase64 = (await frameResponse.body()).toString('base64');
    const evidencePage = await browser.newPage();
    const highlightedPixels = await evidencePage.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/jpeg;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return 0;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let matches = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] < 80 && pixels[index + 1] > 190 && pixels[index + 2] < 90) matches += 1;
      }
      return matches;
    }, frameBase64);
    await evidencePage.close();
    expect(highlightedPixels).toBeGreaterThan(100);
    expect((await request.delete(`/api/projects/${project.id}`)).status()).toBe(204);
  });
});
