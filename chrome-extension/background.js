const sessions = new Map();
const requestOwners = new Map();
const pendingFrameWrites = new Map();
const exportIndexCaches = new Map();
let persistenceTimer;

const storageKey = 'pathproof.activeSessions';
const maxExportPointerSamples = 1_600;
const maxCookieStateBytes = 512 * 1024;
const maxLocalStorageStateBytes = 128 * 1024;
const utf8 = new TextEncoder();
const isoNow = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const byteLength = (value) => utf8.encode(JSON.stringify(value)).byteLength;
const boundedText = (value, max) => typeof value === 'string' ? value.slice(0, max) : undefined;
const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const compactObject = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
const safeDateText = (value, fallback) => {
  const text = boundedText(value, 100);
  return text && Number.isFinite(Date.parse(text)) ? text : fallback;
};
const publicSession = (session) => ({
  id: session.id, tabId: session.tabId, name: session.name, status: session.status,
  startedAt: session.startedAt, stoppedAt: session.stoppedAt, initialUrl: session.initialUrl,
  currentUrl: session.currentUrl, eventCount: session.events.length + (session.streamFrameCount || 0), options: session.options,
});
function exportMeta(session, browser = session.browser, diagnostics = session.diagnostics) {
  const now = isoNow();
  const startedAt = safeDateText(session.startedAt, now);
  const stoppedAt = safeDateText(session.stoppedAt, now);
  const createdAt = safeDateText(session.createdAt, startedAt);
  const options = session.options && typeof session.options === 'object' ? session.options : {};
  return {
    format: 'pathproof-recording', version: 1, id: boundedText(session.id, 200) || uid(),
    name: boundedText(session.name, 500) || 'Recorded journey', createdAt, startedAt, stoppedAt,
    durationMs: Math.max(0, Date.parse(stoppedAt) - Date.parse(startedAt)),
    target: compactObject({
      tabId: Number.isInteger(session.tabId) ? session.tabId : undefined,
      initialUrl: boundedText(session.initialUrl, 10_000) || boundedText(session.currentUrl, 10_000) || 'https://invalid.local/',
      finalUrl: boundedText(session.currentUrl, 10_000) || boundedText(session.initialUrl, 10_000) || 'https://invalid.local/',
      title: boundedText(session.title, 2_000),
    }),
    options: compactObject({
      captureMouseMoves: typeof options.captureMouseMoves === 'boolean' ? options.captureMouseMoves : undefined,
      captureNetwork: typeof options.captureNetwork === 'boolean' ? options.captureNetwork : undefined,
      captureDom: typeof options.captureDom === 'boolean' ? options.captureDom : undefined,
      captureScreenshots: typeof options.captureScreenshots === 'boolean' ? options.captureScreenshots : undefined,
      captureStream: typeof options.captureStream === 'boolean' ? options.captureStream : undefined,
      captureNetworkBodies: typeof options.captureNetworkBodies === 'boolean' ? options.captureNetworkBodies : undefined,
      includeCookies: typeof options.includeCookies === 'boolean' ? options.includeCookies : undefined,
      includeSensitiveState: typeof options.includeSensitiveState === 'boolean' ? options.includeSensitiveState : undefined,
    }),
    browser, diagnostics,
  };
}

function sanitizeBrowserState(browser = {}, omitted) {
  const compact = compactObject({
    userAgent: boundedText(browser.userAgent, 2_000), platform: boundedText(browser.platform, 500),
    language: boundedText(browser.language, 100), locale: boundedText(browser.locale, 100),
    timezoneId: boundedText(browser.timezoneId, 200),
    colorScheme: ['light', 'dark', 'no-preference'].includes(browser.colorScheme) ? browser.colorScheme : undefined,
    reducedMotion: ['reduce', 'no-preference'].includes(browser.reducedMotion) ? browser.reducedMotion : undefined,
    viewport: browser.viewport && finiteNumber(browser.viewport.width) && finiteNumber(browser.viewport.height)
      ? { width: browser.viewport.width, height: browser.viewport.height } : undefined,
    window: browser.window && finiteNumber(browser.window.width) && finiteNumber(browser.window.height)
      ? compactObject({ width: browser.window.width, height: browser.window.height, state: boundedText(browser.window.state, 100) }) : undefined,
  });
  if (Array.isArray(browser.cookies)) {
    compact.cookies = [];
    let cookieBytes = 0;
    for (const cookie of browser.cookies) {
      if (compact.cookies.length >= 300) { omitted.cookies += 1; continue; }
      const name = boundedText(cookie?.name, 1_000);
      const domain = boundedText(cookie?.domain, 1_000);
      if (!name || !domain) { omitted.cookies += 1; continue; }
      const rawValue = typeof cookie.value === 'string' ? cookie.value : '';
      const value = rawValue.slice(0, 8_192);
      if (value.length < rawValue.length) omitted.cookieValueBytes += rawValue.length - value.length;
      const compactCookie = compactObject({
        name, value, domain, path: boundedText(cookie.path, 4_000), expires: finiteNumber(cookie.expires),
        httpOnly: typeof cookie.httpOnly === 'boolean' ? cookie.httpOnly : undefined,
        secure: typeof cookie.secure === 'boolean' ? cookie.secure : undefined,
        sameSite: ['Strict', 'Lax', 'None', 'no_restriction', 'lax', 'strict', 'unspecified'].includes(cookie.sameSite) ? cookie.sameSite : undefined,
      });
      const compactCookieBytes = byteLength(compactCookie) + 1;
      if (cookieBytes + compactCookieBytes > maxCookieStateBytes) { omitted.cookies += 1; continue; }
      compact.cookies.push(compactCookie);
      cookieBytes += compactCookieBytes;
    }
  }
  if (browser.localStorage && typeof browser.localStorage === 'object') {
    const localStorage = {};
    let storedBytes = 0;
    for (const [rawKey, rawValue] of Object.entries(browser.localStorage)) {
      const key = String(rawKey).slice(0, 2_000);
      const value = String(rawValue ?? '').slice(0, 32_000);
      const entryBytes = utf8.encode(key).byteLength + utf8.encode(value).byteLength;
      if (storedBytes + entryBytes > maxLocalStorageStateBytes) { omitted.localStorageEntries += 1; continue; }
      localStorage[key] = value;
      storedBytes += entryBytes;
      if (String(rawValue ?? '').length > value.length) omitted.localStorageValueBytes += String(rawValue ?? '').length - value.length;
    }
    compact.localStorage = localStorage;
  }
  return compact;
}

