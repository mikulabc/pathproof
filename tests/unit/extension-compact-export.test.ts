import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type CompactExport = {
  events: Array<{ id: string; kind: string; selector?: string; offsetMs: number; key?: string; value?: string; data?: Record<string, unknown> }>;
  meta: {
    name: string;
    target: { initialUrl: string; finalUrl: string; title?: string };
    options: Record<string, unknown>;
    browser: { cookies?: unknown[]; localStorage?: Record<string, string> };
    diagnostics: { compactExport: { jsonBytes: number; omitted: Record<string, number> } };
  };
};

function loadCompactor(): (session: Record<string, unknown>) => CompactExport {
  const listener = { addListener: () => undefined };
  const chrome = {
    storage: { local: { get: async () => ({}), set: async () => undefined } },
    action: { onClicked: listener },
    runtime: { onMessage: listener, sendMessage: async () => undefined, getURL: (value: string) => value },
    tabs: { onUpdated: listener, onRemoved: listener },
    windows: { onBoundsChanged: listener },
    debugger: { onEvent: listener, onDetach: listener },
  };
  const source = readFileSync(path.resolve(process.cwd(), 'chrome-extension/background.js'), 'utf8');
  return vm.runInNewContext(`${source}\ncompactExportFor;`, {
    chrome, crypto: { randomUUID }, TextEncoder, console,
  }) as (session: Record<string, unknown>) => CompactExport;
}

