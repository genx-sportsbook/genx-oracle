const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const appSource = fs.readFileSync(path.join(__dirname, '../txline/api/static/app.js'), 'utf8')
const dashboard = vm.createContext({
  assert,
  document: { getElementById: () => ({}) },
})
vm.runInContext(appSource.replace(/\ninit\(\)\s*$/, ''), dashboard)

test('explicit fulltime and an omitted period identify the same primary market', () => {
  vm.runInContext(String.raw`
    for (const type of PRIMARY_MARKET_TYPES) {
      const market = { SuperOddsType: type }
      const fullMatch = { ...market, MarketPeriod: 'fulltime' }
      const firstHalf = { ...market, MarketPeriod: 'half=1' }
      assert.equal(marketSignature(fullMatch), marketSignature(market))
      assert.notEqual(marketSignature(fullMatch), marketSignature(firstHalf))

      const fullMatchLine = { superOddsType: type, marketPeriod: normalizeMarketPeriod('fulltime'), updated: '12:00:00' }
      const firstHalfLine = { superOddsType: type, marketPeriod: 'half=1', updated: '12:00:01' }
      const playerProp = { superOddsType: 'OVERUNDER_PLAYER_TOUCHDOWNS', marketPeriod: '', updated: '12:00:02' }
      assert.equal(pickDefaultLine([playerProp, firstHalfLine, fullMatchLine]), fullMatchLine)
      assert.equal(marketParts(fullMatch).period, '')
      assert.equal(marketParts(firstHalf).period, '1st Half')
    }
  `, dashboard)
})

test('labels prices by feed participant order even when participant one is away', () => {
  vm.runInContext(String.raw`
    const prices = [4683, 4066, 1850]
    const names = ['part1', 'draw', 'part2']
    assert.match(formatPrices(prices, names, null, 18146919), /Participant 1.*4\.683/)
    fixturesCache.set(18146919, {
      Participant1: 'Away & Co', Participant2: 'Home FC', Participant1IsHome: false,
    })
    const html = formatPrices(prices, names, null, 18146919)
    assert.match(html, /Away &amp; Co.*4\.683.*Draw.*4\.066.*Home FC.*1\.850/)
  `, dashboard)
})

