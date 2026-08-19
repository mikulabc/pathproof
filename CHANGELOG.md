# Changelog

All notable changes to Pathproof are documented here. The project follows [Semantic Versioning](https://semver.org/) while allowing breaking changes in minor releases before 1.0.

## [Unreleased]

## [0.1.1] - 2026-08-19

### Security

- Replaced browser-side JavaScript construction with structured Playwright arguments for attached filenames.
- Removed modulo bias from cryptographic test-origin generation.
- Added a browser regression test for injection-shaped filenames and runtime-helper cleanup.

## [0.1.0] - 2026-08-19

### Added

- Local-first project, test, and run workspace.
- Safe smart discovery and step-by-step AI instruction planning.
- Deterministic Playwright plan replay with live Chromium frames.
- Chrome extension recording and `.pathproof.json` import.
- Pointer-path, selection, scroll, browser-state, and evidence replay.
- Run history, reports, pause/resume/stop controls, and bulk actions.
- Same-origin, private-network, mutation, and sensitive-input protections.

### Fixed

- Environment-file loading for instruction-driven discovery.
- Fail-closed behavior when AI planning is unavailable.
- Desktop/mobile navigation duplicate resolution and overlay handling.
- Accessible disambiguation for duplicate arrow controls and filters.

[Unreleased]: https://github.com/mikulabc/pathproof/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/mikulabc/pathproof/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mikulabc/pathproof/releases/tag/v0.1.0
