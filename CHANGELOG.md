# Changelog

All notable changes to this project are documented here.

## [1.0.6] - 2026-09-26

### Fixed

- International-friendly fixtures (`Friendlies`, `Club Friendlies`,
  `Youth Friendlies`, `Friendlies Women`) show up constantly in the odds
  feed but weren't selectable in the competition filter — `v1.0.4`
  hardcoded that dropdown to just TxLINE's confirmed-*scores*-coverage
  leagues (MLS/NFL/Premier League), which isn't the same universe as odds
  coverage. Added them to the hardcoded list.

## [1.0.5] - 2026-09-26

### Fixed

- Clicking the GENX-SPORTSBOOK logo did a real page navigation (`href="/"`),
  reloading the SPA and losing every fixture/odds/score received so far.
  It now just resets the competition filter to "All Competitions" in place
  (`preventDefault` + the same `selectCompetition('', ...)` path the
  dropdown's own "All Competitions" option uses), so live data already in
  memory is kept.

## [1.0.4] - 2026-09-26

### Fixed

- Web dashboard's competition filter dropdown was slow to populate: it
  derived its options by scanning the full `/fixtures` snapshot (tens of
  thousands of fixtures worldwide, thousands of distinct competition names),
  which the dropdown had to wait on before it could render at all.
  Hardcoded instead to the competitions TxLINE's own coverage schedule
  confirms are actually supported (`MLS`, `NFL`, `Premier League`) — the
  dropdown now populates instantly at page load instead of waiting on that
  fetch.

## [1.0.3] - 2026-09-24

### Added

- `scripts/check_scores_coverage.py` — watches the odds and scores streams
  concurrently and, for every fixture the odds stream marks `InRunning`,
  reports whether the scores stream is actually producing events for it.
  Distinguishes a real scores-feed outage from a fixture simply not being on
  TxLINE's scores coverage schedule (which only lists specific leagues, e.g.
  NFL/MLS/Premier League — much narrower than odds coverage).

### Fixed

- `txline-watch` and the web dashboard's per-fixture state badge could get
  stuck showing "Not Started"/`NS` for a match that had actually kicked off:
  both seeded the badge from `/fixtures/snapshot`'s `GameState` field, which
  isn't live-updated (it stayed `1`/`Not Started` for fixtures observed hours
  into play). The badge is now set only from real live score events, so it
  stays blank until one arrives instead of showing a stale, misleading status.
- `stream_odds`/`stream_scores` raised a confusing `httpx_sse.SSEError`
  ("Expected ... 'text/event-stream', got 'text/plain'") when the server
  rejected a request (e.g. no ticket held for the given fixture), burying the
  server's actual error message. Both now check the response status first and
  raise a `TxLineStreamError` carrying the real body (e.g. "Bundle access
  denied and no tickets held for fixture ...").

## [1.0.2] - 2026-09-22

### Fixed

- `v1.0.1`'s `docker.yml` still pushed a floating `:latest` tag despite
  removing the explicit `latest` entry from its tags list: `metadata-action`'s
  `type=semver` tag carries an implicit `flavor.latest=auto` that adds
  `:latest` on top whenever the ref is the highest semver version,
  independent of the tags list. Now disabled explicitly
  (`flavor: latest=false`) — a version-tag build produces only its exact
  version tag (plus the always-present `:sha-<short>`), full stop.

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