test('sorts priced fixtures before fixtures waiting for odds, then by kickoff', () => {
  vm.runInContext(String.raw`
    const now = Date.now()
    const kickoffOffsets = [[4, UPCOMING_WINDOW_MS + 1000], [6, 240000], [2, 120000], [3, -MATCH_STATUS_GRACE_MS - 1000], [5, 180000], [1, 60000]]
    for (const [id, offset] of kickoffOffsets) {
      fixturesCache.set(id, {
        Participant1: 'Team ' + id, Participant2: 'Visitors',
        Competition: 'Premier League', StartTime: now + offset,
      })
      resolveNameFromCache(id)
    }

    const fixtureOrder = () => Array.from(fixtureCards.innerHTML.matchAll(/Team (\d) vs Visitors/g), match => Number(match[1]))
    render()
    assert.deepEqual(fixtureOrder(), [1, 2, 5, 6])
    assert.match(fixtureCards.innerHTML, /Team 1[\s\S]*Waiting for odds[\s\S]*Team 2[\s\S]*Waiting for odds/)
    assert.doesNotMatch(fixtureCards.innerHTML, /Team [34]/)
    assert.equal(fixtureCountEl.textContent, '4 fixtures')
    assert.match(fixtureCards.innerHTML, /<section class="fixture-section">[\s\S]*Awaiting odds/)
    assert.doesNotMatch(fixtureCards.innerHTML, /<t[rd]\b/)
    assert.doesNotMatch(fixtureCards.innerHTML, /Odds history/)

    const laterLine = ensureLine(6, MATCH_ODDS_TYPE)
    laterLine.superOddsType = MATCH_ODDS_TYPE
    laterLine.marketParts = marketParts({ SuperOddsType: MATCH_ODDS_TYPE })
    laterLine.pricesData = { prices: [], priceNames: [] }
    render()
    assert.deepEqual(fixtureOrder(), [1, 2, 5, 6])

    laterLine.pricesData = { prices: [2000], priceNames: ['part1'] }
    render()
    assert.deepEqual(fixtureOrder(), [6, 1, 2, 5])
    assert.match(fixtureCards.innerHTML, /Team 6[\s\S]*2\.000/)
    assert.match(fixtureCards.innerHTML, /<button[^>]+data-line-key="6::1X2_PARTICIPANT_RESULT">Odds history<\/button>/)

    const earlierLine = ensureLine(2, MATCH_ODDS_TYPE)
    earlierLine.superOddsType = MATCH_ODDS_TYPE
    earlierLine.pricesData = { prices: [3000], priceNames: ['part1'] }
    render()
    assert.deepEqual(fixtureOrder(), [2, 6, 1, 5])
    assert.match(fixtureCards.innerHTML, /Latest odds[\s\S]*Awaiting odds/)
    assert.equal((fixtureCards.innerHTML.match(/Waiting for odds/g) || []).length, 2)

    pushHistory(laterLine.key, { Prices: [1900, 3000, 4000], PriceNames: ['part1', 'draw', 'part2'] })
    render()
    assert.doesNotMatch(fixtureCards.innerHTML, /class="market-trend"/)
    pushHistory(laterLine.key, { Prices: [2000, 2900, 3900], PriceNames: ['part1', 'draw', 'part2'] })

    const halves = ['half=1', 'half=2']
    for (const [i, period] of halves.entries()) {
      const half = ensureLine(6, marketSignature({ SuperOddsType: MATCH_ODDS_TYPE, MarketPeriod: period }))
      half.superOddsType = MATCH_ODDS_TYPE
      half.marketPeriod = period
      half.marketParts = marketParts({ SuperOddsType: MATCH_ODDS_TYPE, MarketPeriod: period })
      half.pricesData = { prices: [2200 + i * 200], priceNames: ['part1'] }
      pushHistory(half.key, { Prices: [2100 + i * 200], PriceNames: ['part1'] })
      pushHistory(half.key, { Prices: half.pricesData.prices, PriceNames: ['part1'] })
    }
    render()
    assert.match(fixtureCards.innerHTML, /class="fixture-market-label">\s*<span>Match Odds<\/span>\s*<button[^>]*aria-expanded="false"[^>]*>Half markets/)
    assert.doesNotMatch(fixtureCards.innerHTML, /1st Half|2nd Half/)
    assert.equal((fixtureCards.innerHTML.match(/class="market-trend"/g) || []).length, 1)
    assert.match(fixtureCards.innerHTML, /fixture-title-row[\s\S]*Team 6 vs Visitors<\/h3>\s*<div class="fixture-trend">\s*<canvas class="market-trend"[^>]*[\s\S]*data-fixture-id="6"/)
    assert.match(fixtureCards.innerHTML, /odds-chart-legend[\s\S]*#38bdf8[^>]*><\/span>Home[\s\S]*#a5a6f6[^>]*><\/span>Draw[\s\S]*#2dd4bf[^>]*><\/span>Away/)
    fixturesCache.get(6).Participant1IsHome = false
    render()
    assert.match(fixtureCards.innerHTML, /odds-chart-legend[\s\S]*#38bdf8[^>]*><\/span>Away[\s\S]*#2dd4bf[^>]*><\/span>Home/)

    fixtures.get(6).expanded = true
    render()
    assert.match(fixtureCards.innerHTML, /class="fixture-market-label">\s*<span>Match Odds<\/span>\s*<button[^>]*aria-expanded="true"[^>]*>Half markets/)
    assert.equal((fixtureCards.innerHTML.match(/>Half markets<\/button>/g) || []).length, 1)
    assert.match(fixtureCards.innerHTML, /1st Half[\s\S]*2\.200[\s\S]*2nd Half[\s\S]*2\.400/)
    assert.doesNotMatch(fixtureCards.innerHTML, /market-group-toggle/)
    assert.equal((fixtureCards.innerHTML.match(/class="market-trend"/g) || []).length, 1)
    history.delete(laterLine.key)
    render()
    assert.doesNotMatch(fixtureCards.innerHTML, /class="market-trend"/)


    assert.match(fixtureCards.innerHTML, / · Premier League<\/div>/)
    assert.doesNotMatch(fixtureCards.innerHTML, /competition-link/)
    searchQuery = 'missing team'
    render()
    assert.equal(fixtureCountEl.textContent, '0 fixtures')
  `, dashboard)
})

