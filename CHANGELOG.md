# Changelog

All notable changes to this project are documented here.

## [1.0.1] - 2026-09-22

### Fixed

- Helm releases silently not deploying: `values.yaml`'s default
  `image.repository` had `:latest` baked into it, and the deployment
  template appended another `:{{ .Values.image.tag }}` on top, so
  `--set image.tag=<new-version>` rendered a broken double-tagged image
  reference instead of the version being deployed.
  - `image.repository` is now a bare repo; `image.tag` defaults to the
    chart's own `appVersion`, so bumping `appVersion` and deploying that
    chart version is enough on its own — no `--set image.tag` needed.
  - `docker.yml` no longer pushes a floating `:latest` at all (it was
    landing even on tagged-release builds): a version tag gets only its
    exact version, `main` gets `:edge` (explicitly not for production),
    and every build gets an immutable `:sha-<short>` tag.

## [1.0.0] - 2026-09-22

First full release. `v0.0.1` was an early placeholder tag from the very
start of the project; this is the first version with the complete feature
set below.

### Added

- **On-chain subscription** — `txline-subscribe` end-to-end: guest JWT,
  zero-cost `subscribe` transaction (Token-2022 ATAs, hand-built via
  `solders`), wallet-signed activation, credential persistence.
- **Streaming client** — `txline-stream` for tailing the live odds/scores
  SSE streams or pulling a REST fixtures snapshot; automatic reconnect via
  `Last-Event-ID`.
- **`txline-watch`** — a `Rich.Live` terminal dashboard combining odds and
  scores into one table: decimal prices, labeled price/percentage columns,
  kickoff-sorted fixtures, update-flash highlighting, and (new this
  release) a live match `State`, `Cards/Corners`, and `Last Event` column.
- **`txline-server` web dashboard** — a FastAPI SSE proxy serving a
  GENX-SPORTSBOOK-branded browser dashboard:
  - Live odds table grouped by fixture, sorted by soonest kickoff.
  - Boxed, color-coded market chips (type / line / period as separate
    facets) with a price-history side panel per market.
  - Competition filter (custom-themed listbox, not a native `<select>`),
    fixture search, per-competition and session-wide update counters, and
    a "recently updated" indicator.
  - **Live scores** (new this release): a per-fixture state badge
    (`NS`/`1H`/`HT`/`2H`/`FT`/…, decoded from TxODDS' Status Id table),
    inline score, a goals/cards/corners summary, and a match-events panel
    describing goals, cards, VAR reviews, shots, and more in plain
    English — all decoded from the previously-unused `/scores/stream`.
  - **Market grouping** (new this release): a market type with several
    variants (e.g. every Asian Handicap line) now collapses to one
    representative row with a "N variants" toggle instead of listing every
    line flat.
- **Deployment** — a non-root Docker image, a Helm chart (inline-secret or
  pre-existing-secret credential injection), and a published Helm
  repository via GitHub Pages.

### Fixed

- Fixture name/competition resolution for matches that started "yesterday"
  in UTC (common for US-evening kickoffs, e.g. MLS): `/fixtures/snapshot`
  buckets by scheduled UTC day and silently drops still-live matches once
  the day rolls over, showing them as a bare numeric ID. The dashboard now
  fetches and merges yesterday's bucket too.
- `txline-subscribe`'s activation flow (Token-2022 ATA derivation, IDL
  parsing, activation message format).
- Stale cached `app.js`/`style.css` being served after an edit (missing
  `Cache-Control`); the fixture list now sorts by soonest kickoff instead
  of most-recently-added.
