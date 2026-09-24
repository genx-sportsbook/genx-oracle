// --- Formatting helpers ---

function formatKickoff(startTimeMs) {
  if (!startTimeMs) return '—'
  const d = new Date(startTimeMs)
  const day = d.getDate().toString().padStart(2, '0')
  const month = d.toLocaleString('en', { month: 'short' })
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  return `${day} ${month} ${hh}:${mm}`
}

// Human-readable names for SuperOddsType codes, confirmed against the live
// TxLINE feed (captured 2026-08-18): the vendor's public docs/OpenAPI spec
// don't enumerate these anywhere, so this list only covers codes actually
// observed on the wire. The convention looks like "<FAMILY>_<SCOPE>_<METRIC>"
// (e.g. "ASIANHANDICAP_PARTICIPANT_GOALS") — unrecognized codes fall back to
// a best-effort prettification instead of showing the raw code.
const MARKET_TYPE_NAMES = {
  '1X2_PARTICIPANT_RESULT': 'Match Odds',
  'ASIANHANDICAP_PARTICIPANT_GOALS': 'Asian Handicap',
  'OVERUNDER_PARTICIPANT_GOALS': 'Over/Under',
}

function prettifyMarketType(code) {
  if (!code) return 'Unknown Market'
  if (MARKET_TYPE_NAMES[code]) return MARKET_TYPE_NAMES[code]
  const stripped = code.replace(/_PARTICIPANT_[A-Z]+$/, '')
  return stripped.split('_').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ')
}

// MarketParameters is a "key=value" string (only "line=<number>" observed
// live so far, e.g. handicap/total lines including quarter-lines like
// "line=0.25"). Defensively splits on commas in case multiple params are
// ever sent together, though that hasn't been seen on the wire.
const PARAM_KEY_NAMES = {
  line: 'Line',
}

function prettifyMarketParams(raw) {
  if (!raw) return []
  return raw.split(',').map(part => {
    const [key, value] = part.split('=')
    if (value === undefined) return part
    const label = PARAM_KEY_NAMES[key] || (key.charAt(0).toUpperCase() + key.slice(1))
    return `${label} ${value}`
  })
}

// MarketPeriod is also a "key=value" string. Only "half=1" has ever been
// observed live, and TxLINE's docs/OpenAPI spec don't cover MarketPeriod at
// all (confirmed 2026-08-19 — no enum, no example, not mentioned on any
// documentation page including the odds-coverage/overview pages, which
// explicitly say to read markets off the wire rather than assume a fixed
// catalog). So "1st Half" is our best-effort reading of the "half=1"
// convention, not a vendor-confirmed fact — "half=2" is hardcoded on the
// same assumption since it hasn't appeared on the wire yet.
const HALF_NAMES = { 1: '1st Half', 2: '2nd Half' }

function prettifyMarketPeriod(raw) {
  if (!raw) return ''
  const [key, value] = raw.split('=')
  if (key === 'half' && value !== undefined) return HALF_NAMES[value] || `Half ${value}`
  if (value !== undefined) return `${key.charAt(0).toUpperCase() + key.slice(1)} ${value}`
  return raw
}

// Structured form used by the boxed chip display: one box per component
// (type / line / period) instead of a single flattened string.
function marketParts(d) {
  return {
    type: prettifyMarketType(d.SuperOddsType),
    params: prettifyMarketParams(d.MarketParameters),
    period: prettifyMarketPeriod(d.MarketPeriod),
  }
}

// Flat text form, kept for contexts that want a single plain string (e.g.
// window title, alt text) rather than the boxed chip markup.
function marketLabel(d) {
  const parts = [prettifyMarketType(d.SuperOddsType), ...prettifyMarketParams(d.MarketParameters)]
  const period = prettifyMarketPeriod(d.MarketPeriod)
  if (period) parts.push(period)
  return parts.join(' · ')
}

// parts is a marketParts() result. key is the line's lineKey; pass it only
// when the chip should open that line's history panel on click (the main
// table). History-panel chips pass no key and render as plain,
// non-interactive badges. Each component (type / line / period) renders as
// its own colored box so they read as distinct facets of the market rather
// than one run-on label.
function formatMarketChip(parts, key) {
  if (!parts || !parts.type) return '—'
  const boxes = [`<span class="chip-market-part chip-market-type">${esc(parts.type)}</span>`]
  for (const p of parts.params) {
    boxes.push(`<span class="chip-market-part chip-market-param">${esc(p)}</span>`)
  }
  if (parts.period) {
    boxes.push(`<span class="chip-market-part chip-market-period">${esc(parts.period)}</span>`)
  }
  const inner = boxes.join('')
  const cls = key ? 'chip-market-group chip-market-click' : 'chip-market-group'
  const attr = key ? ` data-line-key="${esc(key)}"` : ''
  return `<span class="${cls}"${attr}>${inner}</span>`
}

function marketSignature(d) {
  return `${d.SuperOddsType}|${d.MarketParameters || ''}|${d.MarketPeriod || ''}`
}

// --- Score / match-event decoding ---
//
// Mirrors txline/soccer.py (see that module's docstring for provenance):
// enum values and the Status Id table come from TxODDS' "Scores Product API
// documentation, Soccer v1.1" PDF, the authoritative spec for this feed (it
// isn't covered by the public txline-docs site at all). The nested score
// object's exact key casing hasn't been observed on a live event yet — no
// ticketed fixture was in-running while this was built — so `pick()` tries
// every casing variant defensively instead of assuming one.

