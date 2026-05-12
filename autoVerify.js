'use strict'

const axios   = require('axios')
const webpush = require('web-push')
const { PrismaClient } = require('@prisma/client')
const cron    = require('node-cron')

const prisma = new PrismaClient()
const ODDS_API = 'https://api.the-odds-api.com/v4'

// ── Sport → Odds API league keys ──────────────────────────────
const LEAGUES = {
  Soccer: [
    'soccer_epl', 'soccer_spain_la_liga', 'soccer_italy_serie_a',
    'soccer_germany_bundesliga', 'soccer_france_ligue_one',
    'soccer_uefa_champs_league', 'soccer_uefa_europa_league',
    'soccer_usa_mls', 'soccer_portugal_primeira_liga',
    'soccer_netherlands_eredivisie', 'soccer_turkey_super_league',
    'soccer_brazil_campeonato', 'soccer_argentina_primera_division'
  ],
  Basketball: ['basketball_nba', 'basketball_euroleague'],
  Football:   ['americanfootball_nfl', 'americanfootball_ncaaf'],
  Tennis: [
    'tennis_atp_french_open', 'tennis_wta_french_open',
    'tennis_atp_wimbledon',   'tennis_wta_wimbledon',
    'tennis_atp_us_open',     'tennis_wta_us_open',
    'tennis_atp_australian_open', 'tennis_wta_australian_open',
    'tennis_atp_double',      'tennis_wta_double'
  ],
  Baseball:   ['baseball_mlb'],
  'MMA/Boxing': ['mma_mixed_martial_arts']
}

// ── Per-run scores cache (reset each cron tick) ───────────────
let _scoresCache = new Map()

async function getScores(league) {
  if (_scoresCache.has(league)) return _scoresCache.get(league)
  try {
    const r = await axios.get(`${ODDS_API}/sports/${league}/scores`, {
      params: { apiKey: process.env.ODDS_API_KEY, daysFrom: 3 },
      timeout: 8000
    })
    const games = r.data || []
    _scoresCache.set(league, games)
    return games
  } catch (_) {
    return []
  }
}

// Returns the completed game object, or null
async function findGame(pick) {
  const leagues = LEAGUES[pick.sport]
  if (!leagues) return null

  const eventLower = (pick.event || '').toLowerCase()
  const htLower    = (pick.homeTeam || '').toLowerCase()
  const awLower    = (pick.awayTeam || '').toLowerCase()

  for (const league of leagues) {
    const games = await getScores(league)
    for (const g of games) {
      if (!g.completed) continue

      // Primary: Odds API event ID match
      if (pick.fixtureId && g.id === pick.fixtureId) return g

      // Fallback: team name match via pick.event or homeTeam/awayTeam
      const home = g.home_team.toLowerCase()
      const away = g.away_team.toLowerCase()

      const nameMatch =
        (htLower && home.includes(htLower)) ||
        (awLower && away.includes(awLower)) ||
        eventLower.includes(home) ||
        eventLower.includes(away)

      if (nameMatch) return g
    }
  }
  return null
}

// ── Grading helpers ───────────────────────────────────────────

function parseOU(m) {
  const ov = m.match(/over\s*([\d.]+)/)
  const un = m.match(/under\s*([\d.]+)/)
  if (ov) return { type: 'over',  line: parseFloat(ov[1]) }
  if (un) return { type: 'under', line: parseFloat(un[1]) }
  return null
}

function ouResult(ou, value) {
  if (!ou) return null
  // Push/half-win not implemented — treat as loss for safety
  if (value === ou.line) return 'loss'
  return ou.type === 'over' ? (value > ou.line ? 'win' : 'loss')
                             : (value < ou.line ? 'win' : 'loss')
}

function getScoreNums(game) {
  const s = game.scores || []
  const h = s.find(x => x.name === game.home_team)
  const a = s.find(x => x.name === game.away_team)
  if (!h || !a) return null
  return { home: parseFloat(h.score), away: parseFloat(a.score) }
}