function sanitizeRect(value) {
  if (!value || typeof value !== 'object') return undefined;
  const rect = compactObject({ x: finiteNumber(value.x), y: finiteNumber(value.y), width: finiteNumber(value.width), height: finiteNumber(value.height) });
  return Object.keys(rect).length === 4 ? rect : undefined;
}

function sanitizeViewport(value) {
  if (!value || typeof value !== 'object') return undefined;
  const viewport = compactObject({ offsetLeft: finiteNumber(value.offsetLeft), offsetTop: finiteNumber(value.offsetTop), scale: finiteNumber(value.scale) });
  return Object.keys(viewport).length ? viewport : undefined;
}

function sanitizeModifiers(value) {
  if (!value || typeof value !== 'object') return undefined;
  return compactObject({ alt: Boolean(value.alt), ctrl: Boolean(value.ctrl), meta: Boolean(value.meta), shift: Boolean(value.shift) });
}

function sanitizeSelection(value) {
  if (!value || typeof value !== 'object') return undefined;
  return compactObject({
    type: boundedText(value.type, 40), direction: boundedText(value.direction, 40),
    start: finiteNumber(value.start), end: finiteNumber(value.end), anchorOffset: finiteNumber(value.anchorOffset),
    focusOffset: finiteNumber(value.focusOffset), selectedTextLength: finiteNumber(value.selectedTextLength),
    anchorSelector: boundedText(value.anchorSelector, 4_000), focusSelector: boundedText(value.focusSelector, 4_000),
  });
}

function sanitizeEventData(event, omitted) {
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  if (['mousemove', 'pointerdown', 'pointerup', 'click', 'dblclick'].includes(event.kind)) {
    return compactObject({
      source: boundedText(data.source, 80), button: finiteNumber(data.button), buttons: finiteNumber(data.buttons),
      pointerId: finiteNumber(data.pointerId), pointerType: boundedText(data.pointerType, 40), pressure: finiteNumber(data.pressure), detail: finiteNumber(data.detail),
      dragged: typeof data.dragged === 'boolean' ? data.dragged : undefined,
      selectionGesture: data.selectionGesture === true ? true : undefined,
      eventTimestamp: finiteNumber(data.eventTimestamp), eventEpochMs: finiteNumber(data.eventEpochMs),
      devicePixelRatio: finiteNumber(data.devicePixelRatio), cursor: boundedText(data.cursor, 80),
      visualViewport: sanitizeViewport(data.visualViewport), targetRect: sanitizeRect(data.targetRect),
      modifiers: sanitizeModifiers(data.modifiers), selection: sanitizeSelection(data.selection),
    });
  }
  if (event.kind === 'input' || event.kind === 'change') {
    return compactObject({
      inputType: boundedText(data.inputType, 100), checked: typeof data.checked === 'boolean' ? data.checked : undefined,
      redacted: typeof data.redacted === 'boolean' ? data.redacted : undefined, selection: sanitizeSelection(data.selection),
    });
  }
  if (event.kind === 'keydown') {
    return compactObject({ code: boundedText(data.code, 100), repeat: Boolean(data.repeat), modifiers: sanitizeModifiers(data.modifiers) });
  }
  if (event.kind === 'network-request') {
    if (data.headers && typeof data.headers === 'object') omitted.networkHeaders += Object.keys(data.headers).length;
    if (typeof data.postData === 'string') omitted.networkBodies += 1;
    return compactObject({ requestId: boundedText(data.requestId, 200), method: boundedText(data.method, 20), resourceType: boundedText(data.resourceType, 80) });
  }
  if (event.kind === 'network-response') {
    if (data.phase === 'body' || typeof data.body === 'string') { omitted.networkBodies += 1; return undefined; }
    if (data.headers && typeof data.headers === 'object') omitted.networkHeaders += Object.keys(data.headers).length;
    return compactObject({
      requestId: boundedText(data.requestId, 200), status: finiteNumber(data.status), statusText: boundedText(data.statusText, 120),
      mimeType: boundedText(data.mimeType, 160), protocol: boundedText(data.protocol, 40),
      fromDiskCache: typeof data.fromDiskCache === 'boolean' ? data.fromDiskCache : undefined,
    });
  }
  if (event.kind === 'dom-mutation') {
    return compactObject({
      source: boundedText(data.source, 80), change: boundedText(data.change, 100), attributes: finiteNumber(data.attributes),
      added: finiteNumber(data.added), removed: finiteNumber(data.removed), characterData: finiteNumber(data.characterData),
    });
  }
  if (event.kind === 'console') {
    return compactObject({ level: boundedText(data.level, 40), args: Array.isArray(data.args) ? data.args.slice(0, 10).map((item) => String(item ?? '').slice(0, 300)) : undefined });
  }
  if (event.kind === 'lifecycle') {
    return compactObject({ name: boundedText(data.name, 100), reason: boundedText(data.reason, 200), readyState: boundedText(data.readyState, 40) });
  }
  if (event.kind === 'navigation') {
    return compactObject({ transition: boundedText(data.transition, 100), source: boundedText(data.source, 100), navigationType: boundedText(data.navigationType, 100) });
  }
  if (event.kind === 'resize') return compactObject({ devicePixelRatio: finiteNumber(data.devicePixelRatio), windowState: boundedText(data.windowState, 100) });
  return undefined;
}