const GAME_STATE_BY_ID = {
  1: 'Not Started', 2: '1st Half', 3: 'Half Time', 4: '2nd Half', 5: 'Finished',
  6: 'Waiting for Extra Time', 7: 'Extra Time 1st Half', 8: 'Extra Time Half Time',
  9: 'Extra Time 2nd Half', 10: 'Finished (Extra Time)', 11: 'Waiting for Penalties',
  12: 'Penalty Shootout', 13: 'Finished (Penalties)', 14: 'Interrupted',
  15: 'Abandoned', 16: 'Cancelled', 17: 'Coverage Cancelled', 18: 'Coverage Suspended',
  19: 'Postponed',
}

const GAME_STATE_BY_CODE = {
  NS: 'Not Started', H1: '1st Half', HT: 'Half Time', H2: '2nd Half', F: 'Finished',
  WET: 'Waiting for Extra Time', ET1: 'Extra Time 1st Half', HTET: 'Extra Time Half Time',
  ET2: 'Extra Time 2nd Half', FET: 'Finished (Extra Time)', WPE: 'Waiting for Penalties',
  PE: 'Penalty Shootout', FPE: 'Finished (Penalties)', I: 'Interrupted', A: 'Abandoned',
  C: 'Cancelled', TXCC: 'Coverage Cancelled', TXCS: 'Coverage Suspended', P: 'Postponed',
}

const LIVE_STATES = new Set([
  '1st Half', '2nd Half', 'Extra Time 1st Half', 'Extra Time 2nd Half', 'Penalty Shootout',
])

// Fixture.GameState (numeric, from /fixtures) or ScoreUpdate.gameState (short
// code, from live score events) — same enum, two wire representations.
function gameStateLabel(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return GAME_STATE_BY_ID[value] || `Unknown (${value})`
  return GAME_STATE_BY_CODE[value] || value
}

// Compact badge text — the full label ("Not Started", "Extra Time 1st Half")
// is too much to show inline on every single fixture row, most of which are
// just "Not Started". Shown as the badge text with the full label as a
// hover tooltip instead.
const GAME_STATE_SHORT_BY_ID = {
  1: 'NS', 2: '1H', 3: 'HT', 4: '2H', 5: 'FT',
  6: 'WAIT-ET', 7: 'ET1', 8: 'ET-HT', 9: 'ET2', 10: 'ET-FT',
  11: 'WAIT-PEN', 12: 'PEN', 13: 'PEN-FT', 14: 'INT',
  15: 'ABAN', 16: 'CANC', 17: 'CANC', 18: 'SUSP', 19: 'POSTP',
}
const GAME_STATE_SHORT_BY_CODE = {
  NS: 'NS', H1: '1H', HT: 'HT', H2: '2H', F: 'FT',
  WET: 'WAIT-ET', ET1: 'ET1', HTET: 'ET-HT', ET2: 'ET2', FET: 'ET-FT',
  WPE: 'WAIT-PEN', PE: 'PEN', FPE: 'PEN-FT', I: 'INT', A: 'ABAN',
  C: 'CANC', TXCC: 'CANC', TXCS: 'SUSP', P: 'POSTP',
}

function gameStateShort(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return GAME_STATE_SHORT_BY_ID[value] || `#${value}`
  return GAME_STATE_SHORT_BY_CODE[value] || value
}

function pick(obj, ...keys) {
  if (!obj) return undefined
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k]
  }
  return undefined
}

function periodStats(period) {
  if (!period) return { goals: 0, yellowCards: 0, redCards: 0, corners: 0 }
  return {
    goals: pick(period, 'Goals', 'goals') || 0,
    yellowCards: pick(period, 'YellowCards', 'yellowCards') || 0,
    redCards: pick(period, 'RedCards', 'redCards') || 0,
    corners: pick(period, 'Corners', 'corners') || 0,
  }
}

// Best-effort decode of the match's aggregate goals/cards/corners so far.
// Prefers scoreSoccer (per-period breakdown), falls back to the generic
// `score` field. Returns null if neither is present — per the vendor PDF,
// score-shaped fields only appear on actions that actually change the
// scoreline, not on every event.
function scoreBreakdown(d) {
  const src = d.scoreSoccer || d.score
  if (!src) return null
  const p1 = pick(src, 'Participant1', 'participant1')
  const p2 = pick(src, 'Participant2', 'participant2')
  if (p1 == null && p2 == null) return null
  const total1 = pick(p1, 'Total', 'total') || p1
  const total2 = pick(p2, 'Total', 'total') || p2
  return { participant1: periodStats(total1), participant2: periodStats(total2) }
}

// Enum labels, confirmed against the PDF's "Amend <X> Action" tables (p.4-6).
const SHOT_OUTCOME_LABELS = { OnTarget: 'On Target', OffTarget: 'Off Target', Woodwork: 'Woodwork', Blocked: 'Blocked' }
const FREE_KICK_LABELS = { Safe: 'Safe', Attack: 'Attacking', Danger: 'Dangerous', HighDanger: 'High Danger', Offside: 'Offside' }
const RED_CARD_LABELS = { StraightRed: 'Straight Red', SecondYellow: 'Second Yellow' }
const GOAL_TYPE_LABELS = { Shot: 'Shot', Head: 'Header', Own: 'Own Goal', Other: 'Other' }
const PENALTY_OUTCOME_LABELS = { Scored: 'Scored', Missed: 'Missed', Retake: 'Retake' }
const THROW_IN_LABELS = { Safe: 'Safe', Attack: 'Attacking', Danger: 'Dangerous' }
const VAR_OUTCOME_LABELS = { Stands: 'Stands', Overturned: 'Overturned' }

