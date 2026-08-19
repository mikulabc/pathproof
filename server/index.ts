import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express, { type Express, type RequestHandler } from 'express';
import { z } from 'zod';
import type { BrowserReplayState, DashboardProject, PathproofRecording, PlanStep, Project, ProjectDetail, RecordedEvent, Run, TestDefinition } from '../src/shared.js';
import { resolveProjectOrigin } from './domain-resolver.js';
import { loadLocalEnvironment } from './environment.js';
import { ApiError, errorHandler, notFound } from './errors.js';
import { RunCoordinator } from './runner.js';
import { assertSafeTarget, parseHttpUrl, sameOrigin } from './security.js';
import { JsonStore, type Database } from './store.js';

const projectInput = z.object({
  name: z.string().trim().min(1).max(100),
  origin: z.string().trim().optional(),
  domain: z.string().trim().optional(),
}).refine((input) => input.origin || input.domain, { message: 'origin or domain is required' });

const projectPatch = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  origin: z.string().trim().optional(),
  domain: z.string().trim().optional(),
}).refine((input) => Object.keys(input).length > 0, { message: 'At least one field is required.' });

const originResolveInput = z.object({
  input: z.string().trim().min(1).max(2_048),
});

const testInput = z.object({
  name: z.string().trim().min(1).max(120),
  seedUrls: z.array(z.string().trim().min(1)).min(1).max(20).optional(),
  urls: z.array(z.string().trim().min(1)).min(1).max(20).optional(),
  aiInstructions: z.string().trim().max(2_000).optional(),
  browserState: z.lazy(() => browserStateInput).optional(),
  files: z.array(z.object({
    name: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(255),
    dataBase64: z.string().max(7_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/),
    size: z.number().int().nonnegative().max(5 * 1024 * 1024),
  }).refine((file) => Buffer.from(file.dataBase64, 'base64').byteLength === file.size, { message: 'Attached file size does not match its encoded data.' })).max(5).optional(),
}).refine((input) => input.seedUrls || input.urls, { message: 'seedUrls or urls is required' })
  .refine((input) => (input.files ?? []).reduce((total, file) => total + file.size, 0) <= 15 * 1024 * 1024, { message: 'Attached files must be 15 MB or smaller in total.' });

const testPatch = z.object({
  name: z.string().trim().min(1).max(120),
});

const playbackSpeedInput = z.number().min(0.25).max(2).multipleOf(0.25);

const bulkInput = z.object({
  projectIds: z.array(z.string().uuid()).max(100).optional(),
  testIds: z.array(z.string().uuid()).max(200).optional(),
  playbackSpeeds: z.record(z.string().uuid(), playbackSpeedInput).optional(),
}).refine((input) => (input.projectIds?.length ?? 0) + (input.testIds?.length ?? 0) > 0, {
  message: 'At least one projectId or testId is required.',
});

const projectBulkDeleteInput = z.object({
  projectIds: z.array(z.string().uuid()).min(1).max(100),
});

const testBulkDeleteInput = z.object({
  testIds: z.array(z.string().uuid()).min(1).max(200),
});

const runBulkDeleteInput = z.object({
  runIds: z.array(z.string().min(1).max(200)).min(1).max(200),
});

const replayRunInput = z.object({
  playbackSpeed: playbackSpeedInput.default(1),
});

const runPatch = z.object({
  name: z.string().trim().min(1).max(120),
});

const runControlInput = z.object({
  action: z.enum(['pause', 'resume', 'stop']),
});

