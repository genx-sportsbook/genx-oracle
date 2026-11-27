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
  // American football (NFL) uses its own codes, confirmed 2026-09-27
  // (Buccaneers vs Vikings) — without these, the generic suffix-stripping
  // fallback below renders them as "Moneyline" (fine), "Eurohandicap" and
  // "Overunder" (not fine).
  'MONEYLINE_PARTICIPANT_RESULT': 'Moneyline',
  'EUROHANDICAP_PARTICIPANT_POINTS': 'Handicap',
  'OVERUNDER_PARTICIPANT_POINTS': 'Over/Under',
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

// The feed uses "fulltime" for full-match markets. Older records can omit it.
function normalizeMarketPeriod(period) {
  return period === 'fulltime' ? '' : (period || '')
}

const HALF_NAMES = { 1: '1st Half', 2: '2nd Half' }

function prettifyMarketPeriod(period) {
  const raw = normalizeMarketPeriod(period)
  if (!raw) return ''
  const [key, value] = raw.split('=')
  if (key === 'half' && value !== undefined) return HALF_NAMES[value] || `Half ${value}`
  if (value !== undefined) return `${key.charAt(0).toUpperCase() + key.slice(1)} ${value}`
  return raw
}

function marketParts(d) {
  return {
    type: prettifyMarketType(d.SuperOddsType),
    params: prettifyMarketParams(d.MarketParameters),
    period: prettifyMarketPeriod(d.MarketPeriod),
  }
}

function marketLabel(d) {
  const parts = [prettifyMarketType(d.SuperOddsType), ...prettifyMarketParams(d.MarketParameters)]
  const period = prettifyMarketPeriod(d.MarketPeriod)
  if (period) parts.push(period)
  return parts.join(' · ')
}

function marketSignature(d) {
  return `${d.SuperOddsType}|${d.MarketParameters || ''}|${normalizeMarketPeriod(d.MarketPeriod)}`
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
  '1st Half', 'Half Time', '2nd Half', 'Waiting for Extra Time', 'Extra Time 1st Half',
  'Extra Time Half Time', 'Extra Time 2nd Half', 'Waiting for Penalties', 'Penalty Shootout',
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
    return { icon: { OnTarget: '🎯', Woodwork: '💥', Blocked: '🛡️' }[pick(data, 'Outcome', 'outcome')] || '👟', cls: 'evt-shot', text: 'Shot' + (label ? ` — ${label}` : '') }
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
    return { icon: { Scored: '⚽', Missed: '❌', Retake: '🔁' }[pick(data, 'Outcome', 'outcome')] || '🥅', cls: 'evt-penalty', text: 'Penalty' + (label ? ` — ${label}` : '') }
  }
  if (key === 'var') return { icon: '📺', cls: 'evt-var', text: 'VAR Review' }
  if (key === 'varend') {
    const label = VAR_OUTCOME_LABELS[pick(data, 'Outcome', 'outcome')]
    return { icon: { Stands: '✅', Overturned: '↩️' }[pick(data, 'Outcome', 'outcome')] || '📺', cls: 'evt-var', text: 'VAR Decision' + (label ? ` — ${label}` : '') }
  }
  if (key === 'substitution') return { icon: '🔃', cls: 'evt-sub', text: 'Substitution' }
  if (key === 'kickoff') return { icon: '🏁', cls: 'evt-kickoff', text: 'Kickoff' }
  if (key === 'halftimefinalised') return { icon: '⏸️', cls: 'evt-status', text: 'Half Time' }
  if (key === 'gamefinalised') return { icon: '🏆', cls: 'evt-status', text: 'Full Time' }
  if (key === 'injury') return { icon: '🩹', cls: 'evt-status', text: 'Injury' }
  if (key === 'suspend') return { icon: '⏹️', cls: 'evt-status', text: 'Suspended' }
  if (key === 'standby') return { icon: '⏳', cls: 'evt-status', text: 'Standby' }
  const icon = {
    lineup: '📋', offside: '🚫', foul: '🗣️', save: '🧤', goalkick: '🥅',
    possession: '⚽', attack: '⚡', dangerousattack: '🔥', clearance: '🛡️',
    restart: '▶️', resume: '▶️', status: '📡', clock: '⏱️',
  }[key]
  return { icon: icon || '📍', cls: 'evt-generic', text: action ? prettifyAction(action) : 'Update' }
}

