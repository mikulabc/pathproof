# Security policy

## Supported versions

Pathproof is pre-1.0. Security fixes are applied to the latest release on `main`.

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities or include live credentials, recordings, cookies, customer data, or private URLs in any report.

Use GitHub private vulnerability reporting from the repository's **Security** tab. Include the affected version, the security boundary that was bypassed, minimal synthetic reproduction steps, expected and actual behavior, and potential impact.

You should receive an acknowledgment within seven days. Please allow time for validation and a coordinated fix before public disclosure.

## Sensitive artifacts

Treat the following as secrets even when Pathproof stores them locally:

- `.env` and API keys;
- `.pathproof.json` recordings;
- cookie and local-storage exports;
- captured request or response bodies;
- screenshots and DOM snapshots;
- `.data/` application state and reports.

The project intentionally excludes these paths from Git. Review every attachment before sharing it.
