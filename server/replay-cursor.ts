import type { Page } from 'playwright';

type ReplayCursorWindow = typeof globalThis & {
  __pathproofReplayCursorInstalled?: boolean;
};

export type PointerCoordinate = { x: number; y: number };

const POINTER_FRAME_INTERVAL_MS = 1_000 / 60;
const MAX_POINTER_SEGMENT_MS = 750;
const MAX_SCALED_POINTER_SEGMENT_MS = 3_000;
const MAX_POINTER_SEGMENT_FRAMES = Math.ceil(MAX_POINTER_SEGMENT_MS / POINTER_FRAME_INTERVAL_MS);
const replayPointerPositions = new WeakMap<Page, PointerCoordinate>();

/** Returns a bounded number of CDP mouse updates for a recorded pointer segment. */
export function pointerInterpolationFrameCount(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 1;
  const boundedDuration = Math.min(MAX_POINTER_SEGMENT_MS, durationMs);
  return Math.max(1, Math.min(MAX_POINTER_SEGMENT_FRAMES, Math.ceil(boundedDuration / POINTER_FRAME_INTERVAL_MS)));
}

/** The last coordinate actually sent to CDP, retained across navigations on a Page. */
export function replayPointerPosition(page: Page): PointerCoordinate {
  const saved = replayPointerPositions.get(page);
  if (saved) return { ...saved };
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
  const centered = { x: viewport.width / 2, y: viewport.height / 2 };
  replayPointerPositions.set(page, centered);
  return { ...centered };
}

/**
 * Moves the real Playwright pointer on a wall-clock schedule instead of asking
 * CDP to burst all intermediate steps at once.
 */
export async function moveReplayPointer(
  page: Page,
  to: PointerCoordinate,
  durationMs: number,
): Promise<void> {
  const from = replayPointerPosition(page);
  const duration = Number.isFinite(durationMs) ? Math.min(MAX_SCALED_POINTER_SEGMENT_MS, Math.max(0, durationMs)) : 0;
  const frames = pointerInterpolationFrameCount(duration);
  const startedAt = Date.now();
  for (let frame = 1; frame <= frames; frame += 1) {
    const progress = frame / frames;
    const coordinate = {
      x: from.x + (to.x - from.x) * progress,
      y: from.y + (to.y - from.y) * progress,
    };
    await page.mouse.move(coordinate.x, coordinate.y);
    replayPointerPositions.set(page, coordinate);
    const waitMs = startedAt + duration * progress - Date.now();
    if (waitMs > 0) await page.waitForTimeout(waitMs);
  }
}

/**
 * Runs in the page's main world. Keep this function self-contained so that
 * Playwright can serialize it as an init script for every navigation.
 */
