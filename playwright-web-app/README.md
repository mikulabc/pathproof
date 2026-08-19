# Pathproof Playwright web app

This folder is the web-app distribution entry point paired with `../chrome-extension/`. It intentionally launches the existing Pathproof source at the repository root so the previously built project, API, storage, runner, tests, and interface remain one application rather than a duplicated fork.

```bash
cd playwright-web-app
npm run dev
```

Open `http://localhost:43827`, create a project for the recording's starting origin, and use **Import recording**. The server validates the portable recording, extracts deterministic user actions, restores browser/session state, and queues concurrent Chromium replays. High-volume diagnostic telemetry stays in the downloaded source recording; replay plans retain only stable actionable steps.

The portable format is documented by `recording-format.schema.json`.
