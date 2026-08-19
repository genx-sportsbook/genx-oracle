# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Python client for the [TxLINE API](https://txline-docs.txodds.com) — a cryptographically-verifiable sports data feed (odds, scores, fixtures) backed by Solana on-chain subscriptions.

## Environment

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

## Commands

```bash
# Lint
.venv/bin/ruff check txline/

# Tests
.venv/bin/pytest
.venv/bin/pytest tests/test_auth.py::test_build_message   # single test

# CLI
.venv/bin/txline-subscribe          # one-time wallet → credentials setup
.venv/bin/txline-stream odds        # tail live SSE stream
.venv/bin/txline-stream scores --fixture-id 12345
.venv/bin/txline-stream fixtures    # REST snapshot

# Watch dashboard (live odds + scores combined, Rich.Live TUI)
.venv/bin/txline-watch                           # all fixtures
.venv/bin/txline-watch --fixture-id 12345        # filter to one fixture

# Server (FastAPI SSE proxy + web dashboard at http://localhost:8000)
.venv/bin/txline-server                          # start on 0.0.0.0:8000
.venv/bin/txline-server --port 9000              # custom port

# Wallet helpers (scripts run directly, not entry points)
.venv/bin/python3 scripts/generate_wallet.py
.venv/bin/python3 scripts/check_wallet.py
```

## Architecture

The credential lifecycle is:
1. **One-time setup** — `txline-subscribe` generates a guest JWT, submits a zero-cost on-chain `subscribe` transaction, NaCl-signs the activation message with the wallet key, and POSTs to `/api/token/activate`. The resulting `{jwt, api_token}` pair is persisted to `.txline-credentials.json`. The guest JWT is short-lived (~30 days) and is reused as the bearer token on every subsequent request — there's no refresh flow, so re-run `txline-subscribe` once it expires (this is why data can silently stop flowing after a while, with no other symptom).
2. **Runtime** — `TxLineClient` loads credentials from that file and uses `Authorization: Bearer {jwt}` + `X-Api-Token: {api_token}` on every request.

**SSE streaming** (`txline/streams/`) uses `httpx-sse`. Both streams (`/api/odds/stream`, `/api/scores/stream`) support optional `fixtureId` filtering and reconnect via `Last-Event-ID`. Streams yield typed Pydantic models (`OddsUpdate | Heartbeat`, `ScoreUpdate | Heartbeat`).

**`txline-watch`** (`txline/cli/watch.py`) fans odds and scores SSE streams into an `asyncio.Queue`, applies events to a `dict[int, FixtureState]` via `apply_event`, and renders a `Rich.Live` table via `build_table`. Fixture names are resolved lazily from a one-shot REST snapshot fetch. Prices are stored as integers and displayed as decimal odds (÷ 1000).

**`txline-server`** (`txline/api/server.py`) is a FastAPI app that proxies the three TxLINE endpoints (`GET /fixtures`, `GET /odds/stream`, `GET /scores/stream`) and serves a vanilla JS browser dashboard at `/`. Static files live in `txline/api/static/` (`index.html`, `app.js`, `style.css`), mounted via `StaticFiles`; a `no_cache` middleware forces `Cache-Control: no-store` on every response so edits to `app.js`/`style.css` are always picked up without a hard refresh (`StaticFiles` alone only sends `Last-Modified`/`ETag`, which Chrome/Safari can serve stale from heuristic cache). CORS is open (`allow_origins=["*"]`).

The browser dashboard fetches `/fixtures` on load for name/competition resolution, then opens two `EventSource` connections and updates a live table, one row-group per fixture:

- **State model** — two `Map`s: `fixtures` (per-fixture metadata: name, competition, kickoff, last-updated, update count) and `lines` (per-market data, keyed by `` `${fixtureId}::${marketSignature}` ``, where `marketSignature` is `` `${SuperOddsType}|${MarketParameters}|${MarketPeriod}` ``). This split lets one fixture track several concurrent markets (Match Odds, Asian Handicap, Over/Under, 1st/2nd half variants) without one overwriting another.
- **Market names** — `SuperOddsType`/`MarketParameters`/`MarketPeriod` are raw vendor codes (e.g. `1X2_PARTICIPANT_RESULT`, `line=-0.25`, `half=1`) not enumerated in TxLINE's docs or OpenAPI spec; `app.js` hardcodes a lookup (`MARKET_TYPE_NAMES`, `PARAM_KEY_NAMES`, `HALF_NAMES`) built from values captured off the live feed, rendering e.g. `Asian Handicap · Line -0.25 · 1st Half`.
- **Default line per fixture** — collapsed rows show one market via `pickDefaultLine()`, which prefers the full-match Match Odds line (`SuperOddsType === '1X2_PARTICIPANT_RESULT' && !marketPeriod`) over any other line, falling back to the most recently updated one. Matching only on `SuperOddsType` without excluding `marketPeriod` was a real bug — it let a 1st-half Match Odds line win over the full-match one. Clicking a fixture expands it to show every tracked line.
- **Tick highlighting** — a line's up/down flash (`chip-up`/`chip-down`) persists until that line's *next* update recomputes direction; there is no timeout that clears it early.
- **Competition filter** — a hand-built dropdown (`div`/`ul[role=listbox]`, not a native `<select>`) in the top bar filters the table to one competition. It's custom-built rather than a native `<select>` because Chrome/Safari on macOS hand the open `<select>` list off to the OS to render, so it can't be themed there (only Firefox lets CSS reach it); the custom version renders identically everywhere and supports click, keyboard (arrows/Enter/Escape), and click-outside-to-close.
- **History panel** — scoped per-market (keyed by the same `lineKey`, not per-fixture), opened by clicking a market chip in the main table.

