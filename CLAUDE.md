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
.venv/bin/txline-ingest                          # ingest into ./txline.sqlite3
.venv/bin/txline-server                          # separate terminal, start on 0.0.0.0:8000
.venv/bin/txline-server --port 9000              # custom port

# Wallet helpers (scripts run directly, not entry points)
.venv/bin/python3 scripts/generate_wallet.py
.venv/bin/python3 scripts/check_wallet.py
```

## Architecture

The credential lifecycle is:
1. **One-time setup** — `txline-subscribe` generates a guest JWT, submits a zero-cost on-chain `subscribe` transaction, NaCl-signs the activation message with the wallet key, and POSTs to `/api/token/activate`. The resulting `{jwt, api_token}` pair is persisted to `.txline-credentials.json`.
2. **Runtime** — `TxLineClient` loads credentials from that file and uses `Authorization: Bearer {jwt}` + `X-Api-Token: {api_token}` on every request. On upstream HTTP 401, `txline-ingest` checks for a replacement credentials file or obtains a fresh guest JWT from `/auth/guest/start` and retries once with the existing API token. Fixture refresh and both streams share this recovery. The fresh JWT is held in process memory.

**SSE streaming** (`txline/streams/`) uses `httpx-sse`. Both streams (`/api/odds/stream`, `/api/scores/stream`) support optional `fixtureId` filtering and reconnect via `Last-Event-ID`. Streams yield typed Pydantic models (`OddsUpdate | Heartbeat`, `ScoreUpdate | Heartbeat`).

**`txline-watch`** (`txline/cli/watch.py`) fans odds and scores SSE streams into an `asyncio.Queue`, applies events to a `dict[int, FixtureState]` via `apply_event`, and renders a `Rich.Live` table via `build_table`. Fixture names are resolved lazily from a one-shot REST snapshot fetch. Prices are stored as integers and displayed as decimal odds (÷ 1000).

**`txline-ingest`** (`txline/ingest.py`) owns the TxLINE credentials, the fixture
refresh, and one SSE connection per feed. It verifies the Premier League
competition ID (8) before storing the serialized fixture snapshot, and filters
stored odds to Match Odds and their available periods. A separate background
task fetches the per-fixture odds archive for recently started fixtures and
those kicking off in the next 72 hours. Archived and live messages deduplicate
by fixture and message ID, and the dashboard orders quotes by source time.
On an upstream outage the
ingester retains the previous snapshot and retries.

**`FeedStore`** (`txline/store.py`) uses SQLite WAL on a shared filesystem volume.
The ingester is the writer and the web process opens read-only connections. The
serialized fixture response and membership are updated in one transaction.
History is pruned to the latest 50 updates per odds market or score feed per
fixture, with the latest quote and scoreline retained through updates without values. Fixture refresh removes history for fixtures outside the cached window.

**`txline-server`** (`txline/api/server.py`) serves the dashboard at `/`, reads
the serialized snapshot for `/fixtures`, and tails the SQLite event log through
`/odds/stream` and `/scores/stream`. The browser replays retained history on
load and resumes from its SSE `Last-Event-ID` on reconnect. The web server
opens no TxLINE connections and can serve retained data during an upstream
outage. All Kubernetes probes point to `/healthz`, which only checks the local
web process and reports whether the stored fixture snapshot is fresh.

The browser dashboard tracks fixture metadata and live score state by fixture
ID, and odds by fixture, market type, parameters, and normalized period. It
builds its odds history, price trends, and match events from the SSE replay
and live updates. Vendor prices are integers and are displayed divided by 1000.
The dashboard assets live under `txline/api/static/`, and responses use
`Cache-Control: no-store` so asset edits take effect on the next page load.

**The on-chain `subscribe` transaction** (`txline/subscription.py`) is hand-built with `solders` rather than through `anchorpy`'s `Program`/`Idl` — the deployed program (`txodds/tx-oracle`) publishes a modern-format Anchor IDL that `anchorpy` (0.21.0, latest on PyPI) cannot parse, and the program has no on-chain IDL account at all, so there is nothing to fetch at runtime regardless. The account list and PDA seeds (`pricing_matrix`, `token_treasury_v2`) are read straight from `programs/txoracle/src/instructions/subscriptions/subscribe.rs` in that repo. TxL is a Token-2022 mint, so ATAs must be derived with `TOKEN_2022_PROGRAM_ID`, not the legacy Token program.

## Key constants (txline/subscription.py)

| Name | Value |
|------|-------|
| Program ID | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` |
| TxL mint | `Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL` (Token-2022) |
| Free tier (delayed) | `SERVICE_LEVEL_FREE_DELAYED = 1` |
| Free tier (real-time) | `SERVICE_LEVEL_FREE_REALTIME = 12` |

## Container image

The `Dockerfile` builds one non-root image with both executables. Its default
entry point is `txline-server`. The ingester uses `--entrypoint txline-ingest`
with Docker or a command override in Kubernetes. Both processes use a shared
`/app/data/txline.sqlite3` by default. See the Docker example in `README.md`.