// ── Soccer grader ──────────────────────────────────────────────
function gradeSoccer(market, homeGoals, awayGoals, homeTeam, awayTeam) {
  const m     = market.toLowerCase()
  const total = homeGoals + awayGoals

  // 1X2
  if (/\bhome win\b/.test(m) || m === '1' || /^\(1\)$/.test(m))       return homeGoals > awayGoals ? 'win' : 'loss'
  if (/\baway win\b/.test(m) || m === '2' || /^\(2\)$/.test(m))       return awayGoals > homeGoals ? 'win' : 'loss'
  if (/\bdraw\b/.test(m) || m === 'x' || m === 'draw')                return homeGoals === awayGoals ? 'win' : 'loss'

  // Double Chance
  if (/1x|home or draw|home\/draw/.test(m))   return homeGoals >= awayGoals ? 'win' : 'loss'
  if (/x2|away or draw|draw\/away/.test(m))   return awayGoals >= homeGoals ? 'win' : 'loss'
  if (/\b12\b|home or away|no draw/.test(m))  return homeGoals !== awayGoals ? 'win' : 'loss'

  // BTTS
  if (/btts\s*yes|both teams.*score\s*yes|both teams to score$/.test(m))
    return (homeGoals > 0 && awayGoals > 0) ? 'win' : 'loss'
  if (/btts\s*no|both teams.*score\s*no/.test(m))
    return (homeGoals === 0 || awayGoals === 0) ? 'win' : 'loss'
  if (/^btts$/.test(m.trim()))   // just "btts" defaults to yes
    return (homeGoals > 0 && awayGoals > 0) ? 'win' : 'loss'

  // Over/Under goals (0.5 – 9.5)
  const ou = parseOU(m)
  if (ou) {
    // Team-specific total?
    const htWord = (homeTeam || '').toLowerCase().split(' ').pop()
    const awWord = (awayTeam || '').toLowerCase().split(' ').pop()
    const goals  = (htWord && m.includes(htWord)) ? homeGoals
                 : (awWord && m.includes(awWord)) ? awayGoals
                 : total
    return ouResult(ou, goals)
  }

  // Asian Handicap — looks for ±N.N at end or "handicap ±N"
  const ah = m.match(/(?:handicap\s*)?([+-]\d+(?:\.\d+)?)\s*$/)
  if (ah) {
    const line   = parseFloat(ah[1])
    const htWord = (homeTeam || '').toLowerCase().split(' ').pop()
    const awWord = (awayTeam || '').toLowerCase().split(' ').pop()
    if (htWord && m.includes(htWord)) return (homeGoals - awayGoals + line) > 0 ? 'win' : 'loss'
    if (awWord && m.includes(awWord)) return (awayGoals - homeGoals + line) > 0 ? 'win' : 'loss'
    // Default: home team handicap
    return (homeGoals - awayGoals + line) > 0 ? 'win' : 'loss'
  }

  // Correct Score — "2-1", "0-0" etc.
  const cs = m.match(/\b(\d{1,2})\s*[-:]\s*(\d{1,2})\b/)
  if (cs) {
    return (homeGoals === parseInt(cs[1]) && awayGoals === parseInt(cs[2])) ? 'win' : 'loss'
  }

  return null
}

// ── NBA grader ────────────────────────────────────────────────
function gradeNBA(market, homeScore, awayScore, homeTeam, awayTeam) {
  const m     = market.toLowerCase()
  const total = homeScore + awayScore

  // Moneyline
  if (/\bhome win\b/.test(m)) return homeScore > awayScore ? 'win' : 'loss'
  if (/\baway win\b/.test(m)) return awayScore > homeScore ? 'win' : 'loss'

  // Named team winner — if team name appears and no spread/ou keyword
  const htWord = (homeTeam || '').toLowerCase().split(' ').pop()
  const awWord = (awayTeam || '').toLowerCase().split(' ').pop()
  if (htWord && m.includes(htWord) && !m.includes('over') && !m.includes('under') && !/[+-]\d/.test(m))
    return homeScore > awayScore ? 'win' : 'loss'
  if (awWord && m.includes(awWord) && !m.includes('over') && !m.includes('under') && !/[+-]\d/.test(m))
    return awayScore > homeScore ? 'win' : 'loss'

  // Spread — ±N.N points
  const sp = m.match(/([+-]\d+(?:\.\d+)?)/)
  if (sp && !m.includes('over') && !m.includes('under')) {
    const line = parseFloat(sp[1])
    const isAway = awWord && m.includes(awWord)
    const diff   = isAway ? awayScore - homeScore : homeScore - awayScore
    return (diff + line) > 0 ? 'win' : 'loss'
  }

  // Over/Under
  const ou = parseOU(m)
  if (ou) return ouResult(ou, total)

  return null
}

