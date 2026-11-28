#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

if [[ ${1:-} == --help ]]; then
    cat <<'USAGE'
Usage: scripts/run-local.sh

Run the TxLINE ingester and dashboard together. Ctrl+C stops both.
Optional environment variables:
  TXLINE_DATABASE     Shared database path (default: ./txline.sqlite3)
  TXLINE_CREDENTIALS  Credentials path (default: ./.txline-credentials.json)
  TXLINE_HOST         Web bind address (default: 127.0.0.1)
  TXLINE_PORT         Web port (default: 8000)
  TXLINE_PYTHON       Python interpreter (default: ./.venv/bin/python)
Relative paths are resolved from the repository root.
USAGE
    exit 0
fi
if (( $# )); then
    printf 'Use %s --help for options.\n' "$0" >&2
    exit 2
fi

python_bin=${TXLINE_PYTHON:-./.venv/bin/python}
database=${TXLINE_DATABASE:-./txline.sqlite3}
credentials=${TXLINE_CREDENTIALS:-./.txline-credentials.json}
host=${TXLINE_HOST:-0.0.0.0}
port=${TXLINE_PORT:-8000}

if ! command -v -- "$python_bin" >/dev/null; then
    printf 'Python not found at %s. Create .venv and install the project first.\n' "$python_bin" >&2
    exit 1
fi
if [[ ! -r $credentials ]]; then
    printf 'Credentials are missing or unreadable at %s. Run txline-subscribe first.\n' "$credentials" >&2
    exit 1
fi

children=()
cleanup() {
    if (( ${#children[@]} )); then
        kill "${children[@]}" 2>/dev/null || true
        wait "${children[@]}" 2>/dev/null || true
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Starting the ingester and dashboard with %s.\n' "$database"
printf 'Open http://%s:%s after the first "Refreshed N fixtures" message. Ctrl+C stops both.\n' "$host" "$port"

"$python_bin" -m txline.ingest --credentials "$credentials" --database "$database" &
children+=("$!")
"$python_bin" -m txline.api.server --database "$database" --host "$host" --port "$port" &
children+=("$!")

status=0
wait -n || status=$?
printf 'A local process exited (status %s). Stopping the other process.\n' "$status" >&2
exit "$status"