const CHIP_HUES = 3  // cycle cyan / violet / teal per price position

// directions is an optional array parallel to prices: 'up' | 'down' | null per index
function priceLabel(name, index, fixtureId) {
  const fixture = fixturesCache.get(fixtureId)
  const selectionLabels = {
    part1: fixture?.Participant1 || 'Participant 1',
    part2: fixture?.Participant2 || 'Participant 2',
    draw: 'Draw',
    over: 'Over',
    under: 'Under',
  }
  return Object.hasOwn(selectionLabels, name) ? selectionLabels[name] : (name || `P${index + 1}`)
}

function formatPrices(prices, priceNames, directions, fixtureId) {
  if (!prices || prices.length === 0) return '—'
  return prices.map((p, i) => {
    const label = esc(priceLabel(priceNames?.[i], i, fixtureId))
    const val = (p / 1000).toFixed(3)
    const dir = directions && directions[i]
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : ''
    const dirClass = dir ? ` chip-${dir}` : ''
    const hue = i % CHIP_HUES
    return `<span class="chip chip-${hue}${dirClass}"><span class="chip-label">${label}</span><span class="chip-value">${arrow}${val}</span></span>`
  }).join('')
}

function fixtureEventsHtml(fid) {
  const entries = scoreEvents.get(fid) || []
  if (entries.length === 0) return '<p class="fixture-empty">No match events yet.</p>'
  const items = entries.map(e => {
    const [title, detail] = e.text.split(' — ', 2)
    return `
      <li class="fix-event-entry ${esc(e.cls)}">
        <span class="event-icon" aria-hidden="true">${esc(e.icon)}</span>
        <span class="event-text"><strong>${esc(title)}</strong>${detail ? `<small>${esc(detail)}</small>` : ''}</span>
        ${e.score ? `<span class="event-score">${esc(e.score)}</span>` : ''}
        <time class="event-time" title="Update received">${esc(e.ts)}</time>
      </li>`
  }).join('')
  return `<ol class="fix-recent-events">${items}</ol>`
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
const history = new Map()        // lineKey -> array of {ts, prices, priceNames}, newest first, one market/line per entry
const scoreEvents = new Map()    // fixtureId -> array of {ts, icon, cls, text}, newest first, one per score event
let lineOrderCounter = 0
let lastFlashKey = null
let flashTimer = null
let openLineKey = null    // market history panel — set when that panel is open
let searchQuery = ''          // '' = no filter; lowercased substring matched against fixture name
let totalUpdateCount = 0      // odds updates received across every fixture/market, for the whole session

const fixtureCards = document.getElementById('fixtureCards')
let fixtureSnapshotLoaded = false
let lastFixtureHtml = ''
const FIXTURE_PAGE_SIZE = 9
let fixtureDisplayLimit = FIXTURE_PAGE_SIZE
const fixtureSearchInput = document.getElementById('fixtureSearch')
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

function ensureFixture(fid) {
  if (!fixtures.has(fid)) {
    fixtures.set(fid, {
      name: String(fid), competition: '—', kickoff: '—', kickoffTs: null, updated: '', updatedAtMs: null, updateCount: 0, expanded: false,
      eventsExpanded: false,
      scoreState: null,
      oddsState: null,
      inRunning: false,
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
  const fix = fixturesCache.get(fid)
  if (!fix) return
  const fx = ensureFixture(fid)
  fx.name = `${fix.Participant1} vs ${fix.Participant2}`
  fx.competition = fix.Competition
  fx.kickoff = formatKickoff(fix.StartTime)
  fx.kickoffTs = fix.StartTime || null
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
      market: '—',            // market label for the history drawer
      marketParts: null,      // card labels — { type, params, period }
      pricesData: null,       // { prices, priceNames }
      priceDirs: null,        // array parallel to prices.prices — cleared/replaced on the line's next update, not on a timer
      lastPrices: null,
      updated: '',
      updateCount: 0,  // odds updates received for this specific market/line
    })
  }
  return lines.get(key)
}

// The default collapsed view for a fixture: its "main line" market if it's
// arrived yet, otherwise whichever line was updated most recently (HH:MM:SS
// string comparison is fine here — all lines are stamped the same day).
// Same SuperOddsType can exist as both a full-match line and a per-half line
// (e.g. Match Odds vs. Match Odds 1st Half both report "1X2_PARTICIPANT_RESULT"
// but differ by MarketPeriod), so the type code alone isn't enough — the
// default must also require no period set. Soccer's main line is Match Odds;
// American football's is Moneyline — same role, different vendor code.
const MATCH_ODDS_TYPE = '1X2_PARTICIPANT_RESULT'
const PRIMARY_MARKET_TYPES = new Set([MATCH_ODDS_TYPE, 'MONEYLINE_PARTICIPANT_RESULT'])

function pickDefaultLine(groupLines) {
  const mainLine = groupLines.find(l => PRIMARY_MARKET_TYPES.has(l.superOddsType) && !l.marketPeriod)
  if (mainLine) return mainLine
  return groupLines.reduce((latest, l) => (!latest || l.updated > latest.updated) ? l : latest, null)
}

// Expanded-fixture market order: Match Odds/Moneyline first, then handicap,
// then Over/Under, then anything unrecognized (in first-seen order). Types
// not listed here rank after all of these rather than being interleaved.
const MARKET_TYPE_ORDER = [
  MATCH_ODDS_TYPE, 'ASIANHANDICAP_PARTICIPANT_GOALS', 'OVERUNDER_PARTICIPANT_GOALS',
  'MONEYLINE_PARTICIPANT_RESULT', 'EUROHANDICAP_PARTICIPANT_POINTS', 'OVERUNDER_PARTICIPANT_POINTS',
]

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
  // Every type MARKET_TYPE_ORDER doesn't know about shares that same
  // fallback rank, so on sports like NFL where none of the observed codes
  // are in the list, two *different* unrecognized types (e.g. a handicap
  // line and an over/under line) would otherwise tie here and fall through
  // to the numeric-line comparison below, interleaving them by line value
  // instead of grouping same-type lines together. Group by the raw type
  // string first so that can't happen.
  if (a.superOddsType !== b.superOddsType) return a.superOddsType.localeCompare(b.superOddsType)
  const va = lineParamValue(a)
  const vb = lineParamValue(b)
  if (va != null && vb != null && va !== vb) return va - vb
  if (va == null && vb != null) return 1
  if (va != null && vb == null) return -1
  const periodDiff = (a.marketPeriod || '').localeCompare(b.marketPeriod || '')
  if (periodDiff !== 0) return periodDiff
  return a.order - b.order
}

