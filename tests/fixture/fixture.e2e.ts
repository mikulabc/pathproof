import { expect, test, type Page } from '@playwright/test';
import { RunCoordinator } from '../../server/runner';

const fixtureUrl = 'http://127.0.0.1:4317';

test.describe('controlled discovery target', () => {
  test('exposes the deterministic depth-one navigation graph', async ({ page }) => {
    await page.goto(`${fixtureUrl}/seed`);
    await expect(page.getByRole('heading', { name: 'Seed catalog' })).toBeVisible();

    await page.getByRole('link', { name: 'Open product details' }).click();
    await expect(page).toHaveURL(`${fixtureUrl}/child`);
    await expect(page.getByRole('link', { name: 'Read delivery information' })).toBeVisible();

    await page.getByRole('link', { name: 'Read delivery information' }).click();
    await expect(page).toHaveURL(`${fixtureUrl}/grandchild`);
  });

  test('has replayable sort, filter, action, and scroll outcomes', async ({ page }) => {
    await page.goto(`${fixtureUrl}/seed`);

    const products = page.locator('#products li');
    await expect(products).toHaveText(['Amber lamp', 'Blue chair', 'Coral desk']);
    await page.getByLabel('Sort products').selectOption('desc');
    await expect(products).toHaveText(['Coral desk', 'Blue chair', 'Amber lamp']);
    await page.getByLabel('Filter products').fill('amber');
    await expect(products).toHaveText(['Amber lamp']);

    await page.getByRole('button', { name: 'Add one to counter' }).click();
    await expect(page.getByRole('status')).toContainText('Counter: 1');

    await page.goto(`${fixtureUrl}/child`);
    await page.locator('#scroll-marker').scrollIntoViewIfNeeded();
    await expect(page.locator('#scroll-marker')).toBeInViewport();
  });

  test('marks destructive controls for safe discovery', async ({ page }) => {
    await page.goto(`${fixtureUrl}/seed`);
    const destructive = page.locator('[data-destructive="true"]');
    await expect(destructive).toHaveCount(2);
    await expect(page.locator('body')).not.toHaveAttribute('data-destructive-action-triggered', 'true');
  });

  test('exposes sequential AI actions for hover menus, unlabeled arrows, slow scroll, and custom filters', async ({ page }) => {
    await page.goto(`${fixtureUrl}/seed`);
    await page.setContent(`
      <nav><button aria-haspopup="true">Gastronomie</button><a href="${fixtureUrl}/restaurants">Restaurants</a></nav>
      <section><h2>Unsere Restaurantguides</h2><div><button><svg aria-hidden="true"></svg></button><button><svg aria-hidden="true"></svg></button></div></section>
      <section><h2>Küche</h2><label><input type="checkbox" style="display:none" value="regional">Regional</label><button class="js-category-filter" data-category-id="1" aria-label="Kategorie: Vegan">Vegan</button></section>
      <section><h2>Profile</h2><label>Full name <input type="text" name="full-name"></label><label>Resume <input type="file"></label></section>
      <div role="menuitem">Seasonal menu</div>
      <div draggable="true" id="menu-card">Menu card</div><div data-dropzone id="menu-board">Menu board</div>
      <section><h2>Signature</h2><canvas aria-label="Signature pad" width="300" height="100" style="width:300px;height:100px"></canvas></section>
      <open-menu id="open-menu"></open-menu>
    `);
    await page.evaluate(() => {
      const root = document.querySelector('#open-menu')!.attachShadow({ mode: 'open' });
      root.innerHTML = '<button aria-label="Shadow action">Go</button>';
    });
    const coordinatorPrototype = RunCoordinator.prototype as unknown as {
      discoverActions(page: Page, instructionDriven: boolean, fileNames: string[]): Promise<Array<{ kind: string; label: string; action: string; locator?: { selector?: string; role?: string; name?: string } }>>;
      resolveLocator(page: Page, locator: { selector?: string; role?: string; name?: string }): ReturnType<Page['locator']>;
    };
    const inventory = await coordinatorPrototype.discoverActions(page, true, ['resume.pdf']);

    expect(inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'hover', label: 'Hover over Gastronomie', action: 'hover' }),
      expect.objectContaining({ kind: 'click', label: 'Open Restaurants', action: 'click' }),
      expect.objectContaining({ kind: 'click', label: 'Use Unlabelled button 2 of 2 near Unsere Restaurantguides', action: 'click' }),
      expect.objectContaining({ kind: 'filter', label: 'Choose Regional', action: 'click' }),
      expect.objectContaining({ kind: 'filter', label: 'Filter with Kategorie: Vegan', action: 'click' }),
      expect.objectContaining({ kind: 'scroll', label: 'Scroll slowly down', action: 'scroll-slow' }),
      expect.objectContaining({ kind: 'fill', label: 'Fill Full name', action: 'fill' }),
      expect.objectContaining({ kind: 'file', label: 'Choose attached file resume.pdf for Resume', action: 'set-files' }),
      expect.objectContaining({ kind: 'click', label: 'Use custom control Seasonal menu', action: 'click' }),
      expect.objectContaining({ kind: 'drag-drop', label: 'Drag Menu card to Menu board', action: 'drag' }),
      expect.objectContaining({ kind: 'canvas-draw', label: 'Draw on Signature pad', action: 'canvas-draw' }),
      expect.objectContaining({ kind: 'click', label: 'Use Shadow action', action: 'click' }),
    ]));
    const shadowAction = inventory.find((candidate) => candidate.label === 'Use Shadow action');
    expect(shadowAction?.locator).toBeTruthy();
    await expect(coordinatorPrototype.resolveLocator(page, shadowAction!.locator!)).toBeVisible();
  });

  test('ignores an off-canvas mobile duplicate and locates the visible desktop navigation control by role', async ({ page }) => {
    await page.setContent(`
      <nav>
        <div role="button" aria-haspopup="true" aria-label="Gastronomie" style="display:inline-block;padding:16px">Gastronomie</div>
        <button style="visibility:hidden;position:absolute;left:1464px;width:342px;height:32px">Gastronomie</button>
      </nav>
    `);
    const coordinatorPrototype = RunCoordinator.prototype as unknown as {
      discoverActions(page: Page, instructionDriven: boolean, fileNames: string[]): Promise<Array<{ label: string; action: string; locator?: { selector?: string; role?: string; name?: string } }>>;
      resolveLocator(page: Page, locator: { selector?: string; role?: string; name?: string }): ReturnType<Page['locator']>;
    };

    const inventory = await coordinatorPrototype.discoverActions(page, true, []);
    const hover = inventory.find((candidate) => candidate.label === 'Hover over Gastronomie');

    expect(hover).toMatchObject({ action: 'hover', locator: { role: 'button', name: 'Gastronomie' } });
    expect(inventory.filter((candidate) => candidate.label === 'Hover over Gastronomie')).toHaveLength(1);
    await expect(coordinatorPrototype.resolveLocator(page, hover!.locator!)).toBeVisible();
  });

  test('prioritizes the least-permissive consent dismissal when an overlay covers navigation', async ({ page }) => {
    await page.setContent(`
      <nav><button aria-haspopup="true">Gastronomie</button></nav>
      <div class="ch2" role="dialog" style="position:fixed;inset:0;background:white;z-index:10">
        <button>Cookie settings</button><button>Deny all</button><button>Allow all cookies</button>
      </div>
    `);
    const coordinatorPrototype = RunCoordinator.prototype as unknown as {
      discoverActions(page: Page, instructionDriven: boolean, fileNames: string[]): Promise<Array<{ label: string; consent?: boolean; locator?: { selector?: string; role?: string; name?: string } }>>;
      moveDiscoveryPointerToLocator(page: Page, locator: ReturnType<Page['locator']>): Promise<unknown>;
    };

    const inventory = await coordinatorPrototype.discoverActions(page, true, []);
    expect(inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Dismiss cookie consent with Deny all', consent: true }),
    ]));
    expect(inventory.some((candidate) => /Allow all cookies|Cookie settings/.test(candidate.label))).toBe(false);
    await expect(coordinatorPrototype.moveDiscoveryPointerToLocator(page, page.getByRole('button', { name: 'Gastronomie' })))
      .rejects.toThrow(/covered by/i);

    await page.setContent(`
      <nav><button aria-haspopup="true">Gastronomie</button></nav>
      <div class="mfp-wrap" style="position:fixed;inset:0;background:white;z-index:10">
        <button aria-label="Overlay schließen">×</button>
      </div>
    `);
    const dialogInventory = await coordinatorPrototype.discoverActions(page, true, []);
    expect(dialogInventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Dismiss dialog with Overlay schließen' }),
    ]));
  });

  test('disambiguates duplicate arrow names using their section headings and unique classes', async ({ page }) => {
    await page.setContent(`
      <div><h2>Unsere Restaurantguides</h2><div><button class="js-highlight-next" aria-label="Weiter"></button></div></div>
      <div><h2>Restaurants im Überblick</h2><div><button class="js-pagination-next" aria-label="Weiter"></button></div></div>
    `);
    const coordinatorPrototype = RunCoordinator.prototype as unknown as {
      discoverActions(page: Page, instructionDriven: boolean, fileNames: string[]): Promise<Array<{ label: string; locator?: { selector?: string; role?: string; name?: string } }>>;
      resolveLocator(page: Page, locator: { selector?: string; role?: string; name?: string }): ReturnType<Page['locator']>;
    };

    const inventory = await coordinatorPrototype.discoverActions(page, true, []);
    const guideArrow = inventory.find((candidate) => candidate.label === 'Use Weiter near Unsere Restaurantguides');
    const paginationArrow = inventory.find((candidate) => candidate.label === 'Use Weiter near Restaurants im Überblick');

    expect(guideArrow?.locator).toEqual({ selector: 'button.js-highlight-next' });
    expect(paginationArrow?.locator).toEqual({ selector: 'button.js-pagination-next' });
    await expect(coordinatorPrototype.resolveLocator(page, guideArrow!.locator!)).toBeVisible();
    await expect(coordinatorPrototype.resolveLocator(page, paginationArrow!.locator!)).toBeVisible();
  });
});
