(() => {
  if (globalThis.__pathproofRecorderInstalled) return;
  globalThis.__pathproofRecorderInstalled = true;
  let active = false;
  let sessionId;
  let options = {};
  let observer;
  let lastMouseAt = 0;
  let lastScrollAt = 0;
  let inputTimers = new WeakMap();
  const activePointers = new Map();
  const clean = (value, max = 500) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

  function selectorFor(element) {
    if (!(element instanceof Element)) return undefined;
    for (const name of ['data-testid', 'data-test', 'data-qa']) {
      const value = element.getAttribute(name);
      if (value) return `[${name}="${CSS.escape(value)}"]`;
    }
    if (element.id) return `#${CSS.escape(element.id)}`;
    if (element.getAttribute('name')) return `${element.localName}[name="${CSS.escape(element.getAttribute('name'))}"]`;
    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
      let part = node.localName;
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((candidate) => candidate.localName === node.localName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (node === document.body) break;
      node = parent;
    }
    return parts.join(' > ');
  }

  function roleFor(element) {
    const explicit = element.getAttribute?.('role');
    if (explicit) return explicit;
    const tag = element.localName;
    if (tag === 'button') return 'button';
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (element.type === 'checkbox') return 'checkbox';
      if (element.type === 'radio') return 'radio';
      if (element.type === 'search') return 'searchbox';
      if (['button', 'submit', 'reset'].includes(element.type)) return 'button';
      return 'textbox';
    }
    return undefined;
  }

  function nameFor(element) {
    if (!(element instanceof Element)) return undefined;
    const labelledBy = element.getAttribute('aria-labelledby');
    const labelled = labelledBy && document.getElementById(labelledBy)?.textContent;
    const label = element.labels?.[0]?.textContent;
    return clean(element.getAttribute('aria-label') || labelled || label || element.getAttribute('alt') || element.getAttribute('title') || element.textContent, 300);
  }

  function elementFields(element) {
    if (!(element instanceof Element)) return {};
    return { selector: selectorFor(element), role: roleFor(element), accessibleName: nameFor(element), tagName: element.localName, frameUrl: location.href };
  }

  function selectionFor(target) {
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
  }

  function pointerData(event, extra = {}) {
    const target = event.target instanceof Element ? event.target : undefined;
    return {
      source: 'content-script-fallback', button: event.button, buttons: event.buttons,
      pointerId: Number.isFinite(event.pointerId) ? event.pointerId : undefined,
      pointerType: event.pointerType || 'mouse', pressure: event.pressure || 0,
      eventTimestamp: event.timeStamp, eventEpochMs: performance.timeOrigin + event.timeStamp,
      cursor: target ? clean(getComputedStyle(target).cursor || 'default', 80) : 'default',
      devicePixelRatio, dragged: extra.dragged, selection: extra.selection,
      visualViewport: globalThis.visualViewport ? { offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop, scale: visualViewport.scale } : undefined,
      targetRect: target ? (() => { const rect = target.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })() : undefined,
      modifiers: { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey },
    };
  }

  const pointerKey = (event) => Number.isFinite(event.pointerId) ? event.pointerId : 'mouse';

  function send(event) {
    if (!active) return;
    chrome.runtime.sendMessage({ type: 'PATHPROOF_CONTENT_EVENT', sessionId, event: { url: location.href, ...event } }).catch(() => undefined);
  }

  const onClick = (event) => {
    if (options.debuggerInput) return;
    send({ kind: event.type, ...elementFields(event.target), x: event.clientX, y: event.clientY, width: innerWidth, height: innerHeight, data: { ...pointerData(event, { selection: selectionFor(event.target) }), detail: event.detail } });
  };
  const onPointerDown = (event) => {
    if (options.debuggerInput) return;
    activePointers.set(pointerKey(event), { x: event.clientX, y: event.clientY, moved: false });
    send({ kind: 'pointerdown', ...elementFields(event.target), x: event.clientX, y: event.clientY, width: innerWidth, height: innerHeight,
      data: pointerData(event, { dragged: false, selection: selectionFor(event.target) }) });
  };
  const onPointerMove = (event) => {
    if (options.debuggerInput) return;
    const pointer = activePointers.get(pointerKey(event));
    if (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >= 2) pointer.moved = true;
  };
  const onPointerUp = (event) => {
    if (options.debuggerInput) return;
    const pointer = activePointers.get(pointerKey(event));
    const dragged = Boolean(pointer?.moved || (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >= 2));
    activePointers.delete(pointerKey(event));
    queueMicrotask(() => {
      if (!active || options.debuggerInput) return;
      send({ kind: 'pointerup', ...elementFields(event.target), x: event.clientX, y: event.clientY, width: innerWidth, height: innerHeight,
        data: pointerData(event, { dragged, selection: selectionFor(event.target) }) });
    });
  };
  const onPointerCancel = (event) => activePointers.delete(pointerKey(event));
  const onInput = (event) => {
    const element = event.target;
    if (element instanceof HTMLSelectElement || (element instanceof HTMLInputElement && ['checkbox', 'radio', 'button', 'submit', 'file'].includes(element.type))) return;
    clearTimeout(inputTimers.get(element));
    inputTimers.set(element, setTimeout(() => {
      const secret = element instanceof HTMLInputElement && (element.type === 'password' || /password|secret|token|card|cvv|ssn/i.test(element.autocomplete || element.name || ''));
      const value = secret ? '[redacted]' : element.value ?? element.textContent ?? '';
      send({ kind: 'input', ...elementFields(element), value: String(value), data: { inputType: element.type, redacted: secret } });
    }, 180));
  };
  const onChange = (event) => {
    const element = event.target;
    const secret = element instanceof HTMLInputElement && element.type === 'password';
    send({ kind: 'change', ...elementFields(element), value: secret ? '[redacted]' : element.value, data: { inputType: element.type, checked: element.checked, redacted: secret } });
  };
  const onKeydown = (event) => send({ kind: 'keydown', ...elementFields(event.target), key: event.key, data: { code: event.code, repeat: event.repeat, modifiers: { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey } } });
  const onFocus = (event) => send({ kind: 'focus', ...elementFields(event.target) });
  const onScroll = () => {
    if (Date.now() - lastScrollAt < 160) return;
    lastScrollAt = Date.now();
    send({ kind: 'scroll', scrollX, scrollY, width: innerWidth, height: innerHeight });
  };
  const onMouse = (event) => {
    if (options.debuggerInput || !options.captureMouseMoves || Date.now() - lastMouseAt < 80) return;
    lastMouseAt = Date.now();
    send({ kind: 'mousemove', ...elementFields(event.target), x: event.clientX, y: event.clientY, width: innerWidth, height: innerHeight, data: pointerData(event) });
  };
  const onResize = () => send({ kind: 'resize', width: innerWidth, height: innerHeight, data: { devicePixelRatio } });
  const onHistory = () => send({ kind: 'navigation', text: document.title, data: { source: 'history' } });

  function start(config) {
    if (active && sessionId === config.sessionId) { options = config.options || {}; if (options.debuggerInput) activePointers.clear(); return; }
    if (active) stop();
    active = true; sessionId = config.sessionId; options = config.options || {};
    addEventListener('click', onClick, true); addEventListener('dblclick', onClick, true);
    addEventListener('input', onInput, true); addEventListener('change', onChange, true);
    addEventListener('keydown', onKeydown, true); addEventListener('focusin', onFocus, true);
    addEventListener('scroll', onScroll, true); addEventListener('mousemove', onMouse, true);
    addEventListener('pointerdown', onPointerDown, true); addEventListener('pointermove', onPointerMove, true);
    addEventListener('pointerup', onPointerUp, true); addEventListener('pointercancel', onPointerCancel, true);
    addEventListener('resize', onResize, true); addEventListener('popstate', onHistory, true); addEventListener('hashchange', onHistory, true);
    if (options.captureDom) {
      observer = new MutationObserver((mutations) => {
        const counts = { attributes: 0, added: 0, removed: 0, characterData: 0 };
        for (const mutation of mutations) {
          if (mutation.type === 'attributes') counts.attributes += 1;
          if (mutation.type === 'characterData') counts.characterData += 1;
          counts.added += mutation.addedNodes?.length || 0; counts.removed += mutation.removedNodes?.length || 0;
        }
        send({ kind: 'dom-mutation', ...elementFields(mutations[0]?.target), data: counts });
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    send({ kind: 'lifecycle', data: { name: 'content-recorder-attached', readyState: document.readyState } });
  }

  function stop() {
    active = false; activePointers.clear(); observer?.disconnect(); observer = undefined;
    removeEventListener('click', onClick, true); removeEventListener('dblclick', onClick, true);
    removeEventListener('input', onInput, true); removeEventListener('change', onChange, true);
    removeEventListener('keydown', onKeydown, true); removeEventListener('focusin', onFocus, true);
    removeEventListener('scroll', onScroll, true); removeEventListener('mousemove', onMouse, true);
    removeEventListener('pointerdown', onPointerDown, true); removeEventListener('pointermove', onPointerMove, true);
    removeEventListener('pointerup', onPointerUp, true); removeEventListener('pointercancel', onPointerCancel, true);
    removeEventListener('resize', onResize, true); removeEventListener('popstate', onHistory, true); removeEventListener('hashchange', onHistory, true);
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'PATHPROOF_START_CONTENT') { start(message); respond({ ok: true }); }
    if (message.type === 'PATHPROOF_STOP_CONTENT') { stop(); respond({ ok: true }); }
    if (message.type === 'PATHPROOF_CAPTURE_STATE') {
      const localStorageValues = {};
      try { for (let index = 0; index < localStorage.length; index += 1) { const key = localStorage.key(index); localStorageValues[key] = localStorage.getItem(key); } } catch {}
      respond({ viewport: { width: innerWidth, height: innerHeight }, localStorage: localStorageValues, url: location.href, title: document.title });
    }
    return true;
  });
})();