function updateLinePrices(line, prices, priceNames) {
  if (!prices?.length) return
  line.priceDirs = computeDirections(line, prices)
  line.pricesData = { prices, priceNames: priceNames || null }
  line.lastPrices = [...prices]
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
    prices: d.Prices,
    priceNames: d.PriceNames,
  })
  if (arr.length > HISTORY_LIMIT) arr.length = HISTORY_LIMIT
}

const MARKET_TREND_UPDATES = 12
const ODDS_SERIES_COLORS = ['#38bdf8', '#a5a6f6', '#2dd4bf', '#fbbf24', '#fb7185']

function historyPriceSeries(entries, fixtureId) {
  const selections = new Map()
  const directions = entries.map(() => [])
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    entry.prices?.forEach((price, position) => {
      if (!Number.isFinite(price) || price <= 0) return
      const name = entry.priceNames?.[position]
      const key = name || position
      if (!selections.has(key)) {
        selections.set(key, { name, label: priceLabel(name, position, fixtureId), points: [] })
      }
      const { points } = selections.get(key)
      const previous = points.at(-1)?.price
      directions[index][position] = previous == null || previous === price
        ? null : price > previous ? 'up' : 'down'
      points.push({ index: entries.length - 1 - index, price })
    })
  }
  return { series: [...selections.values()], directions }
}

