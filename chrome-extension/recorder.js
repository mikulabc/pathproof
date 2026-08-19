const query = new URLSearchParams(location.search);
const targetTabId = Number(query.get('tabId'));
const targetUrl = query.get('url') || '';
const targetTitle = query.get('title') || 'Untitled tab';
const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map((node) => [node.id, node]));
const utf8 = new TextEncoder();
let session;
let exportData;
let exportText;
let timer;
let seenPages = new Set([targetUrl]);
let estimatedBytes = 0;

elements.tabId.textContent = Number.isFinite(targetTabId) ? `#${targetTabId}` : 'Unavailable';
elements.targetTitle.textContent = targetTitle;
elements.targetUrl.textContent = targetUrl;
elements.targetUrl.href = targetUrl;

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'The extension service worker did not respond.');
  return response.result;
}

function formatTime(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function formatBytes(bytes) { return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB` : `${Math.max(0, Math.round(bytes / 1024))} KiB`; }
function setLocked(locked) {
  for (const input of document.querySelectorAll('.settings input')) input.disabled = locked;
  elements.startButton.disabled = locked;
  elements.stopButton.disabled = !locked;
}

function resetForNextRecording() {
  clearInterval(timer);
  session = undefined;
  exportData = undefined;
  exportText = undefined;
  seenPages = new Set([targetUrl]);
  estimatedBytes = 0;
  elements.eventCount.textContent = '0';
  elements.elapsed.textContent = '00:00';
  elements.pageCount.textContent = '1';
  elements.dataSize.textContent = '0 KiB';
  elements.eventList.replaceChildren();
  elements.emptyState.hidden = false;
  elements.downloadButton.hidden = true;
  elements.exportSummary.hidden = true;
  elements.downloadButton.textContent = 'Download compact JSON';
  elements.stopButton.textContent = 'Stop & prepare file';
  elements.startButton.textContent = 'Start recording';
  setLocked(false);
  showStatus('idle');
}
function showStatus(status) {
  elements.statusPill.className = `status-pill ${status}`;
  elements.statusPill.querySelector('span').textContent = status === 'recording' ? 'Recording target tab' : status === 'stopped' ? 'Recording ready' : 'Ready to record';
}
function updateClock() {
  if (!session) return;
  const end = session.stoppedAt ? Date.parse(session.stoppedAt) : Date.now();
  elements.elapsed.textContent = formatTime(end - Date.parse(session.startedAt));
}
function describe(event) {
  if (event.accessibleName) return event.accessibleName;
  if (event.selector) return event.selector;
  if (event.kind.startsWith('network')) return `${event.data?.method || event.data?.status || ''} ${event.url || ''}`;
  if (event.kind === 'mousemove') return `${Math.round(event.x)}, ${Math.round(event.y)}`;
  if (event.kind === 'scroll') return `x ${Math.round(event.scrollX || 0)}, y ${Math.round(event.scrollY || 0)}`;
  if (event.kind === 'dom-mutation') return `${event.data?.added || 0} added · ${event.data?.removed || 0} removed · ${event.data?.attributes || 0} attributes`;
  if (event.kind === 'console') return (event.data?.args || []).join(' ');
  return event.text || event.data?.name || event.url || 'Browser signal';
}
function addEvent(event) {
  elements.emptyState.hidden = true;
  seenPages.add(event.url);
  if (!['screenshot', 'video-frame', 'snapshot'].includes(event.kind) && event.data?.phase !== 'body') {
    estimatedBytes += Math.min(1_200, JSON.stringify(event).length);
  }
  elements.eventCount.textContent = String(event.sequence || Number(elements.eventCount.textContent) + 1);
  elements.pageCount.textContent = String(seenPages.size);
  elements.dataSize.textContent = formatBytes(estimatedBytes);
  if (event.kind === 'screenshot' || event.kind === 'video-frame' || event.kind === 'snapshot' || event.kind === 'mousemove') return;
  const row = document.createElement('div'); row.className = 'event';
  const symbols = { click:'↖', dblclick:'↖', input:'⌨', change:'⌘', navigation:'↗', scroll:'↕', resize:'↔', 'dom-mutation':'◇', 'network-request':'→', 'network-response':'←', console:'›_', exception:'!', lifecycle:'◌' };
  row.innerHTML = `<span class="event-icon">${symbols[event.kind] || '·'}</span><span class="event-kind"></span><span class="event-copy"></span><time class="event-time"></time>`;
  row.querySelector('.event-kind').textContent = event.kind.replace('-', ' ');
  row.querySelector('.event-copy').textContent = describe(event);
  row.querySelector('time').textContent = `+${formatTime(event.offsetMs || 0)}`;
  elements.eventList.append(row);
  while (elements.eventList.children.length > 400) elements.eventList.firstElementChild.remove();
  if (elements.follow.checked) elements.eventList.scrollTop = elements.eventList.scrollHeight;
}

async function start() {
  elements.error.textContent = '';
  elements.downloadButton.hidden = true;
  try {
    session = await send({
      type: 'PATHPROOF_START_SESSION', tabId: targetTabId, name: elements.recordingName.value.trim() || 'User journey',
      options: {
        captureMouseMoves: elements.mouseMoves.checked, captureNetwork: elements.network.checked,
        captureDom: elements.dom.checked, captureScreenshots: elements.screenshots.checked,
        captureStream: elements.compositorStream.checked,
        captureNetworkBodies: elements.bodies.checked, includeCookies: elements.sessionState.checked,
        includeSensitiveState: elements.sessionState.checked,
      },
    });
    setLocked(true); showStatus('recording'); updateClock(); timer = setInterval(updateClock, 500);
  } catch (error) { elements.error.textContent = error.message; }
}

async function collectEvents(sessionId, total) {
  const events = [];
  while (events.length < total) {
    const chunk = await send({ type: 'PATHPROOF_GET_EVENT_CHUNK', sessionId, offset: events.length, limit: 100 });
    events.push(...chunk.events);
    elements.stopButton.textContent = `Preparing ${Math.min(events.length, total)} / ${total}`;
  }
  return events;
}

function serializeCompactExport(data) {
  const compactDiagnostics = data.diagnostics?.compactExport;
  let text = '';
  for (let pass = 0; pass < 4; pass += 1) {
    text = JSON.stringify(data);
    if (compactDiagnostics) compactDiagnostics.jsonBytes = utf8.encode(text).byteLength;
  }
  text = JSON.stringify(data);
  const bytes = utf8.encode(text).byteLength;
  return { text, bytes };
}

function showExportSummary(bytes) {
  const compact = exportData?.diagnostics?.compactExport;
  const omitted = compact?.omitted || {};
  const artifactCount = Number(omitted.videoFrames || 0) + Number(omitted.screenshots || 0) + Number(omitted.domSnapshots || 0) + Number(omitted.networkBodies || 0);
  elements.exportSummary.classList.remove('warning');
  elements.exportSummary.textContent = artifactCount > 0
    ? `${formatBytes(bytes)} replay file · ${artifactCount.toLocaleString()} large visual/body artifacts omitted from JSON (details are in diagnostics).`
    : `${formatBytes(bytes)} replay file · all replay actions, pointer timing, viewport, and selected browser state included.`;
  elements.exportSummary.hidden = false;
}

async function stop() {
  elements.stopButton.disabled = true; elements.stopButton.textContent = 'Finalizing capture…'; elements.error.textContent = '';
  try {
    const stopped = await send({ type: 'PATHPROOF_STOP_SESSION', sessionId: session.id });
    session = stopped.session; clearInterval(timer); updateClock();
    const events = await collectEvents(session.id, stopped.totalEvents);
    exportData = { ...stopped.meta, events };
    const serialized = serializeCompactExport(exportData);
    exportText = serialized.text;
    estimatedBytes = serialized.bytes;
    elements.dataSize.textContent = formatBytes(serialized.bytes);
    elements.downloadButton.textContent = `Download compact JSON · ${formatBytes(serialized.bytes)}`;
    showExportSummary(serialized.bytes);
    setLocked(false); elements.startButton.disabled = false; elements.startButton.textContent = 'Record again'; elements.stopButton.disabled = true; elements.stopButton.textContent = 'Recording stopped';
    elements.downloadButton.hidden = false;
    showStatus('stopped');
  } catch (error) { elements.error.textContent = error.message; elements.stopButton.disabled = false; elements.stopButton.textContent = 'Stop & prepare file'; }
}

function download() {
  if (!exportData || !exportText) return;
  const blob = new Blob([exportText], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const slug = exportData.name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'pathproof-recording';
  const timestamp = String(exportData.stoppedAt || new Date().toISOString()).replace(/[:.]/g, '-');
  const recordingId = String(exportData.id || 'recording').slice(0, 8);
  anchor.href = url; anchor.download = `${slug}-${timestamp}-${recordingId}.pathproof.json`;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'PATHPROOF_SESSION_UPDATE') return;
  if (session && message.session.id !== session.id) return;
  if (!session && message.session.tabId !== targetTabId) return;
  session = message.session;
  if (message.event) addEvent(message.event);
  if (session.currentUrl) seenPages.add(session.currentUrl);
});

elements.startButton.addEventListener('click', () => {
  if (session?.status === 'stopped') resetForNextRecording();
  void start();
});
elements.stopButton.addEventListener('click', stop);
elements.downloadButton.addEventListener('click', download);
elements.focusTarget.addEventListener('click', () => chrome.tabs.update(targetTabId, { active: true }));

send({ type: 'PATHPROOF_GET_SESSION', tabId: targetTabId }).then((existing) => {
  if (!existing) return;
  session = existing;
  if (existing.status === 'recording') { setLocked(true); showStatus('recording'); timer = setInterval(updateClock, 500); }
  else { elements.startButton.disabled = true; void stop(); }
}).catch((error) => { elements.error.textContent = error.message; });