// Fallback for the ~30 other action types the PDF documents (Kickoff,
// Substitution, Lineup, Status, ...) that don't carry a distinctive enum
// worth a bespoke case below.
function prettifyAction(action) {
  return action
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')  // split PascalCase ("FreeKick" -> "Free Kick")
    .replace(/[_-]/g, ' ')
    .split(' ').filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

// One entry {icon, cls, text} describing a score-stream event, for the
// per-fixture match-events ticker.
function describeScoreEvent(d) {
  const action = (d.action || '').trim()
  const data = d.dataSoccer || d.data || {}
  const key = action.toLowerCase().replace(/[_\s]/g, '')

  if (key === 'goal') {
    const label = GOAL_TYPE_LABELS[pick(data, 'GoalType', 'goalType')]
    return { icon: '⚽', cls: 'evt-goal', text: 'GOAL' + (label ? ` — ${label}` : '') }
  }
  if (key === 'yellowcard') return { icon: '🟨', cls: 'evt-yellow', text: 'Yellow Card' }
  if (key === 'redcard') {
    const label = RED_CARD_LABELS[pick(data, 'Type', 'type')]
    return { icon: '🟥', cls: 'evt-red', text: 'Red Card' + (label ? ` — ${label}` : '') }
  }
  if (key === 'corner') return { icon: '🚩', cls: 'evt-corner', text: 'Corner' }
  if (key === 'shot') {
    const label = SHOT_OUTCOME_LABELS[pick(data, 'Outcome', 'outcome')]
    return { icon: '🎯', cls: 'evt-shot', text: 'Shot' + (label ? ` — ${label}` : '') }
  }
  if (key === 'freekick') {
    const label = FREE_KICK_LABELS[pick(data, 'FreeKickType', 'freeKickType')]
    return { icon: '🦵', cls: 'evt-freekick', text: 'Free Kick' + (label ? ` — ${label}` : '') }
  }
  if (key === 'throwin') {
    const label = THROW_IN_LABELS[pick(data, 'ThrowInType', 'throwInType')]
    return { icon: '↩️', cls: 'evt-throwin', text: 'Throw In' + (label ? ` — ${label}` : '') }
  }
  if (key === 'penaltyattempt') return { icon: '⚠️', cls: 'evt-penalty', text: 'Penalty Awarded' }
  if (key === 'penaltyoutcome') {
    const label = PENALTY_OUTCOME_LABELS[pick(data, 'Outcome', 'outcome')]
    return { icon: '🥅', cls: 'evt-penalty', text: 'Penalty' + (label ? ` — ${label}` : '') }
  }
  if (key === 'var') return { icon: '📺', cls: 'evt-var', text: 'VAR Review' }
  if (key === 'varend') {
    const label = VAR_OUTCOME_LABELS[pick(data, 'Outcome', 'outcome')]
    return { icon: '📺', cls: 'evt-var', text: 'VAR Decision' + (label ? ` — ${label}` : '') }
  }
  if (key === 'substitution') return { icon: '🔃', cls: 'evt-sub', text: 'Substitution' }
  if (key === 'kickoff') return { icon: '🏁', cls: 'evt-kickoff', text: 'Kickoff' }
  if (key === 'halftimefinalised') return { icon: '⏸️', cls: 'evt-status', text: 'Half Time' }
  if (key === 'gamefinalised') return { icon: '🏆', cls: 'evt-status', text: 'Full Time' }
  if (key === 'injury') return { icon: '🩹', cls: 'evt-status', text: 'Injury' }
  if (key === 'suspend') return { icon: '⏹️', cls: 'evt-status', text: 'Suspended' }
  if (key === 'standby') return { icon: '⏳', cls: 'evt-status', text: 'Standby' }
  if (!action) return { icon: '•', cls: 'evt-generic', text: 'Update' }
  return { icon: '•', cls: 'evt-generic', text: prettifyAction(action) }
}

const CHIP_HUES = 3  // cycle cyan / violet / teal per price position

// directions is an optional array parallel to prices: 'up' | 'down' | null per index
function formatPrices(prices, priceNames, directions) {
  if (!prices || prices.length === 0) return '—'
  return prices.map((p, i) => {
    const label = priceNames && priceNames[i] ? esc(priceNames[i]) : `P${i + 1}`
    const val = (p / 1000).toFixed(3)
    const dir = directions && directions[i]
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : ''
    const dirClass = dir ? ` chip-${dir}` : ''
    const hue = i % CHIP_HUES
    return `<span class="chip chip-${hue}${dirClass}"><span class="chip-label">${label}</span><span class="chip-value">${arrow}${val}</span></span>`
  }).join('')
}

// Renders the 🟨/🟥/🚩 mini-stats row under a fixture's name from a
// scoreBreakdown() result. Only shown once at least one of the three has a
// nonzero count on either side, so a scoreless/card-free match stays clean.
function statsRowHtml(stats) {
  if (!stats) return ''
  const { participant1: p1, participant2: p2 } = stats
  const parts = []
  if (p1.yellowCards || p2.yellowCards) parts.push(`<span class="stat-pill stat-yellow">🟨 ${p1.yellowCards}–${p2.yellowCards}</span>`)
  if (p1.redCards || p2.redCards) parts.push(`<span class="stat-pill stat-red">🟥 ${p1.redCards}–${p2.redCards}</span>`)
  if (p1.corners || p2.corners) parts.push(`<span class="stat-pill stat-corner">🚩 ${p1.corners}–${p2.corners}</span>`)
  return parts.length ? `<div class="fix-stats">${parts.join('')}</div>` : ''
}

function timeNow() {
  const now = new Date()
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => n.toString().padStart(2, '0'))
    .join(':')
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// --- State ---

const HISTORY_LIMIT = 50

const fixturesCache = new Map()  // fixtureId (number) -> Fixture object from /fixtures
const fixtures = new Map()       // fixtureId (number) -> { name, competition, kickoff }
const lines = new Map()          // lineKey (fixtureId::marketSig) -> line row object, one per market/line
const history = new Map()        // lineKey -> array of {ts, pricesHtml}, newest first, one market/line per entry
const scoreEvents = new Map()    // fixtureId -> array of {ts, icon, cls, text}, newest first, one per score event
let lineOrderCounter = 0
let lastFlashKey = null
let flashTimer = null
let openLineKey = null    // market history panel — set when that panel is open
let openEventsFid = null  // match-events panel — set when that panel is open
let selectedCompetition = ''  // '' = no filter, show every competition
let searchQuery = ''          // '' = no filter; lowercased substring matched against fixture name
let highlightedIndex = -1     // index into dropdownOptions(), for keyboard nav
let totalUpdateCount = 0      // odds updates received across every fixture/market, for the whole session
const competitionUpdateCounts = new Map()  // competition name -> odds updates received for that competition

const tbody = document.getElementById('rows')
const fixtureSearchInput = document.getElementById('fixtureSearch')
const competitionDropdown = document.getElementById('competitionDropdown')
const competitionTrigger = document.getElementById('competitionTrigger')
const competitionTriggerLabel = document.getElementById('competitionTriggerLabel')
const competitionList = document.getElementById('competitionList')
const fixtureCountEl = document.getElementById('fixtureCount')
const totalUpdatesEl = document.getElementById('totalUpdates')
const lastUpdateEl = document.getElementById('lastUpdate')
const clockEl = document.getElementById('clock')
const statusDotEl = document.getElementById('statusDot')
const statusTextEl = document.getElementById('statusText')
const historyPanel = document.getElementById('historyPanel')
const historyTitle = document.getElementById('historyTitle')
const historyList = document.getElementById('historyList')
const backdrop = document.getElementById('backdrop')
const historyClose = document.getElementById('historyClose')
const eventsPanel = document.getElementById('eventsPanel')
const eventsTitle = document.getElementById('eventsTitle')
const eventsList = document.getElementById('eventsList')
const eventsClose = document.getElementById('eventsClose')

function ensureFixture(fid) {
  if (!fixtures.has(fid)) {
    fixtures.set(fid, {
      name: String(fid), competition: '—', kickoff: '—', kickoffTs: null, updated: '', updatedAtMs: null, updateCount: 0, expanded: false,
      stateCode: null,   // raw GameState (int) or gameState (short code) — see gameStateShort()
      stateLabel: null,  // human label, e.g. "1st Half" — set only from a live score event; the
                         // /fixtures snapshot's GameState is stale (often stuck at "Not Started")
                         // and isn't used here, so no badge shows until real score data arrives
      isLive: false,     // true while the ball's in play (see LIVE_STATES)
      scoreText: null,   // "2 – 1", set once a score event with a decodable scoreline arrives
      stats: null,       // { participant1, participant2 } goals/cards/corners breakdown, see scoreBreakdown()
    })
  }
  return fixtures.get(fid)
}

const RECENT_UPDATE_WINDOW_MS = 30000

function isRecentlyUpdated(fx) {
  return fx.updatedAtMs != null && (Date.now() - fx.updatedAtMs) < RECENT_UPDATE_WINDOW_MS
}

function resolveNameFromCache(fid) {
  const fx = fixtures.get(fid)
  const fix = fixturesCache.get(fid)
  if (!fix) return
  if (fx.name === String(fid)) {
    fx.name = `${fix.Participant1} vs ${fix.Participant2}`
    fx.competition = fix.Competition
    fx.kickoff = formatKickoff(fix.StartTime)
    fx.kickoffTs = fix.StartTime || null
  }
}

// One line per distinct market (marketSig) per fixture, so a fixture with
// several concurrent markets (match odds, totals, handicaps, ...) keeps all
// of them visible instead of the latest one overwriting the rest.
function lineKey(fid, marketSig) {
  return `${fid}::${marketSig}`
}

function ensureLine(fid, marketSig) {
  const key = lineKey(fid, marketSig)
  if (!lines.has(key)) {
    lines.set(key, {
      key,
      fixtureId: fid,
      order: lineOrderCounter++,  // stable display order, first-seen wins
      superOddsType: null,    // raw SuperOddsType, used to pick the default line
      marketParameters: null, // raw MarketParameters ("line=-0.25"), used to sort lines numerically
      marketPeriod: null,     // raw MarketPeriod — same SuperOddsType can exist both for full match and per-half
      market: '—',            // flat text form (marketLabel)
      marketParts: null,      // boxed-chip form (marketParts) — { type, params, period }
      pricesData: null,       // { prices, priceNames }
      priceDirs: null,        // array parallel to prices.prices — cleared/replaced on the line's next update, not on a timer
      lastPrices: null,
      updated: '',
      updateCount: 0,  // odds updates received for this specific market/line
    })
  }
  return lines.get(key)
}

// The default collapsed view for a fixture: full-match Match Odds if it's
// arrived yet, otherwise whichever line was updated most recently (HH:MM:SS
// string comparison is fine here — all lines are stamped the same day).
// Same SuperOddsType can exist as both a full-match line and a per-half line
// (e.g. Match Odds vs. Match Odds 1st Half both report "1X2_PARTICIPANT_RESULT"
// but differ by MarketPeriod), so the type code alone isn't enough — the
// default must also require no period set.
const MATCH_ODDS_TYPE = '1X2_PARTICIPANT_RESULT'

function pickDefaultLine(groupLines) {
  const matchOdds = groupLines.find(l => l.superOddsType === MATCH_ODDS_TYPE && !l.marketPeriod)
  if (matchOdds) return matchOdds
  return groupLines.reduce((latest, l) => (!latest || l.updated > latest.updated) ? l : latest, null)
}

// Within one market type (e.g. every Asian Handicap line for a fixture),
// picks the representative variant shown when that type's group is
// collapsed: the full-match variant if there is one, otherwise whichever
// variant was updated most recently — same rule as pickDefaultLine, just
// scoped to lines that already share a type.
function pickDefaultVariant(typeLines) {
  const noPeriod = typeLines.filter(l => !l.marketPeriod)
  const pool = noPeriod.length ? noPeriod : typeLines
  return pool.reduce((latest, l) => (!latest || l.updated > latest.updated) ? l : latest, null)
}

// Per-(fixture, market type) expand state for the variant tree — separate
// from fx.expanded, which only controls whether the fixture shows one line
// or all of them grouped by type.
const expandedMarketGroups = new Set()

function marketGroupKey(fid, superOddsType) {
  return `${fid}::${superOddsType}`
}

// Expanded-fixture market order: Match Odds first, then Asian Handicap, then
// Over/Under, then anything unrecognized (in first-seen order). Types not
// listed here rank after all of these rather than being interleaved.
const MARKET_TYPE_ORDER = [MATCH_ODDS_TYPE, 'ASIANHANDICAP_PARTICIPANT_GOALS', 'OVERUNDER_PARTICIPANT_GOALS']

function marketTypeRank(superOddsType) {
  const idx = MARKET_TYPE_ORDER.indexOf(superOddsType)
  return idx === -1 ? MARKET_TYPE_ORDER.length : idx
}

// Pulls the numeric line value out of MarketParameters ("line=-0.25" -> -0.25)
// for numeric sorting. Only "line=<number>" has been observed on the wire;
// lines with no parseable value sort after ones that have one.
function lineParamValue(line) {
  if (!line.marketParameters) return null
  const match = line.marketParameters.match(/line=(-?[\d.]+)/)
  return match ? parseFloat(match[1]) : null
}

// Sorts an expanded fixture's markets into a consistent order: by market
// type first (see MARKET_TYPE_ORDER), then by numeric line ascending within
// a type, then full-match before per-half periods, falling back to
// first-seen order when nothing else distinguishes two lines.
function compareLines(a, b) {
  const typeDiff = marketTypeRank(a.superOddsType) - marketTypeRank(b.superOddsType)
  if (typeDiff !== 0) return typeDiff
  const va = lineParamValue(a)
  const vb = lineParamValue(b)
  if (va != null && vb != null && va !== vb) return va - vb
  if (va == null && vb != null) return 1
  if (va != null && vb == null) return -1
  const periodDiff = (a.marketPeriod || '').localeCompare(b.marketPeriod || '')
  if (periodDiff !== 0) return periodDiff
  return a.order - b.order
}

// Builds the row list for an expanded fixture: one row per market TYPE
// (Match Odds, Asian Handicap, Over/Under, ...) showing its default variant,
// with a "N variants" toggle in place of listing every line/period
// combination flat. A type with only one variant just shows that line
// directly, with no group toggle (nothing to expand). Expanding a group
// (see expandedMarketGroups) swaps its single row for all of its variant
// rows, in the same order compareLines already sorted them into.
function buildExpandedDisplayList(fid, sortedLines) {
  const result = []
  let i = 0
  while (i < sortedLines.length) {
    const type = sortedLines[i].superOddsType
    const variants = []
    while (i < sortedLines.length && sortedLines[i].superOddsType === type) {
      variants.push(sortedLines[i])
      i++
    }
    if (variants.length === 1) {
      result.push({ kind: 'single', line: variants[0] })
      continue
    }
    if (expandedMarketGroups.has(marketGroupKey(fid, type))) {
      variants.forEach((line, idx) => result.push({
        kind: 'variant', line, groupType: type, count: variants.length, isFirstOfGroup: idx === 0,
      }))
    } else {
      result.push({ kind: 'group', line: pickDefaultVariant(variants), groupType: type, count: variants.length })
    }
  }
  return result
}

function computeDirections(line, prices) {
  if (!prices) return null
  if (!line.lastPrices || line.lastPrices.length !== prices.length) return null
  return prices.map((p, i) => {
    const prev = line.lastPrices[i]
    if (p > prev) return 'up'
    if (p < prev) return 'down'
    return null
  })
}

// --- History ---

function pushHistory(key, d) {
  if (!history.has(key)) history.set(key, [])
  const arr = history.get(key)
  arr.unshift({
    ts: timeNow(),
    pricesHtml: formatPrices(d.Prices, d.PriceNames, null),
  })
  if (arr.length > HISTORY_LIMIT) arr.length = HISTORY_LIMIT
}

function renderHistoryPanel() {
  if (openLineKey == null) return
  const line = lines.get(openLineKey)
  const fx = line ? fixtures.get(line.fixtureId) : null
  historyTitle.innerHTML = line
    ? `<div class="history-title-fixture">${esc(fx ? fx.name : String(line.fixtureId))}</div>
       <div class="history-title-market">${formatMarketChip(line.marketParts)}</div>`
    : esc(String(openLineKey))
  const entries = history.get(openLineKey) || []
  historyList.innerHTML = entries.length === 0
    ? `<p class="history-empty">No odds updates yet for this market.</p>`
    : entries.map(e => `
        <div class="history-entry">
          <span class="h-time">${esc(e.ts)}</span>
          <div class="h-prices">${e.pricesHtml}</div>
        </div>
      `).join('')
}

function openMarketPanel(key) {
  closeEventsPanel()
  openLineKey = key
  historyPanel.classList.add('open')
  backdrop.classList.add('open')
  renderHistoryPanel()
}

function closeMarketPanel() {
  openLineKey = null
  historyPanel.classList.remove('open')
  backdrop.classList.remove('open')
}

function renderEventsPanel() {
  if (openEventsFid == null) return
  const fx = fixtures.get(openEventsFid)
  eventsTitle.innerHTML = fx
    ? `<div class="history-title-fixture">${esc(fx.name)}</div><div class="history-title-market">Match Events</div>`
    : 'Match Events'
  const entries = scoreEvents.get(openEventsFid) || []
  eventsList.innerHTML = entries.length === 0
    ? `<p class="history-empty">No match events yet.</p>`
    : entries.map(e => `
        <div class="history-entry event-entry ${esc(e.cls)}">
          <span class="h-time">${esc(e.ts)}</span>
          <span class="event-icon">${e.icon}</span>
          <span class="event-text">${esc(e.text)}</span>
        </div>
      `).join('')
}

function openEventsPanel(fid) {
  closeMarketPanel()
  openEventsFid = fid
  eventsPanel.classList.add('open')
  backdrop.classList.add('open')
  renderEventsPanel()
}

function closeEventsPanel() {
  openEventsFid = null
  eventsPanel.classList.remove('open')
  backdrop.classList.remove('open')
}

function closeAllPanels() {
  closeMarketPanel()
  closeEventsPanel()
}

// --- Flash ---

function flash(key) {
  clearTimeout(flashTimer)
  lastFlashKey = key
  flashTimer = setTimeout(() => { lastFlashKey = null; render() }, 800)
}

// --- Render ---

function render() {
  const groups = new Map()  // fixtureId -> array of line rows
  for (const line of lines.values()) {
    if (selectedCompetition) {
      const fx = fixtures.get(line.fixtureId)
      if (!fx || fx.competition !== selectedCompetition) continue
    }
    if (searchQuery) {
      const fx = fixtures.get(line.fixtureId)
      if (!fx || !fx.name.toLowerCase().includes(searchQuery)) continue
    }
    if (!groups.has(line.fixtureId)) groups.set(line.fixtureId, [])
    groups.get(line.fixtureId).push(line)
  }
  // Soonest kickoff first; fixtures whose kickoff hasn't resolved yet (name
  // lookup still pending) sort to the bottom rather than jumbling in at "0".
  const fixtureIds = [...groups.keys()].sort((a, b) => {
    const tsA = fixtures.get(a)?.kickoffTs
    const tsB = fixtures.get(b)?.kickoffTs
    if (tsA == null && tsB == null) return a - b
    if (tsA == null) return 1
    if (tsB == null) return -1
    return tsA - tsB
  })

  let html = ''
  for (const fid of fixtureIds) {
    const fx = fixtures.get(fid) || { name: String(fid), competition: '—', kickoff: '—', kickoffTs: null, updated: '', updatedAtMs: null, updateCount: 0, expanded: false }
    const groupLines = groups.get(fid).sort(compareLines)
    const isExpandable = groupLines.length > 1
    const marketTypeCount = new Set(groupLines.map(l => l.superOddsType)).size
    const displayItems = fx.expanded
      ? buildExpandedDisplayList(fid, groupLines)
      : [{ kind: 'single', line: pickDefaultLine(groupLines) }].filter(item => item.line)

    displayItems.forEach((item, i) => {
      const line = item.line
      const isFirst = i === 0
      html += `<tr class="${line.key === lastFlashKey ? 'flash' : ''}${isFirst ? ' group-start' : ''}">`
      if (isFirst) {
        const expandHint = isExpandable
          ? `<div class="fix-expand">${fx.expanded ? '▲ Hide markets' : `▼ ${marketTypeCount} market type${marketTypeCount === 1 ? '' : 's'}`}</div>`
          : ''
        const stateShort = fx.stateCode != null ? gameStateShort(fx.stateCode) : null
        const stateHtml = stateShort
          ? `<span class="state-badge${fx.isLive ? ' state-live' : ''}" title="${esc(fx.stateLabel || stateShort)}">${fx.isLive ? '<span class="state-dot"></span>' : ''}${esc(stateShort)}</span>`
          : ''
        const scoreHtml = fx.scoreText ? `<span class="fix-score">${esc(fx.scoreText)}</span>` : ''
        const statsHtml = statsRowHtml(fx.stats)
        const eventCount = (scoreEvents.get(fid) || []).length
        const eventsLinkHtml = eventCount
          ? `<div class="fix-events-link" data-events-fid="${fid}">📋 ${eventCount} match event${eventCount === 1 ? '' : 's'}</div>`
          : ''
        html += `
          <td class="fix-name${isExpandable ? ' expandable' : ''}" rowspan="${displayItems.length}" data-fid="${fid}">
            <div class="fix-title">${isRecentlyUpdated(fx) ? '<span class="recent-dot" title="Updated in the last 30s"></span>' : ''}${stateHtml}${esc(fx.name)}${scoreHtml}</div>
            <div class="fix-sub">${esc(fx.kickoff)} · ${fx.competition && fx.competition !== '—' ? `<span class="competition-link" data-competition="${esc(fx.competition)}">${esc(fx.competition)}</span>` : esc(fx.competition)}</div>
            ${statsHtml}
            ${eventsLinkHtml}
            <div class="fix-updated">${fx.updated ? `Updated ${esc(fx.updated)} · ${fx.updateCount} update${fx.updateCount === 1 ? '' : 's'}` : ''}</div>
            ${expandHint}
          </td>`
      }
      // A market-type group collapses to its default variant with a "N
      // variants" toggle; expanding it swaps that one row for all of its
      // variant rows (marked .market-variant for the tree-guide styling),
      // with the toggle moving to "Hide variants" on the first of them.
      const groupToggleHtml = item.kind === 'group'
        ? `<div class="market-group-toggle" data-group-fid="${fid}" data-group-type="${esc(item.groupType)}">▼ ${item.count} variants</div>`
        : (item.kind === 'variant' && item.isFirstOfGroup)
          ? `<div class="market-group-toggle" data-group-fid="${fid}" data-group-type="${esc(item.groupType)}">▲ Hide variants</div>`
          : ''
      html += `
          <td class="market${item.kind === 'variant' ? ' market-variant' : ''}">
            ${formatMarketChip(line.marketParts, line.key)}
            ${groupToggleHtml}
            <div class="market-updated">${line.updated ? `Updated ${esc(line.updated)} · ${line.updateCount} update${line.updateCount === 1 ? '' : 's'}` : ''}</div>
          </td>
          <td class="prices">${line.pricesData ? formatPrices(line.pricesData.prices, line.pricesData.priceNames, line.priceDirs) : '—'}</td>
        </tr>`
    })
  }
  tbody.innerHTML = html
  fixtureCountEl.textContent = `${fixtureIds.length} fixture${fixtureIds.length === 1 ? '' : 's'}`
}

function tickClock() {
  clockEl.textContent = timeNow()
}

function setStatus(s) {
  statusDotEl.className = 'dot' + (s === 'live' ? ' live' : s === 'reconnecting' ? ' reconnecting' : '')
  statusTextEl.textContent = s
}

// --- Competition dropdown (custom listbox — see style.css comment for why
// this isn't a native <select>: Chrome/Safari on macOS hand the open list
// off to the OS to render, so CSS can't theme it there; only Firefox does.
// This hand-built version themes identically in every browser.) ---

function populateCompetitionFilter(competitionNames) {
  ;[...competitionNames].sort().forEach((name, i) => {
    const li = document.createElement('li')
    li.className = 'dropdown-option'
    li.setAttribute('role', 'option')
    li.setAttribute('aria-selected', 'false')
    li.dataset.value = name
    li.id = `compopt-${i}`
    li.textContent = name
    competitionList.appendChild(li)
  })
}

function dropdownOptions() {
  return [...competitionList.querySelectorAll('.dropdown-option')]
}

function setHighlighted(idx) {
  const opts = dropdownOptions()
  opts.forEach(o => o.classList.remove('highlighted'))
  if (idx < 0 || idx >= opts.length) {
    highlightedIndex = -1
    return
  }
  highlightedIndex = idx
  const opt = opts[idx]
  opt.classList.add('highlighted')
  competitionTrigger.setAttribute('aria-activedescendant', opt.id)
  opt.scrollIntoView({ block: 'nearest' })
}

function openDropdown() {
  competitionDropdown.dataset.open = 'true'
  competitionList.hidden = false
  competitionTrigger.setAttribute('aria-expanded', 'true')
  const opts = dropdownOptions()
  const currentIdx = opts.findIndex(o => o.dataset.value === selectedCompetition)
  setHighlighted(currentIdx >= 0 ? currentIdx : 0)
}

function closeDropdown() {
  competitionDropdown.dataset.open = 'false'
  competitionList.hidden = true
  competitionTrigger.setAttribute('aria-expanded', 'false')
  competitionTrigger.removeAttribute('aria-activedescendant')
  highlightedIndex = -1
}

function toggleDropdown() {
  if (competitionList.hidden) openDropdown()
  else closeDropdown()
}

// Shows the count for the selected competition, or the session total when
// "All Competitions" is selected. Called on every odds update and whenever
// the dropdown selection changes, so it always reflects the current filter.
function updateTotalUpdatesDisplay() {
  const count = selectedCompetition
    ? (competitionUpdateCounts.get(selectedCompetition) || 0)
    : totalUpdateCount
  totalUpdatesEl.textContent = `${count} update${count === 1 ? '' : 's'}`
}

function selectCompetition(value, label) {
  selectedCompetition = value
  competitionTriggerLabel.textContent = label
  dropdownOptions().forEach(o => {
    const isSelected = o.dataset.value === value
    o.classList.toggle('selected', isSelected)
    o.setAttribute('aria-selected', String(isSelected))
  })
  updateTotalUpdatesDisplay()
  render()
}

// --- Startup ---

async function init() {
  // Fetch fixture names for name resolution (non-fatal on failure)
  try {
    const res = await fetch('/fixtures')
    if (res.ok) {
      const fixtures = await res.json()
      const competitions = new Set()
      for (const f of fixtures) {
        fixturesCache.set(f.FixtureId, f)
        if (f.Competition) competitions.add(f.Competition)
      }
      populateCompetitionFilter(competitions)
    }
  } catch (err) {
    console.warn('Fixture fetch failed, running with raw IDs:', err)
  }

  // Odds stream
  const oddsEs = new EventSource('/odds/stream')
  oddsEs.addEventListener('open', () => setStatus('live'))
  oddsEs.addEventListener('error', () => setStatus('reconnecting'))
  oddsEs.addEventListener('odds', (e) => {
    try {
      const d = JSON.parse(e.data)
      const fid = d.FixtureId
      const fx = ensureFixture(fid)
      resolveNameFromCache(fid)

      const marketSig = marketSignature(d)
      const line = ensureLine(fid, marketSig)
      const directions = computeDirections(line, d.Prices)

      line.superOddsType = d.SuperOddsType
      line.marketParameters = d.MarketParameters || null
      line.marketPeriod = d.MarketPeriod || null
      line.market = marketLabel(d)
      line.marketParts = marketParts(d)
      line.pricesData = { prices: d.Prices || null, priceNames: d.PriceNames || null }
      line.priceDirs = directions
      line.lastPrices = d.Prices ? [...d.Prices] : null
      line.updated = timeNow()
      line.updateCount++  // odds updates received for this specific market/line
      fx.updated = line.updated  // fixture-level "last updated across any of its lines"
      fx.updatedAtMs = Date.now()
      fx.updateCount++  // total odds updates received for this fixture, across all its markets
      totalUpdateCount++  // total odds updates received across every fixture/market
      if (fx.competition && fx.competition !== '—') {
        competitionUpdateCounts.set(fx.competition, (competitionUpdateCounts.get(fx.competition) || 0) + 1)
      }
      lastUpdateEl.textContent = `Updated ${fx.updated}`  // global "last update across the whole feed"
      updateTotalUpdatesDisplay()

      pushHistory(line.key, d)
      flash(line.key)
      render()
      if (openLineKey === line.key) renderHistoryPanel()
    } catch (err) {
      console.warn('Bad odds event:', err)
    }
  })

  // Scores stream — separate connection from odds (different endpoint,
  // fires far less often: only on actual score/match events, not every tick).
  const scoresEs = new EventSource('/scores/stream')
  scoresEs.addEventListener('scores', (e) => {
    try {
      const d = JSON.parse(e.data)
      const fid = d.fixtureId
      const fx = ensureFixture(fid)
      resolveNameFromCache(fid)

      const label = gameStateLabel(d.gameState)
      if (label) {
        fx.stateCode = d.gameState
        fx.stateLabel = label
        fx.isLive = LIVE_STATES.has(label)
      }

      const breakdown = scoreBreakdown(d)
      if (breakdown) {
        fx.stats = breakdown
        fx.scoreText = `${breakdown.participant1.goals} – ${breakdown.participant2.goals}`
      }

      if (!scoreEvents.has(fid)) scoreEvents.set(fid, [])
      const arr = scoreEvents.get(fid)
      arr.unshift({ ts: timeNow(), ...describeScoreEvent(d) })
      if (arr.length > HISTORY_LIMIT) arr.length = HISTORY_LIMIT

      fx.updatedAtMs = Date.now()
      render()
      if (openEventsFid === fid) renderEventsPanel()
    } catch (err) {
      console.warn('Bad scores event:', err)
    }
  })

  tickClock()
  // Re-render every second too, not just on odds events, so a fixture's
  // recent-update dot (see RECENT_UPDATE_WINDOW_MS) disappears on its own
  // once the window elapses instead of waiting for the next update.
  setInterval(() => { tickClock(); render() }, 1000)

  fixtureSearchInput.addEventListener('input', () => {
    searchQuery = fixtureSearchInput.value.trim().toLowerCase()
    render()
  })

  competitionTrigger.addEventListener('click', () => toggleDropdown())

  competitionList.addEventListener('click', (e) => {
    const opt = e.target.closest('.dropdown-option')
    if (!opt) return
    selectCompetition(opt.dataset.value, opt.textContent)
    closeDropdown()
  })

  // Keep keyboard highlight in sync with the mouse so hovering doesn't leave
  // two different rows looking highlighted at once (the hovered one via CSS
  // :hover, and a stale keyboard-set one via the .highlighted class).
  competitionList.addEventListener('mouseover', (e) => {
    const opt = e.target.closest('.dropdown-option')
    if (!opt) return
    const idx = dropdownOptions().indexOf(opt)
    if (idx >= 0) setHighlighted(idx)
  })

  competitionTrigger.addEventListener('keydown', (e) => {
    const opts = dropdownOptions()
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (competitionList.hidden) { openDropdown(); return }
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setHighlighted(Math.max(0, Math.min(opts.length - 1, highlightedIndex + delta)))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (competitionList.hidden) { openDropdown(); return }
      const opt = opts[highlightedIndex]
      if (opt) selectCompetition(opt.dataset.value, opt.textContent)
      closeDropdown()
    } else if (e.key === 'Escape') {
      closeDropdown()
    }
  })

  document.addEventListener('click', (e) => {
    if (!competitionDropdown.contains(e.target)) closeDropdown()
  })

  historyClose.addEventListener('click', closeMarketPanel)
  eventsClose.addEventListener('click', closeEventsPanel)
  backdrop.addEventListener('click', closeAllPanels)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllPanels()
  })
  tbody.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip-market-click')
    if (chip) {
      openMarketPanel(chip.dataset.lineKey)
      return
    }
    const eventsLink = e.target.closest('.fix-events-link')
    if (eventsLink) {
      e.stopPropagation()
      openEventsPanel(Number(eventsLink.dataset.eventsFid))
      return
    }
    const groupToggle = e.target.closest('.market-group-toggle')
    if (groupToggle) {
      e.stopPropagation()
      const key = marketGroupKey(Number(groupToggle.dataset.groupFid), groupToggle.dataset.groupType)
      if (expandedMarketGroups.has(key)) expandedMarketGroups.delete(key)
      else expandedMarketGroups.add(key)
      render()
      return
    }
    const competitionLink = e.target.closest('.competition-link')
    if (competitionLink) {
      e.stopPropagation()
      selectCompetition(competitionLink.dataset.competition, competitionLink.dataset.competition)
      return
    }
    const nameCell = e.target.closest('.fix-name')
    if (!nameCell) return
    const fx = fixtures.get(Number(nameCell.dataset.fid))
    if (!fx) return
    fx.expanded = !fx.expanded
    render()
  })
}

init()
