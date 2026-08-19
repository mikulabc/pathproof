# Architecture

Pathproof separates non-deterministic setup from deterministic replay.

## Components

### React workspace

`src/` contains the project dashboard, automated-test setup, run history, live browser panel, reports, contextual help, and responsive UI.

### Express API

`server/index.ts` exposes project, test, run, recording-import, streaming, export, and control endpoints. It also serves the production Vite build.

### Run coordinator

`server/runner.ts` owns the bounded browser queue. Discovery inventories safety-filtered controls and optionally asks the planner for one next action. Replay executes only saved steps.

### AI planner

`server/ai-planner.ts` sends the current goal, history, page identity, and candidate inventory to the configured model. The model returns an inventory index; it never supplies a selector or browser script.

### Local store

`server/store.ts` persists projects, tests, plans, and run metadata in `.data/pathproof.json`. Frames are stored under `.data/frames/`. Writes use a temporary file and atomic rename.

### Chrome extension

`chrome-extension/` captures high-fidelity browser journeys. Imports are normalized into the same replay plan used by discovered tests.

## Discovery data flow

1. Validate the target and block unsafe address ranges.
2. Launch an isolated Chromium context with mutation-blocking routes.
3. Navigate to the starting page and capture evidence.
4. Inventory visible, non-destructive controls.
5. Select a local action or ask the AI planner for one inventory index.
6. Execute, observe, and record the outcome.
7. Save a replay-ready plan only when setup completes.

## Replay data flow

1. Launch a context with the saved browser state.
2. Start the compositor stream and replay cursor.
3. Execute each saved navigation, pointer, input, scroll, or assertion step.
4. Compare expected and actual outcomes.
5. Persist evidence and finalize the run status.

## Trust boundaries

- The model can select only supplied candidates.
- Discovery traffic blocks non-read HTTP methods.
- Private and reserved network targets are rejected unless fixture access is explicitly enabled.
- Imported recordings are trusted input and can replay mutations.
- Local artifacts may contain sensitive data and are excluded from version control.