test('breaks kickoff ties in each odds group by case-insensitive home team name', () => {
  vm.runInContext(String.raw`
    fixtures.clear()
    fixturesCache.clear()
    lines.clear()
    searchQuery = ''
    const kickoff = Date.now() + 60000
    const matches = [
      [11, 'Zulu', 'beta', false],
      [12, 'Alpha', 'Visitors', true],
      [13, 'Bravo', 'alpha', false],
      [14, 'ZED', 'Visitors', true],
    ]
    for (const [id, Participant1, Participant2, Participant1IsHome] of matches) {
      fixturesCache.set(id, { Participant1, Participant2, Participant1IsHome, StartTime: kickoff })
      resolveNameFromCache(id)
    }
    for (const id of [11, 12]) {
      const line = ensureLine(id, MATCH_ODDS_TYPE)
      line.superOddsType = MATCH_ODDS_TYPE
      line.pricesData = { prices: [2000], priceNames: ['part1'] }
    }
    render()
    assert.match(fixtureCards.innerHTML, /Alpha vs Visitors[\s\S]*Zulu vs beta[\s\S]*Awaiting odds[\s\S]*Bravo vs alpha[\s\S]*ZED vs Visitors/)
  `, dashboard)
})

test('renders odds history as newest-first cards with the same price labels as fixtures', () => {
  vm.runInContext(String.raw`
    const id = 20
    fixturesCache.set(id, { Participant1: 'Alpha', Participant2: 'Visitors' })
    resolveNameFromCache(id)
    const line = ensureLine(id, MATCH_ODDS_TYPE)
    line.market = 'Match Odds · 1st Half'
    openLineKey = line.key
    history.set(line.key, [
      { ts: '12:02:00', prices: [2320, 3100], priceNames: ['part1', 'draw'] },
      { ts: '12:01:00', prices: null },
      { ts: '12:00:00', prices: [2800, 2500], priceNames: ['draw', 'part1'] },
    ])
    const plotted = []
    const segments = []
    const canvas = {
      width: 840,
      height: 302,
      getContext: () => ({
        fillText() {}, beginPath() {}, moveTo() {}, stroke() {}, fill() {},
        lineTo(x, y) { segments.push([x, y]) },
        arc(x, y) { plotted.push([x, y]) },
      }),
    }
    historyList.querySelector = () => historyList.innerHTML.includes('<canvas') ? canvas : null
    renderHistoryPanel()
    assert.match(historyTitle.innerHTML, /Odds history[\s\S]*Alpha vs Visitors[\s\S]*Match Odds · 1st Half/)
    assert.match(historyList.innerHTML, /odds-history-card-latest[\s\S]*12:02:00[\s\S]*Alpha[\s\S]*2\.320[\s\S]*Draw[\s\S]*3\.100/)
    assert.match(historyList.innerHTML, /Decimal odds by update[\s\S]*Draw[\s\S]*Alpha[\s\S]*<canvas/)
    assert.match(historyList.innerHTML, /chip-down[^>]*>[\s\S]*Alpha[\s\S]*▼2\.320/)
    assert.match(historyList.innerHTML, /chip-up[^>]*>[\s\S]*Draw[\s\S]*▲3\.100/)
    assert.match(historyList.innerHTML, /12:01:00[\s\S]*No prices in this update[\s\S]*12:00:00/)
    assert.equal(plotted.length, 4)
    assert.ok(plotted.every(point => point.every(Number.isFinite)))
    assert.equal(segments.length, 5) // Only the axis grid crosses the update without prices.
    history.delete(line.key)
    renderHistoryPanel()
    assert.match(historyList.innerHTML, /No odds updates yet/)
  `, dashboard)
})

