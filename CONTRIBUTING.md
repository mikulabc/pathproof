# Contributing to Pathproof

Thank you for helping improve Pathproof.

## Before opening an issue

- Search existing issues and discussions.
- Use Discussions for setup questions and design exploration.
- Never attach real recordings, `.env` files, cookie exports, customer URLs, credentials, or `.data/` contents.
- Report security vulnerabilities privately using the process in `SECURITY.md`.

## Development setup

```bash
git clone https://github.com/mikulabc/pathproof.git
cd pathproof
npm install
cp .env.example .env
npm run dev
```

AI credentials are optional for most development. Tests must not call paid APIs or depend on external customer sites.

## Pull requests

1. Create a focused branch from `main`.
2. Add or update tests for behavior changes.
3. Keep fixtures synthetic and deterministic.
4. Run `npm run check` and `npm run test:e2e`.
5. Update documentation and `CHANGELOG.md` when behavior changes.
6. Complete the pull-request checklist.

Prefer small changes with a clear problem statement. Preserve the safety boundary: discovery must fail closed when it cannot fulfill instructions safely or completely.

## Coding guidelines

- Use TypeScript for server and application code.
- Prefer accessible roles and names over brittle CSS paths.
- Keep deterministic replay independent from AI.
- Avoid adding dependencies when platform APIs are sufficient.
- Do not weaken private-network, mutation, or sensitive-field protections.
- Write user-facing errors that explain the next action.

By participating, you agree to follow the project Code of Conduct.