function sanitizeEvent(event, omitted) {
  if (event.kind === 'video-frame') { omitted.videoFrames += 1; return undefined; }
  if (event.kind === 'screenshot') { omitted.screenshots += 1; return undefined; }
  if (event.kind === 'snapshot') { omitted.domSnapshots += 1; return undefined; }
  const data = sanitizeEventData(event, omitted);
  if (event.kind === 'network-response' && event.data?.phase === 'body') return undefined;
  return compactObject({
    id: boundedText(event.id, 200) || uid(), sequence: Number.isInteger(event.sequence) ? event.sequence : 0,
    at: boundedText(event.at, 100) || isoNow(), offsetMs: Math.max(0, finiteNumber(event.offsetMs) || 0), kind: event.kind,
    url: boundedText(event.url, 10_000) || '', frameUrl: boundedText(event.frameUrl, 10_000),
    selector: boundedText(event.selector, 4_000), role: boundedText(event.role, 100),
    accessibleName: boundedText(event.accessibleName, 500), tagName: boundedText(event.tagName, 100),
    value: boundedText(event.value, 20_000), key: boundedText(event.key, 100),
    x: finiteNumber(event.x), y: finiteNumber(event.y), scrollX: finiteNumber(event.scrollX), scrollY: finiteNumber(event.scrollY),
    width: finiteNumber(event.width), height: finiteNumber(event.height), text: boundedText(event.text, 2_000),
    data: data && Object.keys(data).length ? data : undefined,
  });
}

function simplifyPointerSamples(samples, limit) {
  if (limit <= 0 || samples.length === 0) return [];
  if (samples.length <= limit) return samples;
  const important = new Set([0, samples.length - 1]);
  const identity = (event) => `${event.selector || ''}\n${event.role || ''}\n${event.accessibleName || ''}\n${event.data?.cursor || ''}\n${event.data?.buttons || 0}`;
  const pointerTime = (event) => finiteNumber(event.data?.eventEpochMs) ?? finiteNumber(event.offsetMs) ?? 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (identity(samples[index]) !== identity(samples[index - 1])) { important.add(index - 1); important.add(index); }
    if (pointerTime(samples[index]) - pointerTime(samples[index - 1]) >= 160) { important.add(index - 1); important.add(index); }
    if (index >= samples.length - 1) continue;
    const before = samples[index - 1]; const current = samples[index]; const after = samples[index + 1];
    const firstX = (current.x || 0) - (before.x || 0); const firstY = (current.y || 0) - (before.y || 0);
    const secondX = (after.x || 0) - (current.x || 0); const secondY = (after.y || 0) - (current.y || 0);
    const distance = Math.hypot(firstX, firstY) + Math.hypot(secondX, secondY);
    if (distance >= 12 && Math.abs(firstX * secondY - firstY * secondX) / distance >= 3) important.add(index);
  }
  if (important.size < limit) {
    for (let slot = 1; important.size < limit && slot < samples.length; slot += 1) important.add(Math.round((slot * (samples.length - 1)) / limit));
  }
  return [...important].sort((a, b) => a - b).map((index) => samples[index]);
}

function sampleEventKind(events, kind, limit, omitted) {
  const matching = events.filter((event) => event.kind === kind);
  if (matching.length <= limit) return events;
  const keep = new Set();
  for (let index = 0; index < limit; index += 1) keep.add(matching[Math.round((index * (matching.length - 1)) / Math.max(1, limit - 1))].id);
  omitted.telemetryEvents += matching.length - keep.size;
  return events.filter((event) => event.kind !== kind || keep.has(event.id));
}

function deduplicateInputEvents(events, omitted) {
  const removed = new Set();
  let pendingInputIndex;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.kind === 'input') {
      const previous = pendingInputIndex === undefined ? undefined : events[pendingInputIndex];
      if (previous && previous.selector === event.selector && previous.url === event.url) {
        removed.add(pendingInputIndex);
      }
      pendingInputIndex = index;
      continue;
    }
    if (['navigation', 'click', 'dblclick', 'change', 'keydown', 'scroll'].includes(event.kind)) pendingInputIndex = undefined;
  }
  omitted.deduplicatedInputs += removed.size;
  return removed.size ? events.filter((_, index) => !removed.has(index)) : events;
}

function markSelectionGestures(events) {
  const activePointers = new Map();
  const pointerKey = (event) => finiteNumber(event.data?.pointerId) ?? 'mouse';
  for (const event of events) {
    if (event.kind === 'pointerdown') {
      activePointers.set(pointerKey(event), event);
      continue;
    }
    if (event.kind !== 'pointerup') continue;
    const pointerDown = activePointers.get(pointerKey(event));
    activePointers.delete(pointerKey(event));
    const selection = event.data?.selection;
    const selectedTextLength = finiteNumber(selection?.selectedTextLength)
      ?? (finiteNumber(selection?.start) !== undefined && finiteNumber(selection?.end) !== undefined ? Math.max(0, selection.end - selection.start) : 0);
    if (!pointerDown || event.data?.dragged !== true || selectedTextLength <= 0) continue;
    pointerDown.data = { ...(pointerDown.data || {}), selectionGesture: true };
    event.data = { ...(event.data || {}), selectionGesture: true };
  }
  return events;
}

function compactRecordedEvents(session, omitted) {
  const pointerGroups = [];
  let pointerGroup = [];
  const boundaryKinds = new Set(['navigation', 'click', 'dblclick', 'pointerdown', 'pointerup', 'input', 'change', 'keydown', 'scroll', 'resize']);
  const nonPointerEvents = [];
  for (const event of session.events) {
    if (event.kind === 'mousemove') { pointerGroup.push(event); continue; }
    if (boundaryKinds.has(event.kind) && pointerGroup.length) { pointerGroups.push(pointerGroup); pointerGroup = []; }
    const compact = sanitizeEvent(event, omitted);
    if (compact) nonPointerEvents.push(compact);
  }
  if (pointerGroup.length) pointerGroups.push(pointerGroup);
  const perGroupLimit = Math.max(1, Math.min(72, Math.floor(maxExportPointerSamples / Math.max(1, pointerGroups.length))));
  const pointerEvents = pointerGroups.flatMap((group) => simplifyPointerSamples(group, perGroupLimit));
  omitted.pointerSamples += pointerGroups.reduce((total, group) => total + group.length, 0) - pointerEvents.length;
  let events = [...nonPointerEvents, ...pointerEvents.map((event) => sanitizeEvent(event, omitted))].filter(Boolean).sort((a, b) => a.sequence - b.sequence);
  events = sampleEventKind(events, 'network-request', 180, omitted);
  events = sampleEventKind(events, 'network-response', 180, omitted);
  events = sampleEventKind(events, 'dom-mutation', 120, omitted);
  events = sampleEventKind(events, 'console', 120, omitted);
  events = sampleEventKind(events, 'lifecycle', 120, omitted);
  events = sampleEventKind(events, 'focus', 160, omitted);
  return markSelectionGestures(deduplicateInputEvents(events, omitted));
}

