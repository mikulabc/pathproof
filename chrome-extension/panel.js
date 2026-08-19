const tabId = chrome.devtools.inspectedWindow.tabId;
const events = document.getElementById('events');
const count = document.getElementById('count');
const dot = document.getElementById('dot');
const empty = document.getElementById('empty');
let total = 0;
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'PATHPROOF_SESSION_UPDATE' || message.session.tabId !== tabId) return;
  dot.classList.toggle('live', message.session.status === 'recording');
  total = message.session.eventCount; count.textContent = `${total} events`;
  if (!message.event || ['mousemove', 'screenshot', 'snapshot'].includes(message.event.kind)) return;
  empty.hidden = true;
  const row = document.createElement('div'); row.className = 'event';
  const description = message.event.accessibleName || message.event.selector || message.event.url || message.event.data?.name || 'browser signal';
  row.innerHTML = '<time></time><span class="kind"></span><span class="copy"></span>';
  row.querySelector('time').textContent = `+${(message.event.offsetMs / 1000).toFixed(2)}s`;
  row.querySelector('.kind').textContent = message.event.kind;
  row.querySelector('.copy').textContent = description;
  events.append(row); while (events.children.length > 500) events.firstElementChild.remove();
  scrollTo(0, document.body.scrollHeight);
});
chrome.runtime.sendMessage({ type: 'PATHPROOF_GET_SESSION', tabId }).then((response) => {
  if (!response?.ok || !response.result) return;
  total = response.result.eventCount; count.textContent = `${total} events`; dot.classList.toggle('live', response.result.status === 'recording');
});
