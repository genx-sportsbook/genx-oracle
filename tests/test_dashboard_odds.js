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
      assert.equal(pickDefaultVariant([firstHalfLine, fullMatchLine]), fullMatchLine)
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