function sanitizeSessionDiagnostics(diagnostics = {}) {
  return compactObject({
    debuggerWarning: boundedText(diagnostics.debuggerWarning, 1_000), screencastWarning: boundedText(diagnostics.screencastWarning, 1_000),
    streamStorageError: boundedText(diagnostics.streamStorageError, 1_000), detachReason: boundedText(diagnostics.detachReason, 200),
  });
}

function compactExportFor(session) {
  const cached = exportIndexCaches.get(session.id);
  if (cached) return cached;
  const previousCompact = session.compactExportReady && session.diagnostics?.compactExport && typeof session.diagnostics.compactExport === 'object'
    ? session.diagnostics.compactExport : undefined;
  const previousOmitted = previousCompact?.omitted && typeof previousCompact.omitted === 'object' ? previousCompact.omitted : {};
  const previousCount = (key) => Math.max(0, finiteNumber(previousOmitted[key]) || 0);
  const omitted = {
    videoFrames: Math.max(session.streamFrameCount || 0, previousCount('videoFrames')),
    screenshots: previousCount('screenshots'), domSnapshots: previousCount('domSnapshots'),
    networkBodies: previousCount('networkBodies'), networkHeaders: previousCount('networkHeaders'),
    pointerSamples: previousCount('pointerSamples'), telemetryEvents: previousCount('telemetryEvents'),
    deduplicatedInputs: previousCount('deduplicatedInputs'),
    cookies: previousCount('cookies'), cookieValueBytes: previousCount('cookieValueBytes'),
    localStorageEntries: previousCount('localStorageEntries'), localStorageValueBytes: previousCount('localStorageValueBytes'),
  };
  const sourceEventCount = Math.max(session.events.length + (session.streamFrameCount || 0), finiteNumber(previousCompact?.sourceEventCount) || 0);
  const browser = sanitizeBrowserState(session.browser, omitted);
  const diagnostics = sanitizeSessionDiagnostics(session.diagnostics);
  const recording = { ...exportMeta(session, browser, diagnostics), events: compactRecordedEvents(session, omitted) };
  if (recording.events.length === 0) {
    recording.events.push({
      id: uid(), sequence: 0, at: recording.startedAt, offsetMs: 0, kind: 'navigation', url: recording.target.initialUrl,
      data: { transition: 'compact-export-fallback' },
    });
  }
  diagnostics.compactExport = {
    mode: 'replay-data-only', sourceEventCount, exportedEventCount: recording.events.length,
    note: 'Replay actions are retained without a file-size ceiling. Compositor frames, screenshots, response bodies, headers, and DOM snapshots are not embedded in JSON exports.', omitted,
  };
  for (let pass = 0; pass < 4; pass += 1) diagnostics.compactExport.jsonBytes = byteLength(recording);
  const compact = { events: recording.events, meta: Object.fromEntries(Object.entries(recording).filter(([key]) => key !== 'events')) };
  exportIndexCaches.set(session.id, compact);
  return compact;
}

async function restore() {
  const saved = (await chrome.storage.local.get(storageKey))[storageKey] || [];
  for (const session of saved) {
    if (session.status === 'recording') session.status = 'interrupted';
    sessions.set(session.id, session);
  }
}
const restored = restore();

function openFrameDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('pathproof-stream-frames', 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.createObjectStore('frames', { keyPath: ['sessionId', 'sequence'] });
      store.createIndex('sessionId', 'sessionId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeStreamFrame(sessionId, frame) {
  const database = await openFrameDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction('frames', 'readwrite');
    transaction.objectStore('frames').put({ sessionId, ...frame });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function readStreamFrameKeys(sessionId) {
  const database = await openFrameDatabase();
  const keys = await new Promise((resolve, reject) => {
    const transaction = database.transaction('frames', 'readonly');
    const request = transaction.objectStore('frames').index('sessionId').getAllKeys(IDBKeyRange.only(sessionId));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return keys;
}

async function readStreamFrameChunk(sessionId, sequences) {
  if (sequences.length === 0) return [];
  const database = await openFrameDatabase();
  const frames = await new Promise((resolve, reject) => {
    const transaction = database.transaction('frames', 'readonly');
    const store = transaction.objectStore('frames');
    const results = [];
    for (const sequence of sequences) {
      const request = store.get([sessionId, sequence]);
      request.onsuccess = () => { if (request.result) { const { sessionId: _sessionId, ...frame } = request.result; results.push(frame); } };
    }
    transaction.oncomplete = () => resolve(results);
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
  return frames;
}

async function deleteStreamFrames(sessionId) {
  const database = await openFrameDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction('frames', 'readwrite');
    const index = transaction.objectStore('frames').index('sessionId');
    const request = index.openKeyCursor(IDBKeyRange.only(sessionId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      transaction.objectStore('frames').delete(cursor.primaryKey);
      cursor.continue();
    };
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

function persistSoon() {
  clearTimeout(persistenceTimer);
  persistenceTimer = setTimeout(() => {
    chrome.storage.local.set({ [storageKey]: [...sessions.values()] }).catch(() => undefined);
  }, 700);
}

function broadcast(session, event) {
  chrome.runtime.sendMessage({ type: 'PATHPROOF_SESSION_UPDATE', session: publicSession(session), event }).catch(() => undefined);
}

function createEvent(session, event) {
  if (!session || session.status !== 'recording') return;
  return {
    id: event.id || uid(), sequence: session.sequence++, at: event.at || isoNow(),
    offsetMs: Math.max(0, Date.now() - Date.parse(session.startedAt)), url: event.url || session.currentUrl,
    ...event,
  };
}

function append(session, event) {
  const saved = createEvent(session, event);
  if (!saved) return;
  exportIndexCaches.delete(session.id);
  session.events.push(saved);
  broadcast(session, saved);
  persistSoon();
  return saved;
}

function appendStreamFrame(session, event) {
  const saved = createEvent(session, event);
  if (!saved) return;
  exportIndexCaches.delete(session.id);
  session.streamFrameCount = (session.streamFrameCount || 0) + 1;
  const write = writeStreamFrame(session.id, saved).catch((error) => { session.diagnostics.streamStorageError = error.message || String(error); });
  const pending = pendingFrameWrites.get(session.id) ?? new Set();
  pending.add(write); pendingFrameWrites.set(session.id, pending);
  void write.finally(() => pending.delete(write));
  broadcast(session, { ...saved, data: { ...saved.data, image: undefined, imageBytes: saved.data?.image?.length || 0 } });
  persistSoon();
  return saved;
}

async function exportEventChunk(session, offset, limit) {
  const compact = compactExportFor(session);
  return { events: compact.events.slice(offset, offset + limit), total: compact.events.length };
}

function debuggerInputSource(captureMouseMoves) {
  const install = (recordMoves) => {
    globalThis.__pathproofDebuggerInputDispose?.();
    if (typeof globalThis.__pathproofDebuggerInput !== 'function') return;
    globalThis.__pathproofDebuggerInputInstalled = true;
    const controller = new AbortController();
    const clean = (value, max = 300) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const selectorFor = (element) => {
      if (!(element instanceof Element)) return undefined;
      for (const name of ['data-testid', 'data-test', 'data-qa']) {
        const value = element.getAttribute(name);
        if (value) return `[${name}="${CSS.escape(value)}"]`;
      }
      if (element.id) return `#${CSS.escape(element.id)}`;
      const parts = [];
      let node = element;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
        let part = node.localName;
        const parent = node.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter((candidate) => candidate.localName === node.localName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part); node = parent;
      }
      return parts.join(' > ');
    };
    const roleFor = (element) => {
      const explicit = element.getAttribute?.('role');
      if (explicit) return explicit;
      if (element.matches?.('button, input[type=button], input[type=submit]')) return 'button';
      if (element.matches?.('a[href]')) return 'link';
      if (element.matches?.('select')) return 'combobox';
      if (element.matches?.('input[type=checkbox]')) return 'checkbox';
      if (element.matches?.('input[type=radio]')) return 'radio';
      if (element.matches?.('input[type=search]')) return 'searchbox';
      if (element.matches?.('input, textarea')) return 'textbox';
      return undefined;
    };
    const nameFor = (element) => {
      if (!(element instanceof Element)) return undefined;
      const labelledBy = element.getAttribute('aria-labelledby');
      return clean(element.getAttribute('aria-label') || (labelledBy && document.getElementById(labelledBy)?.textContent) || element.labels?.[0]?.textContent || element.getAttribute('title') || element.textContent);
    };
    const selectionFor = (target) => {
      if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && Number.isInteger(target.selectionStart) && Number.isInteger(target.selectionEnd)) {
        const start = target.selectionStart; const end = target.selectionEnd;
        return { type: 'control', start, end, direction: target.selectionDirection || 'none', selectedTextLength: Math.max(0, end - start),
          anchorSelector: selectorFor(target), focusSelector: selectorFor(target), anchorOffset: start, focusOffset: end };
      }
      const selection = document.getSelection();
      if (!selection) return undefined;
      const anchorElement = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
      const focusElement = selection.focusNode instanceof Element ? selection.focusNode : selection.focusNode?.parentElement;
      return { type: 'document', selectedTextLength: String(selection).length,
        anchorSelector: selectorFor(anchorElement), focusSelector: selectorFor(focusElement),
        anchorOffset: selection.anchorOffset, focusOffset: selection.focusOffset };
    };
    const activePointers = new Map();
    const pointerKey = (event) => Number.isFinite(event.pointerId) ? event.pointerId : 'mouse';
    const emitOne = (event, sourceEvent, extra = {}) => {
      if (!recordMoves && (sourceEvent.type === 'pointermove' || sourceEvent.type === 'pointerrawupdate')) return;
      const target = event.target instanceof Element ? event.target : undefined;
      if (typeof globalThis.__pathproofDebuggerInput !== 'function') return;
      globalThis.__pathproofDebuggerInput(JSON.stringify({
        kind: sourceEvent.type === 'pointermove' || sourceEvent.type === 'pointerrawupdate' ? 'mousemove' : sourceEvent.type,
        url: location.href, frameUrl: location.href, selector: selectorFor(target), role: roleFor(target),
        accessibleName: nameFor(target), tagName: target?.localName,
        x: event.clientX, y: event.clientY, width: innerWidth, height: innerHeight,
        data: { source: 'chrome-debugger', pageX: event.pageX, pageY: event.pageY, screenX: event.screenX, screenY: event.screenY,
          button: event.button, buttons: event.buttons, pointerId: Number.isFinite(event.pointerId) ? event.pointerId : undefined,
          pointerType: event.pointerType || 'mouse', pressure: event.pressure || 0, dragged: extra.dragged,
          eventTimestamp: event.timeStamp, eventEpochMs: performance.timeOrigin + event.timeStamp, devicePixelRatio,
          cursor: target ? clean(getComputedStyle(target).cursor || 'default', 80) : 'default', selection: extra.selection,
          visualViewport: globalThis.visualViewport ? { offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop, scale: visualViewport.scale } : undefined,
          targetRect: target ? (() => { const rect = target.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })() : undefined,
          modifiers: { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey } },
      }));
    };
    const emit = (event) => {
      const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
      const pointerSamples = samples.length > 0 ? samples : [event];
      const key = pointerKey(event);
      if (event.type === 'pointerdown') {
        activePointers.set(key, { x: event.clientX, y: event.clientY, moved: false });
        for (const sample of pointerSamples) emitOne(sample, event, { dragged: false, selection: selectionFor(event.target) });
        return;
      }
      if (event.type === 'pointermove' || event.type === 'pointerrawupdate') {
        const activePointer = activePointers.get(key);
        if (activePointer) {
          for (const sample of pointerSamples) {
            if (Math.hypot(sample.clientX - activePointer.x, sample.clientY - activePointer.y) >= 2) activePointer.moved = true;
          }
        }
        for (const sample of pointerSamples) emitOne(sample, event);
        return;
      }
      if (event.type === 'pointerup') {
        const activePointer = activePointers.get(key);
        const dragged = Boolean(activePointer?.moved || (activePointer && Math.hypot(event.clientX - activePointer.x, event.clientY - activePointer.y) >= 2));
        activePointers.delete(key);
        queueMicrotask(() => {
          const selection = selectionFor(event.target);
          for (const sample of pointerSamples) emitOne(sample, event, { dragged, selection });
        });
        return;
      }
      for (const sample of pointerSamples) emitOne(sample, event, { selection: selectionFor(event.target) });
    };
    const moveType = 'onpointerrawupdate' in globalThis ? 'pointerrawupdate' : 'pointermove';
    for (const type of [moveType, 'pointerdown', 'pointerup', 'click', 'dblclick']) addEventListener(type, emit, { capture: true, signal: controller.signal });
    globalThis.__pathproofDebuggerInputDispose = () => {
      controller.abort();
      globalThis.__pathproofDebuggerInputInstalled = false;
      delete globalThis.__pathproofDebuggerInputDispose;
    };
  };
  return `(${install.toString()})(${JSON.stringify(Boolean(captureMouseMoves))})`;
}

async function configureDebuggerCapture(session) {
  const target = { tabId: session.tabId };
  const worldName = `pathproof_recorder_${session.id.replace(/-/g, '_')}`;
  const source = debuggerInputSource(session.options.captureMouseMoves);
  await chrome.debugger.sendCommand(target, 'Runtime.addBinding', { name: '__pathproofDebuggerInput', executionContextName: worldName });
  const installed = await chrome.debugger.sendCommand(target, 'Page.addScriptToEvaluateOnNewDocument', { source, worldName, runImmediately: true });
  session.debuggerWorldName = worldName;
  session.debuggerScriptIdentifier = installed.identifier;
  session.debuggerContextIds = [];
  session.debuggerInputActive = true;
  if (session.options.captureStream) {
    try {
      await chrome.debugger.sendCommand(target, 'Page.startScreencast', {
        format: 'jpeg', quality: 58, maxWidth: 1440, maxHeight: 1000, everyNthFrame: 1,
      });
      session.screencastActive = true;
    } catch (error) {
      session.diagnostics.screencastWarning = error.message || String(error);
      session.screencastActive = false;
    }
  }
}

async function disposeDebuggerCapture(session) {
  if (!session.debuggerAttached) return;
  const target = { tabId: session.tabId };
  for (const contextId of session.debuggerContextIds || []) {
    await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: 'globalThis.__pathproofDebuggerInputDispose?.()', contextId }).catch(() => undefined);
  }
  if (session.debuggerScriptIdentifier) {
    await chrome.debugger.sendCommand(target, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: session.debuggerScriptIdentifier }).catch(() => undefined);
  }
  await chrome.debugger.sendCommand(target, 'Runtime.removeBinding', { name: '__pathproofDebuggerInput' }).catch(() => undefined);
  session.debuggerInputActive = false;
}

function redactHeaders(headers = {}) {
  const redacted = {};
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = /authorization|cookie|token|secret|api[-_]?key/i.test(name) ? '[redacted]' : String(value).slice(0, 8_000);
  }
  return redacted;
}

async function captureScreenshot(session, reason) {
  if (!session.debuggerAttached || !session.options.captureScreenshots || Date.now() - (session.lastScreenshotAt || 0) < 1500) return;
  session.lastScreenshotAt = Date.now();
  try {
    const result = await chrome.debugger.sendCommand({ tabId: session.tabId }, 'Page.captureScreenshot', {
      format: 'jpeg', quality: 55, fromSurface: true, captureBeyondViewport: false,
    });
    append(session, { kind: 'screenshot', data: { reason, mimeType: 'image/jpeg', image: result.data } });
  } catch { /* The target can be between navigations. */ }
}

async function initializeTarget(session) {
  await chrome.tabs.sendMessage(session.tabId, { type: 'PATHPROOF_START_CONTENT', sessionId: session.id, options: { ...session.options, debuggerInput: session.debuggerInputActive } }).catch(() => undefined);
}

async function startSession(message, sender) {
  const tab = await chrome.tabs.get(Number(message.tabId));
  if (!tab.id || !/^https?:/i.test(tab.url || '')) throw new Error('Pathproof can record only an open HTTP or HTTPS tab.');
  const existing = [...sessions.values()].find((item) => item.tabId === tab.id && item.status === 'recording');
  if (existing) return publicSession(existing);
  const startedAt = isoNow();
  const session = {
    id: uid(), tabId: tab.id, recorderTabId: sender.tab?.id, name: message.name || tab.title || 'Recorded journey',
    status: 'recording', createdAt: startedAt, startedAt, initialUrl: tab.url, currentUrl: tab.url, title: tab.title,
    sequence: 1, events: [], options: message.options || {}, browser: {}, diagnostics: {},
  };
  sessions.set(session.id, session);
  try {
    try {
      await chrome.debugger.attach({ tabId: tab.id }, '1.3');
      session.debuggerAttached = true;
      await Promise.all([
        chrome.debugger.sendCommand({ tabId: tab.id }, 'Network.enable', { maxTotalBufferSize: 100_000_000, maxResourceBufferSize: 10_000_000 }),
        chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable'),
        chrome.debugger.sendCommand({ tabId: tab.id }, 'Runtime.enable'),
        chrome.debugger.sendCommand({ tabId: tab.id }, 'Performance.enable'),
        chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.enable'),
      ]);
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.setLifecycleEventsEnabled', { enabled: true });
      await configureDebuggerCapture(session);
    } catch (error) {
      session.debuggerAttached = false;
      session.diagnostics.debuggerWarning = error.message || String(error);
      await chrome.debugger.detach({ tabId: tab.id }).catch(() => undefined);
    }
    await initializeTarget(session);
    const environment = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({
      userAgent: navigator.userAgent, platform: navigator.platform, language: navigator.language,
      locale: Intl.DateTimeFormat().resolvedOptions().locale, timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference',
      viewport: { width: innerWidth, height: innerHeight },
    }) });
    session.browser = environment[0]?.result || {};
    const windowInfo = await chrome.windows.get(tab.windowId);
    session.browser.window = { width: windowInfo.width, height: windowInfo.height, state: windowInfo.state };
    append(session, { kind: 'navigation', url: tab.url, text: tab.title, data: { transition: 'recording-started' } });
    await captureScreenshot(session, 'recording-started');
    await chrome.tabs.update(tab.id, { active: true });
    broadcast(session);
    return publicSession(session);
  } catch (error) {
    sessions.delete(session.id);
    if (session.debuggerAttached) await chrome.debugger.detach({ tabId: tab.id }).catch(() => undefined);
    throw error;
  }
}

