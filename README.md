# Pathproof

Pathproof is a local-first website regression workspace with two complementary capture paths. It can safely discover a public site from starting URLs, or import a high-fidelity journey from the bundled Chrome extension. Imported actions become deterministic Playwright plans; later runs retain live progress, browser frames, step evidence, changed text/URL diagnostics, and reports.

The interface includes a three-step getting-started guide and contextual `?` help beside each domain-specific action, field, metric, status, table column, and run event. Help opens in an accessible dialog (or a phone-sized bottom sheet) without discarding form drafts or stopping background runs.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:43827`. This is also the app's default port; set `PORT` to override it. Projects, test plans, run history, and frames are stored under `.data/` in this repository.

The same commands are exposed from `playwright-web-app/` for a clear two-folder distribution. Set `PATHPROOF_CONCURRENCY` from 1–16 to control simultaneous browser workers (default: 4), and `PATHPROOF_IMPORT_LIMIT` to change the default 250 MB JSON import limit.

## Record a browser journey

1. Load `chrome-extension/` as an unpacked extension from `chrome://extensions` and pin it.
2. Open the page to test and click the Pathproof toolbar icon. It opens `recorder.html`; there is no popup.
3. Choose capture settings and start. The recorder binds to that exact tab ID across navigations.
4. Stop, download the `.pathproof.json` export, open its matching Pathproof project, and choose **Import recording**.
5. Optionally supply a fixed cookie header, then run the saved test as often as needed.

The extension records user interactions plus debugger-injected raw pointer coordinates, scroll/resize signals, DOM mutations and a final DOM snapshot, Chrome debugger lifecycle/console/exception events, requests/responses, optional bodies, screenshots, performance metrics, browser settings, and optional cookies/local storage. Its compositor option records continuous `Page.startScreencast` frames into IndexedDB and merges them into the downloaded export without repeatedly rewriting them through extension storage.

During Playwright replay, a separate Chrome DevTools Protocol compositor stream feeds the live right-side viewer. Recorded pointer trails are replayed with `page.mouse`, while an in-page cursor and click ripple make the interaction visible in the stream. The expand control fills only the current browser-tab viewport and deliberately does not invoke the operating-system fullscreen API.

The first run works without credentials only for local smart discovery without AI instructions. Instruction-driven setup requires `OPENAI_API_KEY` in the repository's `.env` file (loaded automatically when Pathproof starts); `PATHPROOF_AI_MODEL` defaults to `gpt-5.6-luna`. Restart Pathproof after changing `.env`. Replays never call the planner.

## Safety boundaries

- Only HTTP(S) targets are accepted.
- Private, loopback, link-local, and reserved targets are blocked by default.
- Crawling stays on the project origin and stops after one linked level.
- Smart-discovery workers block POST/PUT/PATCH/DELETE requests, dialogs, popups, and mutation-like controls.
- Explicitly recorded journeys can replay mutating requests. Run them only against suitable test accounts/environments.
- Ambiguous buttons must be explicitly marked safe by the target or match a non-mutating disclosure/navigation pattern.
- Browser concurrency is bounded and configurable from 1–16.
- Cookie, local-storage, and network-body capture starts enabled and can be switched off before recording. Recording files may contain credentials and must be treated as secrets.

For the repository's controlled localhost fixture only, opt in with `PATHPROOF_ALLOW_LOCALHOST=1`.

## Validate

```bash
npm run typecheck
npm run build
npm test
npm run validate:extension
npx playwright test
PATHPROOF_ALLOW_LOCALHOST=1 RUN_DISCOVERY_E2E=1 PATHPROOF_DISABLE_AI=1 npm run test:e2e
```

The default browser suite skips active localhost discovery. The opt-in command exercises real discovery, depth limits, mutation blocking, saved-plan replay, live frames, bulk runs, contextual-help isolation, keyboard focus, draft preservation, and mobile containment.

## Product boundary

This is a single-user, Chromium-focused local application. Chrome does not let extensions instrument protected pages such as `chrome://` or reproduce an entire profile byte-for-byte. Pathproof restores the replay-relevant viewport, user agent, locale, timezone, color scheme, cookies, local storage, and optional fixed cookie line, but it cannot reproduce installed extensions, OS keychains, hardware, or every source of browser fingerprinting. There is not yet hosted worker isolation, scheduling, CI integration, or a cross-browser matrix.

`Page.startScreencast` exposes Chrome's compositor output. Whether that compositor is physically GPU-accelerated depends on the machine, Chrome launch mode, graphics drivers, and container configuration; Pathproof does not falsely label software-composited frames as hardware encoding.
