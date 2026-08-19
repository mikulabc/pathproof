import { createServer, type ServerResponse } from 'node:http';

// Bind all local interfaces so isolated tests can use distinct 127.x loopback
// origins while exercising the same deterministic site.
const host = process.env.FIXTURE_HOST ?? '0.0.0.0';
const port = Number(process.env.FIXTURE_PORT ?? 4317);
let mutationCount = 0;

const pageShell = (title: string, body: string, script = '') => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} · PathProof crawl target</title>
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; color: #172033; background: #f5f7fb; }
      header, main { width: min(880px, calc(100% - 32px)); margin: auto; }
      header { padding: 24px 0 8px; }
      main { padding: 16px 0 48px; }
      section { background: white; border: 1px solid #dfe5ef; border-radius: 12px; padding: 20px; margin: 16px 0; }
      button, select, input { font: inherit; min-height: 40px; }
      button { padding: 8px 14px; cursor: pointer; }
      .stack { display: grid; gap: 12px; }
      .products { padding-left: 24px; }
      .products li { padding: 6px; }
      .scroll-course { height: 780px; border-left: 3px dashed #b9c6dc; margin: 12px; }
      .danger { color: #a01818; border-color: #db9b9b; }
      [role=status] { min-height: 24px; color: #075f46; font-weight: 600; }
      footer { padding: 24px 0; }
    </style>
  </head>
  <body>
    <header>
      <strong>PathProof controlled target</strong>
    </header>
    <main>${body}</main>
    <script>${script}</script>
  </body>
</html>`;

const seedPage = pageShell(
  'Seed',
  `<h1>Seed catalog</h1>
  <p id="top">The stable level-one entry point for discovery.</p>
  <section aria-labelledby="catalog-heading">
    <h2 id="catalog-heading">Catalog controls</h2>
    <div class="stack">
      <label>Filter products <input id="filter" type="search" placeholder="Try amber" /></label>
      <label>Sort products
        <select id="sort">
          <option value="asc">Name, A to Z</option>
          <option value="desc">Name, Z to A</option>
        </select>
      </label>
      <ul id="products" class="products" aria-live="polite"></ul>
      <button id="increment" type="button">Add one to counter</button>
      <output id="counter" role="status">Counter: 0</output>
    </div>
  </section>
  <section>
    <h2>Continue browsing</h2>
    <a href="/child">Open product details</a>
  </section>
  <section aria-labelledby="contact-heading">
    <h2 id="contact-heading">Contact form</h2>
    <p>This unrelated global form verifies that discovery does not mistake ordinary fields for filters.</p>
    <label>Anrede
      <select id="salutation" name="salutation">
        <option value="">Choose an option</option>
        <option value="frau">Frau</option>
        <option value="herr">Herr</option>
      </select>
    </label>
  </section>
  <section aria-labelledby="danger-heading">
    <h2 id="danger-heading">Protected actions</h2>
    <p>These controls exist to verify that discovery avoids destructive actions.</p>
    <button class="danger" data-destructive="true" type="button">Delete catalog</button>
    <button class="danger" data-destructive="true" type="button">Confirm purchase</button>
    <button id="ambiguous-mutation" type="button">View status</button>
    <button type="button">Previous</button>
    <button type="button">Next</button>
  </section>`,
  `
    const products = ['Amber lamp', 'Blue chair', 'Coral desk'];
    const list = document.querySelector('#products');
    const filter = document.querySelector('#filter');
    const sort = document.querySelector('#sort');
    const render = () => {
      const query = filter.value.toLowerCase();
      const direction = sort.value;
      const visible = products
        .filter((name) => name.toLowerCase().includes(query))
        .sort((a, b) => direction === 'asc' ? a.localeCompare(b) : b.localeCompare(a));
      list.innerHTML = visible.map((name) => '<li>' + name + '</li>').join('');
    };
    filter.addEventListener('input', render);
    sort.addEventListener('change', render);
    let count = 0;
    document.querySelector('#increment').addEventListener('click', () => {
      count += 1;
      document.querySelector('#counter').textContent = 'Counter: ' + count;
    });
    document.querySelectorAll('[data-destructive]').forEach((button) => {
      button.addEventListener('click', () => {
        document.body.dataset.destructiveActionTriggered = 'true';
        button.textContent = 'Destructive action triggered';
      });
    });
    document.querySelector('#ambiguous-mutation').addEventListener('click', async () => {
      await fetch('/mutation', { method: 'POST' });
      document.querySelector('#ambiguous-mutation').textContent = 'Mutation completed';
    });
    render();
  `,
);

const childPage = pageShell(
  'Child',
  `<h1>Product details</h1>
  <p>This is one navigation level below the seed.</p>
  <section>
    <h2>Product status</h2>
    <p role="status">Available</p>
    <a href="/grandchild">Read delivery information</a>
  </section>
  <section aria-labelledby="scroll-heading">
    <h2 id="scroll-heading">Scroll inspection</h2>
    <p>Scroll down to reveal the stable marker.</p>
    <div class="scroll-course" aria-hidden="true"></div>
    <p id="scroll-marker" tabindex="-1">End-of-page marker reached</p>
    <a href="#top">Back to top</a>
  </section>`,
);

const grandchildPage = pageShell(
  'Grandchild',
  `<h1>Delivery information</h1>
  <p>This page is two navigation levels below the seed and should not be included by a depth-one crawl.</p>
  <a href="/seed">Return to seed catalog</a>`,
);

const hoverMenuPage = pageShell(
  'Hover menu',
  `<style>
    .hover-nav { min-height: 180px; display: flex; align-items: flex-start; gap: 12px; padding: 20px; background: white; border: 1px solid #dfe5ef; border-radius: 12px; }
    .hover-menu { position: relative; }
    #products-menu { width: 180px; }
    #submenu { position: absolute; top: 48px; left: 0; width: 230px; padding-top: 8px; }
    #submenu a { display: block; padding: 14px; border: 1px solid #bfc9db; border-radius: 9px; background: white; color: #27324a; box-shadow: 0 10px 25px #1720331f; text-decoration: none; }
  </style>
  <h1>Delayed hover navigation</h1>
  <p>The submenu is mounted only after the pointer rests over Products for 320 milliseconds.</p>
  <nav class="hover-nav" aria-label="Product navigation">
    <div class="hover-menu"><button id="products-menu" type="button">Products</button><div id="submenu"></div></div>
    <a href="/seed">Catalog home</a>
  </nav>`,
  `
    const menu = document.querySelector('#products-menu');
    const submenu = document.querySelector('#submenu');
    let timer;
    menu.addEventListener('mouseenter', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        submenu.innerHTML = '<a id="hover-destination" href="/hover-result">Technology details</a>';
      }, 320);
    });
  `,
);

const hoverResultPage = pageShell(
  'Hover result',
  `<h1>Hover navigation completed</h1><p role="status">The delayed submenu received the replayed click.</p><a href="/hover-menu">Return to hover menu</a>`,
);

const textSelectionPage = pageShell(
  'Text selection',
  `<style>
    #selection-copy { padding: 24px; background: white; border: 1px solid #dfe5ef; border-radius: 12px; font: 26px/1.5 ui-monospace, monospace; white-space: nowrap; user-select: text; }
    #selection-copy::selection { color: #000; background: #00ff00; }
  </style>
  <h1>Native text selection</h1>
  <p id="selection-copy">PathProof replays native selection precisely.</p>
  <p id="selection-status" role="status">No text selected</p>`,
  `
    document.addEventListener('selectionchange', () => {
      const selection = document.getSelection();
      const length = selection && !selection.isCollapsed ? selection.toString().length : 0;
      document.body.dataset.selectedTextLength = String(length);
      document.querySelector('#selection-status').textContent = length ? 'Native selection: ' + length + ' characters' : 'No text selected';
    });
  `,
);

function send(response: ServerResponse, status: number, contentType: string, body: string) {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  response.end(body);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`);

  if (url.pathname === '/health') {
    send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/mutation-state') {
    send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ mutationCount }));
    return;
  }

  if (url.pathname === '/mutation' && request.method === 'POST') {
    mutationCount += 1;
    send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/seed') {
    send(response, 200, 'text/html; charset=utf-8', seedPage);
    return;
  }

  if (url.pathname === '/child') {
    send(response, 200, 'text/html; charset=utf-8', childPage);
    return;
  }

  if (url.pathname === '/grandchild') {
    send(response, 200, 'text/html; charset=utf-8', grandchildPage);
    return;
  }

  if (url.pathname === '/hover-menu') {
    send(response, 200, 'text/html; charset=utf-8', hoverMenuPage);
    return;
  }

  if (url.pathname === '/hover-result') {
    send(response, 200, 'text/html; charset=utf-8', hoverResultPage);
    return;
  }

  if (url.pathname === '/text-selection') {
    send(response, 200, 'text/html; charset=utf-8', textSelectionPage);
    return;
  }

  send(response, 404, 'text/plain; charset=utf-8', 'Fixture route not found');
});

server.listen(port, host, () => {
  process.stdout.write(`Controlled target listening on http://${host}:${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
