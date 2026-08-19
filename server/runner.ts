import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Locator, type Page } from 'playwright';
import type { BrowserReplayState, PlanStep, Run, RunEvent, TestDefinition, TestPlan } from '../src/shared.js';
import { aiConfigurationIssue, planActionsWithAi, planNextActionWithAi } from './ai-planner.js';
import { attachReplayCursor, moveReplayPointer, replayPointerPosition } from './replay-cursor.js';
import { assertSafeTarget, sameOrigin } from './security.js';
import type { Database, JsonStore } from './store.js';

const NAVIGATION_TIMEOUT_MS = Number(process.env.PATHPROOF_NAVIGATION_TIMEOUT_MS ?? 20_000);
const MAX_DISCOVERED_PAGES = Number(process.env.PATHPROOF_MAX_PAGES ?? 20);
const MAX_ACTIONS_PER_PAGE = 8;
const DEFAULT_VIEWPORT = { width: 1600, height: 1000 };
const NAVIGATION_ATTEMPTS = 3;
const STREAM_FPS = Math.min(60, Math.max(1, Number(process.env.PATHPROOF_STREAM_FPS ?? 60)));
const STREAM_FRAME_INTERVAL_MS = STREAM_FPS >= 60 ? 0 : 1_000 / STREAM_FPS;
const TRANSIENT_NAVIGATION_ERROR = /ERR_(NETWORK_CHANGED|CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT|INTERNET_DISCONNECTED)|Navigation timeout/i;

type Job = { runId: string; testId: string };

type RunControl = {
  paused: boolean;
  stopRequested: boolean;
  previousAction?: string;
  browser?: Browser;
  waiters: Set<() => void>;
};

class RunStoppedError extends Error {
  constructor() {
    super('Run stopped by user.');
    this.name = 'RunStoppedError';
  }
}

type ReplayPointerGeometry = {
  scaleX: number;
  scaleY: number;
  recordedX: number;
  recordedY: number;
  path: Array<{ x: number; y: number; offsetMs: number }>;
};

type ReplayPointerPoint = {
  x: number;
  y: number;
  position: { x: number; y: number };
  warning?: { expected: string; actual: string };
};

type DiscoveryPointerTarget = {
  position: { x: number; y: number };
  metadata: Record<string, unknown>;
};

interface CandidateAction {
  kind: 'click' | 'sort' | 'filter' | 'hover' | 'scroll' | 'fill' | 'drag-drop' | 'canvas-draw' | 'file';
  label: string;
  context?: string;
  locator?: NonNullable<PlanStep['locator']>;
  targetLocator?: NonNullable<PlanStep['locator']>;
  action?: 'select' | 'fill' | 'click' | 'hover' | 'check' | 'scroll-slow' | 'drag' | 'canvas-draw' | 'set-files';
  acceptsValue?: boolean;
  consent?: boolean;
  dismissal?: boolean;
  fileName?: string;
  value?: string;
}

function now(): string {
  return new Date().toISOString();
}

function textFingerprint(value: string): string {
  return createHash('sha256').update(value.replace(/\s+/g, ' ').trim().slice(0, 10_000)).digest('hex').slice(0, 16);
}

function event(runId: string, type: RunEvent['type'], label: string, status: RunEvent['status'], fields: Partial<RunEvent> = {}): RunEvent {
  return { id: randomUUID(), runId, at: now(), type, label, status, ...fields };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').trim();
}

function playbackDelay(durationMs: number, playbackSpeed: number): number {
  return Math.max(0, Math.round(durationMs / playbackSpeed));
}

export class RunCoordinator {
  private readonly queue: Job[] = [];
  private active = 0;
  private readonly subscribers = new Map<string, Set<(run: Run) => void>>();
  private readonly frameSubscribers = new Map<string, Set<(frame: Buffer) => void>>();
  private readonly latestFrames = new Map<string, Buffer>();
  private readonly liveStreams = new Set<string>();
  private readonly controls = new Map<string, RunControl>();
  readonly framesDirectory = path.resolve(process.cwd(), '.data', 'frames');

