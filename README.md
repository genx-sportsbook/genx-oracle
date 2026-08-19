# genx-oracle

Python client and server for the [TxLINE API](https://txline-docs.txodds.com) — a cryptographically-verifiable sports data feed (odds, scores, fixtures) backed by Solana on-chain subscriptions.

## Tools

| Tool | Description |
|------|-------------|
| `txline-subscribe` | One-time wallet setup — activates your on-chain subscription and stores credentials locally |
| `txline-stream` | CLI for tailing live SSE streams (odds, scores) or fetching fixture snapshots |
| `txline-watch` | Live terminal dashboard combining odds + scores streams (Rich.Live TUI) |
| `txline-server` | FastAPI SSE proxy + browser dashboard served at `/` |

## Requirements

- Python 3.11+
- A funded Solana wallet (0.02 SOL is sufficient)

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

## One-time activation

```bash
.venv/bin/python3 scripts/generate_wallet.py   # creates wallet.json
.venv/bin/python3 scripts/check_wallet.py       # verify balance
.venv/bin/txline-subscribe                      # activates subscription, writes .txline-credentials.json
```

`wallet.json` and `.txline-credentials.json` are gitignored — back them up externally.

## Usage

```bash
.venv/bin/txline-stream odds                    # live odds stream
.venv/bin/txline-stream scores --fixture-id 12345
.venv/bin/txline-stream fixtures                # fixture snapshot (REST)

.venv/bin/txline-watch                          # terminal dashboard (odds + scores)

.venv/bin/txline-server                         # browser dashboard + SSE API at http://localhost:8000
```

Open `http://localhost:8000` for the live browser dashboard.

## Docker

```bash
docker build -t txline-server .
docker run -p 8000:8000 \
  -v /path/to/.txline-credentials.json:/app/credentials/.txline-credentials.json:ro \
  txline-server
```

## Kubernetes

```bash
helm repo add txline https://genx-sportsbook.github.io/genx-oracle
helm repo update
helm install txline-server txline/txline-server \
  --set credentials.existingSecret=txline-credentials \
  --set image.tag=latest \
  --set ingress.host=txline.example.com
```

See `CLAUDE.md` for the full Helm chart reference and release process.

## Development

```bash
.venv/bin/ruff check txline/   # lint
.venv/bin/pytest               # tests
```

See `CLAUDE.md` for architecture details.
