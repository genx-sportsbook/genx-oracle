# genx-oracle

Python client and server for the [TxLINE API](https://txline-docs.txodds.com) — a cryptographically-verifiable sports data feed (odds, scores, fixtures) backed by Solana on-chain subscriptions.

## Tools

| Tool | Description |
|------|-------------|
| `txline-subscribe` | One-time wallet setup — activates your on-chain subscription and stores credentials locally |
| `txline-stream` | CLI for tailing live SSE streams (odds, scores) or fetching fixture snapshots |
| `txline-watch` | Live terminal dashboard combining odds + scores streams (Rich.Live TUI) |
| `txline-ingest` | Collects TxLINE fixtures, odds, and scores into SQLite |
| `txline-server` | Serves the browser dashboard and streams stored data from SQLite |

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

./scripts/run-local.sh                        # start the ingester and dashboard together
```

Open `http://127.0.0.1:8000` after the ingester logs `Refreshed N fixtures`.
Press Ctrl+C to stop both processes. Use `TXLINE_PORT=8001 ./scripts/run-local.sh`
if port 8000 is occupied, or run the script with `--help` for other settings.

To run the processes independently, open separate terminals and use
`.venv/bin/python -m txline.ingest` and `.venv/bin/python -m txline.api.server`.
Both commands default to `txline.sqlite3` in the working directory. Set `TXLINE_DATABASE` or
pass `--database` to both commands to use another path. The web server needs
access to the database directory and can start before the first fixture snapshot.
The ingester loads recent Match Odds history for fixtures on the board in the
background, so previous quotes can appear while it waits for new live updates.

On an upstream HTTP 401, `txline-ingest` refreshes the guest JWT in memory
and retries with the existing API token. The credentials mount stays read-only.
If TxLINE rejects the API token or the subscription expires, check the
subscription and update the credentials Secret with a valid pair.
[TxLINE authentication troubleshooting](https://txline-docs.txodds.com/documentation/examples/troubleshooting)

## Docker

```bash
docker build -t txline-server .
docker volume create txline-data
docker run -d --name txline-ingest --entrypoint txline-ingest \
  -v txline-data:/app/data \
  -v /path/to/.txline-credentials.json:/app/credentials/.txline-credentials.json:ro \
  txline-server --credentials /app/credentials/.txline-credentials.json
docker run --rm -p 8000:8000 -v txline-data:/app/data txline-server
```

## Kubernetes

```bash
helm repo add txline https://genx-sportsbook.github.io/genx-oracle
helm repo update
helm install txline-server txline/txline-server \
  --set credentials.existingSecret=txline-credentials \
  --set ingress.host=txline.example.com
```

The ingester-enabled chart runs one web container and one ingester in the same pod, with a
shared persistent volume. The cluster needs a default storage class or an existing
claim set through `persistence.existingClaim`. Set `persistence.enabled=false`
for a temporary database whose contents last for the life of the pod. Use
storage that supports local SQLite WAL file locking. If installing this chart
from source before its first release, set `image.tag` to an image built from
the same source revision.

See `CLAUDE.md` for the Helm chart reference and release process.

## Development

```bash
.venv/bin/ruff check txline/   # lint
.venv/bin/pytest               # tests
```

See `CLAUDE.md` for architecture details.