GitHub Actions (`.github/workflows/docker.yml`) builds and pushes to `ghcr.io/genx-sportsbook/txline-server`. It's `workflow_dispatch`-only (no automatic push trigger) — run it manually from the Actions tab, from the branch or tag you want to build:
- Run from a `v*.*.*` tag → that version only (e.g. `:1.0.0`) — this is the tag the Helm chart deploys, see below
- Run from `main` → `:edge` (a moving convenience tag — never deploy this via Helm; the chart's `appVersion` default is what makes real releases reproducible)
- Every run also gets an immutable `:sha-<short-sha>` tag regardless of ref

Earlier versions of this workflow also pushed `:latest` on every run, including tagged releases, and the Helm chart's default `image.repository` had `:latest` baked directly into it. Combined, `helm upgrade --set image.tag=<new-version>` silently rendered a broken `repo:latest:<new-version>` image reference instead of the version being deployed — that's why a "release" often didn't actually change what was running. Both are fixed now: `image.repository` is a bare repo with no tag, and `image.tag` defaults to the chart's own `appVersion` (see `deployment.yaml`) — so bumping `appVersion` and deploying that chart version is enough on its own, no `--set image.tag` needed.

## Kubernetes / Helm

The Helm chart lives at `helm/txline-server/`. The ingester receives the
credentials Secret read-only. One pod runs both processes with a shared
ReadWriteOnce volume. Use `persistence.existingClaim` for an existing claim,
`persistence.storageClass` to choose the storage class, or
`persistence.enabled=false` to use an ephemeral volume. `image.tag` defaults to the chart's `appVersion`, so the examples below only pass it to pin something different from the chart being installed.

`resources` defaults to a 512Mi request / 1Gi limit. Don't lower the limit below ~700Mi: a fixture refresh transiently holds ~68MB of JSON and ~230k Pydantic models, peaking near 600MB, and a limit under that peak OOM-kills the pod mid-refresh in a restart loop.

Probes use a `startupProbe` (3s period, 20 failures = up to 60s to come up) to cover slow starts, with liveness and readiness both on `/healthz`.

Two ways to supply credentials:

**Option A — inline JSON (chart creates the Secret):**
```bash
helm install txline-server helm/txline-server/ \
  --set credentials.json="$(base64 -w0 .txline-credentials.json)" \
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
  --set ingress.host=txline.example.com
```

**Upgrade** (from a local checkout that has pulled the new release commit — its `appVersion` is what gets deployed):
```bash
# Option A:
helm upgrade txline-server helm/txline-server/ \
  --set credentials.json="$(base64 -w0 .txline-credentials.json)"

# Option B (secret already exists — no credentials needed):
helm upgrade txline-server helm/txline-server/ \
  --set credentials.existingSecret=txline-credentials
```

### Published Helm repository

Once GitHub Pages is enabled (Settings → Pages → `gh-pages` / root), the chart is available at:

```bash
helm repo add txline https://genx-sportsbook.github.io/genx-oracle
helm repo update
helm install txline-server txline/txline-server \
  --version 1.0.0 \
  --set credentials.existingSecret=txline-credentials \
  --set ingress.host=txline.example.com
```

**Upgrade to a new release** — this is the actual "release a version, it gets deployed" step: publish the new chart version (release checklist below), then
```bash
helm repo update
helm upgrade txline-server txline/txline-server \
  --version 1.1.0 \
  --set credentials.existingSecret=txline-credentials
```
`--version` selects the chart, whose `appVersion` (bumped in lockstep, see the release checklist) picks the matching image tag automatically — no `--set image.tag` needed, and no risk of the old `:latest` double-tag bug.

`.github/workflows/helm-pages.yml` (`workflow_dispatch`-only) publishes it: `helm package`s `helm/txline-server`, then pushes the `.tgz` straight onto the `gh-pages` branch alongside a merged `index.yaml` — GitHub Pages serves the chart file directly from that branch. There's no `helm/chart-releaser-action` and no GitHub Release involved; this project doesn't use GitHub Releases.

### Release checklist

1. Bump `version` and `appVersion` in `helm/txline-server/Chart.yaml` together, to the same new version (e.g. `1.1.0`) — `version` is the chart's own version, `appVersion` is the image tag it deploys; keeping them equal is what makes `--version X.Y.Z` alone enough to deploy image `X.Y.Z`
2. Update `CHANGELOG.md`
3. Commit: `git commit -m "chore: bump chart to 1.1.0"`
4. Tag: `git tag v1.1.0 && git push origin v1.1.0`
5. Trigger `docker.yml` and `helm-pages.yml` manually from the Actions tab (both `workflow_dispatch`-only) — for `docker.yml`, choose the `v1.1.0` tag as the ref to run from
6. Deploy it: `helm repo update && helm upgrade txline-server txline/txline-server --version 1.1.0 ...` (see above) — this is the step that was broken before; confirm the rollout actually picked up the new image with `kubectl rollout status deployment/txline-server` and `kubectl get pods -o jsonpath='{.items[*].spec.containers[*].image}'`

Key values to override: `ingress.host`, `ingress.className`, `credentials.json`/`credentials.existingSecret`. `image.repository`/`image.tag` are there for pinning something other than the chart's own version, not needed for a normal release.

## Sensitive files (all gitignored)

- `wallet.json` — Solana keypair; back up externally
- `.txline-credentials.json` — live JWT + API token
- `txline/idl/` — cached on-chain IDL


### Git Commits
- Always author and commit as the developer.
- Never include Claude or AI attribution in commit messages.
- Do not use `Co-Authored-By` tags or any other form of AI credit.