async function finalizeCompactSession(session) {
  await Promise.all([...(pendingFrameWrites.get(session.id) || [])]);
  const compact = compactExportFor(session);
  session.events = compact.events;
  session.browser = compact.meta.browser;
  session.diagnostics = compact.meta.diagnostics;
  session.name = compact.meta.name;
  session.createdAt = compact.meta.createdAt;
  session.startedAt = compact.meta.startedAt;
  session.stoppedAt = compact.meta.stoppedAt;
  session.initialUrl = compact.meta.target.initialUrl;
  session.currentUrl = compact.meta.target.finalUrl;
  session.title = compact.meta.target.title;
  session.options = compact.meta.options;
  session.compactExportReady = true;
  await deleteStreamFrames(session.id).catch(() => undefined);
  pendingFrameWrites.delete(session.id);
  await chrome.storage.local.set({ [storageKey]: [...sessions.values()] });
  return { session: publicSession(session), totalEvents: compact.events.length, meta: compact.meta };
}

async function stopSession(message) {
  const session = sessions.get(message.sessionId);
  if (!session) throw new Error('Recording session not found.');
  if (session.status !== 'recording') return finalizeCompactSession(session);
  const tab = await chrome.tabs.get(session.tabId).catch(() => undefined);
  if (tab) {
    if (session.debuggerAttached && session.screencastActive) {
      await chrome.debugger.sendCommand({ tabId: session.tabId }, 'Page.stopScreencast').catch(() => undefined);
      session.screencastActive = false;
    }
    await disposeDebuggerCapture(session);
    session.currentUrl = tab.url || session.currentUrl;
    session.title = tab.title || session.title;
    const state = await chrome.tabs.sendMessage(session.tabId, { type: 'PATHPROOF_CAPTURE_STATE' }).catch(() => undefined);
    if (state) {
      session.browser = { ...session.browser, viewport: state.viewport || session.browser.viewport };
      if (session.options.includeSensitiveState) session.browser.localStorage = state.localStorage;
    }
    if (session.options.includeCookies) {
      const chromeCookies = await chrome.cookies.getAll({ url: session.currentUrl }).catch(() => []);
      session.browser.cookies = chromeCookies.map((cookie) => ({
        name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
        expires: cookie.expirationDate, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite,
      }));
    }
    await captureScreenshot(session, 'recording-stopped');
    if (session.debuggerAttached && session.options.captureDom) {
      const snapshot = await chrome.debugger.sendCommand({ tabId: session.tabId }, 'DOMSnapshot.captureSnapshot', {
        computedStyles: ['display', 'visibility', 'position'], includePaintOrder: true, includeDOMRects: true,
      }).catch(() => undefined);
      if (snapshot) append(session, { kind: 'snapshot', data: snapshot });
    }
    if (session.debuggerAttached) session.diagnostics.performance = await chrome.debugger.sendCommand({ tabId: session.tabId }, 'Performance.getMetrics').catch(() => undefined);
    await chrome.tabs.sendMessage(session.tabId, { type: 'PATHPROOF_STOP_CONTENT' }).catch(() => undefined);
  }
  session.status = 'stopped';
  session.stoppedAt = isoNow();
  if (session.debuggerAttached) await chrome.debugger.detach({ tabId: session.tabId }).catch(() => undefined);
  broadcast(session);
  return finalizeCompactSession(session);
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^https?:/i.test(tab.url || '')) return;
  const query = new URLSearchParams({ tabId: String(tab.id), url: tab.url || '', title: tab.title || '' });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`recorder.html?${query}`) });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const reply = async () => {
    await restored;
    if (message.type === 'PATHPROOF_START_SESSION') return startSession(message, sender);
    if (message.type === 'PATHPROOF_STOP_SESSION') return stopSession(message);
    if (message.type === 'PATHPROOF_GET_SESSION') {
      const session = message.sessionId ? sessions.get(message.sessionId) : [...sessions.values()].reverse().find((item) => item.tabId === Number(message.tabId));
      return session ? publicSession(session) : null;
    }
    if (message.type === 'PATHPROOF_GET_EVENT_CHUNK') {
      const session = sessions.get(message.sessionId);
      if (!session) throw new Error('Recording session not found.');
      const offset = Math.max(0, Number(message.offset) || 0);
      const limit = Math.min(20, Math.max(1, Number(message.limit) || 20));
      return exportEventChunk(session, offset, limit);
    }
    if (message.type === 'PATHPROOF_DELETE_SESSION') {
      sessions.delete(message.sessionId); exportIndexCaches.delete(message.sessionId); pendingFrameWrites.delete(message.sessionId);
      await deleteStreamFrames(message.sessionId).catch(() => undefined); persistSoon(); return { ok: true };
    }
    if (message.type === 'PATHPROOF_CONTENT_EVENT') {
      const session = [...sessions.values()].find((item) => item.tabId === sender.tab?.id && item.status === 'recording');
      if (!session || message.sessionId !== session.id) return { ignored: true };
      append(session, message.event);
      if (['click', 'dblclick', 'change'].includes(message.event.kind)) void captureScreenshot(session, message.event.kind);
      return { ok: true };
    }
    throw new Error('Unknown Pathproof message.');
  };
  reply().then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const session = [...sessions.values()].find((item) => item.tabId === tabId && item.status === 'recording');
  if (!session) return;
  if (changeInfo.url) {
    session.currentUrl = changeInfo.url;
    append(session, { kind: 'navigation', url: changeInfo.url, text: tab.title, data: { source: 'tabs.onUpdated' } });
  }
  if (changeInfo.status === 'loading') setTimeout(() => void initializeTarget(session), 40);
  if (changeInfo.status === 'complete') void initializeTarget(session);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const session = [...sessions.values()].find((item) => item.tabId === tabId && item.status === 'recording');
  if (!session) return;
  append(session, { kind: 'lifecycle', data: { name: 'target-tab-closed' } });
  session.status = 'interrupted'; session.stoppedAt = isoNow();
  persistSoon(); broadcast(session);
});

