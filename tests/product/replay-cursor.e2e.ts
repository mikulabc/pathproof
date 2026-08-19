import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { attachReplayCursor, moveReplayPointer } from '../../server/replay-cursor';

const pageMarkup = (label: string) => `<!doctype html>
  <html>
    <head>
      <meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'">
      <style>
        body { margin: 0; font: 16px sans-serif; }
        button, input, textarea, [contenteditable] { position: fixed; left: 20px; width: 180px; height: 36px; }
        button { top: 20px; cursor: pointer; }
        input { top: 76px; }
        textarea { top: 132px; }
        [contenteditable] { top: 188px; border: 1px solid #777; }
        p { position: fixed; top: 244px; left: 20px; }
      </style>
    </head>
    <body>
      <button>${label}</button>
      <input aria-label="Text input">
      <textarea aria-label="Text area"></textarea>
      <div contenteditable="true">Editable text</div>
      <p id="selectable">Selectable plain text</p>
    </body>
  </html>`;

const dataUrl = (markup: string) => `data:text/html;charset=utf-8,${encodeURIComponent(markup)}`;

async function cursorState(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-pathproof-replay-cursor]');
    const cursor = host?.shadowRoot?.querySelector<HTMLElement>('#cursor');
    const ring = host?.shadowRoot?.querySelector<HTMLElement>('[data-pathproof-click-highlight]');
    const transform = cursor ? new DOMMatrixReadOnly(cursor.style.transform) : null;
    return {
      hosts: document.querySelectorAll('[data-pathproof-replay-cursor]').length,
      connected: Boolean(host?.isConnected),
      opacity: cursor ? getComputedStyle(cursor).opacity : null,
      shape: cursor?.dataset.shape ?? null,
      transform: cursor?.style.transform ?? null,
      x: transform?.m41 ?? null,
      y: transform?.m42 ?? null,
      cursorText: cursor?.textContent?.trim() ?? null,
      ringCount: host?.shadowRoot?.querySelectorAll('[data-pathproof-click-highlight]').length ?? 0,
      ringBorder: ring ? getComputedStyle(ring).borderTopColor : null,
    };
  });
}

test('replay cursor stays visible, changes shape, and only highlights clicks in yellow', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await attachReplayCursor(page);
  await page.goto(dataUrl(pageMarkup('First page')));

  await expect.poll(async () => cursorState(page)).toMatchObject({
    hosts: 1,
    connected: true,
    opacity: '1',
    shape: 'arrow',
    cursorText: '',
    ringCount: 0,
  });
  expect((await cursorState(page)).transform).not.toContain('-40px');

  await page.mouse.move(80, 94);
  await expect.poll(async () => (await cursorState(page)).shape).toBe('text');
  await expect.poll(async () => (await cursorState(page)).ringCount).toBe(0);

  await page.mouse.move(80, 38);
  await expect.poll(async () => (await cursorState(page)).shape).toBe('arrow');
  await page.mouse.down();
  await expect.poll(async () => cursorState(page)).toMatchObject({
    ringCount: 1,
    ringBorder: 'rgb(250, 204, 21)',
  });
  await page.mouse.up();

  await page.waitForTimeout(650);
  await expect.poll(async () => cursorState(page)).toMatchObject({ opacity: '1', ringCount: 0 });

  await page.evaluate(() => document.querySelector('[data-pathproof-replay-cursor]')?.remove());
  await expect.poll(async () => cursorState(page)).toMatchObject({ hosts: 1, connected: true, opacity: '1' });

  await page.goto(dataUrl(pageMarkup('Second page')));
  await expect.poll(async () => cursorState(page)).toMatchObject({
    hosts: 1,
    connected: true,
    opacity: '1',
    ringCount: 0,
  });

  await page.mouse.move(80, 150);
  await expect.poll(async () => (await cursorState(page)).shape).toBe('text');
  await page.mouse.move(80, 206);
  await expect.poll(async () => (await cursorState(page)).shape).toBe('text');

  const plainText = await page.locator('#selectable').boundingBox();
  expect(plainText).toBeTruthy();
  await page.mouse.move(plainText!.x + 20, plainText!.y + plainText!.height / 2);
  await expect.poll(async () => (await cursorState(page)).shape).toBe('text');

  await page.evaluate(() => {
    const text = document.querySelector('#selectable')?.firstChild;
    if (!text) return;
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(text);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.mouse.move(plainText!.x + 60, plainText!.y + plainText!.height / 2);
  await expect.poll(async () => (await cursorState(page)).shape).toBe('text');
  expect(pageErrors).toEqual([]);
});

test('cursor keeps its real coordinate through a cross-origin document replacement', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await attachReplayCursor(page);
  await page.goto(dataUrl(pageMarkup('Opaque origin one')));
  await moveReplayPointer(page, { x: 137, y: 219 }, 0);
  await expect.poll(async () => cursorState(page)).toMatchObject({ x: 137, y: 219, opacity: '1' });

  await page.goto(dataUrl(pageMarkup('Opaque origin two')));
  await expect.poll(async () => cursorState(page)).toMatchObject({
    hosts: 1,
    x: 137,
    y: 219,
    opacity: '1',
  });
  expect(pageErrors).toEqual([]);
});

test('pointer movement and clicks inside a cross-origin iframe reach the top overlay', async ({ page }) => {
  const child = `<!doctype html><html><head><style>
    html, body { margin: 0; }
    input { position: fixed; left: 20px; top: 20px; width: 180px; height: 36px; }
  </style></head><body><input aria-label="Framed input"></body></html>`;
  const parent = `<!doctype html><html><head><style>
    html, body { margin: 0; }
    iframe { position: fixed; left: 100px; top: 80px; width: 320px; height: 220px; border: 4px solid #222; }
  </style></head><body><iframe title="Cross-origin child" src="${dataUrl(child)}"></iframe></body></html>`;
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await attachReplayCursor(page);
  await page.goto(dataUrl(parent));

  const childFrame = page.frames().find((frame) => frame !== page.mainFrame());
  expect(childFrame).toBeTruthy();
  await childFrame!.getByRole('textbox', { name: 'Framed input' }).waitFor();
  const frameBox = await page.getByTitle('Cross-origin child').boundingBox();
  expect(frameBox).toBeTruthy();
  const pointer = { x: frameBox!.x + 4 + 80, y: frameBox!.y + 4 + 38 };
  await page.mouse.move(pointer.x, pointer.y);
  await expect.poll(async () => cursorState(page)).toMatchObject({
    x: pointer.x,
    y: pointer.y,
    shape: 'text',
    ringCount: 0,
  });

  await page.mouse.down();
  await expect.poll(async () => cursorState(page)).toMatchObject({
    ringCount: 1,
    ringBorder: 'rgb(250, 204, 21)',
  });
  await page.mouse.up();
  expect(pageErrors).toEqual([]);
});

test('cursor init source produced by the production tsx runtime has no missing helpers', async ({ page }) => {
  const source = execFileSync(process.execPath, [
    '--import', 'tsx',
    '--input-type=module',
    '--eval',
    "import { replayCursorScriptSource } from './server/replay-cursor.ts'; process.stdout.write(replayCursorScriptSource());",
  ], { cwd: process.cwd(), encoding: 'utf8' });
  expect(source).toContain('const __name = (target) => target');
  expect(source).toContain('__name(');

  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.addInitScript({ content: source });
  await page.goto(dataUrl(pageMarkup('tsx runtime page')));
  await expect.poll(async () => cursorState(page)).toMatchObject({
    hosts: 1,
    connected: true,
    opacity: '1',
  });
  expect(pageErrors).toEqual([]);
});