test('initially shows at most nine sorted fixtures while search covers the full schedule', () => {
  vm.runInContext(String.raw`
    fixtures.clear()
    fixturesCache.clear()
    lines.clear()
    searchQuery = ''
    const scheduleStart = Date.now()
    for (let id = 1; id <= 11; id++) {
      fixturesCache.set(id, {
        Participant1: 'Team ' + id, Participant2: 'Visitors',
        Competition: 'Premier League', StartTime: scheduleStart + id * 60000,
      })
      resolveNameFromCache(id)
    }
    render()
    assert.equal((fixtureCards.innerHTML.match(/<article/g) || []).length, 9)
    assert.equal(fixtureCountEl.textContent, '9 of 11 fixtures')
    assert.match(fixtureCards.innerHTML, /Show more fixtures/)
    assert.doesNotMatch(fixtureCards.innerHTML, /Team 11 vs Visitors/)

    searchQuery = 'team 11'
    render()
    assert.match(fixtureCards.innerHTML, /Team 11 vs Visitors/)
    assert.equal(fixtureCountEl.textContent, '1 fixture')

    searchQuery = ''
    fixtureDisplayLimit += FIXTURE_PAGE_SIZE
    render()
    assert.match(fixtureCards.innerHTML, /Team 11 vs Visitors/)
    assert.equal(fixtureCountEl.textContent, '11 fixtures')
    assert.doesNotMatch(fixtureCards.innerHTML, /Show more fixtures/)
  `, dashboard)
})