chrome.windows.onBoundsChanged.addListener((windowInfo) => {
  for (const session of sessions.values()) {
    if (session.status !== 'recording') continue;
    chrome.tabs.get(session.tabId).then((tab) => {
      if (tab.windowId === windowInfo.id) append(session, { kind: 'resize', width: windowInfo.width, height: windowInfo.height, data: { windowState: windowInfo.state } });
    }).catch(() => undefined);
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const session = [...sessions.values()].find((item) => item.tabId === source.tabId && item.status === 'recording');
  if (!session) return;
  if (method === 'Runtime.executionContextCreated' && params.context?.name === session.debuggerWorldName) {
    if (!session.debuggerContextIds.includes(params.context.id)) session.debuggerContextIds.push(params.context.id);
  } else if (method === 'Page.screencastFrame') {
    const debuggerTarget = source.sessionId ? { tabId: session.tabId, sessionId: source.sessionId } : { tabId: session.tabId };
    void chrome.debugger.sendCommand(debuggerTarget, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => undefined);
    if (session.options.captureStream) appendStreamFrame(session, { kind: 'video-frame', data: {
      mimeType: 'image/jpeg', image: params.data, sessionId: params.sessionId, metadata: params.metadata,
    } });
  } else if (method === 'Runtime.bindingCalled' && params.name === '__pathproofDebuggerInput') {
    try {
      if (!session.debuggerContextIds.includes(params.executionContextId)) session.debuggerContextIds.push(params.executionContextId);
      const pointer = JSON.parse(params.payload);
      if (['mousemove', 'pointerdown', 'pointerup', 'click', 'dblclick'].includes(pointer.kind)) {
        const eventEpochMs = finiteNumber(pointer.data?.eventEpochMs);
        if (eventEpochMs !== undefined) {
          pointer.offsetMs = Math.max(0, eventEpochMs - Date.parse(session.startedAt));
          pointer.at = new Date(eventEpochMs).toISOString();
        }
        append(session, pointer);
        if (pointer.kind === 'click' || pointer.kind === 'dblclick') void captureScreenshot(session, pointer.kind);
      }
    } catch { /* Ignore malformed page binding payloads. */ }
  } else if (method === 'Network.requestWillBeSent' && session.options.captureNetwork) {
    requestOwners.set(params.requestId, session.id);
    append(session, { kind: 'network-request', url: params.request.url, data: {
      requestId: params.requestId, method: params.request.method, resourceType: params.type,
      headers: redactHeaders(params.request.headers),
      postData: session.options.captureNetworkBodies ? params.request.postData : undefined,
    } });
  } else if (method === 'Network.responseReceived' && session.options.captureNetwork) {
    append(session, { kind: 'network-response', url: params.response.url, data: {
      requestId: params.requestId, status: params.response.status, statusText: params.response.statusText,
      mimeType: params.response.mimeType, protocol: params.response.protocol, fromDiskCache: params.response.fromDiskCache,
      headers: redactHeaders(params.response.headers),
    } });
  } else if (method === 'Network.loadingFinished' && session.options.captureNetworkBodies && requestOwners.get(params.requestId) === session.id) {
    chrome.debugger.sendCommand({ tabId: session.tabId }, 'Network.getResponseBody', { requestId: params.requestId }).then((body) => {
      append(session, { kind: 'network-response', data: { requestId: params.requestId, body: body.body, base64Encoded: body.base64Encoded, phase: 'body' } });
    }).catch(() => undefined).finally(() => requestOwners.delete(params.requestId));
  } else if (method === 'Runtime.consoleAPICalled') {
    append(session, { kind: 'console', data: { level: params.type, args: params.args?.map((arg) => arg.value ?? arg.description).slice(0, 20), stackTrace: params.stackTrace } });
  } else if (method === 'Runtime.exceptionThrown') {
    append(session, { kind: 'exception', text: params.exceptionDetails?.text, data: { exceptionDetails: params.exceptionDetails } });
  } else if (method === 'Page.frameNavigated' && !params.frame.parentId) {
    session.currentUrl = params.frame.url || session.currentUrl;
    append(session, { kind: 'navigation', url: session.currentUrl, text: params.frame.name, data: { source: 'debugger', loaderId: params.frame.loaderId } });
  } else if (method === 'Page.navigatedWithinDocument') {
    session.currentUrl = params.url || session.currentUrl;
    append(session, { kind: 'navigation', url: session.currentUrl, data: { source: 'debugger-within-document', navigationType: params.navigationType } });
  } else if (method === 'Page.lifecycleEvent') {
    append(session, { kind: 'lifecycle', data: { name: params.name, frameId: params.frameId, loaderId: params.loaderId } });
  } else if (method === 'DOM.documentUpdated' && session.options.captureDom) {
    append(session, { kind: 'dom-mutation', data: { source: 'debugger', change: 'document-updated' } });
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const session = [...sessions.values()].find((item) => item.tabId === source.tabId && item.status === 'recording');
  if (!session) return;
  session.debuggerAttached = false; session.diagnostics.detachReason = reason;
  session.screencastActive = false;
  session.debuggerInputActive = false;
  append(session, { kind: 'lifecycle', data: { name: 'debugger-detached', reason } });
  void initializeTarget(session);
  persistSoon(); broadcast(session);
});