  constructor(
    private readonly store: JsonStore,
    readonly capacity = Math.min(16, Math.max(1, Number(process.env.PATHPROOF_CONCURRENCY ?? 4))),
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.framesDirectory, { recursive: true });
  }

  enqueue(job: Job): void {
    this.queue.push(job);
    void this.drain();
  }

  async pauseRun(runId: string): Promise<Run> {
    const control = this.controlFor(runId);
    const run = await this.store.mutate((database) => {
      const draft = database.runs.find((candidate) => candidate.id === runId);
      if (!draft) throw new Error(`Run ${runId} was not found.`);
      if (!['queued', 'running'].includes(draft.status)) return draft;
      if (!control.paused) control.previousAction = draft.currentAction;
      control.paused = true;
      draft.controlState = 'paused';
      draft.currentAction = 'Paused';
      return draft;
    });
    this.publish(runId);
    return run;
  }

  async resumeRun(runId: string): Promise<Run> {
    const control = this.controlFor(runId);
    control.paused = false;
    for (const resolve of control.waiters) resolve();
    control.waiters.clear();
    const run = await this.store.mutate((database) => {
      const draft = database.runs.find((candidate) => candidate.id === runId);
      if (!draft) throw new Error(`Run ${runId} was not found.`);
      if (!['queued', 'running'].includes(draft.status)) return draft;
      draft.controlState = 'running';
      draft.currentAction = control.previousAction || 'Resuming run';
      return draft;
    });
    this.publish(runId);
    return run;
  }

  async stopRun(runId: string): Promise<Run> {
    const control = this.controlFor(runId);
    control.stopRequested = true;
    control.paused = false;
    for (const resolve of control.waiters) resolve();
    control.waiters.clear();
    const queuedIndex = this.queue.findIndex((job) => job.runId === runId);
    if (queuedIndex >= 0) {
      const [job] = this.queue.splice(queuedIndex, 1);
      await this.finishInterrupted(job.runId, job.testId);
      this.controls.delete(runId);
      return this.store.snapshot().runs.find((run) => run.id === runId)!;
    }
    await this.store.mutate((database) => {
      const draft = database.runs.find((candidate) => candidate.id === runId);
      if (!draft) throw new Error(`Run ${runId} was not found.`);
      if (['queued', 'running'].includes(draft.status)) {
        draft.controlState = 'running';
        draft.currentAction = 'Stopping run';
      }
    });
    this.publish(runId);
    await control.browser?.close().catch(() => undefined);
    return this.store.snapshot().runs.find((run) => run.id === runId)!;
  }

  private controlFor(runId: string): RunControl {
    const existing = this.controls.get(runId);
    if (existing) return existing;
    const created: RunControl = { paused: false, stopRequested: false, waiters: new Set() };
    this.controls.set(runId, created);
    return created;
  }

  private async checkpoint(runId: string): Promise<void> {
    const control = this.controlFor(runId);
    if (control.stopRequested) throw new RunStoppedError();
    while (control.paused) {
      await new Promise<void>((resolve) => control.waiters.add(resolve));
      if (control.stopRequested) throw new RunStoppedError();
    }
  }

  subscribe(runId: string, listener: (run: Run) => void): () => void {
    const listeners = this.subscribers.get(runId) ?? new Set();
    listeners.add(listener);
    this.subscribers.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.subscribers.delete(runId);
    };
  }

  subscribeFrames(runId: string, listener: (frame: Buffer) => void): () => void {
    const listeners = this.frameSubscribers.get(runId) ?? new Set();
    listeners.add(listener);
    this.frameSubscribers.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.frameSubscribers.delete(runId);
    };
  }

  latestFrame(runId: string): Buffer | undefined {
    return this.latestFrames.get(runId);
  }

  async deleteRunArtifacts(runIds: Iterable<string>): Promise<void> {
    await Promise.all([...new Set(runIds)].map(async (runId) => {
      this.latestFrames.delete(runId);
      this.frameSubscribers.delete(runId);
      this.subscribers.delete(runId);
      try {
        await unlink(path.join(this.framesDirectory, `${runId}.jpg`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`Could not delete saved frame for run ${runId}:`, error);
        }
      }
    }));
  }

  private publishFrame(runId: string, frame: Buffer): void {
    this.latestFrames.set(runId, frame);
    for (const listener of this.frameSubscribers.get(runId) ?? []) listener(frame);
  }

  private async drain(): Promise<void> {
    while (this.active < this.capacity && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active += 1;
      void this.execute(job).finally(() => {
        this.active -= 1;
        void this.drain();
      });
    }
  }

  private async execute(job: Job): Promise<void> {
    const snapshot = this.store.snapshot();
    const run = snapshot.runs.find((candidate) => candidate.id === job.runId);
    const test = snapshot.tests.find((candidate) => candidate.id === job.testId);
    if (!run || !test) return;

    const control = this.controlFor(run.id);
    let browser: Browser | undefined;
    try {
      await this.checkpoint(run.id);
      await this.updateRun(run.id, (draft) => {
        draft.status = 'running';
        draft.controlState = 'running';
        draft.progress = 2;
        draft.startedAt = now();
        draft.currentAction = run.kind === 'discovery' ? 'Starting first-run setup' : 'Loading saved plan';
        draft.events.push(event(draft.id, 'status', draft.currentAction, 'running'));
      });
      browser = await chromium.launch({ headless: process.env.PATHPROOF_HEADFUL !== '1' });
      control.browser = browser;
      await this.checkpoint(run.id);
      if (run.kind === 'discovery') await this.discover(browser, run.id, test);
      else await this.replay(browser, run.id, test, Math.min(2, Math.max(0.25, run.playbackSpeed ?? 1)));
      await this.checkpoint(run.id);
      await this.finish(run.id, test.id, true);
    } catch (error) {
      if (control.stopRequested || error instanceof RunStoppedError) await this.finishInterrupted(run.id, test.id);
      else {
        const message = error instanceof Error ? error.message : String(error);
        await this.finish(run.id, test.id, false, message);
      }
    } finally {
      await browser?.close().catch(() => undefined);
      this.controls.delete(run.id);
    }
  }

  private async newPage(browser: Browser, state?: BrowserReplayState, initialUrl?: string, allowMutations = false, allowPopups = false): Promise<Page> {
    const options: BrowserContextOptions = {
      viewport: state?.viewport ?? DEFAULT_VIEWPORT,
      reducedMotion: state?.reducedMotion ?? 'no-preference',
      ignoreHTTPSErrors: process.env.PATHPROOF_IGNORE_HTTPS_ERRORS === '1',
      userAgent: state?.userAgent,
      locale: state?.locale,
      timezoneId: state?.timezoneId,
      colorScheme: state?.colorScheme,
    };
    const context = await browser.newContext(options);
    const cookies: Array<Parameters<typeof context.addCookies>[0][number]> = (state?.cookies ?? []).flatMap((cookie) => {
      const sameSite = cookie.sameSite === 'no_restriction' ? 'None' : cookie.sameSite === 'lax' ? 'Lax' : cookie.sameSite === 'strict' ? 'Strict' : cookie.sameSite;
      if (sameSite === 'unspecified') return [{ ...cookie, path: cookie.path || '/', sameSite: undefined, expires: cookie.expires && cookie.expires > 0 ? cookie.expires : undefined }];
      return [{ ...cookie, path: cookie.path || '/', sameSite, expires: cookie.expires && cookie.expires > 0 ? cookie.expires : undefined }];
    });
    if (state?.cookieHeader && initialUrl) {
      for (const part of state.cookieHeader.split(';')) {
        const separator = part.indexOf('=');
        if (separator < 1) continue;
        cookies.push({ name: part.slice(0, separator).trim(), value: part.slice(separator + 1).trim(), url: initialUrl });
      }
    }
    if (cookies.length > 0) await context.addCookies(cookies);
    if (state?.localStorage && initialUrl) {
      await context.addInitScript(({ origin, values }) => {
        if (location.origin !== origin) return;
        for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
      }, { origin: new URL(initialUrl).origin, values: state.localStorage });
    }
    const configuredPages = new WeakSet<Page>();
    const configurePage = (page: Page) => {
      if (configuredPages.has(page)) return;
      configuredPages.add(page);
      page.on('dialog', (dialog) => void dialog.dismiss());
      if (!allowPopups) page.on('popup', (popup) => void popup.close());
      page.setDefaultTimeout(8_000);
      page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    };
    context.on('page', configurePage);
    const safetyCache = new Map<string, Promise<void>>();
    await context.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      if (/^(data|blob|about):/.test(requestUrl)) return route.continue();
      if (!allowMutations && !['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
        await route.abort('blockedbyclient');
        return;
      }
      try {
        const target = new URL(requestUrl);
        let check = safetyCache.get(target.hostname);
        if (!check) {
          check = assertSafeTarget(requestUrl).then(() => undefined);
          safetyCache.set(target.hostname, check);
        }
        await check;
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
    const page = await context.newPage();
    configurePage(page);
    return page;
  }

  private async navigate(page: Page, runId: string, url: string, progress: number, options: { record?: boolean; failureStatus?: 'failed' | 'skipped' } = {}): Promise<void> {
    const record = options.record ?? true;
    const navigationEvent = event(runId, 'navigate', `Open ${url}`, 'running', { url });
    await assertSafeTarget(url);
    await this.updateRun(runId, (run) => {
      run.progress = progress;
      run.currentUrl = url;
      run.currentAction = 'Opening page';
      if (record) run.events.push(navigationEvent);
    });
    let finalError: unknown;
    for (let attempt = 1; attempt <= NAVIGATION_ATTEMPTS; attempt += 1) {
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
        if (!response) throw new Error(`No response was received for ${url}.`);
        if (response.status() >= 400) throw new Error(`${url} returned HTTP ${response.status()}.`);
        finalError = undefined;
        break;
      } catch (error) {
        finalError = error;
        if (!TRANSIENT_NAVIGATION_ERROR.test(errorMessage(error)) || attempt === NAVIGATION_ATTEMPTS) break;
        await this.addEvent(runId, event(runId, 'warning', `Temporary network problem; retrying ${new URL(url).pathname || '/'}`, 'skipped', {
          url,
          actual: `Retry ${attempt} of ${NAVIGATION_ATTEMPTS - 1}: ${errorMessage(error).split('\n')[0]}`,
        }));
        await page.waitForTimeout(attempt * 750);
      }
    }
    if (finalError) {
      if (record) await this.updateRun(runId, (run) => {
        const saved = run.events.find((candidate) => candidate.id === navigationEvent.id);
        if (saved) {
          saved.status = options.failureStatus ?? 'failed';
          saved.expected = 'Page loads successfully';
          saved.actual = errorMessage(finalError);
        }
      });
      throw finalError;
    }
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
    await this.captureFrame(page, runId);
    if (record) await this.updateRun(runId, (run) => {
      const saved = run.events.find((candidate) => candidate.id === navigationEvent.id);
      if (saved) saved.status = 'passed';
    });
  }

  private async discover(browser: Browser, runId: string, test: TestDefinition): Promise<void> {
    for (const seed of test.seedUrls) await assertSafeTarget(seed);
    const instructionDriven = Boolean(test.aiInstructions?.trim());
    const configurationIssue = instructionDriven ? aiConfigurationIssue() : undefined;
    if (configurationIssue) throw new Error(`AI instruction planning could not start: ${configurationIssue}`);
    let page = await this.newPage(browser, test.browserState, test.seedUrls[0], false, true);
    await attachReplayCursor(page);
    const pages: string[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < test.seedUrls.length; index += 1) {
      const seed = test.seedUrls[index];
      if (!seen.has(seed)) {
        seen.add(seed);
        pages.push(seed);
      }
      await this.navigate(page, runId, seed, 5 + Math.round((index / Math.max(test.seedUrls.length, 1)) * 20), { record: false });
      if (instructionDriven) continue;
      const links = await page.locator('a[href]').evaluateAll((anchors) =>
        anchors.map((anchor) => (anchor as HTMLAnchorElement).href).filter(Boolean),
      );
      for (const href of links) {
        if (pages.length >= MAX_DISCOVERED_PAGES) break;
        try {
          const normalized = new URL(href);
          normalized.hash = '';
          const value = normalized.toString();
          if (!sameOrigin(seed, value) || seen.has(value)) continue;
          await assertSafeTarget(value);
          seen.add(value);
          pages.push(value);
        } catch {
          // Invalid, cross-origin, or unsafe links are deliberately omitted.
        }
      }
    }

    const steps: PlanStep[] = [];
    const testedPages: string[] = [];
    const seedPages = new Set(test.seedUrls);
    let discoveredActions = 0;
    let usedAi = false;
    for (let index = 0; index < pages.length; index += 1) {
      const url = pages[index];
      const baseProgress = 25 + Math.round((index / Math.max(pages.length, 1)) * 55);
      try {
        await this.navigate(page, runId, url, baseProgress, { failureStatus: seedPages.has(url) ? 'failed' : 'skipped' });
      } catch (error) {
        if (seedPages.has(url)) throw error;
        continue;
      }
      testedPages.push(url);
      const title = await page.title();
      steps.push({ id: randomUUID(), kind: 'navigate', label: `Open ${new URL(url).pathname || '/'}`, url });
      steps.push({
        id: randomUUID(),
        kind: 'assert',
        label: 'Page responds and renders',
        url,
        expected: title || 'Page has visible content',
        metadata: { assertion: title ? 'title' : 'body-visible', title },
      });
      if (instructionDriven) {
        const result = await this.followAiInstructions(page, runId, test, url, baseProgress, steps, testedPages);
        page = result.page;
        discoveredActions += result.actions;
        usedAi = usedAi || result.usedAi;
        continue;
      }
      const scrollPosition = await this.smoothScrollToBottom(page);
      await this.captureFrame(page, runId);
      steps.push({ id: randomUUID(), kind: 'scroll', label: 'Scroll through primary content', url, metadata: scrollPosition });
      await this.addEvent(runId, event(runId, 'scroll', 'Inspect content below the fold', 'passed', { url }));

      const candidates = await this.discoverActions(page, instructionDriven);
      const aiPlan = await planActionsWithAi({ url, title, candidates, instructions: test.aiInstructions });
      if (aiPlan.usedAi) {
        usedAi = true;
        await this.updateRun(runId, (run) => {
          run.aiUsed = true;
          run.events.push(event(run.id, 'inspect', `AI selected ${aiPlan.actions.length} candidate ${aiPlan.actions.length === 1 ? 'interaction' : 'interactions'}`, 'passed', { url }));
        });
      } else if (aiPlan.warning) {
        await this.addEvent(runId, event(runId, 'warning', instructionDriven ? 'AI planning unavailable; no instruction-driven interactions were added' : 'AI planning unavailable; continued with local first-run setup', 'skipped', {
          url,
          actual: aiPlan.warning,
        }));
      }
      for (const [candidateIndex, candidate] of aiPlan.actions.slice(0, MAX_ACTIONS_PER_PAGE).entries()) {
        let effect: 'url' | 'content' | 'visible' = 'visible';
        try {
          if (candidateIndex > 0 || page.url() !== url) {
            await this.navigate(page, runId, url, baseProgress, { record: false });
          }
          const beforeUrl = page.url();
          const beforeText = textFingerprint(await page.locator('body').innerText().catch(() => ''));
          if (!candidate.locator) throw new Error('The selected action has no usable locator.');
          const locator = this.resolveLocator(page, candidate.locator);
          const pointerTarget = await this.moveDiscoveryPointerToLocator(page, locator);
          let attemptedMutation = false;
          const mutationMonitor = (request: { method(): string }) => {
            if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) attemptedMutation = true;
          };
          page.on('request', mutationMonitor);
          try {
            if (candidate.action === 'select') await locator.selectOption(candidate.value!);
            else if (candidate.action === 'fill') await locator.fill(candidate.value!);
            else await locator.click({ timeout: 5_000, position: pointerTarget.position });
            await page.waitForTimeout(350);
          } finally {
            page.off('request', mutationMonitor);
          }
          if (attemptedMutation) throw new Error('The control attempted a mutating network request and requires explicit review.');
          const afterText = textFingerprint(await page.locator('body').innerText().catch(() => ''));
          if (page.url() !== beforeUrl) effect = 'url';
          else if (afterText !== beforeText) effect = 'content';
          steps.push({
            id: randomUUID(),
            kind: candidate.kind,
            label: candidate.label,
            url,
            locator: candidate.locator,
            expected: effect === 'url' ? 'Navigation changes as expected' : effect === 'content' ? 'Visible results update' : 'Control remains operable',
            metadata: { action: candidate.action ?? 'click', value: candidate.value ?? '', effect, ...pointerTarget.metadata },
          });
          discoveredActions += 1;
          await this.captureFrame(page, runId);
          await this.addEvent(runId, event(runId, 'action', candidate.label, 'passed', {
            url,
            expected: effect === 'content' ? 'Visible results update' : 'Control responds',
            actual: effect === 'visible' ? 'Control accepted the interaction' : effect === 'url' ? `Navigated to ${page.url()}` : 'Visible content changed',
          }));
        } catch (error) {
          await this.addEvent(runId, event(runId, 'warning', `Skipped unstable control: ${candidate.label}`, 'skipped', {
            url,
            actual: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    }

    const plan: TestPlan = { version: 1, pages: testedPages, steps, generatedBy: usedAi ? 'ai-assisted' : 'local-smart-discovery' };
    const coverage = Math.min(100, 35 + testedPages.length * 12 + discoveredActions * 5);
    await this.store.mutate((database) => {
      const draft = database.tests.find((candidate) => candidate.id === test.id);
      if (!draft) throw new Error('Test disappeared while discovery was running.');
      draft.plan = plan;
      draft.coverage = coverage;
      draft.status = 'ready';
      this.store.recomputeProjects(database);
    });
    await page.context().close();
  }

  private async followAiInstructions(
    page: Page,
    runId: string,
    test: TestDefinition,
    seedUrl: string,
    baseProgress: number,
    steps: PlanStep[],
    testedPages: string[],
  ): Promise<{ actions: number; usedAi: boolean; page: Page }> {
    const history: Array<{ action: string; outcome: string; url: string }> = [];
    const actionCounts = new Map<string, number>();
    const unavailableLocators = new Set<string>();
    let actions = 0;
    let usedAi = false;
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const inventory = await this.discoverActions(page, true, test.files?.map((file) => file.name) ?? []);
      const candidates = inventory.filter((candidate) =>
        (actionCounts.get(`${page.url()}|${candidate.action}|${candidate.label}`) ?? 0) < 2
        && (!candidate.locator || !unavailableLocators.has(JSON.stringify(candidate.locator))),
      );
      const decision = await planNextActionWithAi({
        url: page.url(), title: await page.title(), candidates,
        instructions: test.aiInstructions ?? '', history,
      });
      usedAi = usedAi || decision.usedAi;
      if (decision.usedAi) await this.updateRun(runId, (run) => { run.aiUsed = true; });
      if (decision.warning) {
        throw new Error(`AI instruction planning could not continue: ${decision.warning}`);
      }
      if (decision.completed || !decision.action) {
        await this.addEvent(runId, event(runId, 'inspect', 'AI finished the requested journey', 'passed', { url: page.url(), actual: decision.reason }));
        break;
      }
      const candidate = decision.action;
      const beforeUrl = page.url();
      const signature = `${beforeUrl}|${candidate.action}|${candidate.label}`;
      actionCounts.set(signature, (actionCounts.get(signature) ?? 0) + 1);
      await this.updateRun(runId, (run) => {
        run.progress = Math.min(88, baseProgress + 5 + iteration * 5);
        run.currentAction = candidate.label;
      });
      try {
        if (candidate.action === 'scroll-slow') {
          const position = await this.slowScrollDown(page);
          await this.captureFrame(page, runId);
          steps.push({ id: randomUUID(), kind: 'scroll', label: candidate.label, url: beforeUrl, metadata: { ...position, slow: true } });
          await this.addEvent(runId, event(runId, 'scroll', candidate.label, 'passed', { url: beforeUrl, expected: 'Content is revealed gradually', actual: `Scrolled to ${Math.round(position.y)}px` }));
          history.push({ action: candidate.label, outcome: `Scrolled to ${Math.round(position.y)}px`, url: page.url() });
          actions += 1;
          continue;
        }
        if (!candidate.locator) throw new Error('AI selected an action without a usable control locator.');
        const locator = this.resolveLocator(page, candidate.locator);
        const pointerTarget = candidate.action === 'set-files'
          ? { position: { x: 0, y: 0 }, metadata: {} }
          : await this.moveDiscoveryPointerToLocator(page, locator);
        const beforeText = textFingerprint(await page.locator('body').innerText().catch(() => ''));
        let attemptedMutation = false;
        const popups: Page[] = [];
        const popupListener = (popup: Page) => popups.push(popup);
        if (candidate.action === 'click') page.once('popup', popupListener);
        const mutationMonitor = (request: { method(): string }) => {
          if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) attemptedMutation = true;
        };
        page.on('request', mutationMonitor);
        try {
          if (candidate.action === 'hover') await locator.hover({ position: pointerTarget.position });
          else if (candidate.action === 'select') await locator.selectOption(candidate.value!);
          else if (candidate.action === 'fill') await locator.fill(candidate.value!);
          else if (candidate.action === 'check') await locator.setChecked(true);
          else if (candidate.action === 'drag') {
            if (!candidate.targetLocator) throw new Error('The drag action has no drop target.');
            await locator.dragTo(this.resolveLocator(page, candidate.targetLocator));
          } else if (candidate.action === 'canvas-draw') await this.drawOnCanvas(page, locator);
          else if (candidate.action === 'set-files') {
            const file = test.files?.find((item) => item.name === candidate.fileName);
            if (!file) throw new Error(`Attached file ${candidate.fileName || ''} is unavailable.`);
            await locator.setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: Buffer.from(file.dataBase64, 'base64') });
          }
          else await locator.click({ timeout: 5_000, position: pointerTarget.position });
          await page.waitForTimeout(candidate.action === 'hover' ? 650 : 400);
          await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => undefined);
        } finally {
          page.off('request', mutationMonitor);
          page.off('popup', popupListener);
        }
        if (attemptedMutation && !candidate.consent) throw new Error('The control attempted a mutating network request and was blocked.');
        const popup = popups[0];
        if (popup) {
          await popup.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => undefined);
          if (!sameOrigin(seedUrl, popup.url())) {
            await popup.close().catch(() => undefined);
            throw new Error('The control opened a popup outside the project origin.');
          }
          await assertSafeTarget(popup.url());
          page = popup;
          await attachReplayCursor(page);
        }
        const afterUrl = page.url();
        if (!sameOrigin(seedUrl, afterUrl)) throw new Error('The control navigated outside the project origin.');
        await assertSafeTarget(afterUrl);
        if (!testedPages.includes(afterUrl)) testedPages.push(afterUrl);
        const afterText = textFingerprint(await page.locator('body').innerText().catch(() => ''));
        const effect: 'url' | 'content' | 'visible' = afterUrl !== beforeUrl ? 'url' : afterText !== beforeText ? 'content' : 'visible';
        const expected = candidate.action === 'hover' ? 'The related menu or controls become available' : effect === 'url' ? 'Navigation changes as instructed' : effect === 'content' ? 'Visible content updates' : 'Control remains operable';
        steps.push({
          id: randomUUID(), kind: candidate.kind, label: candidate.label, url: beforeUrl,
          locator: candidate.locator, expected,
          metadata: { action: candidate.action ?? 'click', value: candidate.value ?? '', checked: candidate.action === 'check', effect, consent: candidate.consent, targetLocator: candidate.targetLocator, fileName: candidate.fileName, openedPopup: Boolean(popup), ...pointerTarget.metadata },
        });
        actions += 1;
        await this.captureFrame(page, runId);
        const outcome = candidate.action === 'hover' ? 'Hover revealed the current menu state' : effect === 'url' ? `Navigated to ${afterUrl}` : effect === 'content' ? 'Visible content changed' : 'Control accepted the interaction';
        await this.addEvent(runId, event(runId, 'action', candidate.label, 'passed', { url: beforeUrl, expected, actual: outcome }));
        history.push({ action: candidate.label, outcome, url: afterUrl });
        if (candidate.consent || candidate.dismissal) {
          actionCounts.clear();
          unavailableLocators.clear();
        }
      } catch (error) {
        const outcome = error instanceof Error ? error.message : String(error);
        if (candidate.locator && !/covered by|intercepts pointer events/i.test(outcome)) unavailableLocators.add(JSON.stringify(candidate.locator));
        await this.addEvent(runId, event(runId, 'warning', `Skipped unsafe or unavailable action: ${candidate.label}`, 'skipped', { url: beforeUrl, actual: outcome }));
        history.push({ action: candidate.label, outcome: `Skipped: ${outcome}`, url: page.url() });
      }
    }
    return { actions, usedAi, page };
  }

  private async waitForSmoothScroll(page: Page): Promise<void> {
    await page.evaluate(`new Promise((resolve) => {
      const startedAt = performance.now();
      let previousX = window.scrollX;
      let previousY = window.scrollY;
      let stableFrames = 0;
      const check = () => {
        const settled = Math.abs(window.scrollX - previousX) < 0.5 && Math.abs(window.scrollY - previousY) < 0.5;
        stableFrames = settled ? stableFrames + 1 : 0;
        previousX = window.scrollX;
        previousY = window.scrollY;
        if (stableFrames >= 5 || performance.now() - startedAt >= 1800) resolve();
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    })`);
  }

  private async smoothScrollToBottom(page: Page): Promise<{ x: number; y: number }> {
    await page.evaluate(() => window.scrollTo({ left: 0, top: document.documentElement.scrollHeight, behavior: 'smooth' }));
    await this.waitForSmoothScroll(page);
    return page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  }

  private async slowScrollDown(page: Page): Promise<{ x: number; y: number }> {
    await page.evaluate(`new Promise((resolve) => {
      const start = window.scrollY;
      const maximum = Math.max(0, document.documentElement.scrollHeight - innerHeight);
      const target = Math.min(maximum, start + Math.max(360, innerHeight * 0.85));
      const startedAt = performance.now();
      const duration = 1800;
      const tick = (now) => {
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = progress < .5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
        window.scrollTo(0, start + (target - start) * eased);
        if (progress < 1) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    })`);
    return page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  }

  private async drawOnCanvas(page: Page, locator: Locator): Promise<void> {
    const box = await locator.boundingBox();
    if (!box || box.width < 4 || box.height < 4) throw new Error('The canvas is not currently drawable.');
    const points = [
      { x: box.x + box.width * 0.25, y: box.y + box.height * 0.55 },
      { x: box.x + box.width * 0.4, y: box.y + box.height * 0.35 },
      { x: box.x + box.width * 0.58, y: box.y + box.height * 0.65 },
      { x: box.x + box.width * 0.75, y: box.y + box.height * 0.42 },
    ];
    await page.mouse.move(points[0].x, points[0].y);
    await page.mouse.down();
    for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 8 });
    await page.mouse.up();
  }

  private async moveDiscoveryPointerToLocator(page: Page, locator: Locator): Promise<DiscoveryPointerTarget> {
    await locator.waitFor({ state: 'visible' });
    await locator.evaluate((element) => element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }));
    await this.waitForSmoothScroll(page);
    const box = await locator.boundingBox();
    if (!box) throw new Error('The selected control is no longer visible.');

    const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
    const from = replayPointerPosition(page);
    const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const obstruction = await locator.evaluate((element, point) => {
      const top = document.elementFromPoint(point.x, point.y);
      if (!top || top === element || element.contains(top)) return '';
      const blocker = top.closest('[role="dialog"], [aria-modal="true"], .ch2, .mfp-wrap, [class*="cookie" i], [class*="consent" i], [class*="modal" i], [class*="popup" i], [class*="overlay" i]') || top;
      const className = typeof blocker.className === 'string' ? blocker.className : '';
      return (blocker.getAttribute('aria-label') || blocker.getAttribute('role') || className || blocker.tagName).replace(/\s+/g, ' ').trim().slice(0, 120);
    }, target);
    if (obstruction) throw new Error(`The selected control is covered by ${obstruction}.`);
    const distance = Math.hypot(target.x - from.x, target.y - from.y);
    const totalDuration = Math.round(Math.min(720, Math.max(220, distance * 0.72)));
    const normal = distance > 0
      ? { x: -(target.y - from.y) / distance, y: (target.x - from.x) / distance }
      : { x: 0, y: 0 };
    const bend = Math.min(72, distance * 0.12) * (target.x >= from.x ? 1 : -1);
    const control = {
      x: (from.x + target.x) / 2 + normal.x * bend,
      y: (from.y + target.y) / 2 + normal.y * bend,
    };
    const samples = [0.18, 0.42, 0.68, 0.86, 1].map((progress) => {
      const inverse = 1 - progress;
      return {
        x: inverse * inverse * from.x + 2 * inverse * progress * control.x + progress * progress * target.x,
        y: inverse * inverse * from.y + 2 * inverse * progress * control.y + progress * progress * target.y,
        offsetMs: Math.round(totalDuration * progress),
      };
    });
    let previousOffset = 0;
    for (const sample of samples) {
      await moveReplayPointer(page, sample, sample.offsetMs - previousOffset);
      previousOffset = sample.offsetMs;
    }

    return {
      position: { x: box.width / 2, y: box.height / 2 },
      metadata: {
        x: target.x,
        y: target.y,
        recordedViewportWidth: viewport.width,
        recordedViewportHeight: viewport.height,
        recordedOffsetMs: totalDuration + 100,
        pointerPath: [{ x: from.x, y: from.y, offsetMs: 0 }, ...samples],
        recordedTargetRect: { x: box.x, y: box.y, width: box.width, height: box.height },
        targetOffsetX: 0.5,
        targetOffsetY: 0.5,
      },
    };
  }

  private async discoverActions(page: Page, includeInstructionLinks = false, fileNames: string[] = []): Promise<CandidateAction[]> {
    const discoverInPage = ({ instructionDriven, attachedFiles }: { instructionDriven: boolean; attachedFiles: string[] }): CandidateAction[] => {
      type BrowserLocator = { role?: string; name?: string; selector?: string };
      type BrowserCandidate = CandidateAction & { locator?: BrowserLocator; targetLocator?: BrowserLocator };
      const dangerous = /delete|remove|destroy|archive|erase|clear|purchase|buy|pay|checkout|submit|send|publish|save|create|update|edit|logout|log out|sign out|unsubscribe|reset|confirm|approve|reject|invite|add to (cart|basket)|order/i;
      const sensitive = /password|passcode|credit|debit|card|cvv|cvc|iban|bank|payment|social security|ssn/i;
      const safeButton = /show|hide|toggle|expand|collapse|open (menu|details|filters?)|close|sort|filter|view|preview|learn more|read more/i;
      function normalize(value?: string | null) {
        return (value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      }
      function deepAll(selector: string, root: Document | ShadowRoot = document): Element[] {
        const found = Array.from(root.querySelectorAll(selector));
        for (const element of Array.from(root.querySelectorAll('*'))) {
          if (element.shadowRoot) found.push(...deepAll(selector, element.shadowRoot));
        }
        return found;
      }
      function elementName(element: Element) {
        const input = element as HTMLInputElement;
        const labelledBy = element.getAttribute('aria-labelledby');
        const labelledText = labelledBy?.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
        return normalize(element.getAttribute('aria-label') || labelledText || input.labels?.[0]?.textContent || element.getAttribute('title') || element.textContent || input.placeholder || input.name || input.value);
      }
      function visible(element: Element) {
        const style = getComputedStyle(element);
        const rectangle = element.getBoundingClientRect();
        return element.getClientRects().length > 0
          && rectangle.width > 0 && rectangle.height > 0
          && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
          && style.pointerEvents !== 'none'
          && element.getAttribute('aria-hidden') !== 'true' && element.getAttribute('aria-disabled') !== 'true'
          && !(element as HTMLInputElement).disabled;
      }
      function contextFor(element: Element) {
        return normalize((element.closest('nav, header, footer, fieldset, section, article, aside, form, div') || element.parentElement)?.textContent).slice(0, 180);
      }
      function locatorFor(element: Element, role?: string, name?: string): BrowserLocator {
        const testId = element.getAttribute('data-testid');
        if (testId) return { selector: `[data-testid="${CSS.escape(testId)}"]` };
        if (element.id) return { selector: `#${CSS.escape(element.id)}` };
        const matchesRole = (candidate: Element, candidateRole: string) => candidate.getAttribute('role') === candidateRole
          || candidateRole === 'button' && candidate.matches('button')
          || candidateRole === 'link' && candidate.matches('a[href]')
          || candidateRole === 'combobox' && candidate.matches('select')
          || candidateRole === 'searchbox' && candidate.matches('input[type="search"]')
          || candidateRole === 'checkbox' && candidate.matches('input[type="checkbox"]')
          || candidateRole === 'radio' && candidate.matches('input[type="radio"]')
          || candidateRole === 'textbox' && candidate.matches('input:not([type]), input[type="text"], textarea');
        if (role && name && matchesRole(element, role)) {
          const duplicateNames = deepAll('*').filter((candidate) => visible(candidate) && matchesRole(candidate, role) && elementName(candidate) === name);
          if (duplicateNames.length === 1) return { role, name };
          const classNames = [...element.classList].sort((left, right) => Number(right.startsWith('js-')) - Number(left.startsWith('js-')));
          for (const className of classNames) {
            const selector = `${element.tagName.toLowerCase()}.${CSS.escape(className)}`;
            if (deepAll(selector).length === 1) return { selector };
          }
        }
        const segments: string[] = [];
        let current: Element | null = element;
        while (current && segments.length < 10) {
          let segment = current.tagName.toLowerCase();
          const parentElement: Element | null = current.parentElement;
          const siblings: Element[] = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === current!.tagName) : [];
          if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
          segments.unshift(segment);
          if (parentElement) current = parentElement;
          else {
            const root = current.getRootNode();
            current = root instanceof ShadowRoot ? root.host : null;
          }
        }
        return segments.length ? { selector: segments.join(' > ') } : { role, name };
      }
      function nearbyHeading(element: Element) {
        let ancestor = element.parentElement;
        while (ancestor && !ancestor.matches('main, body')) {
          const rootHeading = ancestor.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > div > h1, :scope > div > h2, :scope > div > h3, :scope > div > h4');
          if (rootHeading) return normalize(rootHeading.textContent);
          ancestor = ancestor.parentElement;
        }
        const headings = deepAll('h1, h2, h3, h4').filter((heading) => heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
        return normalize(headings[headings.length - 1]?.textContent);
      }
      const results: BrowserCandidate[] = [];

      if (instructionDriven) {
        results.push({ kind: 'scroll', label: 'Scroll slowly down', context: 'Reveal the next section of this page', action: 'scroll-slow' });
        for (const element of deepAll('nav button, nav a, header button, header a, [aria-haspopup], [aria-expanded]')) {
          const name = elementName(element);
          if (!name || dangerous.test(name) || !visible(element)) continue;
          results.push({ kind: 'hover', label: `Hover over ${name}`, context: 'Navigation or menu control', locator: locatorFor(element, element.matches('a') ? 'link' : 'button', name), action: 'hover' });
        }
        for (const link of deepAll('a[href]')) {
          const anchor = link as HTMLAnchorElement;
          const name = elementName(link);
          let target: URL;
          try { target = new URL(anchor.href, location.href); } catch { continue; }
          if (!name || dangerous.test(name) || !visible(link) || target.origin !== location.origin || !/^https?:$/.test(target.protocol) || target.href === location.href) continue;
          results.push({ kind: 'click', label: `Open ${name}`, context: contextFor(link), locator: locatorFor(link, 'link', name), action: 'click' });
        }
      }

      for (const element of deepAll('select')) {
        const select = element as HTMLSelectElement;
        if (!visible(select)) continue;
        const name = elementName(select) || 'Select option';
        const descriptor = `${name} ${select.name} ${select.id} ${select.className}`;
        const filterContainer = select.closest('[data-filter], [data-sort], [class*="filter" i], [class*="sort" i], [id*="filter" i], [id*="sort" i]');
        const isSort = /sort|order|sortier/i.test(descriptor);
        const isFilter = /filter|facet|category|kategorie|branche|industry|technology|technologie/i.test(descriptor);
        if (!instructionDriven && !isSort && !isFilter && !filterContainer && !select.matches('[data-pathproof-safe="true"]')) continue;
        const options = Array.from(select.options).filter((option) => !option.disabled && option.value && option.value !== select.value).slice(0, instructionDriven ? 12 : 1);
        for (const option of options) results.push({
          kind: isSort ? 'sort' : 'filter', label: instructionDriven ? `Choose ${normalize(option.textContent)} in ${name}` : `${isSort ? 'Sort' : 'Filter'} with ${name}`,
          context: contextFor(select), locator: locatorFor(select, 'combobox', name), action: 'select', value: option.value,
        });
      }

      for (const element of deepAll('input[type="search"], input[aria-label*="filter" i], input[placeholder*="filter" i]')) {
        const input = element as HTMLInputElement;
        if (!visible(input)) continue;
        const name = elementName(input) || 'Search';
        const hint = normalize(input.getAttribute('data-test-value') || input.placeholder || 'test').match(/[a-z0-9]+/gi) || ['test'];
        results.push({ kind: 'filter', label: `Filter with ${name}`, context: contextFor(input), locator: locatorFor(input, 'searchbox', name), action: 'fill', acceptsValue: instructionDriven, value: hint[hint.length - 1] });
      }

      if (instructionDriven) {
        for (const element of deepAll('textarea, input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input[type="date"], input[type="time"], input[type="month"], input[type="week"]')) {
          const input = element as HTMLInputElement | HTMLTextAreaElement;
          const name = elementName(element) || 'Unlabelled field';
          const descriptor = `${name} ${input.getAttribute('autocomplete') || ''} ${input.getAttribute('name') || ''}`;
          if (!visible(element) || sensitive.test(descriptor) || input.readOnly) continue;
          results.push({ kind: 'fill', label: `Fill ${name}`, context: contextFor(element), locator: locatorFor(element, element.matches('textarea') ? 'textbox' : undefined, name), action: 'fill', acceptsValue: true });
        }
        for (const element of deepAll('input[type="file"]')) {
          const input = element as HTMLInputElement;
          const name = elementName(input) || 'file input';
          if (input.disabled) continue;
          for (const fileName of attachedFiles) results.push({ kind: 'file', label: `Choose attached file ${fileName} for ${name}`, context: input.accept ? `Accepted types: ${input.accept}` : contextFor(input), locator: locatorFor(input, undefined, name), action: 'set-files', fileName });
        }
      }

      for (const element of deepAll('input[type="checkbox"], input[type="radio"]')) {
        const input = element as HTMLInputElement;
        const name = elementName(input);
        const visibleLabel = Array.from(input.labels || []).find((label) => visible(label));
        const control = visible(input) ? input : visibleLabel;
        if (!name || dangerous.test(name) || input.disabled || !control || input.checked) continue;
        results.push({ kind: 'filter', label: `Choose ${name}`, context: contextFor(input), locator: locatorFor(control, input.type === 'radio' ? 'radio' : 'checkbox', name), action: control === input ? 'check' : 'click' });
      }

      for (const element of deepAll('button, [role="button"]')) {
        let name = elementName(element);
        const group = element.parentElement ? Array.from(element.parentElement.querySelectorAll(':scope > button, :scope > [role="button"]')) : [element];
        const heading = nearbyHeading(element);
        if (!name && heading) name = `Unlabelled button ${group.indexOf(element) + 1} of ${group.length} near ${heading}`;
        const locatorName = name;
        const describedName = name && heading && /^(next|previous|weiter|zurück|zurueck)$/i.test(name) ? `${name} near ${heading}` : name;
        const explicitlySafe = element.matches('[data-pathproof-safe="true"], [aria-controls], [aria-expanded], [role="tab"]');
        if (!name || dangerous.test(name) || !visible(element) || (!instructionDriven && ((/^(next|previous)$/i.test(name) && !explicitlySafe) || (!explicitlySafe && !safeButton.test(name))))) continue;
        const consent = Boolean(element.closest('.ch2, [class*="cookie-consent" i], [id*="cookie-consent" i], [class*="consent" i], [id*="consent" i]')
          && /deny all|reject all|only necessary|necessary only|essential only|allow all cookies|accept all|cookie settings|close/i.test(name));
        const dismissal = Boolean(!consent
          && element.closest('[role="dialog"], [aria-modal="true"], .mfp-wrap, [class*="modal" i], [class*="popup" i], [class*="overlay" i]')
          && /close|schließ|schliess|dismiss|not now|later|×/i.test(name));
        const filterControl = element.matches('[data-category-id], [data-filter], [class*="filter" i]') || Boolean(element.closest('[data-filter], [class*="filters" i], [id*="filters" i]'));
        const kind = /sort|order/i.test(name) ? 'sort' : filterControl || /filter|show|hide|toggle/i.test(name) ? 'filter' : 'click';
        results.push({
          kind,
          label: consent ? `Dismiss cookie consent with ${describedName}` : dismissal ? `Dismiss dialog with ${describedName}` : `${kind === 'click' ? 'Use' : kind === 'sort' ? 'Sort with' : 'Filter with'} ${describedName}`,
          context: consent ? 'Cookie consent overlay blocks the requested page controls' : dismissal ? 'Dialog overlay blocks the requested page controls' : contextFor(element),
          locator: locatorFor(element, 'button', locatorName), action: 'click', consent, dismissal,
        });
      }

      if (instructionDriven) {
        const customControls = [...deepAll('[role="menuitem"], [role="option"], [role="tab"], [role="switch"], [role="treeitem"], [tabindex]:not([tabindex="-1"]), [onclick], [data-action]'), ...deepAll('div, span, li, svg').filter((element) => getComputedStyle(element).cursor === 'pointer')];
        for (const element of [...new Set(customControls)]) {
          const name = elementName(element);
          if (!name || dangerous.test(name) || !visible(element) || element.matches('button, a, input, select, textarea, [role="button"]')) continue;
          results.push({ kind: 'click', label: `Use custom control ${name}`, context: contextFor(element), locator: locatorFor(element, element.getAttribute('role') || undefined, name), action: 'click' });
        }
        const sources = deepAll('[draggable="true"], [data-draggable]').filter(visible).slice(0, 8);
        const targets = deepAll('[data-dropzone], [ondrop], [role="listbox"], [data-sortable]').filter(visible).slice(0, 8);
        for (const source of sources) for (const target of targets) {
          if (source === target || source.contains(target)) continue;
          const sourceName = elementName(source) || 'draggable item';
          const targetName = elementName(target) || target.getAttribute('aria-label') || 'drop area';
          if (dangerous.test(`${sourceName} ${targetName}`)) continue;
          results.push({ kind: 'drag-drop', label: `Drag ${sourceName} to ${targetName}`, context: `${contextFor(source)} → ${contextFor(target)}`, locator: locatorFor(source, undefined, sourceName), targetLocator: locatorFor(target, undefined, targetName), action: 'drag' });
        }
        for (const canvas of deepAll('canvas').filter(visible).slice(0, 8)) {
          const label = elementName(canvas) || nearbyHeading(canvas) || 'canvas';
          results.push({ kind: 'canvas-draw', label: `Draw on ${label}`, context: 'Canvas pointer gesture', locator: locatorFor(canvas, undefined, label), action: 'canvas-draw' });
        }
      }

      const seen = new Set<string>();
      const preferredConsent = results.filter((candidate) => candidate.consent && /deny|reject|necessary|essential/i.test(candidate.label));
      return results.filter((candidate) => preferredConsent.length === 0 || !candidate.consent || preferredConsent.includes(candidate)).filter((candidate) => {
        const signature = `${candidate.action}|${candidate.label}|${JSON.stringify(candidate.locator)}|${JSON.stringify(candidate.targetLocator)}`;
        if (seen.has(signature)) return false;
        seen.add(signature);
        return true;
      }).slice(0, instructionDriven ? 180 : 20);
    };
    const serializedArguments = JSON.stringify({ instructionDriven: includeInstructionLinks, attachedFiles: fileNames });
    const expression = `((__name) => (${discoverInPage.toString()})(${serializedArguments}))((target, value) => Object.defineProperty(target, "name", { value, configurable: true }))`;
    return page.evaluate<CandidateAction[]>(expression);
  }

  private async replay(browser: Browser, runId: string, test: TestDefinition, playbackSpeed: number): Promise<void> {
    if (!test.plan) throw new Error('This test has no saved plan. Complete discovery before replaying it.');
    let page = await this.newPage(browser, test.browserState, test.seedUrls[0], test.source === 'recording', true);
    await attachReplayCursor(page);
    const stopStream = await this.startCompositorStream(page, runId);
    try {
      const steps = test.plan.steps;
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        const progress = 5 + Math.round((index / Math.max(steps.length, 1)) * 90);
        if (step.kind === 'navigate') {
          await this.navigate(page, runId, step.url, progress);
          continue;
        }
        if (page.url() !== step.url) await this.navigate(page, runId, step.url, progress);
        await this.updateRun(runId, (run) => {
          run.progress = progress;
          run.currentAction = step.label;
        });
        if (step.kind === 'scroll') {
          const target = { x: Number(step.metadata?.x ?? 0), y: Number(step.metadata?.y ?? Number.MAX_SAFE_INTEGER) };
          if (step.metadata?.slow) {
            await page.evaluate(`({ x, y }) => new Promise((resolve) => {
              const startX = window.scrollX; const startY = window.scrollY; const startedAt = performance.now(); const duration = 1800;
              const tick = (now) => { const progress = Math.min(1, (now - startedAt) / duration); const eased = progress < .5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
                window.scrollTo(startX + (x - startX) * eased, startY + (y - startY) * eased); if (progress < 1) requestAnimationFrame(tick); else resolve(); };
              requestAnimationFrame(tick);
            })`, target);
          } else {
            await page.evaluate(({ x, y }) => window.scrollTo({ left: x, top: y, behavior: 'smooth' }), target);
            await this.waitForSmoothScroll(page);
          }
          await page.waitForTimeout(playbackDelay(80, playbackSpeed));
          await this.captureFrame(page, runId);
          await this.addEvent(runId, event(runId, 'scroll', step.label, 'passed', { url: step.url }));
        } else if (step.kind === 'select-text') {
          const selection = await this.replayTextSelection(page, step, playbackSpeed);
          await this.captureFrame(page, runId);
          await this.addEvent(runId, event(runId, 'action', step.label, 'passed', {
            url: step.url,
            expected: selection.expected,
            actual: selection.actual,
          }));
        } else if (step.kind === 'assert') {
          const assertion = String(step.metadata?.assertion ?? 'body-visible');
          if (assertion === 'title') {
            const actual = await page.title();
            const expected = String(step.metadata?.title ?? '');
            if (actual !== expected) throw new Error(`Title changed on ${step.url}. Expected “${expected}”, received “${actual}”.`);
            await this.addEvent(runId, event(runId, 'assert', step.label, 'passed', { url: step.url, expected, actual }));
          } else {
            const visible = await page.locator('body').isVisible();
            if (!visible) throw new Error(`The page body was not visible on ${step.url}.`);
            await this.addEvent(runId, event(runId, 'assert', step.label, 'passed', { url: step.url, expected: 'Visible page', actual: 'Visible page' }));
          }
        } else {
          const locator = this.resolveLocator(page, step.locator ?? {});
          const action = String(step.metadata?.action ?? 'click');
          const pointerGeometry = await this.replayPointerTrail(page, step, playbackSpeed);
          const expectedName = String(step.metadata?.expectedName ?? '').trim();
          if (expectedName) {
            const actualName = (await locator.evaluate((element) => {
              const direct = element.getAttribute('aria-label') || element.getAttribute('title');
              if (direct) return direct;
              return element.matches('button, a, [role="button"], [role="link"]') ? element.textContent || '' : '';
            }).catch(() => '')).replace(/\s+/g, ' ').trim();
            if (actualName && actualName !== expectedName) throw new Error(`${step.label} changed text. Expected “${expectedName}”, received “${actualName}”.`);
          }
          const point: ReplayPointerPoint = action === 'set-files'
            ? { x: 0, y: 0, position: { x: 0, y: 0 } }
            : await this.animatePointerToLocator(page, step, locator, pointerGeometry, playbackSpeed);
          if (point.warning) {
            await this.addEvent(runId, event(runId, 'warning', `${step.label}: recorded position changed`, 'skipped', {
              url: step.url, expected: point.warning.expected, actual: point.warning.actual,
            }));
          }
          const beforeUrl = page.url();
          const beforeText = textFingerprint(await page.locator('body').innerText().catch(() => ''));
          const popups: Page[] = [];
          const popupListener = (popup: Page) => popups.push(popup);
          if (action === 'click') page.once('popup', popupListener);
          if (action === 'select') await locator.selectOption(String(step.metadata?.value ?? ''));
          else if (action === 'fill') await locator.fill(String(step.metadata?.value ?? ''));
          else if (action === 'check') await locator.setChecked(Boolean(step.metadata?.checked));
          else if (action === 'hover') await locator.hover({ position: point.position });
          else if (action === 'press') await locator.press(String(step.metadata?.key ?? 'Enter'));
          else if (action === 'dblclick') await locator.dblclick({ position: point.position, delay: playbackDelay(120, playbackSpeed) });
          else if (action === 'drag') {
            const targetLocator = step.metadata?.targetLocator as PlanStep['locator'] | undefined;
            if (!targetLocator) throw new Error(`${step.label} has no saved drop target.`);
            await locator.dragTo(this.resolveLocator(page, targetLocator));
          } else if (action === 'canvas-draw') await this.drawOnCanvas(page, locator);
          else if (action === 'set-files') {
            const fileName = String(step.metadata?.fileName ?? '');
            const file = test.files?.find((item) => item.name === fileName);
            if (!file) throw new Error(`Attached file ${fileName} is unavailable.`);
            await locator.setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: Buffer.from(file.dataBase64, 'base64') });
          }
          else await locator.click({ position: point.position, delay: playbackDelay(120, playbackSpeed) });
          await page.waitForTimeout(playbackDelay(350, playbackSpeed));
          page.off('popup', popupListener);
          const popup = popups[0];
          if (popup) {
            await popup.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => undefined);
            if (!sameOrigin(test.seedUrls[0], popup.url())) {
              await popup.close().catch(() => undefined);
              throw new Error(`${step.label} opened a popup outside the project origin.`);
            }
            await assertSafeTarget(popup.url());
            page = popup;
            await attachReplayCursor(page);
          }
          const effect = String(step.metadata?.effect ?? 'visible');
          const afterText = textFingerprint(await page.locator('body').innerText().catch(() => ''));
          const expectedUrl = String(step.metadata?.expectedUrl ?? '');
          if (expectedUrl && page.url() !== expectedUrl) throw new Error(`${step.label} changed destination. Expected ${expectedUrl}, received ${page.url()}.`);
          if (effect === 'url' && page.url() === beforeUrl) throw new Error(`${step.label} no longer changes navigation.`);
          if (effect === 'content' && afterText === beforeText) throw new Error(`${step.label} no longer updates visible results.`);
          await this.captureFrame(page, runId);
          await this.addEvent(runId, event(runId, 'action', step.label, 'passed', {
            url: step.url,
            expected: step.expected,
            actual: action === 'hover' ? 'Hover state restored' : effect === 'url' ? `Navigated to ${page.url()}` : effect === 'content' ? 'Visible results updated' : 'Control accepted the interaction',
          }));
        }
      }
    } finally {
      await stopStream();
      await page.context().close();
    }
  }

  private pointerGeometry(page: Page, step: PlanStep): ReplayPointerGeometry {
    const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
    const recordedWidth = Number(step.metadata?.recordedViewportWidth ?? viewport.width);
    const recordedHeight = Number(step.metadata?.recordedViewportHeight ?? viewport.height);
    const scaleX = recordedWidth > 0 ? viewport.width / recordedWidth : 1;
    const scaleY = recordedHeight > 0 ? viewport.height / recordedHeight : 1;
    const recordedX = Number(step.metadata?.x);
    const recordedY = Number(step.metadata?.y);
    const rawPath = Array.isArray(step.metadata?.pointerPath) ? step.metadata.pointerPath : [];
    const path = rawPath.flatMap((sample) => {
      if (!sample || typeof sample !== 'object') return [];
      const x = Number((sample as { x?: unknown }).x);
      const y = Number((sample as { y?: unknown }).y);
      const offsetMs = Number((sample as { offsetMs?: unknown }).offsetMs);
      return Number.isFinite(x) && Number.isFinite(y) ? [{ x: x * scaleX, y: y * scaleY, offsetMs: Number.isFinite(offsetMs) ? offsetMs : 0 }] : [];
    });
    return { scaleX, scaleY, recordedX, recordedY, path };
  }

  private async replayPointerTrail(page: Page, step: PlanStep, playbackSpeed: number): Promise<ReplayPointerGeometry> {
    const geometry = this.pointerGeometry(page, step);
    if (geometry.path.length === 0) return geometry;
    const important = new Set<number>([0, geometry.path.length - 1]);
    for (let index = 1; index < geometry.path.length; index += 1) {
      if (geometry.path[index].offsetMs - geometry.path[index - 1].offsetMs >= 180) { important.add(index - 1); important.add(index); }
    }
    const limit = 32;
    const remaining = Math.max(0, limit - important.size);
    for (let slot = 1; slot <= remaining; slot += 1) important.add(Math.round((slot * (geometry.path.length - 1)) / (remaining + 1)));
    let selected = [...important].sort((a, b) => a - b);
    if (selected.length > 48) selected = selected.filter((_index, position) => position === 0 || position === selected.length - 1 || position % Math.ceil(selected.length / 48) === 0);
    const recordedOffsetMs = Number(step.metadata?.recordedOffsetMs);
    const lastOffsetMs = geometry.path.at(-1)?.offsetMs ?? recordedOffsetMs;
    const finalDwell = Number.isFinite(recordedOffsetMs) && recordedOffsetMs > lastOffsetMs ? Math.min(800, recordedOffsetMs - lastOffsetMs) : 140;
    let timingBudget = Math.max(0, 4_000 - finalDwell);
    const first = geometry.path[selected[0]];
    const entryDuration = Math.min(120, timingBudget);
    await moveReplayPointer(page, first, playbackDelay(entryDuration, playbackSpeed));
    timingBudget -= entryDuration;
    for (let position = 0; position < selected.length - 1; position += 1) {
      const sample = geometry.path[selected[position]];
      const next = geometry.path[selected[position + 1]];
      const recordedDuration = next.offsetMs > sample.offsetMs ? next.offsetMs - sample.offsetMs : 16;
      const duration = Math.min(750, recordedDuration, timingBudget);
      await moveReplayPointer(page, next, playbackDelay(duration, playbackSpeed));
      timingBudget -= duration;
    }
    await page.waitForTimeout(playbackDelay(finalDwell, playbackSpeed));
    return geometry;
  }

  private async animatePointerToLocator(page: Page, step: PlanStep, locator: Locator, geometry: ReplayPointerGeometry, playbackSpeed: number): Promise<ReplayPointerPoint> {
    await locator.waitFor({ state: 'visible' });
    await locator.evaluate((element) => element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }));
    await this.waitForSmoothScroll(page);
    const box = await locator.boundingBox();
    if (!box) throw new Error(`${step.label} is no longer visible after replaying its recorded hover path.`);
    const rawPoint = Number.isFinite(geometry.recordedX) && Number.isFinite(geometry.recordedY)
      ? { x: geometry.recordedX * geometry.scaleX, y: geometry.recordedY * geometry.scaleY }
      : undefined;
    const targetOffsetX = Number(step.metadata?.targetOffsetX);
    const targetOffsetY = Number(step.metadata?.targetOffsetY);
    const hasRelativePosition = Number.isFinite(targetOffsetX) && Number.isFinite(targetOffsetY);
    const rawInside = rawPoint && rawPoint.x >= box.x - 2 && rawPoint.x <= box.x + box.width + 2 && rawPoint.y >= box.y - 2 && rawPoint.y <= box.y + box.height + 2;
    const relativeX = hasRelativePosition ? Math.min(0.98, Math.max(0.02, targetOffsetX)) * box.width : rawInside ? rawPoint.x - box.x : box.width / 2;
    const relativeY = hasRelativePosition ? Math.min(0.98, Math.max(0.02, targetOffsetY)) * box.height : rawInside ? rawPoint.y - box.y : box.height / 2;
    const point: ReplayPointerPoint = {
      x: box.x + relativeX,
      y: box.y + relativeY,
      position: { x: relativeX, y: relativeY },
    };
    if (rawPoint && !rawInside) {
      point.warning = {
        expected: `Recorded pointer at (${Math.round(rawPoint.x)}, ${Math.round(rawPoint.y)})`,
        actual: `Control moved; replay used its live position at (${Math.round(point.x)}, ${Math.round(point.y)})`,
      };
    }
    await moveReplayPointer(page, point, playbackDelay(geometry.path.length > 0 ? 100 : 160, playbackSpeed));
    return point;
  }

  private async replayTextSelection(page: Page, step: PlanStep, playbackSpeed: number): Promise<{ expected: string; actual: string }> {
    const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
    const recordedWidth = Number(step.metadata?.recordedViewportWidth ?? viewport.width);
    const recordedHeight = Number(step.metadata?.recordedViewportHeight ?? viewport.height);
    const scaleX = recordedWidth > 0 ? viewport.width / recordedWidth : 1;
    const scaleY = recordedHeight > 0 ? viewport.height / recordedHeight : 1;
    const parsePoint = (raw: unknown): { x: number; y: number; offsetMs: number } | undefined => {
      if (!raw || typeof raw !== 'object') return undefined;
      const point = raw as { x?: unknown; y?: unknown; offsetMs?: unknown };
      const x = Number(point.x);
      const y = Number(point.y);
      const offsetMs = Number(point.offsetMs);
      return Number.isFinite(x) && Number.isFinite(y)
        ? { x: x * scaleX, y: y * scaleY, offsetMs: Number.isFinite(offsetMs) ? offsetMs : 0 }
        : undefined;
    };
    const start = parsePoint(step.metadata?.selectionStart);
    const end = parsePoint(step.metadata?.selectionEnd);
    if (!start || !end) throw new Error(`${step.label} no longer has complete recorded drag coordinates.`);
    const path = (Array.isArray(step.metadata?.dragPath) ? step.metadata.dragPath : [])
      .flatMap((sample) => parsePoint(sample) ?? [])
      .filter((sample) => sample.offsetMs >= start.offsetMs && sample.offsetMs <= end.offsetMs);
    const dragPoints = [...path, end].filter((point, index, points) => {
      const previous = points[index - 1];
      return !previous || point.x !== previous.x || point.y !== previous.y || point.offsetMs !== previous.offsetMs;
    });

    await moveReplayPointer(page, start, playbackDelay(140, playbackSpeed));
    let pointerHeld = false;
    let timingBudget = 4_000;
    let previous = start;
    try {
      await page.mouse.down({ button: 'left' });
      pointerHeld = true;
      for (const point of dragPoints) {
        const recordedDuration = Math.max(0, point.offsetMs - previous.offsetMs);
        const duration = Math.min(750, recordedDuration, timingBudget);
        await moveReplayPointer(page, point, playbackDelay(duration, playbackSpeed));
        timingBudget -= duration;
        previous = point;
      }
      await page.mouse.up({ button: 'left' });
      pointerHeld = false;
    } finally {
      if (pointerHeld) await page.mouse.up({ button: 'left' }).catch(() => undefined);
    }
    await page.waitForTimeout(playbackDelay(120, playbackSpeed));

    const observed = await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        const startOffset = active.selectionStart;
        const endOffset = active.selectionEnd;
        if (startOffset !== null && endOffset !== null && startOffset !== endOffset) {
          return { collapsed: false, length: Math.abs(endOffset - startOffset), kind: 'control' as const };
        }
      }
      const selection = document.getSelection();
      return {
        collapsed: !selection || selection.isCollapsed,
        length: selection?.toString().length ?? 0,
        kind: 'document' as const,
      };
    });
    const expectedLength = Number(step.metadata?.expectedSelectedTextLength);
    if (observed.collapsed || observed.length <= 0) {
      throw new Error(`${step.label} no longer produces a native text selection.`);
    }
    if (Number.isFinite(expectedLength) && expectedLength > 0 && observed.length !== expectedLength) {
      throw new Error(`${step.label} changed selection length. Expected ${expectedLength} characters, received ${observed.length}.`);
    }
    const expected = Number.isFinite(expectedLength) && expectedLength > 0
      ? `Native selection contains ${expectedLength} characters`
      : 'Native text selection is non-collapsed';
    return {
      expected,
      actual: `Native ${observed.kind === 'control' ? 'form-control' : 'document'} selection contains ${observed.length} characters`,
    };
  }

  private async startCompositorStream(page: Page, runId: string): Promise<() => Promise<void>> {
    let stopped = false;
    let lastPublishedAt = 0;
    const viewport = page.viewportSize() ?? DEFAULT_VIEWPORT;
    const scale = Math.min(1, 1440 / viewport.width, 1000 / viewport.height);
    const size = {
      width: Math.max(2, Math.floor((viewport.width * scale) / 2) * 2),
      height: Math.max(2, Math.floor((viewport.height * scale) / 2) * 2),
    };
    let screencast: Awaited<ReturnType<Page['screencast']['start']>> | undefined;
    try {
      screencast = await page.screencast.start({
        size, quality: 72,
        onFrame: ({ data }) => {
          const timestamp = performance.now();
          if (!stopped && timestamp - lastPublishedAt >= STREAM_FRAME_INTERVAL_MS) { lastPublishedAt = timestamp; this.publishFrame(runId, data); }
        },
      });
      this.liveStreams.add(runId);
    } catch (error) {
      await screencast?.dispose().catch(() => undefined);
      this.liveStreams.delete(runId);
      await this.addEvent(runId, event(runId, 'warning', 'Live replay stream could not start', 'skipped', { actual: errorMessage(error) }));
      return async () => undefined;
    }
    return async () => {
      if (stopped) return;
      stopped = true;
      this.liveStreams.delete(runId);
      await screencast?.dispose().catch(() => undefined);
    };
  }

  private resolveLocator(page: Page, locator: NonNullable<PlanStep['locator']>): Locator {
    if (locator.selector) return page.locator(locator.selector).first();
    if (locator.role) return page.getByRole(locator.role as Parameters<Page['getByRole']>[0], { name: locator.name, exact: true }).first();
    throw new Error('The saved control locator is incomplete.');
  }

  private async captureFrame(page: Page, runId: string): Promise<void> {
    const buffer = await page.screenshot({ type: 'jpeg', quality: 72, fullPage: false });
    const framePath = path.join(this.framesDirectory, `${runId}.jpg`);
    const temporaryPath = `${framePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, buffer);
    await rename(temporaryPath, framePath);
    if (!this.liveStreams.has(runId)) this.publishFrame(runId, buffer);
    await this.updateRun(runId, (run) => {
      run.frameVersion += 1;
      run.currentUrl = page.url();
    });
  }

  private async addEvent(runId: string, runEvent: RunEvent): Promise<void> {
    await this.updateRun(runId, (run) => run.events.push(runEvent));
  }

  private async finish(runId: string, testId: string, passed: boolean, errorMessage?: string): Promise<void> {
    const completedAt = now();
    await this.store.mutate((database) => {
      const run = database.runs.find((candidate) => candidate.id === runId);
      const test = database.tests.find((candidate) => candidate.id === testId);
      if (!run || !test) return;
      run.status = passed ? 'passed' : 'failed';
      run.controlState = undefined;
      const failedAction = run.currentAction;
      run.progress = passed ? 100 : Math.min(Math.max(run.progress, 2), 99);
      run.completedAt = completedAt;
      run.durationMs = run.startedAt ? Date.parse(completedAt) - Date.parse(run.startedAt) : undefined;
      run.currentAction = passed ? 'Run complete' : 'Run failed';
      run.error = errorMessage;
      run.expected = passed ? undefined : 'The saved Playwright journey completes without regressions.';
      run.actual = errorMessage;
      run.events.push(event(run.id, 'complete', passed ? 'All checks passed' : `Failed: ${failedAction || 'browser step'}`, passed ? 'passed' : 'failed', {
        url: run.currentUrl,
        expected: run.expected,
        actual: errorMessage,
      }));
      test.lastRunId = run.id;
      if (!passed) test.status = 'failed';
      else test.status = run.kind === 'discovery' ? 'ready' : 'passed';
      this.store.recomputeProjects(database);
    });
    this.publish(runId);
    setTimeout(() => this.latestFrames.delete(runId), 60_000).unref?.();
  }

  private async finishInterrupted(runId: string, testId: string): Promise<void> {
    const completedAt = now();
    await this.store.mutate((database) => {
      const run = database.runs.find((candidate) => candidate.id === runId);
      const test = database.tests.find((candidate) => candidate.id === testId);
      if (!run || !test || run.status === 'interrupted') return;
      run.status = 'interrupted';
      run.controlState = undefined;
      run.progress = Math.min(Math.max(run.progress, 0), 99);
      run.completedAt = completedAt;
      run.durationMs = run.startedAt ? Date.parse(completedAt) - Date.parse(run.startedAt) : undefined;
      run.currentAction = 'Run stopped';
      run.error = 'Stopped by user.';
      run.actual = 'The run was stopped before completion.';
      run.events.push(event(run.id, 'complete', 'Run stopped by user', 'failed', { url: run.currentUrl, actual: run.actual }));
      test.lastRunId = run.id;
      test.status = test.plan ? 'ready' : 'failed';
      this.store.recomputeProjects(database);
    });
    this.publish(runId);
    setTimeout(() => this.latestFrames.delete(runId), 60_000).unref?.();
  }

  private async updateRun(runId: string, mutate: (run: Run, database: Database) => void): Promise<void> {
    await this.checkpoint(runId);
    await this.store.mutate((database) => {
      const run = database.runs.find((candidate) => candidate.id === runId);
      if (!run) throw new Error(`Run ${runId} no longer exists.`);
      mutate(run, database);
      this.store.recomputeProjects(database);
    });
    this.publish(runId);
  }

  private publish(runId: string): void {
    const run = this.store.snapshot().runs.find((candidate) => candidate.id === runId);
    if (!run) return;
    for (const listener of this.subscribers.get(runId) ?? []) listener(run);
  }
}