// ── NFL grader ────────────────────────────────────────────────
function gradeNFL(market, homeScore, awayScore, homeTeam, awayTeam) {
  const m     = market.toLowerCase()
  const total = homeScore + awayScore

  if (/\bhome win\b/.test(m) || /moneyline/.test(m) && (() => {
    const htWord = (homeTeam || '').toLowerCase().split(' ').pop()
    return htWord && m.includes(htWord)
  })()) return homeScore > awayScore ? 'win' : 'loss'

  if (/\baway win\b/.test(m)) return awayScore > homeScore ? 'win' : 'loss'

  // Spread
  const sp = m.match(/([+-]\d+(?:\.\d+)?)/)
  if (sp && !m.includes('over') && !m.includes('under')) {
    const line   = parseFloat(sp[1])
    const awWord = (awayTeam || '').toLowerCase().split(' ').pop()
    const isAway = awWord && m.includes(awWord)
    const diff   = isAway ? awayScore - homeScore : homeScore - awayScore
    return (diff + line) > 0 ? 'win' : 'loss'
  }

  // Over/Under total points
  const ou = parseOU(m)
  if (ou) return ouResult(ou, total)

  return null
}

// ── Tennis grader ─────────────────────────────────────────────
// Odds API scores for tennis = sets won by each player
function gradeTennis(market, homeSets, awaySets, homeTeam, awayTeam) {
  const m     = market.toLowerCase()
  const total = homeSets + awaySets    // total sets

  // Match winner (any form)
  if (/\bhome win\b/.test(m)) return homeSets > awaySets ? 'win' : 'loss'
  if (/\baway win\b/.test(m)) return awaySets > homeSets ? 'win' : 'loss'

  // Named player winner
  const p1 = (homeTeam || '').toLowerCase().split(' ').pop()
  const p2 = (awayTeam || '').toLowerCase().split(' ').pop()
  if (p1 && m.includes(p1) && !m.includes('over') && !m.includes('under'))
    return homeSets > awaySets ? 'win' : 'loss'
  if (p2 && m.includes(p2) && !m.includes('over') && !m.includes('under'))
    return awaySets > homeSets ? 'win' : 'loss'

  // Total sets O/U (2.5, 3.5 in best-of-5; 1.5, 2.5 in best-of-3)
  const ou = parseOU(m)
  if (ou) return ouResult(ou, total)

  return null
}

// ── MMA/Boxing grader ─────────────────────────────────────────
// Odds API MMA scores: winner has higher "score" (method isn't graded here)
function gradeMMA(market, homeScore, awayScore, homeTeam, awayTeam) {
  const m = market.toLowerCase()

  // Moneyline / winner
  if (/\bhome win\b/.test(m)) return homeScore > awayScore ? 'win' : 'loss'
  if (/\baway win\b/.test(m)) return awayScore > homeScore ? 'win' : 'loss'

  const f1 = (homeTeam || '').toLowerCase().split(' ').pop()
  const f2 = (awayTeam || '').toLowerCase().split(' ').pop()
  if (f1 && m.includes(f1)) return homeScore > awayScore ? 'win' : 'loss'
  if (f2 && m.includes(f2)) return awayScore > homeScore ? 'win' : 'loss'

  // Over/Under rounds
  const ou = parseOU(m)
  if (ou) {
    const totalRounds = homeScore + awayScore  // Odds API represents rounds this way for MMA
    return ouResult(ou, totalRounds)
  }

  return null
}

