// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type RuntimeMessage = { type: string; sessionId?: string; options?: Record<string, unknown> };
type ContentMessage = { type: string; sessionId: string; event: { kind: string; selector?: string; data?: Record<string, unknown> } };

let stopRecorder: (() => void) | undefined;

afterEach(() => {
  stopRecorder?.();
  stopRecorder = undefined;
  delete (globalThis as typeof globalThis & { __pathproofRecorderInstalled?: boolean }).__pathproofRecorderInstalled;
  delete (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
  document.body.replaceChildren();
});

function pointerEvent(type: string, x: number, y: number, buttons: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons });
  Object.defineProperties(event, {
    pointerId: { value: 17 }, pointerType: { value: 'mouse' }, pressure: { value: buttons ? 0.5 : 0 },
  });
  return event;
}

function installFallback(options: Record<string, unknown> = { debuggerInput: false, captureMouseMoves: true }) {
  const sent: ContentMessage[] = [];
  let listener: ((message: RuntimeMessage, sender: unknown, respond: (value: unknown) => void) => boolean) | undefined;
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    runtime: {
      onMessage: { addListener: (registered: typeof listener) => { listener = registered; } },
      sendMessage: (message: ContentMessage) => { sent.push(message); return Promise.resolve(); },
    },
  } });
  if (!globalThis.CSS) Object.defineProperty(globalThis, 'CSS', { configurable: true, value: {} });
  if (!globalThis.CSS.escape) Object.defineProperty(globalThis.CSS, 'escape', { configurable: true, value: (value: string) => value.replace(/[^a-z0-9_-]/gi, '\\$&') });
  const source = readFileSync(path.resolve(process.cwd(), 'chrome-extension/content-script.js'), 'utf8');
  (0, eval)(source);
  if (!listener) throw new Error('Content-script message listener was not installed.');
  listener({ type: 'PATHPROOF_START_CONTENT', sessionId: 'fallback-session', options }, {}, () => undefined);
  stopRecorder = () => listener?.({ type: 'PATHPROOF_STOP_CONTENT' }, {}, () => undefined);
  sent.length = 0;
  return { sent, update: (nextOptions: Record<string, unknown>) => listener?.({ type: 'PATHPROOF_START_CONTENT', sessionId: 'fallback-session', options: nextOptions }, {}, () => undefined) };
}

describe('content-script pointer fallback', () => {
  it('captures a real drag selection without selected text and suppresses itself for debugger input', async () => {
    document.body.innerHTML = '<p id="article">privacy safe selection text</p>';
    const article = document.querySelector('#article') as HTMLElement;
    const text = article.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0); range.setEnd(text, 12);
    const selection = document.getSelection();
    selection?.removeAllRanges(); selection?.addRange(range);
    const fallback = installFallback();

    article.dispatchEvent(pointerEvent('pointerdown', 10, 20, 1));
    article.dispatchEvent(pointerEvent('pointermove', 120, 20, 1));
    article.dispatchEvent(pointerEvent('pointerup', 120, 20, 0));
    await Promise.resolve();

    const pointerDown = fallback.sent.find((message) => message.event.kind === 'pointerdown')?.event;
    const pointerUp = fallback.sent.find((message) => message.event.kind === 'pointerup')?.event;
    const upSelection = pointerUp?.data?.selection as Record<string, unknown>;
    expect(pointerDown?.selector).toBe('#article');
    expect(pointerUp?.selector).toBe('#article');
    expect(pointerUp?.data?.dragged).toBe(true);
    expect(pointerUp?.data?.eventEpochMs).toEqual(expect.any(Number));
    expect(pointerUp?.data?.cursor).toEqual(expect.any(String));
    expect(upSelection.selectedTextLength).toBe(12);
    expect(upSelection.anchorSelector).toBe('#article');
    expect(upSelection.focusSelector).toBe('#article');
    expect(upSelection).not.toHaveProperty('selectedText');

    fallback.sent.length = 0;
    fallback.update({ debuggerInput: true, captureMouseMoves: true });
    article.dispatchEvent(pointerEvent('pointerdown', 10, 20, 1));
    article.dispatchEvent(pointerEvent('pointermove', 120, 20, 1));
    article.dispatchEvent(pointerEvent('pointerup', 120, 20, 0));
    await Promise.resolve();
    expect(fallback.sent.some((message) => message.event.kind === 'pointerdown' || message.event.kind === 'pointerup')).toBe(false);
  });
});