const recordedEventInput = z.object({
  id: z.string().min(1).max(200),
  sequence: z.number().int().nonnegative(),
  at: z.string().min(1).max(100),
  offsetMs: z.number().nonnegative(),
  kind: z.enum(['navigation', 'click', 'dblclick', 'pointerdown', 'pointerup', 'input', 'change', 'keydown', 'focus', 'scroll', 'mousemove', 'resize', 'dom-mutation', 'network-request', 'network-response', 'console', 'exception', 'lifecycle', 'screenshot', 'video-frame', 'snapshot']),
  url: z.string().max(10_000),
  frameUrl: z.string().max(10_000).optional(),
  selector: z.string().max(4_000).optional(),
  role: z.string().max(100).optional(),
  accessibleName: z.string().max(500).optional(),
  tagName: z.string().max(100).optional(),
  value: z.string().max(100_000).optional(),
  key: z.string().max(100).optional(),
  x: z.number().finite().optional(), y: z.number().finite().optional(),
  scrollX: z.number().finite().optional(), scrollY: z.number().finite().optional(),
  width: z.number().finite().positive().max(20_000).optional(), height: z.number().finite().positive().max(20_000).optional(),
  text: z.string().max(100_000).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const browserCookieInput = z.object({
  name: z.string().min(1).max(1_000), value: z.string().max(100_000), domain: z.string().min(1).max(1_000),
  path: z.string().max(4_000).optional(), expires: z.number().optional(), httpOnly: z.boolean().optional(), secure: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None', 'no_restriction', 'lax', 'strict', 'unspecified']).optional(),
});

const browserStateInput = z.object({
  viewport: z.object({ width: z.number().positive().max(20_000), height: z.number().positive().max(20_000) }).optional(),
  userAgent: z.string().max(2_000).optional(),
  locale: z.string().max(100).optional(),
  timezoneId: z.string().max(200).optional(),
  colorScheme: z.enum(['light', 'dark', 'no-preference']).optional(),
  reducedMotion: z.enum(['reduce', 'no-preference']).optional(),
  cookies: z.array(browserCookieInput).max(10_000).optional(),
  cookieHeader: z.string().max(200_000).optional(),
  localStorage: z.record(z.string(), z.string()).optional(),
  platform: z.string().max(500).optional(), language: z.string().max(100).optional(),
  window: z.object({ width: z.number().positive().max(20_000), height: z.number().positive().max(20_000), state: z.string().max(100).optional() }).optional(),
}).passthrough();

const recordingImportInput = z.object({
  name: z.string().trim().min(1).max(120),
  cookieHeader: z.string().max(200_000).optional(),
  recording: z.object({
    format: z.literal('pathproof-recording'), version: z.literal(1), id: z.string().min(1).max(200), name: z.string().max(500),
    createdAt: z.string().min(1), startedAt: z.string().min(1), stoppedAt: z.string().min(1), durationMs: z.number().nonnegative(),
    target: z.object({ tabId: z.number().int().optional(), initialUrl: z.string().min(1).max(10_000), finalUrl: z.string().min(1).max(10_000), title: z.string().max(2_000).optional() }),
    options: z.object({ captureMouseMoves: z.boolean().optional(), captureNetwork: z.boolean().optional(), captureDom: z.boolean().optional(), captureScreenshots: z.boolean().optional(), captureStream: z.boolean().optional(), includeCookies: z.boolean().optional() }).optional(),
    browser: browserStateInput,
    events: z.array(recordedEventInput).min(1).max(100_000),
    diagnostics: z.record(z.string(), z.unknown()).optional(),
  }),
});

const recordingCookiePatch = z.object({
  cookies: z.array(browserCookieInput).max(10_000),
  cookieHeader: z.string().max(200_000).optional(),
});

function recordedLocator(item: RecordedEvent): PlanStep['locator'] | undefined {
  if (!item.selector && !item.role) return undefined;
  return { selector: item.selector, role: item.role, name: item.accessibleName };
}

function eventUrl(item: RecordedEvent, fallback: string): string {
  try { return parseHttpUrl(item.url || fallback).toString(); } catch { return fallback; }
}

type PointerTrailSample = {
  x: number;
  y: number;
  offsetMs: number;
  selector?: string;
  role?: string;
  accessibleName?: string;
};

type PendingSelectionDrag = {
  down: RecordedEvent;
  moves: PointerTrailSample[];
};

function compactPointerTrail(samples: PointerTrailSample[], preferredLimit = 120): PointerTrailSample[] {
  if (samples.length <= preferredLimit) return samples;
  const important = new Set<number>([0, samples.length - 1]);
  const identity = (sample: PointerTrailSample) => `${sample.selector || ''}\n${sample.role || ''}\n${sample.accessibleName || ''}`;
  for (let index = 1; index < samples.length; index += 1) {
    if (identity(samples[index]) !== identity(samples[index - 1])) { important.add(index - 1); important.add(index); }
    if (samples[index].offsetMs - samples[index - 1].offsetMs >= 180) { important.add(index - 1); important.add(index); }
    if (index >= samples.length - 1) continue;
    const before = samples[index - 1];
    const current = samples[index];
    const after = samples[index + 1];
    const first = { x: current.x - before.x, y: current.y - before.y };
    const second = { x: after.x - current.x, y: after.y - current.y };
    const cross = Math.abs(first.x * second.y - first.y * second.x);
    const distance = Math.hypot(first.x, first.y) + Math.hypot(second.x, second.y);
    if (distance >= 12 && cross / distance >= 3) important.add(index);
  }
  const limit = Math.max(preferredLimit, Math.min(240, important.size));
  if (important.size < limit) {
    const remaining = limit - important.size;
    for (let slot = 1; slot <= remaining; slot += 1) important.add(Math.round((slot * (samples.length - 1)) / (remaining + 1)));
  }
  const indices = [...important].sort((a, b) => a - b);
  if (indices.length <= limit) return indices.map((index) => samples[index]);
  const selected = new Set<number>([indices[0], indices.at(-1)!]);
  for (let slot = 1; slot < limit - 1; slot += 1) selected.add(indices[Math.round((slot * (indices.length - 1)) / (limit - 1))]);
  return [...selected].sort((a, b) => a - b).map((index) => samples[index]);
}

function pointerMetadata(item: RecordedEvent, pointerTrail: PointerTrailSample[]): Record<string, unknown> {
  const rawRect = item.data?.targetRect;
  const targetRect = rawRect && typeof rawRect === 'object' ? rawRect as Record<string, unknown> : undefined;
  const rectX = Number(targetRect?.x);
  const rectY = Number(targetRect?.y);
  const rectWidth = Number(targetRect?.width);
  const rectHeight = Number(targetRect?.height);
  const hasRect = [rectX, rectY, rectWidth, rectHeight].every(Number.isFinite) && rectWidth > 0 && rectHeight > 0;
  const x = Number(item.x);
  const y = Number(item.y);
  return {
    x: item.x,
    y: item.y,
    recordedViewportWidth: item.width,
    recordedViewportHeight: item.height,
    recordedOffsetMs: item.offsetMs,
    pointerPath: compactPointerTrail(pointerTrail),
    ...(hasRect ? {
      recordedTargetRect: { x: rectX, y: rectY, width: rectWidth, height: rectHeight },
      targetOffsetX: Number.isFinite(x) ? Math.min(1, Math.max(0, (x - rectX) / rectWidth)) : undefined,
      targetOffsetY: Number.isFinite(y) ? Math.min(1, Math.max(0, (y - rectY) / rectHeight)) : undefined,
    } : {}),
  };
}

function selectionLength(item: RecordedEvent): number {
  const rawSelection = item.data?.selection;
  if (!rawSelection || typeof rawSelection !== 'object') return 0;
  const length = Number((rawSelection as Record<string, unknown>).selectedTextLength);
  return Number.isFinite(length) && length > 0 ? Math.floor(length) : 0;
}

function selectionDragStep(
  down: RecordedEvent,
  up: RecordedEvent,
  moves: PointerTrailSample[],
  url: string,
): PlanStep | undefined {
  const startX = Number(down.x);
  const startY = Number(down.y);
  const endX = Number(up.x);
  const endY = Number(up.y);
  const expectedLength = selectionLength(up);
  if (![startX, startY, endX, endY].every(Number.isFinite) || moves.length === 0 || expectedLength <= 0) return undefined;
  if (Math.hypot(endX - startX, endY - startY) < 2) return undefined;
  const rawSelection = up.data?.selection as Record<string, unknown>;
  const selection = Object.fromEntries([
    'type', 'direction', 'start', 'end', 'anchorOffset', 'focusOffset', 'selectedTextLength', 'anchorSelector', 'focusSelector',
  ].flatMap((key) => rawSelection[key] === undefined ? [] : [[key, rawSelection[key]]]));
  const target = (down.accessibleName || down.text || down.selector || 'page content').replace(/\s+/g, ' ').trim().slice(0, 100);
  return {
    id: randomUUID(),
    kind: 'select-text',
    label: `Select text in ${target}`,
    url,
    locator: recordedLocator(down) ?? recordedLocator(up),
    expected: `A native text selection containing ${expectedLength} characters`,
    metadata: {
      action: 'select-text',
      recordedViewportWidth: down.width ?? up.width,
      recordedViewportHeight: down.height ?? up.height,
      recordedOffsetMs: up.offsetMs,
      dragDurationMs: Math.max(0, up.offsetMs - down.offsetMs),
      selectionStart: { x: startX, y: startY, offsetMs: down.offsetMs },
      selectionEnd: { x: endX, y: endY, offsetMs: up.offsetMs },
      dragPath: compactPointerTrail(moves),
      expectedSelectedTextLength: expectedLength,
      selection,
    },
  };
}

function planFromRecording(recording: PathproofRecording): { pages: string[]; steps: PlanStep[]; actionCount: number } {
  const events = [...recording.events].sort((a, b) => a.sequence - b.sequence);
  const pages: string[] = [];
  const steps: PlanStep[] = [];
  let pointerTrail: PointerTrailSample[] = [];
  let pendingPointer: { selector?: string; metadata: Record<string, unknown> } | undefined;
  let selectionDrag: PendingSelectionDrag | undefined;
  let pendingSelectionClick: { x: number; y: number; untilOffsetMs: number } | undefined;
  const addPage = (url: string) => { if (!pages.includes(url)) pages.push(url); };
  let currentUrl = parseHttpUrl(recording.target.initialUrl).toString();
  addPage(currentUrl);
  steps.push({ id: randomUUID(), kind: 'navigate', label: `Open ${new URL(currentUrl).pathname || '/'}`, url: currentUrl });

  for (let index = 0; index < events.length; index += 1) {
    const item = events[index];
    const url = eventUrl(item, currentUrl);
    if (item.kind === 'mousemove') {
      if (typeof item.x === 'number' && typeof item.y === 'number') {
        const buttons = Number(item.data?.buttons);
        if (selectionDrag && Number.isFinite(buttons) && (buttons & 1) === 1) {
          selectionDrag.moves.push({ x: item.x, y: item.y, offsetMs: item.offsetMs, selector: item.selector, role: item.role, accessibleName: item.accessibleName });
          if (selectionDrag.moves.length > 2_000) selectionDrag.moves = compactPointerTrail(selectionDrag.moves, 600);
          continue;
        }
        pointerTrail.push({ x: item.x, y: item.y, offsetMs: item.offsetMs, selector: item.selector, role: item.role, accessibleName: item.accessibleName });
        if (pointerTrail.length > 2_000) pointerTrail = compactPointerTrail(pointerTrail, 600);
      }
      continue;
    }
    if (item.kind === 'pointerdown') {
      if (selectionDrag?.moves.length) pointerTrail.push(...selectionDrag.moves);
      selectionDrag = undefined;
      pendingSelectionClick = undefined;
      const button = Number(item.data?.button);
      if ((button === 0 || !Number.isFinite(button)) && typeof item.x === 'number' && typeof item.y === 'number') {
        selectionDrag = { down: item, moves: [] };
      }
      continue;
    }
    if (item.kind === 'pointerup') {
      if (selectionDrag) {
        const selectionStep = selectionDragStep(selectionDrag.down, item, selectionDrag.moves, url);
        if (selectionStep) {
          steps.push(selectionStep);
          pointerTrail = [];
          pendingPointer = undefined;
          pendingSelectionClick = { x: Number(item.x), y: Number(item.y), untilOffsetMs: item.offsetMs + 700 };
        } else if (selectionDrag.moves.length) {
          pointerTrail.push(...selectionDrag.moves);
        }
      }
      selectionDrag = undefined;
      continue;
    }
    if (item.kind === 'video-frame') continue;
    if (item.kind === 'navigation') {
      if (url === currentUrl) continue;
      pointerTrail = []; pendingPointer = undefined; selectionDrag = undefined; pendingSelectionClick = undefined;
      currentUrl = url; addPage(url);
      steps.push({ id: randomUUID(), kind: 'navigate', label: `Navigate to ${new URL(url).pathname || '/'}`, url });
      continue;
    }
    if (item.kind === 'scroll') {
      const previous = steps[steps.length - 1];
      if (previous?.kind === 'scroll' && previous.url === url) steps.pop();
      steps.push({ id: randomUUID(), kind: 'scroll', label: 'Scroll page', url, metadata: { x: item.scrollX ?? 0, y: item.scrollY ?? 0 } });
      continue;
    }
    if (item.kind === 'input') {
      if (item.value === '[redacted]') continue;
      const nextAction = events.slice(index + 1).find((candidate) => ['input', 'change', 'click', 'keydown', 'navigation'].includes(candidate.kind));
      if (nextAction?.kind === 'input' && nextAction.selector === item.selector) continue;
      if (!recordedLocator(item)) continue;
      steps.push({ id: randomUUID(), kind: 'fill', label: `Fill ${item.accessibleName || item.selector || 'field'}`, url, locator: recordedLocator(item), metadata: { action: 'fill', value: item.value ?? '', expectedName: item.accessibleName ?? '' } });
      continue;
    }
    if (item.kind === 'change') {
      if (!recordedLocator(item)) continue;
      const inputType = String(item.data?.inputType ?? '');
      const pending = pendingPointer;
      const pointer = pending && pending.selector === item.selector ? pending.metadata : {};
      pendingPointer = undefined;
      if (inputType === 'checkbox' || inputType === 'radio') {
        steps.push({ id: randomUUID(), kind: 'check', label: `${item.data?.checked ? 'Check' : 'Uncheck'} ${item.accessibleName || item.selector || 'control'}`, url, locator: recordedLocator(item), metadata: { ...pointer, action: 'check', checked: Boolean(item.data?.checked), expectedName: item.accessibleName ?? '' } });
      } else if (item.tagName?.toLowerCase() === 'select') {
        steps.push({ id: randomUUID(), kind: 'select', label: `Select ${item.accessibleName || item.selector || 'option'}`, url, locator: recordedLocator(item), metadata: { ...pointer, action: 'select', value: item.value ?? '', expectedName: item.accessibleName ?? '' } });
      }
      continue;
    }
    if (item.kind === 'keydown' && item.key && ['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp'].includes(item.key) && recordedLocator(item)) {
      steps.push({ id: randomUUID(), kind: 'keypress', label: `Press ${item.key}`, url, locator: recordedLocator(item), metadata: { action: 'press', key: item.key, expectedName: item.accessibleName ?? '' } });
      continue;
    }
    if ((item.kind === 'click' || item.kind === 'dblclick') && recordedLocator(item)) {
      if (pendingSelectionClick) {
        const clickX = Number(item.x);
        const clickY = Number(item.y);
        const isSyntheticSelectionClick = item.offsetMs <= pendingSelectionClick.untilOffsetMs
          && Number.isFinite(clickX) && Number.isFinite(clickY)
          && Math.hypot(clickX - pendingSelectionClick.x, clickY - pendingSelectionClick.y) <= 12;
        pendingSelectionClick = undefined;
        if (isSyntheticSelectionClick) continue;
      }
      if (item.kind === 'click') {
        const upcomingDoubleClick = events.slice(index + 1).find((candidate) => candidate.kind === 'dblclick' && candidate.selector === item.selector && candidate.offsetMs - item.offsetMs < 700);
        if (upcomingDoubleClick) continue;
        const related = events.slice(index + 1).find((candidate) => ['click', 'dblclick', 'change', 'navigation'].includes(candidate.kind));
        if (related && related.selector === item.selector && related.offsetMs - item.offsetMs < 700 && related.kind === 'dblclick') continue;
        if (related && related.selector === item.selector && related.offsetMs - item.offsetMs < 700 && related.kind === 'change') {
          pendingPointer = { selector: item.selector, metadata: pointerMetadata(item, pointerTrail) };
          pointerTrail = [];
          continue;
        }
      }
      const nextNavigation = events.slice(index + 1).find((candidate) => candidate.kind === 'navigation' || ['click', 'dblclick', 'input', 'change'].includes(candidate.kind));
      const expectedUrl = nextNavigation?.kind === 'navigation' ? eventUrl(nextNavigation, url) : '';
      steps.push({
        id: randomUUID(), kind: 'click', label: `Click ${item.accessibleName || item.text || item.selector || 'control'}`, url,
        locator: recordedLocator(item), expected: expectedUrl ? `Navigate to ${expectedUrl}` : 'Control accepts the interaction',
        metadata: {
          ...pointerMetadata(item, pointerTrail),
          action: item.kind === 'dblclick' ? 'dblclick' : 'click', expectedName: item.accessibleName ?? '', expectedUrl,
        },
      });
      pointerTrail = []; pendingPointer = undefined;
    }
  }
  return { pages, steps, actionCount: steps.filter((step) => step.kind !== 'navigate' && step.kind !== 'scroll').length };
}

function asyncRoute(handler: (request: express.Request, response: express.Response) => Promise<void>): RequestHandler {
  return (request, response, next) => void handler(request, response).catch(next);
}

function makeRun(projectId: string, testId: string, kind: Run['kind'], playbackSpeed = 1, name?: string): Run {
  const createdAt = new Date().toISOString();
  return {
    id: randomUUID(),
    projectId,
    testId,
    kind,
    aiUsed: false,
    status: 'queued',
    progress: 0,
    currentAction: 'Waiting for an available browser',
    createdAt,
    events: [{
      id: randomUUID(),
      runId: '',
      at: createdAt,
      type: 'status',
      label: 'Queued',
      status: 'queued',
    }],
    frameVersion: 0,
    ...(name ? { name } : {}),
    ...(kind === 'replay' ? { playbackSpeed } : {}),
  };
}

function nextReplayName(database: Database, projectId: string, offset = 0): string {
  const replayCount = database.runs.filter((run) => run.projectId === projectId && run.kind === 'replay').length;
  return `Saved test replay ${replayCount + offset + 1}`;
}

function withRunId(run: Run): Run {
  run.events[0].runId = run.id;
  return run;
}

export async function createApp(options: {
  store?: JsonStore;
  coordinator?: RunCoordinator;
  originResolver?: (input: string) => Promise<string>;
} = {}): Promise<{
  app: Express;
  store: JsonStore;
  coordinator: RunCoordinator;
}> {
  const store = options.store ?? new JsonStore();
  await store.initialize();
  const coordinator = options.coordinator ?? new RunCoordinator(store);
  await coordinator.initialize();
  const originResolver = options.originResolver ?? resolveProjectOrigin;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: process.env.PATHPROOF_IMPORT_LIMIT ?? '250mb' }));

  const deleteRunsById = async (requestedIds: string[]): Promise<number> => {
    const runIds = [...new Set(requestedIds)];
    await store.mutate((database) => {
      const missing = runIds.filter((id) => !database.runs.some((run) => run.id === id));
      if (missing.length > 0) throw new ApiError(404, 'RUNS_NOT_FOUND', 'One or more selected runs were not found.', { ids: missing });
      const activeRuns = database.runs.filter((run) => runIds.includes(run.id) && ['queued', 'running'].includes(run.status));
      if (activeRuns.length > 0) throw new ApiError(409, 'RUN_BUSY', 'Wait for active runs to finish before deleting them.', { ids: activeRuns.map((run) => run.id) });
      const affectedTestIds = new Set(database.runs.filter((run) => runIds.includes(run.id)).map((run) => run.testId));
      database.runs = database.runs.filter((run) => !runIds.includes(run.id));
      for (const test of database.tests) {
        if (!affectedTestIds.has(test.id)) continue;
        test.lastRunId = database.runs.filter((run) => run.testId === test.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.id;
      }
      store.recomputeProjects(database);
    });
    await coordinator.deleteRunArtifacts(runIds);
    return runIds.length;
  };

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok', runnerConcurrency: coordinator.capacity, timestamp: new Date().toISOString() });
  });

  app.get('/api/dashboard', (_request, response) => {
    const database = store.snapshot();
    const projects: DashboardProject[] = database.projects
      .map((project) => {
        const tests = database.tests.filter((test) => test.projectId === project.id);
        const lastRun = database.runs
          .filter((run) => run.projectId === project.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        return {
          ...project,
          tests: tests.length,
          readyTests: tests.filter((test) => Boolean(test.plan)).length,
          lastRun,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    response.json({ projects, running: database.runs.filter((run) => run.status === 'running' || run.status === 'queued') });
  });

  app.get('/api/projects', (_request, response) => {
    const database = store.snapshot();
    const projects: DashboardProject[] = database.projects.map((project) => {
      const tests = database.tests.filter((test) => test.projectId === project.id);
      const lastRun = database.runs
        .filter((run) => run.projectId === project.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return { ...project, tests: tests.length, readyTests: tests.filter((test) => Boolean(test.plan)).length, lastRun };
    });
    response.json(projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  });

  app.post('/api/origins/resolve', asyncRoute(async (request, response) => {
    const input = originResolveInput.parse(request.body);
    response.json({ origin: await originResolver(input.input) });
  }));

  app.post('/api/projects', asyncRoute(async (request, response) => {
    const input = projectInput.parse(request.body);
    const origin = await originResolver(input.origin ?? input.domain!);
    const project = await store.mutate((database) => {
      if (database.projects.some((candidate) => candidate.origin === origin)) {
        throw new ApiError(409, 'DUPLICATE_PROJECT', 'A project already exists for this domain.');
      }
      const created: Project = {
        id: randomUUID(),
        name: input.name,
        origin,
        createdAt: new Date().toISOString(),
        status: 'empty',
      };
      database.projects.push(created);
      return created;
    });
    response.status(201).json(project);
  }));

  app.post('/api/projects/bulk-delete', asyncRoute(async (request, response) => {
    const input = projectBulkDeleteInput.parse(request.body);
    const projectIds = [...new Set(input.projectIds)];
    const runIds = await store.mutate((database) => {
      const missing = projectIds.filter((id) => !database.projects.some((project) => project.id === id));
      if (missing.length > 0) {
        throw new ApiError(404, 'PROJECTS_NOT_FOUND', 'One or more selected projects were not found.', { ids: missing });
      }
      const busy = database.projects.filter((project) => projectIds.includes(project.id)
        && database.runs.some((run) => run.projectId === project.id && (run.status === 'queued' || run.status === 'running')));
      if (busy.length > 0) {
        throw new ApiError(409, 'PROJECT_BUSY', 'Wait for active runs to finish before deleting the selected projects.', {
          ids: busy.map((project) => project.id),
          names: busy.map((project) => project.name),
        });
      }
      const deletedRunIds = database.runs.filter((run) => projectIds.includes(run.projectId)).map((run) => run.id);
      database.projects = database.projects.filter((project) => !projectIds.includes(project.id));
      database.tests = database.tests.filter((test) => !projectIds.includes(test.projectId));
      database.runs = database.runs.filter((run) => !projectIds.includes(run.projectId));
      return deletedRunIds;
    });
    await coordinator.deleteRunArtifacts(runIds);
    response.json({ deleted: projectIds.length });
  }));

  app.get('/api/projects/:id', (request, response, next) => {
    try {
      const database = store.snapshot();
      const project = database.projects.find((candidate) => candidate.id === request.params.id);
      if (!project) throw notFound('Project');
      const detail: ProjectDetail = {
        project,
        tests: database.tests.filter((test) => test.projectId === project.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        runs: database.runs.filter((run) => run.projectId === project.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      };
      response.json(detail);
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/projects/:id', asyncRoute(async (request, response) => {
    const input = projectPatch.parse(request.body);
    const nextOrigin = input.origin || input.domain ? await originResolver(input.origin ?? input.domain!) : undefined;
    const project = await store.mutate((database) => {
      const draft = database.projects.find((candidate) => candidate.id === request.params.id);
      if (!draft) throw notFound('Project');
      if (nextOrigin && database.projects.some((candidate) => candidate.id !== draft.id && candidate.origin === nextOrigin)) {
        throw new ApiError(409, 'DUPLICATE_PROJECT', 'A project already exists for this domain.');
      }
      if (nextOrigin && nextOrigin !== draft.origin && database.tests.some((test) => test.projectId === draft.id)) {
        throw new ApiError(409, 'PROJECT_HAS_TESTS', 'The project origin cannot change after tests have been created.');
      }
      if (input.name) draft.name = input.name;
      if (nextOrigin) draft.origin = nextOrigin;
      return draft;
    });
    response.json(project);
  }));

  app.delete('/api/projects/:id', asyncRoute(async (request, response) => {
    const runIds = await store.mutate((database) => {
      const project = database.projects.find((candidate) => candidate.id === request.params.id);
      if (!project) throw notFound('Project');
      if (database.runs.some((run) => run.projectId === project.id && (run.status === 'queued' || run.status === 'running'))) {
        throw new ApiError(409, 'PROJECT_BUSY', 'Wait for active runs to finish before deleting this project.');
      }
      const deletedRunIds = database.runs.filter((run) => run.projectId === project.id).map((run) => run.id);
      database.projects = database.projects.filter((candidate) => candidate.id !== project.id);
      database.tests = database.tests.filter((test) => test.projectId !== project.id);
      database.runs = database.runs.filter((run) => run.projectId !== project.id);
      return deletedRunIds;
    });
    await coordinator.deleteRunArtifacts(runIds);
    response.status(204).end();
  }));

  app.post('/api/projects/:id/tests', asyncRoute(async (request, response) => {
    const input = testInput.parse(request.body);
    const rawSeeds = input.seedUrls ?? input.urls!;
    const database = store.snapshot();
    const project = database.projects.find((candidate) => candidate.id === request.params.id);
    if (!project) throw notFound('Project');
    const seedUrls = [...new Set(rawSeeds.map((seed) => parseHttpUrl(seed).toString()))];
    for (const seedUrl of seedUrls) {
      await assertSafeTarget(seedUrl);
      if (!sameOrigin(project.origin, seedUrl)) {
        throw new ApiError(400, 'ORIGIN_MISMATCH', `Seed URL must use the project origin ${project.origin}.`, { seedUrl });
      }
    }
    const created = await store.mutate((draft) => {
      const cookieHeader = input.browserState?.cookieHeader?.replace(/[\r\n]/g, '').trim();
      const test: TestDefinition = {
        id: randomUUID(),
        projectId: project.id,
        name: input.name,
        seedUrls,
        status: 'discovering',
        coverage: 0,
        createdAt: new Date().toISOString(),
        aiInstructions: input.aiInstructions || undefined,
        files: input.files?.length ? input.files : undefined,
        browserState: input.browserState ? {
          cookies: input.browserState.cookies,
          cookieHeader: cookieHeader || undefined,
        } : undefined,
      };
      const run = withRunId(makeRun(project.id, test.id, 'discovery'));
      test.lastRunId = run.id;
      draft.tests.push(test);
      draft.runs.push(run);
      store.recomputeProjects(draft);
      return { test, run };
    });
    coordinator.enqueue({ runId: created.run.id, testId: created.test.id });
    response.status(202).json(created);
  }));

  app.post('/api/projects/:id/recordings', asyncRoute(async (request, response) => {
    const input = recordingImportInput.parse(request.body);
    const recording = input.recording as PathproofRecording;
    const database = store.snapshot();
    const project = database.projects.find((candidate) => candidate.id === request.params.id);
    if (!project) throw notFound('Project');
    const initialUrl = parseHttpUrl(recording.target.initialUrl).toString();
    if (!sameOrigin(project.origin, initialUrl)) {
      throw new ApiError(400, 'ORIGIN_MISMATCH', `The recording must begin on the project origin ${project.origin}.`, { initialUrl });
    }
    const converted = planFromRecording(recording);
    if (converted.steps.length < 2) throw new ApiError(400, 'NO_REPLAYABLE_STEPS', 'The recording does not contain any replayable actions.');
    for (const page of converted.pages) await assertSafeTarget(page);
    const cookieHeader = input.cookieHeader?.replace(/[\r\n]/g, '').trim();
    const browserState: BrowserReplayState = {
      viewport: recording.browser.viewport,
      userAgent: recording.browser.userAgent,
      locale: recording.browser.locale || recording.browser.language,
      timezoneId: recording.browser.timezoneId,
      colorScheme: recording.browser.colorScheme,
      reducedMotion: recording.browser.reducedMotion,
      cookies: recording.browser.cookies,
      localStorage: recording.browser.localStorage,
      cookieHeader: cookieHeader || undefined,
    };
    const test = await store.mutate((draft) => {
      const created: TestDefinition = {
        id: randomUUID(), projectId: project.id, name: input.name, seedUrls: [initialUrl], status: 'ready', coverage: 100,
        createdAt: new Date().toISOString(), source: 'recording', browserState,
        recording: {
          recordingId: recording.id, importedAt: new Date().toISOString(), startedAt: recording.startedAt,
          durationMs: recording.durationMs, eventCount: recording.events.length, actionCount: converted.actionCount,
          finalUrl: recording.target.finalUrl, hasCookies: Boolean(recording.browser.cookies?.length || cookieHeader),
          streamFrameCount: recording.events.filter((item) => item.kind === 'video-frame').length,
        },
        plan: { version: 1, pages: converted.pages, steps: converted.steps, generatedBy: 'browser-recording' },
      };
      draft.tests.push(created);
      store.recomputeProjects(draft);
      return created;
    });
    response.status(201).json(test);
  }));

  app.get('/api/tests/:id', (request, response, next) => {
    try {
      const database = store.snapshot();
      const test = database.tests.find((candidate) => candidate.id === request.params.id);
      if (!test) throw notFound('Test');
      response.json({ test, runs: database.runs.filter((run) => run.testId === test.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/tests/:id', asyncRoute(async (request, response) => {
    const input = testPatch.parse(request.body);
    const test = await store.mutate((database) => {
      const draft = database.tests.find((candidate) => candidate.id === request.params.id);
      if (!draft) throw notFound('Test');
      draft.name = input.name;
      return draft;
    });
    response.json(test);
  }));

  app.patch('/api/tests/:id/cookies', asyncRoute(async (request, response) => {
    const input = recordingCookiePatch.parse(request.body);
    const cookieHeader = input.cookieHeader?.replace(/[\r\n]/g, '').trim();
    const test = await store.mutate((database) => {
      const draft = database.tests.find((candidate) => candidate.id === request.params.id);
      if (!draft) throw notFound('Test');
      if (draft.source !== 'recording' || !draft.recording) {
        throw new ApiError(409, 'NOT_A_RECORDING', 'Cookies can only be edited for imported recordings.');
      }
      if (database.runs.some((run) => run.testId === draft.id && (run.status === 'queued' || run.status === 'running'))) {
        throw new ApiError(409, 'TEST_BUSY', 'Wait for the active replay to finish before editing its cookies.');
      }
      draft.browserState = {
        ...draft.browserState,
        cookies: input.cookies,
        cookieHeader: cookieHeader || undefined,
      };
      draft.recording.hasCookies = input.cookies.length > 0 || Boolean(cookieHeader);
      return draft;
    });
    response.json(test);
  }));

  app.post('/api/tests/bulk-delete', asyncRoute(async (request, response) => {
    const input = testBulkDeleteInput.parse(request.body);
    const testIds = [...new Set(input.testIds)];
    const runIds = await store.mutate((database) => {
      const missing = testIds.filter((id) => !database.tests.some((test) => test.id === id));
      if (missing.length > 0) throw new ApiError(404, 'TESTS_NOT_FOUND', 'One or more selected tests were not found.', { ids: missing });
      const busy = database.tests.filter((test) => testIds.includes(test.id)
        && database.runs.some((run) => run.testId === test.id && (run.status === 'queued' || run.status === 'running')));
      if (busy.length > 0) {
        throw new ApiError(409, 'TEST_BUSY', 'Wait for active runs to finish before deleting the selected recordings.', {
          ids: busy.map((test) => test.id), names: busy.map((test) => test.name),
        });
      }
      const deletedRunIds = database.runs.filter((run) => testIds.includes(run.testId)).map((run) => run.id);
      database.tests = database.tests.filter((test) => !testIds.includes(test.id));
      database.runs = database.runs.filter((run) => !testIds.includes(run.testId));
      store.recomputeProjects(database);
      return deletedRunIds;
    });
    await coordinator.deleteRunArtifacts(runIds);
    response.json({ deleted: testIds.length });
  }));

  app.delete('/api/tests/:id', asyncRoute(async (request, response) => {
    const runIds = await store.mutate((database) => {
      const test = database.tests.find((candidate) => candidate.id === request.params.id);
      if (!test) throw notFound('Test');
      if (database.runs.some((run) => run.testId === test.id && (run.status === 'queued' || run.status === 'running'))) {
        throw new ApiError(409, 'TEST_BUSY', 'Wait for the active run to finish before deleting this test.');
      }
      const deletedRunIds = database.runs.filter((run) => run.testId === test.id).map((run) => run.id);
      database.tests = database.tests.filter((candidate) => candidate.id !== test.id);
      database.runs = database.runs.filter((run) => run.testId !== test.id);
      store.recomputeProjects(database);
      return deletedRunIds;
    });
    await coordinator.deleteRunArtifacts(runIds);
    response.status(204).end();
  }));

  const replayHandler = asyncRoute(async (request, response) => {
    const input = replayRunInput.parse(request.body ?? {});
    const created = await store.mutate((database) => {
      const test = database.tests.find((candidate) => candidate.id === request.params.id);
      if (!test) throw notFound('Test');
      if (!test.plan) throw new ApiError(409, 'TEST_NOT_READY', 'Discovery must complete before this test can be replayed.');
      const run = withRunId(makeRun(test.projectId, test.id, 'replay', input.playbackSpeed, nextReplayName(database, test.projectId)));
      database.runs.push(run);
      test.lastRunId = run.id;
      store.recomputeProjects(database);
      return run;
    });
    coordinator.enqueue({ runId: created.id, testId: created.testId });
    response.status(202).json(created);
  });
  app.post('/api/tests/:id/run', replayHandler);
  app.post('/api/tests/:id/runs', replayHandler);

  const bulkHandler = asyncRoute(async (request, response) => {
    const input = bulkInput.parse(request.body);
    const created = await store.mutate((database) => {
      const requested = new Set(input.testIds ?? []);
      for (const test of database.tests) if (input.projectIds?.includes(test.projectId)) requested.add(test.id);
      const missing = [...requested].filter((id) => !database.tests.some((test) => test.id === id));
      if (missing.length > 0) throw new ApiError(404, 'TESTS_NOT_FOUND', 'One or more selected tests were not found.', { ids: missing });
      const tests = database.tests.filter((test) => requested.has(test.id) && test.plan);
      if (tests.length === 0) throw new ApiError(409, 'NO_READY_TESTS', 'The selection has no tests with a saved plan.');
      const projectOffsets = new Map<string, number>();
      const runs = tests.map((test) => {
        const offset = projectOffsets.get(test.projectId) ?? 0;
        projectOffsets.set(test.projectId, offset + 1);
        return withRunId(makeRun(test.projectId, test.id, 'replay', input.playbackSpeeds?.[test.id] ?? 1, nextReplayName(database, test.projectId, offset)));
      });
      database.runs.push(...runs);
      for (const test of tests) test.lastRunId = runs.find((run) => run.testId === test.id)!.id;
      store.recomputeProjects(database);
      return runs;
    });
    for (const run of created) coordinator.enqueue({ runId: run.id, testId: run.testId });
    response.status(202).json({ runs: created });
  });
  app.post('/api/batches', bulkHandler);
  app.post('/api/runs/bulk', bulkHandler);
  app.post('/api/projects/bulk-run', bulkHandler);

  app.get('/api/runs', (request, response) => {
    const projectId = typeof request.query.projectId === 'string' ? request.query.projectId : undefined;
    const runs = store.snapshot().runs
      .filter((run) => !projectId || run.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    response.json(runs);
  });

  app.get('/api/runs/:id', (request, response, next) => {
    try {
      const run = store.snapshot().runs.find((candidate) => candidate.id === request.params.id);
      if (!run) throw notFound('Run');
      response.json(run);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/runs/bulk-delete', asyncRoute(async (request, response) => {
    const input = runBulkDeleteInput.parse(request.body);
    response.json({ deleted: await deleteRunsById(input.runIds) });
  }));

  app.delete('/api/runs/:id', asyncRoute(async (request, response) => {
    await deleteRunsById([String(request.params.id)]);
    response.status(204).end();
  }));

  app.post('/api/runs/:id/control', asyncRoute(async (request, response) => {
    const input = runControlInput.parse(request.body);
    const current = store.snapshot().runs.find((candidate) => candidate.id === request.params.id);
    if (!current) throw notFound('Run');
    if (!['queued', 'running'].includes(current.status)) throw new ApiError(409, 'RUN_NOT_ACTIVE', 'Only an active run can be paused, resumed, or stopped.');
    const run = input.action === 'pause'
      ? await coordinator.pauseRun(current.id)
      : input.action === 'resume'
        ? await coordinator.resumeRun(current.id)
        : await coordinator.stopRun(current.id);
    response.json(run);
  }));

  app.patch('/api/runs/:id', asyncRoute(async (request, response) => {
    const input = runPatch.parse(request.body);
    const run = await store.mutate((database) => {
      const draft = database.runs.find((candidate) => candidate.id === request.params.id);
      if (!draft) throw notFound('Run');
      draft.name = input.name;
      return draft;
    });
    response.json(run);
  }));

  app.get('/api/runs/:id/pathfinder-steps', (request, response, next) => {
    try {
      const database = store.snapshot();
      const run = database.runs.find((candidate) => candidate.id === request.params.id);
      if (!run) throw notFound('Run');
      const test = database.tests.find((candidate) => candidate.id === run.testId);
      if (!test) throw notFound('Test');
      const fallbackSteps = run.events
        .filter((item) => !['status', 'inspect', 'warning', 'complete'].includes(item.type))
        .map((item, index) => ({
          sequence: index + 1, kind: item.type, label: item.label, url: item.url,
          expected: item.expected, actual: item.actual, status: item.status, at: item.at,
        }));
      const safePart = (value: string, maximum = 80) => value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, maximum) || 'unknown';
      const safeName = safePart(test.name);
      const runLabel = safePart(run.name || (run.kind === 'replay' ? 'saved-test-replay' : 'first-run-setup'), 60);
      const runTimestamp = safePart((run.completedAt || run.startedAt || run.createdAt).replace(/\.\d{3}Z$/, 'Z').replace('T', '_').replace(/:/g, '-'), 32);
      const shortRunId = safePart(run.id, 12);
      const exportFilename = `${safeName}-${runLabel}-${runTimestamp}-${safePart(run.status, 20)}-${shortRunId}-pathfinder-steps.json`;
      response.status(200).set({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFilename}"`,
        'Cache-Control': 'no-store',
      }).send(JSON.stringify({
        format: 'pathproof-pathfinder-steps', version: 1, exportedAt: new Date().toISOString(),
        test: { id: test.id, name: test.name, source: test.plan?.generatedBy ?? test.source ?? 'unknown', startingUrls: test.seedUrls },
        run: { id: run.id, name: run.name, kind: run.kind, status: run.status, aiUsed: run.aiUsed, createdAt: run.createdAt, completedAt: run.completedAt },
        steps: test.plan?.steps ?? fallbackSteps,
        evidence: run.events,
      }, null, 2));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/runs/:id/logs', (request, response, next) => {
    try {
      const database = store.snapshot();
      const run = database.runs.find((candidate) => candidate.id === request.params.id);
      if (!run) throw notFound('Run');
      const test = database.tests.find((candidate) => candidate.id === run.testId);
      if (!test) throw notFound('Test');
      const startedAt = new Date(run.startedAt ?? run.createdAt).getTime();
      const interactions = run.events.map((item, index) => {
        const expected = item.expected ?? null;
        const actual = item.actual ?? null;
        const compared = expected !== null || actual !== null;
        return {
          sequence: index + 1,
          id: item.id,
          at: item.at,
          elapsedMs: Math.max(0, new Date(item.at).getTime() - startedAt),
          type: item.type,
          label: item.label,
          url: item.url ?? null,
          status: item.status,
          comparison: {
            expected,
            actual,
            result: compared ? item.status === 'passed' ? 'matched' : item.status === 'failed' ? 'different' : 'not-completed' : 'not-compared',
          },
        };
      });
      const safePart = (value: string, maximum = 80) => value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, maximum) || 'unknown';
      const safeName = safePart(test.name);
      const runLabel = safePart(run.name || (run.kind === 'replay' ? 'saved-test-replay' : 'first-run-setup'), 60);
      const runTimestamp = safePart((run.completedAt || run.startedAt || run.createdAt).replace(/\.\d{3}Z$/, 'Z').replace('T', '_').replace(/:/g, '-'), 32);
      const shortRunId = safePart(run.id, 12);
      const exportFilename = `${safeName}-${runLabel}-${runTimestamp}-${safePart(run.status, 20)}-${shortRunId}-run-logs.json`;
      response.status(200).set({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFilename}"`,
        'Cache-Control': 'no-store',
      }).send(JSON.stringify({
        format: 'pathproof-run-logs',
        version: 1,
        exportedAt: new Date().toISOString(),
        test: {
          id: test.id,
          name: test.name,
          source: test.plan?.generatedBy ?? test.source ?? 'unknown',
          startingUrls: test.seedUrls,
        },
        run: {
          id: run.id,
          name: run.name,
          kind: run.kind,
          status: run.status,
          aiUsed: run.aiUsed,
          playbackSpeed: run.playbackSpeed,
          progress: run.progress,
          createdAt: run.createdAt,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          durationMs: run.durationMs,
          currentUrl: run.currentUrl,
          currentAction: run.currentAction,
          error: run.error,
        },
        summary: {
          totalInteractions: interactions.length,
          passed: interactions.filter((item) => item.status === 'passed').length,
          failed: interactions.filter((item) => item.status === 'failed').length,
          skipped: interactions.filter((item) => item.status === 'skipped').length,
          comparisonsMatched: interactions.filter((item) => item.comparison.result === 'matched').length,
          comparisonsDifferent: interactions.filter((item) => item.comparison.result === 'different').length,
        },
        recordedBaseline: test.plan ?? null,
        interactions,
      }, null, 2));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/runs/:id/events', (request, response, next) => {
    const initial = store.snapshot().runs.find((candidate) => candidate.id === request.params.id);
    if (!initial) return next(notFound('Run'));
    response.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    const send = (run: Run) => response.write(`event: run\ndata: ${JSON.stringify(run)}\n\n`);
    send(initial);
    const unsubscribe = coordinator.subscribe(initial.id, (run) => {
      send(run);
      if (run.status === 'passed' || run.status === 'failed' || run.status === 'interrupted') response.end();
    });
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
    request.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get('/api/runs/:id/frame', asyncRoute(async (request, response) => {
    const run = store.snapshot().runs.find((candidate) => candidate.id === request.params.id);
    if (!run) throw notFound('Run');
    if (run.frameVersion === 0) {
      response.status(204).end();
      return;
    }
    response.set({ 'Cache-Control': 'no-store', 'Content-Type': 'image/jpeg', 'X-Frame-Version': String(run.frameVersion) });
    response.send(await readFile(path.join(coordinator.framesDirectory, `${run.id}.jpg`)));
  }));

  app.get('/api/runs/:id/stream', (request, response, next) => {
    const initial = store.snapshot().runs.find((candidate) => candidate.id === request.params.id);
    if (!initial) return next(notFound('Run'));
    const boundary = 'pathproof-frame';
    let closed = false;
    let blocked = false;
    let pendingFrame: Buffer | undefined;
    response.status(200).set({
      'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    const sendFrame = (frame: Buffer) => {
      if (closed) return;
      if (blocked) { pendingFrame = frame; return; }
      const header = Buffer.from(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      blocked = !response.write(Buffer.concat([header, frame, Buffer.from('\r\n')]));
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribeFrames(); unsubscribeRun();
    };
    const finish = () => {
      if (closed) return;
      response.end(`--${boundary}--\r\n`);
      cleanup();
    };
    response.on('drain', () => {
      blocked = false;
      if (pendingFrame) { const nextFrame = pendingFrame; pendingFrame = undefined; sendFrame(nextFrame); }
    });
    const unsubscribeFrames = coordinator.subscribeFrames(initial.id, sendFrame);
    const unsubscribeRun = coordinator.subscribe(initial.id, (run) => {
      if (run.status === 'passed' || run.status === 'failed' || run.status === 'interrupted') finish();
    });
    const latest = coordinator.latestFrame(initial.id);
    if (latest) sendFrame(latest);
    if (initial.status === 'passed' || initial.status === 'failed' || initial.status === 'interrupted') finish();
    request.on('close', cleanup);
    response.on('close', cleanup);
  });

  app.use('/api', (_request, _response, next) => next(notFound('API route')));
  app.use(errorHandler);
  return { app, store, coordinator };
}

async function attachFrontend(app: Express): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
    return;
  }
  const dist = path.resolve(process.cwd(), 'dist');
  await access(dist);
  app.use(express.static(dist));
  app.use((_request, response) => response.sendFile(path.join(dist, 'index.html')));
}

export async function startServer(): Promise<void> {
  loadLocalEnvironment();
  const { app } = await createApp();
  await attachFrontend(app);
  const port = Number(process.env.PORT ?? 43827);
  app.listen(port, () => console.log(`Pathproof is running at http://localhost:${port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