function oddsChartLegend(series) {
  const items = series.map(({ label }, index) =>
    `<li><span style="--series-color:${ODDS_SERIES_COLORS[index % ODDS_SERIES_COLORS.length]}"></span>${esc(label)}</li>`
  ).join('')
  return `<ul class="odds-chart-legend">${items}</ul>`
}

function oddsChartHtml(series, entries) {
  if (series.length === 0) return ''
  return `
    <figure class="odds-chart">
      <figcaption>Decimal odds by update</figcaption>
      ${oddsChartLegend(series)}
      <canvas width="840" height="302" role="img"
        aria-label="Decimal odds by update, oldest to newest. The price history below lists the exact values."></canvas>
      <div class="odds-chart-axis"><span>${esc(entries.at(-1).ts)}</span>${entries.length > 1
        ? `<span>${esc(entries[0].ts)}</span>` : ''}</div>
    </figure>`
}

function drawOddsChart(canvas, series, entryCount, compact = false) {
  const ctx = canvas?.getContext('2d')
  if (!ctx) return
  const prices = series.flatMap(selection => selection.points.map(point => point.price))
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const padding = Math.max(10, (max - min) * 0.1)
  const low = Math.max(0, min - padding)
  const high = max + padding
  const left = compact ? 10 : 90
  const right = canvas.width - (compact ? 10 : 16)
  const top = compact ? 10 : 20
  const bottom = canvas.height - top
  const x = index => entryCount === 1 ? (left + right) / 2
    : left + index * (right - left) / (entryCount - 1)
  const y = price => bottom - (price - low) * (bottom - top) / (high - low)

  ctx.font = '24px system-ui'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#a7b3c5'
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)'
  ctx.lineWidth = 1
  const gridDivisions = compact ? 2 : 4
  for (let tick = 0; tick <= gridDivisions; tick++) {
    const price = low + (high - low) * tick / gridDivisions
    const row = y(price)
    if (!compact) ctx.fillText((price / 1000).toFixed(3), 0, row, left - 10)
    ctx.beginPath()
    ctx.moveTo(left, row)
    ctx.lineTo(right, row)
    ctx.stroke()
  }

  series.forEach(({ points }, index) => {
    ctx.strokeStyle = ctx.fillStyle = ODDS_SERIES_COLORS[index % ODDS_SERIES_COLORS.length]
    ctx.lineWidth = compact ? 3 : 4
    ctx.lineJoin = 'round'
    ctx.beginPath()
    points.forEach((point, position) => {
      const method = points[position - 1]?.index === point.index - 1 ? 'lineTo' : 'moveTo'
      ctx[method](x(point.index), y(point.price))
    })
    ctx.stroke()
    for (const point of points) {
      ctx.beginPath()
      ctx.arc(x(point.index), y(point.price), compact ? 3 : 5, 0, 2 * Math.PI)
      ctx.fill()
    }
  })
}

function renderHistoryPanel() {
  if (openLineKey == null) return
  const line = lines.get(openLineKey)
  const fx = line ? fixtures.get(line.fixtureId) : null
  const fixtureName = fx?.name || String(line?.fixtureId ?? openLineKey)
  historyTitle.innerHTML = `
    <p class="odds-history-label">Odds history</p>
    <h2 class="history-title-fixture">${esc(fixtureName)}</h2>
    ${line?.market && line.market !== '—' ? `<p class="history-title-market">${esc(line.market)}</p>` : ''}`
  const entries = history.get(openLineKey) || []
  const { series, directions } = historyPriceSeries(entries, line?.fixtureId)
  historyList.innerHTML = entries.length === 0
    ? '<p class="fixture-empty">No odds updates yet for this market.</p>'
    : `${oddsChartHtml(series, entries)}<ol class="odds-history-cards">${entries.map((entry, index) => `
        <li class="odds-history-card${index === 0 ? ' odds-history-card-latest' : ''}">
          <div class="odds-history-card-header">
            <time>${esc(entry.ts)}</time>
            ${index === 0 ? '<span>Latest update</span>' : ''}
          </div>
          ${entry.prices?.length
            ? `<div class="fixture-prices">${formatPrices(entry.prices, entry.priceNames, directions[index], line?.fixtureId)}</div>`
            : '<p class="odds-waiting">No prices in this update</p>'}
        </li>`).join('')}</ol>`
  drawOddsChart(historyList.querySelector?.('canvas'), series, entries.length)
}

