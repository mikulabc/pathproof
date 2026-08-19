# Pathproof

![Pathproof dashboard showing website projects and the guided setup workflow](docs/assets/pathproof-dashboard-hero.png)

[![CI](https://github.com/mikulabc/pathproof/actions/workflows/ci.yml/badge.svg)](https://github.com/mikulabc/pathproof/actions/workflows/ci.yml)
[![CodeQL](https://github.com/mikulabc/pathproof/actions/workflows/codeql.yml/badge.svg)](https://github.com/mikulabc/pathproof/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](package.json)

Pathproof is a local-first website regression workspace. It combines safe AI-assisted discovery with deterministic Playwright replay, live browser evidence, and high-fidelity journeys captured by a bundled Chrome extension.

## Why Pathproof?

Most browser automation tools make you choose between brittle hand-authored scripts and opaque autonomous agents. Pathproof separates setup from replay:

1. **Discover or record** a journey once.
2. **Review and save** stable, evidence-backed Pathfinder steps.
3. **Replay deterministically** without calling AI again.

Every run remains inspectable: it includes its URL, action history, expected outcome, actual outcome, screenshots, timing, and status.

## Who is this for?

- **Developers using AI coding assistants** who want to spend fewer tokens and less time repeatedly asking tools such as Claude to write and maintain Playwright tests. Discover or record a journey once, then replay the saved plan without AI.
- **Website owners and non-technical teams** who want to monitor important pages and user journeys without having to write browser-automation code.
- **UX and UI experts** who want to explore how AI interprets a site as a user—where it navigates, which controls it chooses, and how it interacts with the interface.
- **QA and test engineers** who want to turn exploratory sessions and browser recordings into reviewable, repeatable regression coverage.
- **Product and release teams** who need visual evidence that critical journeys still work before and after a release.
- **Agencies and consultants** who maintain multiple websites and want locally stored, reusable journeys with clear replay evidence for each project.

Every audience gets the same core benefit: a visual replay of the real browser journey, backed by the exact saved steps, outcomes, and evidence.

## Why choose Pathproof's AI workflow over your agentic coding agent?

An agentic coding tool is excellent when you need custom test architecture, fixtures, assertions, or CI integration. But asking it to create one browser journey can require it to read repository files, understand the existing test framework, inspect the page, generate Playwright code, run it, interpret failures, and revise the code. Pathproof gives the model a narrower job: choose the next action from a safety-filtered inventory, then save the successful journey for deterministic replay.

| For one medium, multi-step browser journey | Agentic coding agent | Pathproof AI setup |
| --- | ---: | ---: |
| Context supplied to the model | Repository, test configuration, existing tests, page details, tool output, and prior turns | User goal, current page, completed actions, and available safe controls |
| Output requested from the model | Test code, selectors, assertions, commands, explanations, and repairs | One action index, an optional value, and a short reason |
| Estimated input tokens | 40,000–100,000 | 8,000–24,000 |
| Estimated output tokens | 3,000–10,000 | 200–800 |
| Model tokens used by later deterministic replays | 0 | 0 |

### Worked example

Using the midpoint of those ranges:

- Agentic coding flow: **70,000 input + 6,500 output = 76,500 tokens**.
- Pathproof setup: **16,000 input + 500 output = 16,500 tokens**.
- Illustrative saving: **about 60,000 tokens, or 78%**, while still producing a visually replayable journey.

This is a planning estimate, not a universal benchmark or guaranteed saving. It assumes three to six coding-agent turns versus four to eight constrained Pathproof decisions. Actual usage changes with the model, tokenizer, repository size, page complexity, cache behavior, number of controls, and retries. Compare it with your own telemetry. We recommend measuring against the exact model in use.

The comparison concerns initial authoring and AI-assisted repair. Once either approach has a stable Playwright test, ordinary deterministic execution should not need additional model tokens. Choose an agentic coding tool when the deliverable must be maintainable source code with bespoke engineering; choose Pathproof when the goal is to create, inspect, and visually replay a browser journey with less model context and no hand-authored test.

## Highlights

- AI follows natural-language instructions one safe action at a time.
- Local smart discovery works without an API key for generic public-page coverage.
- Saved journeys replay with Playwright and do not call the AI planner.
- Live Chromium frames, a visible replay cursor, and click evidence make runs observable.
- The Chrome extension records navigation, pointer paths, inputs, DOM changes, network signals, screenshots, browser state, and optional compositor frames.
- Same-origin and private-network protections constrain discovery.
- Mutating requests and dangerous controls are blocked during safe discovery.
- Imported recordings can restore replay-relevant viewport, locale, timezone, cookies, and local storage.
- Projects, plans, run history, reports, and frames remain on the local machine.

## Quick start

### Requirements

- Node.js 22 or newer
- pnpm 11 or newer
- Chromium, installed automatically by Playwright when needed

### Install and run

```bash
git clone https://github.com/mikulabc/pathproof.git
cd pathproof
pnpm install
cp .env.example .env
pnpm dev
```

Open [http://localhost:43827](http://localhost:43827).

The `.env` file is local and ignored by Git. Do not commit credentials, recordings, cookie exports, or the `.data/` directory.

## AI-assisted setup

Generic local discovery does not require credentials. Natural-language, instruction-driven setup requires an OpenAI API key:

```dotenv
OPENAI_API_KEY=your_api_key
PATHPROOF_AI_MODEL=gpt-5.6-luna
```

Restart Pathproof after changing `.env`. The model only selects from a safety-filtered inventory of controls; it does not provide selectors or directly operate the browser. See [Configuration](docs/CONFIGURATION.md) for all settings.

## Chrome extension recording

1. Load `chrome-extension/` as an unpacked extension from `chrome://extensions`.
2. Pin Pathproof and open the page you want to record.
3. Select the Pathproof toolbar icon and start recording.
4. Stop and download the `.pathproof.json` recording.
5. Import it into the matching Pathproof project.
6. Review cookies and browser state before replaying against a suitable test environment.

A packaged copy is available at [`public/pathproof-chrome-extension.zip`](public/pathproof-chrome-extension.zip).

## Safety model

Safe discovery applies the following boundaries:

- Only HTTP and HTTPS targets are accepted.
- Private, loopback, link-local, and reserved targets are blocked by default.
- Crawling remains on the project origin and is depth-limited.
- POST, PUT, PATCH, and DELETE requests are blocked.
- Mutation-like and destructive controls are filtered out.
- Cross-origin popups and navigation are rejected.
- Sensitive form fields are not offered to the planner.

Imported recordings are more powerful and may replay mutations. Treat recording files as sensitive because they can contain cookies, storage, request bodies, and user-entered values. See the [Security policy](SECURITY.md).

## Architecture

```text
React workspace ──HTTP/SSE── Express API ──queue── Playwright/Chromium
       │                          │                     │
       │                          └── local JSON store  └── screenshots/stream
       │
Chrome recorder ──.pathproof.json import── deterministic replay plan
```

For component responsibilities and data flow, see [Architecture](docs/ARCHITECTURE.md).

## Development

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run the API and Vite development server |
| `pnpm build` | Type-check and build the production client |
| `pnpm start` | Start the production server from `dist/` |
| `pnpm typecheck` | Run TypeScript checks |
| `pnpm test` | Run unit tests |
| `pnpm test:e2e` | Run Playwright browser tests |
| `pnpm validate:extension` | Validate extension scripts and manifest |
| `pnpm check` | Run the complete non-browser quality suite |

The full localhost discovery suite is opt-in:

```bash
PATHPROOF_ALLOW_LOCALHOST=1 \
RUN_DISCOVERY_E2E=1 \
PATHPROOF_DISABLE_AI=1 \
pnpm test:e2e
```

## Data and privacy

- Application state is stored under `.data/` and is excluded from Git.
- `.env` is excluded; `.env.example` contains only non-secret defaults.
- Recordings and cookie exports should never be attached to public issues.
- The repository uses neutral `example.com` fixtures and contains no customer data.

## Project status

Pathproof is an early-stage, single-user, Chromium-focused local application. Hosted worker isolation, scheduling, CI test execution against user sites, and a cross-browser matrix are not yet implemented. See the [changelog](CHANGELOG.md) for release history.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), follow the [Code of Conduct](CODE_OF_CONDUCT.md), and use the provided issue and pull-request templates. General support questions belong in [GitHub Discussions](https://github.com/mikulabc/pathproof/discussions).

## License

Pathproof is available under the [MIT License](LICENSE).