// ── Grader router ─────────────────────────────────────────────
function grade(pick, game) {
  const scores = getScoreNums(game)
  if (!scores) return null

  const { home, away } = scores

  switch (pick.sport) {
    case 'Soccer':    return gradeSoccer(pick.market, home, away, pick.homeTeam, pick.awayTeam)
    case 'Basketball':return gradeNBA(pick.market, home, away, pick.homeTeam, pick.awayTeam)
    case 'Football':  return gradeNFL(pick.market, home, away, pick.homeTeam, pick.awayTeam)
    case 'Tennis':    return gradeTennis(pick.market, home, away, pick.homeTeam, pick.awayTeam)
    case 'MMA/Boxing':return gradeMMA(pick.market, home, away, pick.homeTeam, pick.awayTeam)
    default:          return null
  }
}

// ── Sharp Score ───────────────────────────────────────────────
async function recalculateSharpScore(userId) {
  const picks = await prisma.pick.findMany({
    where: { userId, result: { in: ['win', 'loss'] } }
  })
  if (!picks.length) return 0

  const n          = picks.length
  const totalStake = picks.reduce((s, p) => s + p.stake, 0)
  const totalPnl   = picks.reduce((s, p) => s + p.pnl,   0)
  const roi        = totalStake > 0 ? totalPnl / totalStake : 0

  const sampleFactor = Math.min(n / 30, 1)

  const avgOdds    = picks.reduce((s, p) => s + p.odds, 0) / n
  const oddsFactor = 1 + Math.log(Math.max(avgOdds, 1.01)) * 0.2

  const perPickROI   = picks.map(p => p.pnl / p.stake)
  const mean         = perPickROI.reduce((s, x) => s + x, 0) / n
  const variance     = perPickROI.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / n
  const streakFactor = 1 / (1 + Math.sqrt(variance) * 0.5)

  const clvPicks = picks.filter(p => p.clv != null)
  let clvFactor  = 1
  if (clvPicks.length >= 5) {
    const avgCLV = clvPicks.reduce((s, p) => s + p.clv, 0) / clvPicks.length
    clvFactor = 1 + Math.max(-0.2, Math.min(0.2, avgCLV / 50))
  }

  const raw = roi * 100 * sampleFactor * oddsFactor * streakFactor * clvFactor
  return Math.max(-100, Math.min(100, Math.round(raw * 100) / 100))
}

// ── CLV ───────────────────────────────────────────────────────
async function fetchClosingOdds(pick) {
  if (!pick.fixtureId || !process.env.ODDS_API_KEY) return null
  const leagues = LEAGUES[pick.sport] || []
  const m       = pick.market.toLowerCase()

  for (const league of leagues) {
    try {
      const r = await axios.get(`${ODDS_API}/sports/${league}/odds`, {
        params: { apiKey: process.env.ODDS_API_KEY, regions: 'eu', markets: 'h2h', oddsFormat: 'decimal', eventIds: pick.fixtureId },
        timeout: 6000
      })
      const game = r.data?.[0]
      if (!game) continue

      let best = null
      for (const bk of (game.bookmakers || [])) {
        const h2h     = bk.markets?.find(x => x.key === 'h2h')
        if (!h2h) continue
        let outcome = null
        if (/home win|^1$/.test(m))       outcome = h2h.outcomes.find(o => o.name === game.home_team)
        else if (/away win|^2$/.test(m))  outcome = h2h.outcomes.find(o => o.name === game.away_team)
        else if (/draw|^x$/.test(m))      outcome = h2h.outcomes.find(o => o.name === 'Draw')
        else                               outcome = h2h.outcomes.find(o => o.name === game.home_team)
        if (outcome && (!best || outcome.price > best)) best = outcome.price
      }
      if (best) return parseFloat(best.toFixed(3))
    } catch (_) {}
  }
  return null
}

