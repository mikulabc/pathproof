# Configuration

Pathproof loads `.env` from the repository root when the server starts. Exported shell variables take precedence.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `43827` | HTTP port |
| `OPENAI_API_KEY` | unset | Enables instruction-driven AI setup |
| `PATHPROOF_AI_MODEL` | `gpt-5.6-luna` | Planner model |
| `PATHPROOF_DISABLE_AI` | `0` | Forces local/no-AI behavior when set to `1` |
| `PATHPROOF_CONCURRENCY` | `4` | Browser worker limit, clamped from 1–16 |
| `PATHPROOF_MAX_PAGES` | `20` | Maximum pages considered during local discovery |
| `PATHPROOF_NAVIGATION_TIMEOUT_MS` | `20000` | Navigation timeout in milliseconds |
| `PATHPROOF_STREAM_FPS` | `60` | Maximum live frame publication rate |
| `PATHPROOF_IMPORT_LIMIT` | `250mb` | JSON limit for recording imports |
| `PATHPROOF_HEADFUL` | `0` | Launches visible discovery browsers when set to `1` |
| `PATHPROOF_IGNORE_HTTPS_ERRORS` | `0` | Ignores certificate errors when set to `1` |
| `PATHPROOF_ALLOW_LOCALHOST` | `0` | Allows controlled localhost fixtures when set to `1` |

## Production

```bash
npm ci
npm run build
NODE_ENV=production npm start
```

Pathproof is currently designed as a single-user local application. Do not expose it directly to an untrusted network without adding authentication, TLS termination, worker isolation, and appropriate storage controls.