export function replayCursorInit(): void {
  const isTopFrame = window.top === window;
  const replayWindow = globalThis as ReplayCursorWindow;
  if (replayWindow.__pathproofReplayCursorInstalled) return;
  replayWindow.__pathproofReplayCursorInstalled = true;

  const positionStorageKey = '__pathproofReplayCursorPosition';
  const svgNamespace = 'http://www.w3.org/2000/svg';
  let targetX = Math.max(0, window.innerWidth / 2);
  let targetY = Math.max(0, window.innerHeight / 2);
  try {
    const savedPosition = JSON.parse(sessionStorage.getItem(positionStorageKey) ?? 'null') as PointerCoordinate | null;
    if (savedPosition && Number.isFinite(savedPosition.x) && Number.isFinite(savedPosition.y)) {
      targetX = Math.min(Math.max(0, savedPosition.x), Math.max(0, window.innerWidth - 1));
      targetY = Math.min(Math.max(0, savedPosition.y), Math.max(0, window.innerHeight - 1));
    }
  } catch {
    // Opaque origins and storage-disabled pages still get a centered cursor.
  }

  let currentX = targetX;
  let currentY = targetY;
  let host: HTMLElement | undefined;
  let cursor: HTMLElement | undefined;
  let rippleLayer: HTMLElement | undefined;
  let animationFrame = 0;
  let lastPositionSave = 0;
  let observedRoot: HTMLElement | undefined;
  let positionReady = false;
  let receivedPointerEvent = false;
  let targetShape: 'arrow' | 'text' = 'arrow';

  const textAtPoint = (x: number, y: number): boolean => {
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed) {
      for (let index = 0; index < selection.rangeCount; index += 1) {
        if ([...selection.getRangeAt(index).getClientRects()].some((rect) => (
          x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2
        ))) return true;
      }
    }

    const range = document.caretRangeFromPoint?.(x, y);
    const text = range?.startContainer;
    if (!text || text.nodeType !== Node.TEXT_NODE || !text.textContent?.trim()) return false;
    const parent = text.parentElement;
    if (!parent || parent.closest('a, button, select, summary, [role="button"], [role="link"], [draggable="true"]')) return false;
    if (getComputedStyle(parent).userSelect === 'none') return false;
    const offsets = new Set([
      Math.min(Math.max(0, range.startOffset), Math.max(0, text.textContent.length - 1)),
      Math.min(Math.max(0, range.startOffset - 1), Math.max(0, text.textContent.length - 1)),
    ]);
    for (const offset of offsets) {
      const probe = document.createRange();
      probe.setStart(text, offset);
      probe.setEnd(text, Math.min(text.textContent.length, offset + 1));
      if ([...probe.getClientRects()].some((rect) => (
        x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2
      ))) return true;
    }
    return false;
  };

  const isTextTarget = (target: EventTarget | null, x: number, y: number): boolean => {
    const element = target instanceof Element ? target : document.elementFromPoint(x, y);
    if (!element) return false;
    if (element.closest('textarea, [contenteditable]:not([contenteditable="false"])')) return true;
    const input = element.closest('input');
    if (input instanceof HTMLInputElement && ![
      'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit',
    ].includes(input.type)) return true;
    const computedCursor = getComputedStyle(element).cursor;
    if (computedCursor === 'text' || computedCursor === 'vertical-text') return true;
    if (['pointer', 'grab', 'grabbing', 'move', 'not-allowed'].includes(computedCursor)) return false;
    return textAtPoint(x, y);
  };

  const createSvg = (className: string, viewBox: string, paths: Array<Record<string, string>>): SVGSVGElement => {
    const svg = document.createElementNS(svgNamespace, 'svg');
    svg.setAttribute('class', `shape ${className}`);
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('aria-hidden', 'true');
    for (const attributes of paths) {
      const path = document.createElementNS(svgNamespace, 'path');
      for (const [name, value] of Object.entries(attributes)) path.setAttribute(name, value);
      svg.append(path);
    }
    return svg;
  };

  const refreshShape = () => {
    if (!cursor?.isConnected) return;
    targetShape = isTextTarget(document.elementFromPoint(targetX, targetY), targetX, targetY) ? 'text' : 'arrow';
    cursor.dataset.shape = targetShape;
  };

  const mount = (): boolean => {
    if (!isTopFrame || !positionReady) return false;
    if (host?.isConnected && cursor && rippleLayer) return true;
    const documentRoot = document.documentElement;
    if (!documentRoot) return false;

    const nextHost = document.createElement('div');
    nextHost.dataset.pathproofReplayCursor = 'true';
    nextHost.setAttribute('aria-hidden', 'true');
    nextHost.style.position = 'fixed';
    nextHost.style.inset = '0';
    nextHost.style.zIndex = '2147483647';
    nextHost.style.pointerEvents = 'none';
    nextHost.style.overflow = 'visible';
    nextHost.style.contain = 'layout style';
    const shadow = nextHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      #cursor {
        position: fixed; left: 0; top: 0; width: 1px; height: 1px; opacity: 1;
        pointer-events: none; will-change: transform;
      }
      .shape {
        position: absolute; left: 0; top: 0; overflow: visible;
        filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .48));
        transition: opacity 70ms linear;
      }
      .arrow { width: 24px; height: 30px; opacity: 1; }
      .ibeam { width: 20px; height: 28px; transform: translate(-10px, -14px); opacity: 0; }
      #cursor[data-shape="text"] .arrow { opacity: 0; }
      #cursor[data-shape="text"] .ibeam { opacity: 1; }
      #ripples { position: fixed; inset: 0; pointer-events: none; overflow: visible; }
      .click-ring {
        position: fixed; width: 18px; height: 18px; margin: -9px 0 0 -9px;
        border: 3px solid #facc15; border-radius: 999px;
        background: rgba(250, 204, 21, .24); box-shadow: 0 0 0 2px rgba(17, 24, 39, .3);
        pointer-events: none;
        animation: pathproof-click-ring 480ms cubic-bezier(.16, 1, .3, 1) forwards;
      }
      @keyframes pathproof-click-ring {
        0% { opacity: 1; transform: scale(.35); }
        72% { opacity: .72; }
        100% { opacity: 0; transform: scale(2.9); }
      }
    `;
    shadow.append(style);

    const nextRippleLayer = document.createElement('div');
    nextRippleLayer.id = 'ripples';
    const nextCursor = document.createElement('div');
    nextCursor.id = 'cursor';
    nextCursor.dataset.shape = targetShape;
    nextCursor.style.transform = `translate3d(${currentX.toFixed(2)}px, ${currentY.toFixed(2)}px, 0)`;
    nextCursor.append(
      createSvg('arrow', '0 0 24 30', [{
        d: 'M2 1.5v22.2l5.6-5.1 4.1 9.1 4.1-1.9-4.1-8.7h7.7z',
        fill: '#fff', stroke: '#111827', 'stroke-width': '2', 'stroke-linejoin': 'round',
      }]),
      createSvg('ibeam', '0 0 20 28', [
        { d: 'M6 2h8M10 2v24M6 26h8M5 8h10M5 20h10', fill: 'none', stroke: '#fff', 'stroke-width': '4', 'stroke-linecap': 'round' },
        { d: 'M6 2h8M10 2v24M6 26h8M5 8h10M5 20h10', fill: 'none', stroke: '#111827', 'stroke-width': '2', 'stroke-linecap': 'round' },
      ]),
    );
    shadow.append(nextRippleLayer, nextCursor);
    documentRoot.append(nextHost);
    host = nextHost;
    cursor = nextCursor;
    rippleLayer = nextRippleLayer;
    if (!receivedPointerEvent) requestAnimationFrame(refreshShape);
    return true;
  };

  const render = () => {
    animationFrame = 0;
    if (!mount() || !cursor) return;
    const dx = targetX - currentX;
    const dy = targetY - currentY;
    if (Math.abs(dx) < .12 && Math.abs(dy) < .12) {
      currentX = targetX;
      currentY = targetY;
    } else {
      currentX += dx * .42;
      currentY += dy * .42;
    }
    cursor.style.transform = `translate3d(${currentX.toFixed(2)}px, ${currentY.toFixed(2)}px, 0)`;
    if (currentX !== targetX || currentY !== targetY) animationFrame = requestAnimationFrame(render);
  };

  const scheduleRender = () => {
    if (!animationFrame) animationFrame = requestAnimationFrame(render);
  };

  const savePosition = (force = false) => {
    const timestamp = Date.now();
    if (!force && timestamp - lastPositionSave < 100) return;
    lastPositionSave = timestamp;
    try {
      sessionStorage.setItem(positionStorageKey, JSON.stringify({ x: targetX, y: targetY }));
    } catch {
      // Storage may be unavailable without affecting the visible overlay.
    }
  };

  const applyPointer = (x: number, y: number, shape: 'arrow' | 'text', fromPointerEvent = true) => {
    targetX = x;
    targetY = y;
    positionReady = true;
    if (fromPointerEvent) receivedPointerEvent = true;
    targetShape = shape;
    if (mount() && cursor) {
      cursor.dataset.shape = shape;
    }
    savePosition();
    scheduleRender();
  };

  const addClickRing = (x: number, y: number) => {
    if (!mount() || !rippleLayer) return;
    const ring = document.createElement('span');
    ring.className = 'click-ring';
    ring.dataset.pathproofClickHighlight = 'true';
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    rippleLayer.append(ring);
    window.setTimeout(() => ring.remove(), 520);
  };

  const relayKey = '__pathproofReplayCursorRelayV1';
  const relayToParent = (kind: 'move' | 'click', x: number, y: number, shape: 'arrow' | 'text') => {
    if (isTopFrame) return;
    window.parent.postMessage({
      [relayKey]: true,
      kind,
      x,
      y,
      shape,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    }, '*');
  };

  const eventShape = (event: PointerEvent | MouseEvent): 'arrow' | 'text' => (
    isTextTarget(event.composedPath()[0] ?? event.target, event.clientX, event.clientY) ? 'text' : 'arrow'
  );

  const updatePointer = (event: PointerEvent | MouseEvent) => {
    const shape = eventShape(event);
    if (!isTopFrame) {
      relayToParent('move', event.clientX, event.clientY, shape);
      return;
    }
    applyPointer(event.clientX, event.clientY, shape);
  };

  const showClick = (event: PointerEvent | MouseEvent) => {
    const shape = eventShape(event);
    if (!isTopFrame) {
      relayToParent('click', event.clientX, event.clientY, shape);
      return;
    }
    applyPointer(event.clientX, event.clientY, shape);
    savePosition(true);
    addClickRing(event.clientX, event.clientY);
  };

  const receiveRelayedPointer = (event: MessageEvent) => {
    const data = event.data as {
      __pathproofReplayCursorRelayV1?: boolean;
      kind?: unknown;
      x?: unknown;
      y?: unknown;
      shape?: unknown;
      viewportWidth?: unknown;
      viewportHeight?: unknown;
    } | null;
    if (!data?.[relayKey] || (data.kind !== 'move' && data.kind !== 'click')) return;
    const x = Number(data.x);
    const y = Number(data.y);
    const childViewportWidth = Number(data.viewportWidth);
    const childViewportHeight = Number(data.viewportHeight);
    if (![x, y, childViewportWidth, childViewportHeight].every(Number.isFinite) || childViewportWidth <= 0 || childViewportHeight <= 0) return;
    const childFrame = [...document.querySelectorAll<HTMLIFrameElement | HTMLFrameElement>('iframe, frame')]
      .find((frame) => frame.contentWindow === event.source);
    if (!childFrame) return;
    const frameRect = childFrame.getBoundingClientRect();
    const cssScaleX = childFrame.offsetWidth > 0 ? frameRect.width / childFrame.offsetWidth : 1;
    const cssScaleY = childFrame.offsetHeight > 0 ? frameRect.height / childFrame.offsetHeight : 1;
    const contentWidth = Math.max(1, childFrame.clientWidth * cssScaleX);
    const contentHeight = Math.max(1, childFrame.clientHeight * cssScaleY);
    const translatedX = frameRect.left + childFrame.clientLeft * cssScaleX + x * contentWidth / childViewportWidth;
    const translatedY = frameRect.top + childFrame.clientTop * cssScaleY + y * contentHeight / childViewportHeight;
    const shape = data.shape === 'text' ? 'text' : 'arrow';
    if (!isTopFrame) {
      relayToParent(data.kind, translatedX, translatedY, shape);
      return;
    }
    applyPointer(translatedX, translatedY, shape);
    if (data.kind === 'click') {
      savePosition(true);
      addClickRing(translatedX, translatedY);
    }
  };

  const rootObserver = new MutationObserver(() => {
    if (!host?.isConnected) mount();
  });
  const observeDocumentRoot = () => {
    const documentRoot = document.documentElement;
    if (documentRoot && documentRoot !== observedRoot) {
      rootObserver.disconnect();
      rootObserver.observe(documentRoot, { childList: true });
      observedRoot = documentRoot;
    }
    if (!host?.isConnected) mount();
  };
  const documentObserver = new MutationObserver(observeDocumentRoot);

  addEventListener('pointermove', updatePointer, { capture: true, passive: true });
  if (!('PointerEvent' in window)) addEventListener('mousemove', updatePointer, { capture: true, passive: true });
  addEventListener('pointerdown', showClick, { capture: true, passive: true });
  if (!('PointerEvent' in window)) addEventListener('mousedown', showClick, { capture: true, passive: true });
  addEventListener('message', receiveRelayedPointer, { capture: true });
  if (isTopFrame) {
    addEventListener('pagehide', () => savePosition(true), { capture: true });
    document.addEventListener('DOMContentLoaded', () => {
      observeDocumentRoot();
      requestAnimationFrame(refreshShape);
    }, { once: true });
    documentObserver.observe(document, { childList: true });

    const activatePosition = (position?: PointerCoordinate) => {
      if (!receivedPointerEvent && position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
        targetX = Math.min(Math.max(0, position.x), Math.max(0, window.innerWidth - 1));
        targetY = Math.min(Math.max(0, position.y), Math.max(0, window.innerHeight - 1));
        currentX = targetX;
        currentY = targetY;
      }
      positionReady = true;
      observeDocumentRoot();
      mount();
      scheduleRender();
    };
    const synchronizePosition = (attempt = 0) => {
      const provider = (globalThis as typeof globalThis & {
        __pathproofReplayCursorPosition?: () => Promise<PointerCoordinate>;
      }).__pathproofReplayCursorPosition;
      if (typeof provider === 'function') {
        void provider().then(activatePosition).catch(() => activatePosition());
      } else if (attempt < 20) {
        window.setTimeout(() => synchronizePosition(attempt + 1), 0);
      } else {
        activatePosition();
      }
    };
    synchronizePosition();
  }
}

/** Installs the custom cursor in the current document and every later navigation. */
export function replayCursorScriptSource(): string {
  // tsx/esbuild can add __name(...) calls inside Function#toString output. The
  // init world does not inherit that module helper, so provide it explicitly.
  return `(() => { const __name = (target) => target; (${replayCursorInit.toString()})(); })()`;
}

export async function attachReplayCursor(page: Page): Promise<void> {
  await page.exposeFunction('__pathproofReplayCursorPosition', () => replayPointerPosition(page));
  const source = replayCursorScriptSource();
  await page.addInitScript({ content: source });
  await page.evaluate(source);
}