// ── Push notification to tipster ──────────────────────────────
async function pushToTipster(userId, result, pick, pnl) {
  try {
    const subs = await prisma.pushSubscription.findMany({ where: { userId } })
    if (!subs.length || !process.env.VAPID_PUBLIC_KEY) return

    const emoji  = result === 'win' ? '✅' : '❌'
    const pnlStr = result === 'win' ? `+${pnl.toFixed(2)}u` : `${pnl.toFixed(2)}u`
    const payload = JSON.stringify({
      title: `${emoji} Pick ${result === 'win' ? 'Won' : 'Lost'} — ${pnlStr}`,
      body:  `${pick.event} · ${pick.market} @ ${parseFloat(pick.odds).toFixed(2)}`,
      url:   '/home'
    })

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        )
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          await prisma.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } }).catch(() => {})
        }
      }
    }
  } catch (_) {}
}

// ── Settle a single pick ──────────────────────────────────────
async function settlePick(pick, result) {
  const pnl = result === 'win'
    ? parseFloat(pick.stake) * (parseFloat(pick.odds) - 1)
    : -parseFloat(pick.stake)

  const closingOdds = await fetchClosingOdds(pick)
  const clv = closingOdds != null
    ? parseFloat(((pick.odds - closingOdds) / closingOdds * 100).toFixed(2))
    : null

  await prisma.pick.update({
    where: { id: pick.id },
    data:  { result, pnl: parseFloat(pnl.toFixed(2)), closingOdds, clv }
  })

  const sharpScore = await recalculateSharpScore(pick.userId)
  await prisma.user.update({ where: { id: pick.userId }, data: { sharpScore } })

  await pushToTipster(pick.userId, result, pick, pnl)

  const clvStr = clv != null ? ` | CLV ${clv >= 0 ? '+' : ''}${clv}%` : ''
  const pnlStr = result === 'win' ? `+${pnl.toFixed(2)}u` : `${pnl.toFixed(2)}u`
  console.log(`  ✅ [${pick.sport}] ${pick.event} · ${pick.market} → ${result.toUpperCase()} ${pnlStr}${clvStr} | SS ${sharpScore}`)
}

// ── Main verification loop ────────────────────────────────────
async function verifyAllPendingPicks() {
  const picks = await prisma.pick.findMany({
    where: { result: 'pending' }
  })
  if (!picks.length) return

  console.log(`🔍 Checking ${picks.length} pending pick(s)…`)

  // Group by sport for cleaner logs
  const bySport = {}
  for (const p of picks) {
    if (!bySport[p.sport]) bySport[p.sport] = []
    bySport[p.sport].push(p)
  }

  for (const [sport, sportPicks] of Object.entries(bySport)) {
    if (!LEAGUES[sport]) {
      console.log(`  ⚠️  No league config for sport: ${sport} — skipping`)
      continue
    }
    console.log(`  ${sportEmoji(sport)} ${sport}: ${sportPicks.length} pick(s)`)

    for (const pick of sportPicks) {
      try {
        const game   = await findGame(pick)
        if (!game) continue                  // game not finished / not found yet

        const result = grade(pick, game)
        if (!result) {
          console.log(`  ⚠️  Could not grade: "${pick.market}" for ${pick.event}`)
          continue
        }

        await settlePick(pick, result)
      } catch (err) {
        console.error(`  ⚠️  Error grading pick ${pick.id}:`, err.message)
      }
    }
  }
}

function sportEmoji(sport) {
  return { Soccer:'⚽', Basketball:'🏀', Football:'🏈', Tennis:'🎾', Baseball:'⚾', 'MMA/Boxing':'🥊' }[sport] || '🎯'
}

// ── Cron — every 5 minutes ────────────────────────────────────
cron.schedule('*/5 * * * *', async () => {
  console.log(`\n🤖 Auto-verify @ ${new Date().toLocaleTimeString()}`)
  _scoresCache.clear()   // fresh data each run
  try {
    await verifyAllPendingPicks()
    console.log('✅ Auto-verify done\n')
  } catch (err) {
    console.error('❌ Auto-verify error:', err.message)
  }
})

console.log('🤖 Auto-verify started — every 5 minutes')