describe('Chrome extension compact export', () => {
  it('compacts noisy artifacts while preserving replay actions and hover timing', () => {
    const compactExportFor = loadCompactor();
    const at = new Date().toISOString();
    const events: Array<Record<string, unknown>> = [{
      id: 'navigation', sequence: 1, at, offsetMs: 0, kind: 'navigation', url: 'https://example.test/',
    }];
    for (let index = 0; index < 12_000; index += 1) {
      const overMenu = index >= 11_700;
      events.push({
        id: `move-${index}`, sequence: index + 2, at, offsetMs: index * 5, kind: 'mousemove',
        url: 'https://example.test/', selector: overMenu ? '#products-menu' : '#canvas',
        role: overMenu ? 'button' : undefined, accessibleName: overMenu ? 'Products' : undefined,
        x: index % 1_200, y: (index * 3) % 700, width: 1_280, height: 720,
        data: { buttons: 0, pointerType: 'mouse', eventTimestamp: index * 5, cursor: overMenu ? 'pointer' : 'default' },
      });
    }
    events.push({
      id: 'click', sequence: 12_002, at, offsetMs: 61_000, kind: 'click', url: 'https://example.test/',
      selector: '#products-menu', role: 'button', accessibleName: 'Products', x: 900, y: 100, width: 1_280, height: 720,
    });
    events.push({ id: 'screenshot', sequence: 12_003, at, offsetMs: 61_100, kind: 'screenshot', url: 'https://example.test/', data: { image: 'x'.repeat(500_000) } });
    events.push({ id: 'body', sequence: 12_004, at, offsetMs: 61_200, kind: 'network-response', url: 'https://example.test/api', data: { phase: 'body', body: 'x'.repeat(800_000) } });
    events.push({ id: 'snapshot', sequence: 12_005, at, offsetMs: 61_300, kind: 'snapshot', url: 'https://example.test/', data: { strings: ['x'.repeat(800_000)] } });

    const cookies = Array.from({ length: 300 }, (_, index) => ({
      name: `session-${index}`, value: 'v'.repeat(8_192), domain: 'example.test', path: '/', secure: true, sameSite: 'lax',
    }));
    const localStorage = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`state-${index}`, 's'.repeat(32_000)]));
    const compact = compactExportFor({
      id: 'compact-test', tabId: 12, name: 'Compact stress test', status: 'stopped', createdAt: at, startedAt: at, stoppedAt: at,
      initialUrl: 'https://example.test/', currentUrl: 'https://example.test/', title: 'Example', sequence: 12_006,
      events, streamFrameCount: 5_000, options: { captureMouseMoves: true, captureStream: true, includeCookies: true },
      browser: { viewport: { width: 1_280, height: 720 }, cookies, localStorage }, diagnostics: {},
    });
    const json = JSON.stringify({ ...compact.meta, events: compact.events });
    const omitted = compact.meta.diagnostics.compactExport.omitted;

    expect(Buffer.byteLength(json)).toBeGreaterThan(0);
    expect(compact.events.some((event) => event.kind === 'navigation')).toBe(true);
    expect(compact.events.some((event) => event.kind === 'click' && event.selector === '#products-menu')).toBe(true);
    expect(compact.events.some((event) => event.kind === 'mousemove' && event.selector === '#products-menu')).toBe(true);
    expect(compact.events.every((event) => !['video-frame', 'screenshot', 'snapshot'].includes(event.kind))).toBe(true);
    expect(omitted.videoFrames).toBe(5_000);
    expect(omitted.screenshots).toBe(1);
    expect(omitted.networkBodies).toBe(1);
    expect(omitted.domSnapshots).toBe(1);
    expect(omitted.pointerSamples).toBeGreaterThan(0);
  });

  it('preserves more than 20,000 semantic actions without a file-size ceiling', () => {
    const compactExportFor = loadCompactor();
    const at = new Date().toISOString();
    const events: Array<Record<string, unknown>> = [{
      id: 'journey-start', sequence: 1, at, offsetMs: 0, kind: 'navigation', url: 'https://example.test/form',
    }];
    for (let index = 0; index < 22_000; index += 1) {
      const base = { sequence: index + 2, at, offsetMs: index * 10 + 10, url: 'https://example.test/form' };
      if (index === 0) events.push({ ...base, id: 'begin-input', kind: 'input', selector: '#first-name', role: 'textbox', value: 'Ada' });
      else if (index === 10_999) events.push({ ...base, id: 'middle-select', kind: 'change', selector: '#country', role: 'combobox', tagName: 'select', value: 'DE', data: { inputType: 'select-one' } });
      else if (index === 11_000) events.push({ ...base, id: 'middle-scroll', kind: 'scroll', scrollX: 0, scrollY: 900 });
      else if (index === 21_999) events.push({ ...base, id: 'end-key', kind: 'keydown', selector: '#submit', role: 'button', key: 'Enter', data: { code: 'Enter' } });
      else events.push({ ...base, id: `action-${index}`, kind: 'click', selector: `#control-${index}`, role: 'button', accessibleName: `Control ${index}`, x: index % 1_000, y: index % 700 });
    }
    const started = performance.now();
    const compact = compactExportFor({
      id: 'large-essential-journey', tabId: 4, name: 'Large journey', status: 'stopped', createdAt: at, startedAt: at, stoppedAt: at,
      initialUrl: 'https://example.test/form', currentUrl: 'https://example.test/form', title: 'Form', sequence: events.length + 1,
      events, streamFrameCount: 0, options: { captureMouseMoves: true }, browser: { viewport: { width: 1_280, height: 720 } }, diagnostics: {},
    });
    const elapsedMs = performance.now() - started;
    const json = JSON.stringify({ ...compact.meta, events: compact.events });
    const ids = new Set(compact.events.map((event) => event.id));

    expect(elapsedMs).toBeLessThan(5_000);
    expect(Buffer.byteLength(json)).toBeGreaterThan(2 * 1024 * 1024);
    expect(compact.events).toHaveLength(events.length);
    expect(ids.has('journey-start')).toBe(true);
    expect(ids.has('begin-input')).toBe(true);
    expect(ids.has('middle-select')).toBe(true);
    expect(ids.has('middle-scroll')).toBe(true);
    expect(ids.has('end-key')).toBe(true);
    expect(compact.meta.diagnostics.compactExport.omitted).not.toHaveProperty('journeyTruncatedEvents');
  }, 10_000);

  it('bounds hostile multi-megabyte metadata inside the compactor', () => {
    const compactExportFor = loadCompactor();
    const at = new Date().toISOString();
    const huge = 'x'.repeat(3 * 1024 * 1024);
    const longUrl = `https://example.test/?payload=${huge}`;
    const compact = compactExportFor({
      id: huge, tabId: 9, name: huge, status: 'stopped', createdAt: huge, startedAt: huge, stoppedAt: huge,
      initialUrl: longUrl, currentUrl: longUrl, title: huge, sequence: 3,
      events: [
        { id: huge, sequence: 1, at, offsetMs: 0, kind: 'navigation', url: longUrl, text: huge },
        { id: 'hostile-click', sequence: 2, at, offsetMs: 10, kind: 'click', url: longUrl, selector: huge, accessibleName: huge, x: 1, y: 1 },
      ],
      streamFrameCount: 0,
      options: { captureMouseMoves: true, hostile: { value: huge } },
      browser: { userAgent: huge, viewport: { width: 1_280, height: 720 }, cookies: [{ name: 'session', value: huge, domain: 'example.test' }] },
      diagnostics: { debuggerWarning: huge, hostile: huge },
    });
    const json = JSON.stringify({ ...compact.meta, events: compact.events });

    expect(Buffer.byteLength(json)).toBeGreaterThan(0);
    expect(compact.meta.name.length).toBeLessThanOrEqual(500);
    expect(compact.meta.target.initialUrl.length).toBeLessThanOrEqual(10_000);
    expect(compact.meta.target.finalUrl.length).toBeLessThanOrEqual(10_000);
    expect(compact.meta.target.title?.length).toBeLessThanOrEqual(2_000);
    expect(compact.meta.options).not.toHaveProperty('hostile');
  });

  it('never drops pointer identity transitions or long-gap boundaries at the soft sample limit', () => {
    const compactExportFor = loadCompactor();
    const at = new Date().toISOString();
    const events: Array<Record<string, unknown>> = [{ id: 'nav-hover', sequence: 1, at, offsetMs: 0, kind: 'navigation', url: 'https://example.test/menu' }];
    for (let index = 0; index < 110; index += 1) {
      const criticalHover = index >= 49 && index <= 57;
      events.push({
        id: `hover-${index}`, sequence: index + 2, at,
        offsetMs: index * 10 + (index >= 53 ? 600 : 0), kind: 'mousemove', url: 'https://example.test/menu',
        selector: criticalHover ? '#critical-hover' : `#target-${index}`, x: index * 4, y: index * 2,
        data: { cursor: criticalHover ? 'pointer' : 'default' },
      });
    }
    events.push({ id: 'hover-click', sequence: 112, at, offsetMs: 1_800, kind: 'click', url: 'https://example.test/menu', selector: '#destination', role: 'link', x: 440, y: 220 });
    const compact = compactExportFor({
      id: 'hover-critical', tabId: 10, name: 'Hover critical', status: 'stopped', createdAt: at, startedAt: at, stoppedAt: at,
      initialUrl: 'https://example.test/menu', currentUrl: 'https://example.test/menu', title: 'Menu', sequence: 113,
      events, streamFrameCount: 0, options: { captureMouseMoves: true }, browser: { viewport: { width: 1_280, height: 720 } }, diagnostics: {},
    });
    const moves = compact.events.filter((event) => event.kind === 'mousemove');

    expect(moves.length).toBeGreaterThan(72);
    expect(moves.some((event) => event.selector === '#target-30')).toBe(true);
    expect(moves.some((event) => event.selector === '#target-90')).toBe(true);
    expect(moves.some((event) => event.selector === '#critical-hover' && event.offsetMs === 520)).toBe(true);
    expect(moves.some((event) => event.selector === '#critical-hover' && event.offsetMs === 1_130)).toBe(true);
  });

  it('collapses contiguous typing updates to the final replay value', () => {
    const compactExportFor = loadCompactor();
    const at = new Date().toISOString();
    const events: Array<Record<string, unknown>> = [{ id: 'typing-nav', sequence: 1, at, offsetMs: 0, kind: 'navigation', url: 'https://example.test/search' }];
    for (let index = 0; index < 4_000; index += 1) {
      events.push({
        id: `typing-${index}`, sequence: index + 2, at, offsetMs: index + 1, kind: 'input', url: 'https://example.test/search',
        selector: '#query', role: 'searchbox', value: `query-${index}`,
      });
    }
    events.push({ id: 'typing-hover', sequence: 4_002, at, offsetMs: 4_100, kind: 'mousemove', url: 'https://example.test/search', selector: '#submit', x: 400, y: 80 });
    events.push({ id: 'typing-click', sequence: 4_003, at, offsetMs: 4_200, kind: 'click', url: 'https://example.test/search', selector: '#submit', role: 'button', x: 400, y: 80 });
    const compact = compactExportFor({
      id: 'typing-dedupe', tabId: 11, name: 'Typing dedupe', status: 'stopped', createdAt: at, startedAt: at, stoppedAt: at,
      initialUrl: 'https://example.test/search', currentUrl: 'https://example.test/search', title: 'Search', sequence: 4_004,
      events, streamFrameCount: 0, options: { captureMouseMoves: true }, browser: { viewport: { width: 1_280, height: 720 } }, diagnostics: {},
    });
    const inputs = compact.events.filter((event) => event.kind === 'input');

    expect(inputs).toHaveLength(1);
    expect(inputs[0].value).toBe('query-3999');
    expect(compact.events.some((event) => event.id === 'typing-hover')).toBe(true);
    expect(compact.events.some((event) => event.id === 'typing-click')).toBe(true);
    expect(compact.meta.diagnostics.compactExport.omitted.deduplicatedInputs).toBe(3_999);
  });

  it('retains dense pointer identity transitions without a hard byte budget', () => {
    const compactExportFor = loadCompactor();
    const at = new Date().toISOString();
    const events: Array<Record<string, unknown>> = [{ id: 'dense-nav', sequence: 1, at, offsetMs: 0, kind: 'navigation', url: 'https://example.test/dense-menu' }];
    for (let index = 0; index < 5_000; index += 1) {
      events.push({
        id: index === 2_500 ? 'pre-gap-hover' : index === 2_501 ? 'post-gap-hover' : `dense-${index}`,
        sequence: index + 2, at, offsetMs: index * 5 + (index > 2_500 ? 600 : 0), kind: 'mousemove',
        url: 'https://example.test/dense-menu', selector: index === 2_500 ? '#critical-hover' : `#identity-${index}`,
        accessibleName: `Dense pointer identity ${index} ${'x'.repeat(300)}`, x: index % 1_200, y: index % 700,
        data: { cursor: index % 2 ? 'pointer' : 'default', buttons: 0 },
      });
    }
    events.push({ id: 'dense-click', sequence: 5_002, at, offsetMs: 26_000, kind: 'click', url: 'https://example.test/dense-menu', selector: '#destination', role: 'link', x: 900, y: 100 });
    const compact = compactExportFor({
      id: 'dense-hover-budget', tabId: 12, name: 'Dense hover budget', status: 'stopped', createdAt: at, startedAt: at, stoppedAt: at,
      initialUrl: 'https://example.test/dense-menu', currentUrl: 'https://example.test/dense-menu', title: 'Dense menu', sequence: 5_003,
      events, streamFrameCount: 0, options: { captureMouseMoves: true }, browser: { viewport: { width: 1_280, height: 720 } }, diagnostics: {},
    });
    const json = JSON.stringify({ ...compact.meta, events: compact.events });
    const moves = compact.events.filter((event) => event.kind === 'mousemove');

    expect(Buffer.byteLength(json)).toBeGreaterThan(2 * 1024 * 1024);
    expect(moves).toHaveLength(5_000);
    expect(moves.some((event) => event.id === 'pre-gap-hover' && event.selector === '#critical-hover')).toBe(true);
    expect(moves.some((event) => event.id === 'post-gap-hover')).toBe(true);
    expect(compact.meta.diagnostics.compactExport.omitted.pointerSamples).toBe(0);
  });

  it('marks only a real non-collapsed pointer selection pair as semantic', () => {
    const compactExportFor = loadCompactor();
    const at = new Date().toISOString();
    const compact = compactExportFor({
      id: 'selection-gesture', tabId: 13, name: 'Selection gesture', status: 'stopped', createdAt: at, startedAt: at, stoppedAt: at,
      initialUrl: 'https://example.test/article', currentUrl: 'https://example.test/article', title: 'Article', sequence: 8,
      events: [
        { id: 'selection-nav', sequence: 1, at, offsetMs: 0, kind: 'navigation', url: 'https://example.test/article' },
        { id: 'ordinary-down', sequence: 2, at, offsetMs: 10, kind: 'pointerdown', url: 'https://example.test/article', x: 10, y: 10, data: { pointerId: 1 } },
        { id: 'ordinary-up', sequence: 3, at, offsetMs: 20, kind: 'pointerup', url: 'https://example.test/article', x: 10, y: 10, data: { pointerId: 1, dragged: false, selection: { selectedTextLength: 12 } } },
        { id: 'selection-down', sequence: 4, at, offsetMs: 100, kind: 'pointerdown', url: 'https://example.test/article', selector: '#article', x: 20, y: 40, data: { pointerId: 2 } },
        { id: 'selection-move', sequence: 5, at, offsetMs: 180, kind: 'mousemove', url: 'https://example.test/article', selector: '#article', x: 220, y: 40, data: { pointerId: 2, buttons: 1 } },
        { id: 'selection-up', sequence: 6, at, offsetMs: 220, kind: 'pointerup', url: 'https://example.test/article', selector: '#article', x: 220, y: 40, data: { pointerId: 2, dragged: true, selection: { type: 'document', selectedTextLength: 34, anchorSelector: '#article', focusSelector: '#article', anchorOffset: 1, focusOffset: 35, selectedText: 'must not export' } } },
        { id: 'selection-click', sequence: 7, at, offsetMs: 230, kind: 'click', url: 'https://example.test/article', selector: '#article', x: 220, y: 40 },
      ],
      streamFrameCount: 0, options: { captureMouseMoves: true }, browser: { viewport: { width: 1_280, height: 720 } }, diagnostics: {},
    });
    const byId = new Map(compact.events.map((event) => [event.id, event]));
    const selection = byId.get('selection-up')?.data?.selection as Record<string, unknown>;

    expect(byId.get('selection-down')?.data?.selectionGesture).toBe(true);
    expect(byId.get('selection-up')?.data?.selectionGesture).toBe(true);
    expect(byId.get('ordinary-down')?.data?.selectionGesture).toBeUndefined();
    expect(byId.get('ordinary-up')?.data?.selectionGesture).toBeUndefined();
    expect(selection.selectedTextLength).toBe(34);
    expect(selection).not.toHaveProperty('selectedText');
  });
});