SSE events use named types (`event: odds`, `event: scores`, `event: heartbeat`).

**The on-chain `subscribe` transaction** (`txline/subscription.py`) is hand-built with `solders` rather than through `anchorpy`'s `Program`/`Idl` — the deployed program (`txodds/tx-oracle`) publishes a modern-format Anchor IDL that `anchorpy` (0.21.0, latest on PyPI) cannot parse, and the program has no on-chain IDL account at all, so there is nothing to fetch at runtime regardless. The account list and PDA seeds (`pricing_matrix`, `token_treasury_v2`) are read straight from `programs/txoracle/src/instructions/subscriptions/subscribe.rs` in that repo. TxL is a Token-2022 mint, so ATAs must be derived with `TOKEN_2022_PROGRAM_ID`, not the legacy Token program.

## Key constants (txline/subscription.py)

| Name | Value |
|------|-------|
| Program ID | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` |
| TxL mint | `Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL` (Token-2022) |
| Free tier (delayed) | `SERVICE_LEVEL_FREE_DELAYED = 1` |
| Free tier (real-time) | `SERVICE_LEVEL_FREE_REALTIME = 12` |

## Container image

The `Dockerfile` at the repo root builds `txline-server` as a non-root container image.

```bash
# Build locally
docker build -t txline-server .

# Run with credentials mounted
docker run -p 8000:8000 \
  -v /path/to/.txline-credentials.json:/app/credentials/.txline-credentials.json:ro \
  txline-server
```

GitHub Actions (`.github/workflows/docker.yml`) builds and pushes to `ghcr.io/teamzuzu/txline-server`. It's `workflow_dispatch`-only (no automatic push trigger) — run it manually from the Actions tab, from the branch or tag you want to build:
- Run from `main` → `:latest`
- Run from a `v*.*.*` tag → versioned tag + `:latest`

## Kubernetes / Helm

The Helm chart lives at `helm/txline-server/`. Credentials are injected as a Kubernetes Secret.

Two ways to supply credentials:

**Option A — inline JSON (chart creates the Secret):**
```bash
helm install txline-server helm/txline-server/ \
  --set credentials.json="$(base64 -w0 .txline-credentials.json)" \
  --set image.repository=ghcr.io/teamzuzu/txline-server \
  --set image.tag=latest \
  --set ingress.host=txline.example.com
```

**Option B — pre-existing Secret (no JSON at install time):**
```bash
# Create the secret once (outside Helm lifecycle):
kubectl create secret generic txline-credentials \
  --from-file=.txline-credentials.json

# Install without passing the JSON:
helm install txline-server helm/txline-server/ \
  --set credentials.existingSecret=txline-credentials \
  --set image.repository=ghcr.io/teamzuzu/txline-server \
  --set image.tag=latest \
  --set ingress.host=txline.example.com
```

**Upgrade:**
```bash
# Option A:
helm upgrade txline-server helm/txline-server/ \
  --set credentials.json="$(base64 -w0 .txline-credentials.json)" \
  --set image.tag=<new-version>

# Option B (secret already exists — no credentials needed):
helm upgrade txline-server helm/txline-server/ \
  --set credentials.existingSecret=txline-credentials \
  --set image.tag=<new-version>
```

### Published Helm repository

Once GitHub Pages is enabled (Settings → Pages → `gh-pages` / root), the chart is available at:

```bash
helm repo add txline https://teamzuzu.github.io/genx-oracle
helm repo update
helm install txline-server txline/txline-server \
  --set credentials.existingSecret=txline-credentials \
  --set image.tag=1.0.0 \
  --set ingress.host=txline.example.com
```

### Release checklist (before tagging)

1. Bump `version` and `appVersion` in `helm/txline-server/Chart.yaml` to match the release (e.g. `1.0.0`)
2. Commit: `git commit -m "chore: bump chart to 1.0.0"`
3. Tag: `git tag v1.0.0 && git push origin v1.0.0`
4. Both `docker.yml` and `helm-release.yml` are `workflow_dispatch`-only — trigger each manually from the Actions tab (choose the `v1.0.0` tag as the ref to run from)

Key values to override: `image.repository`, `image.tag`, `ingress.host`, `ingress.className`.

## Sensitive files (all gitignored)

- `wallet.json` — Solana keypair; back up externally
- `.txline-credentials.json` — live JWT + API token
- `txline/idl/` — cached on-chain IDL


### Git Commits
- Always author and commit as the developer.
- Never include Claude or AI attribution in commit messages.
- Do not use `Co-Authored-By` tags or any other form of AI credit.