function openMarketPanel(key) {
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

// --- Flash ---

function flash(key) {
  clearTimeout(flashTimer)
  lastFlashKey = key
  flashTimer = setTimeout(() => { lastFlashKey = null; render() }, 800)
}

// --- Render ---

// Keep recently started fixtures visible while the feed catches up.
const MATCH_STATUS_GRACE_MS = 150 * 60 * 1000
const MAX_LIVE_AGE_MS = 6 * 60 * 60 * 1000
const UPCOMING_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
const homeTeamOrder = new Intl.Collator('en', { sensitivity: 'base' })

function homeTeamName(fid) {
  const fixture = fixturesCache.get(fid)
  return (fixture?.Participant1IsHome === false ? fixture.Participant2 : fixture?.Participant1) || ''
}

function fixtureState(fix, fx, now) {
  const kickoff = fix?.StartTime ?? fx?.kickoffTs
  const canBeLive = Number.isFinite(kickoff) && kickoff >= now - MAX_LIVE_AGE_MS && kickoff <= now
  const snapshotState = fix?.GameState
  const code = fx?.scoreState ?? fx?.oddsState ?? snapshotState
  const label = gameStateLabel(code)
  if (canBeLive && fx?.inRunning && (!label || label === 'Not Started')) {
    return { label: 'In Running', short: 'Live', live: true }
  }
  if (LIVE_STATES.has(label) && !canBeLive) return { label: null, short: null, live: false }
  return { label, short: gameStateShort(code), live: LIVE_STATES.has(label) }
}

function render() {
  const now = Date.now()
  const groups = new Map()
  const fixturesWithOdds = new Set()
  const liveFixtures = new Set()
  const pendingStatusFixtures = new Set()
  for (const [fid, fix] of fixturesCache) {
    const state = fixtureState(fix, fixtures.get(fid), now)
    if (state.live) liveFixtures.add(fid)
    const awaitingStatus = !state.live && (!state.label || state.label === 'Not Started')
      && fix.StartTime < now && fix.StartTime >= now - MATCH_STATUS_GRACE_MS
    if (awaitingStatus) pendingStatusFixtures.add(fid)
    const upcoming = fix.StartTime >= now && fix.StartTime < now + UPCOMING_WINDOW_MS
    if (state.live || awaitingStatus || upcoming) {
      groups.set(fid, [])
    }
  }
  for (const line of lines.values()) {
    const kickoff = fixtures.get(line.fixtureId)?.kickoffTs
    if (kickoff != null && (kickoff < now - MAX_LIVE_AGE_MS || kickoff >= now + UPCOMING_WINDOW_MS)) {
      continue
    }
    if (!groups.has(line.fixtureId)) groups.set(line.fixtureId, [])
    groups.get(line.fixtureId).push(line)
    if (line.pricesData?.prices?.length) fixturesWithOdds.add(line.fixtureId)
  }
  for (const fid of groups.keys()) {
    const fx = fixtures.get(fid)
    if (searchQuery && !fx?.name.toLowerCase().includes(searchQuery)) {
      groups.delete(fid)
    }
  }
  // Sort each section by odds, kickoff and home team.
  const fixtureIds = [...groups.keys()].sort((a, b) => {
    const liveOrder = Number(liveFixtures.has(b)) - Number(liveFixtures.has(a))
    if (liveOrder !== 0) return liveOrder
    const pendingOrder = Number(pendingStatusFixtures.has(b)) - Number(pendingStatusFixtures.has(a))
    if (pendingOrder !== 0) return pendingOrder
    const oddsOrder = Number(fixturesWithOdds.has(b)) - Number(fixturesWithOdds.has(a))
    if (oddsOrder !== 0) return oddsOrder
    const tsA = fixtures.get(a)?.kickoffTs ?? Infinity
    const tsB = fixtures.get(b)?.kickoffTs ?? Infinity
    if (tsA !== tsB) return tsA - tsB
    return homeTeamOrder.compare(homeTeamName(a), homeTeamName(b)) || a - b
  })

  const visibleFixtureIds = fixtureIds.slice(0, fixtureDisplayLimit)
  const marketTrends = new Map()
  const liveCards = []
  const pendingStatusCards = []
  const pricedCards = []
  const waitingCards = []
  for (const fid of visibleFixtureIds) {
    const fx = fixtures.get(fid) || { name: String(fid), competition: '—', kickoff: '—' }
    const groupLines = groups.get(fid).sort(compareLines)
    const isExpandable = groupLines.length > 1
    const expanded = Boolean(fx.expanded && isExpandable)
    const hasOdds = fixturesWithOdds.has(fid)
    const pricedLines = hasOdds ? groupLines.filter(line => line.pricesData?.prices?.length) : groupLines
    const displayLines = expanded ? groupLines : [pickDefaultLine(pricedLines)]
    const fullMatch = groupLines.find(line => line.superOddsType === MATCH_ODDS_TYPE && !line.marketPeriod)
    const trend = fullMatch ? renderMarketTrend(fullMatch, fid, marketTrends) : ''

    const state = fixtureState(fixturesCache.get(fid), fx, now)
    const stateHtml = state.short && state.label !== 'Not Started'
      ? `<span class="state-badge${state.live ? ' state-live' : ''}" title="${esc(state.label)}">${state.live ? '<span class="state-dot"></span>' : ''}${esc(state.short)}</span>`
      : ''
    const scoreHtml = fx.scoreText ? `<span class="fix-score">${esc(fx.scoreText)}</span>` : ''
    const hasEvents = scoreEvents.has(fid)
    const showEvents = hasEvents || (fx.kickoffTs != null && fx.kickoffTs <= now)
    const eventsExpanded = Boolean(fx.eventsExpanded)
    const eventsButton = showEvents
      ? `<button type="button" class="fix-events-toggle card-action" data-fid="${fid}" aria-expanded="${eventsExpanded}" aria-controls="fixture-events-${fid}">Match Events</button>`
      : ''
    const expandButton = isExpandable
      ? `<button type="button" class="fix-expand card-action" data-fid="${fid}" aria-expanded="${expanded}" aria-controls="fixture-markets-${fid}">Half markets</button>`
      : ''
    const markets = displayLines.map((line, index) =>
      renderFixtureMarket(line, fid, index === 0 ? expandButton : '')
    ).join('')
    let cards = hasOdds ? pricedCards : waitingCards
    if (liveFixtures.has(fid)) cards = liveCards
    if (pendingStatusFixtures.has(fid)) cards = pendingStatusCards
    cards.push(`
      <article class="fixture-card${hasOdds ? ' fixture-card-priced' : ''}">
        <header class="fixture-card-header">
          <div class="fix-sub">${esc(fx.kickoff)} · ${esc(fx.competition)}</div>
          ${stateHtml}
        </header>
        <div class="fixture-title-row">
          <h3 class="fix-title">${isRecentlyUpdated(fx) ? '<span class="recent-dot" title="Updated in the last 30s"></span>' : ''}${esc(fx.name)}${scoreHtml}</h3>
          ${trend}
        </div>
        ${statsRowHtml(fx.stats)}
        <div class="fixture-markets" id="fixture-markets-${fid}">${markets}</div>
        ${eventsButton || fx.updated ? `
          <footer class="fixture-card-footer">
            ${fx.updated ? `<span class="fix-updated">Updated ${esc(fx.updated)} · ${fx.updateCount} update${fx.updateCount === 1 ? '' : 's'}</span>` : ''}
            ${eventsButton}
          </footer>` : ''}
        ${showEvents ? `<div id="fixture-events-${fid}"${eventsExpanded ? '' : ' hidden'}>${eventsExpanded ? fixtureEventsHtml(fid) : ''}</div>` : ''}
      </article>`)
  }

  const sections = [
    ['In running', liveCards],
    ['Awaiting match status', pendingStatusCards],
    ['Latest odds', pricedCards],
    ['Awaiting odds', waitingCards],
  ]
  const sectionHtml = sections.filter(([, cards]) => cards.length).map(([title, cards]) => `
    <section class="fixture-section">
      <h2>${title}</h2>
      <div class="fixture-grid">${cards.join('')}</div>
    </section>`).join('') || `<p class="fixture-empty">${fixtureSnapshotLoaded
    ? (searchQuery ? 'No fixtures match your search.' : 'No upcoming fixtures.')
    : 'Loading fixtures…'}</p>`
  const hasMore = fixtureIds.length > visibleFixtureIds.length
  const html = sectionHtml + (hasMore
    ? '<button type="button" class="show-more-fixtures">Show more fixtures</button>'
    : '')
  if (html !== lastFixtureHtml) {
    fixtureCards.innerHTML = html
    lastFixtureHtml = html
    for (const canvas of fixtureCards.querySelectorAll?.('.market-trend') || []) {
      const { series, count } = marketTrends.get(Number(canvas.dataset.fixtureId))
      drawOddsChart(canvas, series, count, true)
    }
  }
  fixtureCountEl.textContent = hasMore
    ? `${visibleFixtureIds.length} of ${fixtureIds.length} fixtures`
    : `${fixtureIds.length} fixture${fixtureIds.length === 1 ? '' : 's'}`
}

function renderMarketTrend(line, fixtureId, marketTrends) {
  const entries = (history.get(line.key) || []).slice(0, MARKET_TREND_UPDATES)
  const { series } = historyPriceSeries(entries, fixtureId)
  if (!series.some(selection => selection.points.length >= 2)) return ''
  marketTrends.set(fixtureId, { series, count: entries.length })
  const participant1IsHome = fixturesCache.get(fixtureId)?.Participant1IsHome !== false
  const labels = {
    part1: participant1IsHome ? 'Home' : 'Away',
    draw: 'Draw',
    part2: participant1IsHome ? 'Away' : 'Home',
  }
  const legend = series.map(selection => ({
    label: Object.hasOwn(labels, selection.name) ? labels[selection.name] : selection.label,
  }))
  return `
    <div class="fixture-trend">
      <canvas class="market-trend" width="200" height="68" role="img"
        aria-label="Recent full-match odds trend, oldest to newest"
        title="Recent full-match odds" data-fixture-id="${fixtureId}"></canvas>
      ${oddsChartLegend(legend)}
    </div>`
}

function renderFixtureMarket(line, fid, expandButton) {
  if (!line) return '<p class="odds-waiting">Waiting for odds</p>'

  const variant = [...(line.marketParts?.params || []), line.marketParts?.period]
    .filter(Boolean).join(' · ')
  return `
    <div class="fixture-market${line.key === lastFlashKey ? ' flash' : ''}">
      <div class="fixture-market-header">
        <div class="fixture-market-label">
          <span>${esc(variant || line.marketParts?.type || 'Match Odds')}</span>
          ${expandButton}
        </div>
        <button type="button" class="odds-history card-action" data-line-key="${esc(line.key)}">Odds history</button>
      </div>
      ${line.pricesData?.prices?.length
        ? `<div class="fixture-prices">${formatPrices(line.pricesData.prices, line.pricesData.priceNames, line.priceDirs, fid)}</div>`
        : '<p class="odds-waiting">Waiting for odds</p>'}
    </div>`
}

function tickClock() {
  clockEl.textContent = timeNow()
}

function setStatus(s) {
  statusDotEl.className = 'dot' + (s === 'live' ? ' live' : s === 'connecting' ? '' : ' reconnecting')
  statusTextEl.textContent = s
}

// --- Startup ---

async function loadFixtureNames() {
  try {
    const res = await fetch('/fixtures', { signal: AbortSignal.timeout(30000) })
    if (res.ok) {
      const snapshot = await res.json()
      fixtureSnapshotLoaded = true
      fixturesCache.clear()
      for (const f of snapshot) {
        fixturesCache.set(f.FixtureId, f)
        resolveNameFromCache(f.FixtureId)
      }
      render()
      renderHistoryPanel()
      setTimeout(loadFixtureNames, 60000)
      return
    }
  } catch (err) {
    console.warn('Fixture fetch failed, running with raw IDs:', err)
  }
  setTimeout(loadFixtureNames, 30000)
}

function updateFixtureScore(fx, d) {
  if (d.gameState) fx.scoreState = d.gameState

  const breakdown = scoreBreakdown(d)
  if (breakdown) {
    fx.stats = breakdown
    fx.scoreText = `${breakdown.participant1.goals} – ${breakdown.participant2.goals}`
  }
  return breakdown
}

function init() {
  loadFixtureNames()

  const oddsEs = new EventSource('/odds/stream')
  let feedFailure = null
  const markLive = () => {
    feedFailure = null
    setStatus('live')
  }
  oddsEs.addEventListener('heartbeat', markLive)
  oddsEs.addEventListener('feed_status', (e) => {
    feedFailure = e.data
    setStatus(feedFailure)
  })
  oddsEs.addEventListener('error', () => {
    setStatus(feedFailure || (oddsEs.readyState === EventSource.CLOSED
      ? 'feed unavailable'
      : 'reconnecting'))
  })
  oddsEs.addEventListener('odds', (e) => {
    try {
      const d = JSON.parse(e.data)
      markLive()
      const fid = d.FixtureId
      const fx = ensureFixture(fid)
      resolveNameFromCache(fid)

      if (d.InRunning) fx.inRunning = true
      if (Object.hasOwn(GAME_STATE_BY_CODE, d.GameState) && d.GameState !== 'NS') {
        fx.oddsState = d.GameState
      }

      const marketSig = marketSignature(d)
      const line = ensureLine(fid, marketSig)

      line.superOddsType = d.SuperOddsType
      line.marketParameters = d.MarketParameters || null
      line.marketPeriod = normalizeMarketPeriod(d.MarketPeriod)
      line.market = marketLabel(d)
      line.marketParts = marketParts(d)
      updateLinePrices(line, d.Prices, d.PriceNames)
      line.updated = timeNow()
      line.updateCount++  // odds updates received for this specific market/line
      fx.updated = line.updated  // fixture-level "last updated across any of its lines"
      fx.updatedAtMs = Date.now()
      fx.updateCount++  // total odds updates received for this fixture, across all its markets
      totalUpdateCount++  // total odds updates received across every fixture/market
      lastUpdateEl.textContent = `Updated ${fx.updated}`
      totalUpdatesEl.textContent = `${totalUpdateCount} update${totalUpdateCount === 1 ? '' : 's'}`

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

      const breakdown = updateFixtureScore(fx, d)
      const event = describeScoreEvent(d)
      if (event.cls === 'evt-goal' && breakdown) event.score = fx.scoreText

      if (!scoreEvents.has(fid)) scoreEvents.set(fid, [])
      const arr = scoreEvents.get(fid)
      arr.unshift({ ts: timeNow(), ...event })
      if (arr.length > HISTORY_LIMIT) arr.length = HISTORY_LIMIT

      fx.updatedAtMs = Date.now()
      render()
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
    fixtureDisplayLimit = FIXTURE_PAGE_SIZE
    render()
  })

  historyClose.addEventListener('click', closeMarketPanel)
  backdrop.addEventListener('click', closeMarketPanel)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMarketPanel()
  })
  fixtureCards.addEventListener('click', (e) => {
    if (e.target.closest('.show-more-fixtures')) {
      fixtureDisplayLimit += FIXTURE_PAGE_SIZE
      render()
      return
    }
    const historyButton = e.target.closest('.odds-history')
    if (historyButton) {
      openMarketPanel(historyButton.dataset.lineKey)
      return
    }
    const expandButton = e.target.closest('.fix-expand, .fix-events-toggle')
    if (!expandButton) return
    const fid = Number(expandButton.dataset.fid)
    const fx = fixtures.get(fid)
    if (!fx) return
    const isEventsToggle = expandButton.classList.contains('fix-events-toggle')
    const field = isEventsToggle ? 'eventsExpanded' : 'expanded'
    const selector = isEventsToggle ? '.fix-events-toggle' : '.fix-expand'
    fx[field] = !fx[field]
    render()
    fixtureCards.querySelector(`${selector}[data-fid="${fid}"]`)?.focus()
  })
}

init()