test('keeps in-running fixtures visible and shows score updates without odds', () => {
  vm.runInContext(String.raw`{
    fixtures.clear()
    fixturesCache.clear()
    lines.clear()
    searchQuery = ''
    fixtureDisplayLimit = FIXTURE_PAGE_SIZE
    const now = Date.now()
    for (let id = 1; id <= 10; id++) {
      fixturesCache.set(id, {
        Participant1: 'Team ' + id, Participant2: 'Visitors', StartTime: now + id * 60000,
      })
      resolveNameFromCache(id)
    }

    const id = 11
    fixturesCache.set(id, {
      Participant1: 'Nottingham Forest', Participant2: 'Chelsea',
      StartTime: now - 3600000, GameState: 3,
    })
    resolveNameFromCache(id)
    const fx = fixtures.get(id)

    fixturesCache.get(id).GameState = 1
    render()
    assert.match(fixtureCards.innerHTML, /Awaiting match status[\s\S]*Nottingham Forest vs Chelsea/)
    assert.doesNotMatch(fixtureCards.innerHTML, /state-live/)
    assert.match(fixtureCards.innerHTML, /aria-controls="fixture-events-11">Match Events/)

    fixturesCache.get(id).StartTime = now - MATCH_STATUS_GRACE_MS - 1000
    resolveNameFromCache(id)
    render()
    assert.doesNotMatch(fixtureCards.innerHTML, /Nottingham Forest vs Chelsea/)

    fixturesCache.get(id).StartTime = now - 3600000
    fixturesCache.get(id).GameState = 3
    resolveNameFromCache(id)
    render()
    assert.match(fixtureCards.innerHTML, /In running[\s\S]*title="Half Time"[\s\S]*Nottingham Forest vs Chelsea/)
    assert.doesNotMatch(fixtureCards.innerHTML, /class="fix-score"/)
    assert.equal((fixtureCards.innerHTML.match(/<article/g) || []).length, 9)

    assert.match(fixtureCards.innerHTML, /aria-expanded="false" aria-controls="fixture-events-11">Match Events/)
    assert.match(fixtureCards.innerHTML, /id="fixture-events-11" hidden/)
    fx.eventsExpanded = true
    render()
    assert.match(fixtureCards.innerHTML, /aria-expanded="true" aria-controls="fixture-events-11">Match Events/)
    assert.match(fixtureCards.innerHTML, /id="fixture-events-11"><p class="fixture-empty">No match events yet/)
    assert.match(fixtureCards.innerHTML, /Waiting for odds/)

    fixturesCache.get(id).GameState = 1
    fx.inRunning = true
    render()
    assert.match(fixtureCards.innerHTML, /title="In Running"[\s\S]*Nottingham Forest vs Chelsea/)
    updateFixtureScore(fx, {
      gameState: 'H2',
      scoreSoccer: { Participant1: { Total: { Goals: 1 } }, Participant2: { Total: { Goals: 2 } } },
    })
    updateFixtureScore(fx, { gameState: 'H2' })
    render()
    assert.match(fixtureCards.innerHTML, /title="2nd Half"[\s\S]*Nottingham Forest vs Chelsea<span class="fix-score">1 – 2/)

    const main = ensureLine(id, MATCH_ODDS_TYPE)
    main.superOddsType = MATCH_ODDS_TYPE
    updateLinePrices(main, [2120], ['part1'])
    updateLinePrices(main, [], null)
    updateLinePrices(main, null, null)
    pushHistory(main.key, { Prices: [] })
    scoreEvents.set(id, [
      { ts: '15:30:00', score: '1 – 2', ...describeScoreEvent({ action: 'Goal', data: { GoalType: 'Head' } }) },
      { ts: '15:00:00', ...describeScoreEvent({ action: 'Kickoff' }) },
    ])
    const half = ensureLine(id, MATCH_ODDS_TYPE + '::half=1')
    half.superOddsType = MATCH_ODDS_TYPE
    half.marketPeriod = 'half=1'
    render()
    assert.match(fixtureCards.innerHTML, /aria-expanded="false"[^>]*>Half markets/)
    assert.match(fixtureCards.innerHTML, /id="fixture-events-11">[\s\S]*⚽[\s\S]*GOAL[\s\S]*Header[\s\S]*1 – 2[\s\S]*15:30:00[\s\S]*🏁[\s\S]*Kickoff[\s\S]*15:00:00/)
    assert.match(fixtureCards.innerHTML, /Nottingham Forest[\s\S]*2\.120/)
    assert.doesNotMatch(fixtureCards.innerHTML, /No prices in this update/)
    fx.expanded = true
    fx.eventsExpanded = false
    render()
    assert.match(fixtureCards.innerHTML, /aria-expanded="true"[^>]*>Half markets/)
    assert.match(fixtureCards.innerHTML, /id="fixture-events-11" hidden/)
    assert.doesNotMatch(fixtureCards.innerHTML, /Kickoff/)

    updateFixtureScore(fx, { gameState: 'F' })
    lines.clear()
    render()
    assert.doesNotMatch(fixtureCards.innerHTML, /Nottingham Forest vs Chelsea/)
  }`, dashboard)
})

test('ignores stale live states and odds for old fixtures and hides premature live badges', () => {
  vm.runInContext(String.raw`{
    fixtures.clear()
    fixturesCache.clear()
    lines.clear()
    const now = Date.now()
    fixturesCache.set(1, {
      Participant1: 'Old Team', Participant2: 'Visitors',
      StartTime: now - 24 * 60 * 60 * 1000, GameState: 4,
    })
    fixturesCache.set(2, {
      Participant1: 'Future Team', Participant2: 'Visitors',
      StartTime: now + 60 * 60 * 1000, GameState: 2,
    })
    resolveNameFromCache(1)
    resolveNameFromCache(2)
    render()
    assert.doesNotMatch(fixtureCards.innerHTML, /Old Team|In running|state-live/)
    assert.match(fixtureCards.innerHTML, /Future Team/)

    const fx = fixtures.get(1)
    fx.inRunning = true
    updateFixtureScore(fx, { gameState: 'H2' })
    ensureLine(1, MATCH_ODDS_TYPE).pricesData = { prices: [2000], priceNames: ['part1'] }
    render()
    assert.doesNotMatch(fixtureCards.innerHTML, /Old Team|In running|state-live/)
  }`, dashboard)
})
