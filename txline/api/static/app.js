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
let lineOrderCounter = 0
let lastFlashKey = null
let flashTimer = null
let openLineKey = null
let selectedCompetition = ''  // '' = no filter, show every competition
let highlightedIndex = -1     // index into dropdownOptions(), for keyboard nav
let totalUpdateCount = 0      // odds updates received across every fixture/market, for the whole session
const competitionUpdateCounts = new Map()  // competition name -> odds updates received for that competition

const tbody = document.getElementById('rows')
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

function ensureFixture(fid) {
  if (!fixtures.has(fid)) {
    fixtures.set(fid, { name: String(fid), competition: '—', kickoff: '—', kickoffTs: null, updated: '', updateCount: 0, expanded: false })
  }
  return fixtures.get(fid)
}

function resolveNameFromCache(fid) {
  const fx = fixtures.get(fid)
  if (fx.name !== String(fid)) return  // already resolved
  const fix = fixturesCache.get(fid)
  if (!fix) return
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
      market: '—',            // flat text form (marketLabel)
      marketParts: null,      // boxed-chip form (marketParts) — { type, params, period }
      pricesData: null,       // { prices, priceNames }
      priceDirs: null,        // array parallel to prices.prices — cleared/replaced on the line's next update, not on a timer
      lastPrices: null,
      updated: '',
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

function openPanel(key) {
  openLineKey = key
  historyPanel.classList.add('open')
  backdrop.classList.add('open')
  renderHistoryPanel()
}

function closePanel() {
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

function render() {
  const groups = new Map()  // fixtureId -> array of line rows
  for (const line of lines.values()) {
    if (selectedCompetition) {
      const fx = fixtures.get(line.fixtureId)
      if (!fx || fx.competition !== selectedCompetition) continue
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
    const fx = fixtures.get(fid) || { name: String(fid), competition: '—', kickoff: '—', kickoffTs: null, updated: '', updateCount: 0, expanded: false }
    const groupLines = groups.get(fid).sort(compareLines)
    const isExpandable = groupLines.length > 1
    const visibleLines = fx.expanded ? groupLines : [pickDefaultLine(groupLines)].filter(Boolean)

    visibleLines.forEach((line, i) => {
      const isFirst = i === 0
      html += `<tr class="${line.key === lastFlashKey ? 'flash' : ''}${isFirst ? ' group-start' : ''}">`
      if (isFirst) {
        const expandHint = isExpandable
          ? `<div class="fix-expand">${fx.expanded ? '▲ Hide markets' : `▼ ${groupLines.length} markets`}</div>`
          : ''
        html += `
          <td class="fix-name${isExpandable ? ' expandable' : ''}" rowspan="${visibleLines.length}" data-fid="${fid}">
            <div class="fix-title">${esc(fx.name)}</div>
            <div class="fix-sub">${esc(fx.kickoff)} · ${esc(fx.competition)}</div>
            <div class="fix-updated">${fx.updated ? `Updated ${esc(fx.updated)} · ${fx.updateCount} update${fx.updateCount === 1 ? '' : 's'}` : ''}</div>
            ${expandHint}
          </td>`
      }
      html += `
          <td class="market">${formatMarketChip(line.marketParts, line.key)}</td>
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
      fx.updated = line.updated  // fixture-level "last updated across any of its lines"
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

  tickClock()
  setInterval(tickClock, 1000)

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

  historyClose.addEventListener('click', closePanel)
  backdrop.addEventListener('click', closePanel)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel()
  })
  tbody.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip-market-click')
    if (chip) {
      openPanel(chip.dataset.lineKey)
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
