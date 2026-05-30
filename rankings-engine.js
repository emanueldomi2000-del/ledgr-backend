'use strict'
const { Prisma } = require('@prisma/client')

// ─── Constants ────────────────────────────────────────────────────────────────
const ELO_START = 1000
const ELO_K     = 32
const ELO_FLOOR = 100

const DIVISION_THRESHOLDS = [
  { label: 'LEGENDARY', min: 92 },
  { label: 'ELITE',     min: 80 },
  { label: 'DIAMOND',   min: 65 },
  { label: 'PLATINUM',  min: 50 },
  { label: 'GOLD',      min: 35 },
  { label: 'SILVER',    min: 20 },
  { label: 'BRONZE',    min: 0  },
]

const ARCHETYPES = [
  { key: 'high-stakes',   test: s => s.currentStreak >= 5 || (s.sharpScore > 60 && s.roi > 30) },
  { key: 'sharp',         test: s => s.sharpScore > 70 },
  { key: 'data-nerd',     test: s => s.clvAvg != null && s.clvAvg > 2 && s.totalPicks >= 20 },
  { key: 'grinder',       test: s => s.totalPicks > 100 && s.roi > 0 },
  { key: 'underdog-king', test: s => (s.avgOdds || 0) > 3.0 && s.roi > 0 },
  { key: 'value-hunter',  test: s => (s.avgOdds || 0) >= 2.0 && (s.avgOdds || 0) <= 3.5 && s.roi > 5 && s.totalPicks >= 10 },
  { key: 'contender',     test: s => s.totalPicks >= 5 },
]

const FLOW_STATES = [
  { id: 'on_fire',        test: s => s.streakType === 'win'  && s.currentStreak >= 5 },
  { id: 'cold_streak',    test: s => s.streakType === 'loss' && Math.abs(s.currentStreak) >= 3 },
  { id: 'heating_up',     test: s => s.streakType === 'win'  && s.currentStreak >= 3 && s.currentStreak < 5 },
  { id: 'sharp_momentum', test: s => (s.clvAvg || 0) > 2 },
  { id: 'underdog',       test: s => (s.avgOdds || 0) > 3.0 && s.roi > 10 },
  { id: 'clv_leader',     test: s => (s.clvAvg || 0) > 4 },
  { id: 'consistent',     test: s => s.totalPicks >= 20 && s.winRate >= 0.55 },
  { id: 'contender',      test: s => s.elo >= 1200 },
]

const ARCHETYPE_META = {
  'high-stakes':   { icon: '💀', name: 'The Reaper',       color: '#FF1515' },
  'sharp':         { icon: '👁',  name: 'The Oracle',        color: '#00D4FF' },
  'value-hunter':  { icon: '💎', name: 'The Diamond Mind',  color: '#80E8FF' },
  'grinder':       { icon: '🦈', name: 'The Shark',         color: '#5878A0' },
  'underdog-king': { icon: '🐉', name: 'The Dragon Soul',   color: '#FF3322' },
  'specialist':    { icon: '👑', name: 'The Kingmaker',     color: '#C8A000' },
  'data-nerd':     { icon: '⬡',  name: 'The Void Emperor',  color: '#8B00FF' },
  'contender':     { icon: '🥊', name: 'The Contender',     color: '#94a3b8' },
}

const FLOW_META = {
  on_fire:        { icon: '🔥', label: '🔥 On Fire',        short: 'On Fire',        color: '#fb923c' },
  cold_streak:    { icon: '🥶', label: '🥶 Cold Streak',    short: 'Cold Streak',    color: '#7dd3fc' },
  heating_up:     { icon: '🌡️', label: '🌡️ Heating Up',    short: 'Heating Up',     color: '#fbbf24' },
  sharp_momentum: { icon: '📈', label: '📈 Sharp Momentum', short: 'Sharp Momentum', color: '#818cf8' },
  underdog:       { icon: '🐉', label: '🐉 Underdog',       short: 'Underdog',       color: '#e879f9' },
  clv_leader:     { icon: '💡', label: '💡 CLV Leader',     short: 'CLV Leader',     color: '#34d399' },
  consistent:     { icon: '🧱', label: '🧱 Consistent',     short: 'Consistent',     color: '#94a3b8' },
  contender:      { icon: '⚡', label: '⚡ Contender',      short: 'Contender',      color: '#f59e0b' },
}

// ─── Formula helpers ──────────────────────────────────────────────────────────

function calcEloChange(currentElo, result, odds, winStreak) {
  const rawIp    = 1 / (odds || 2)
  const ip       = Math.max(0.05, Math.min(0.95, rawIp * 0.9))
  const expected = 1 / (1 + Math.pow(10, (ELO_START - currentElo) / 400))
  const actual   = result === 'win' ? 1 : (result === 'push' ? 0.5 : 0)
  let delta = Math.round(ELO_K * (actual - expected))
  if (result === 'win' && winStreak >= 3) delta += Math.min((winStreak - 2), 5) * 2
  return Math.max(ELO_FLOOR, currentElo + delta) - currentElo
}

function calcDivisionScore(picks, winRate, roi) {
  return (
    Math.min(40, (roi / 20) * 40) +
    Math.min(30, ((winRate * 100) / 70) * 30) +
    Math.min(20, (picks / 100) * 20) +
    Math.min(10, picks)
  )
}

function divisionFromScore(score) {
  for (const t of DIVISION_THRESHOLDS) { if (score >= t.min) return t.label }
  return 'BRONZE'
}

function calcSharpScore(roi, totalPicks, avgOdds, currentStreak) {
  const sampleFactor = Math.min(1, totalPicks / 50)
  const oddsFactor   = Math.min(1.5, (avgOdds || 1.5) / 1.5)
  const streakFactor = currentStreak > 0 ? Math.min(1.3, 1 + currentStreak * 0.05) : 1
  return Math.max(0, Math.min(100, roi * sampleFactor * oddsFactor * streakFactor))
}

function calcReliabilityScore(totalPicks, winRate, bestStreak) {
  return Math.min(100,
    Math.min(40, (totalPicks / 50) * 40) +
    Math.min(40, (winRate * 100 / 70) * 40) +
    Math.min(20, (bestStreak / 10) * 20)
  )
}

function detectArchetype(stats) {
  for (const a of ARCHETYPES) { if (a.test(stats)) return a.key }
  return null
}

function detectFlowState(stats) {
  for (const f of FLOW_STATES) { if (f.test(stats)) return f.id }
  return null
}

function enrichArchetype(key) {
  if (!key || !ARCHETYPE_META[key]) return null
  return { key, ...ARCHETYPE_META[key] }
}

function enrichFlowState(id) {
  if (!id || !FLOW_META[id]) return null
  return { id, ...FLOW_META[id] }
}

function getISOWeek(date) {
  const d   = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
}

// ─── Core recalculation ───────────────────────────────────────────────────────
// Call after every pick is graded.
async function recalcUserRankings(prisma, userId) {
  const picks = await prisma.pick.findMany({
    where:   { userId, result: { in: ['win', 'loss', 'push'] } },
    select:  { result: true, odds: true, stake: true, pnl: true, sport: true, market: true, eloAfter: true, clv: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!picks.length) return

  let wins = 0, losses = 0, pushes = 0
  let totalStake = 0, totalPnl = 0
  let oddsSum = 0, oddsCount = 0
  let clvSum = 0, clvCount = 0
  let currentStreak = 0, bestStreak = 0
  let streakType = 'none'
  let elo = ELO_START, winStreakForElo = 0

  for (const p of picks) {
    if      (p.result === 'win')  wins++
    else if (p.result === 'loss') losses++
    else                          pushes++

    totalStake += p.stake || 0
    totalPnl   += p.pnl   || 0
    if (p.odds != null)  { oddsSum += p.odds; oddsCount++ }
    if (p.clv  != null)  { clvSum  += p.clv;  clvCount++  }

    if (p.result !== 'push') {
      winStreakForElo = p.result === 'win' ? winStreakForElo + 1 : 0
    }
    elo = p.eloAfter
      ? p.eloAfter
      : Math.max(ELO_FLOOR, elo + calcEloChange(elo, p.result, p.odds || 2, winStreakForElo))
  }

  const graded = picks.filter(p => p.result === 'win' || p.result === 'loss')
  if (graded.length) {
    const last = graded[graded.length - 1].result
    streakType = last === 'win' ? 'win' : 'loss'
    let streak = 0
    for (let i = graded.length - 1; i >= 0; i--) {
      if (graded[i].result === last) streak++; else break
    }
    currentStreak = streakType === 'win' ? streak : -streak
    let run = 0
    for (const p of graded) {
      if (p.result === 'win') { run++; bestStreak = Math.max(bestStreak, run) } else run = 0
    }
  }

  const totalPicks   = wins + losses + pushes
  const gradedCount  = wins + losses
  const winRate      = gradedCount > 0 ? wins / gradedCount : 0
  const roi          = totalStake > 0 ? (totalPnl / totalStake) * 100 : 0
  const avgOdds      = oddsCount > 0 ? oddsSum / oddsCount : null
  const clvAvg       = clvCount >= 5 ? clvSum / clvCount : null

  const divisionScore    = calcDivisionScore(totalPicks, winRate, roi)
  const division         = divisionFromScore(divisionScore)
  const sharpScore       = calcSharpScore(roi, totalPicks, avgOdds, currentStreak > 0 ? currentStreak : 0)
  const reliabilityScore = calcReliabilityScore(totalPicks, winRate, bestStreak)
  const lastPickAt       = picks[picks.length - 1].createdAt
  const isLive           = (Date.now() - new Date(lastPickAt).getTime()) < 2 * 60 * 60 * 1000

  const statsForDetection = { currentStreak, streakType, roi, totalPicks, sharpScore, avgOdds, winRate, elo, clvAvg }
  const archetype  = detectArchetype(statsForDetection)
  const flowState  = detectFlowState(statsForDetection)

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } })
  if (!user) return
  const { username } = user

  await prisma.$executeRaw`
    INSERT INTO user_rankings
      ("userId", username, "totalPicks", wins, losses, pushes,
       "totalStake", "totalPnl", roi, "winRate", elo, "divisionScore", division,
       "sharpScore", "reliabilityScore", "clvAvg", "clvSum", "clvCount",
       "currentStreak", "streakType", "bestStreak", archetype, "flowState",
       "isLive", "lastPickAt", "avgOdds")
    VALUES (
      ${userId}, ${username}, ${totalPicks}, ${wins}, ${losses}, ${pushes},
      ${parseFloat(totalStake.toFixed(2))}, ${parseFloat(totalPnl.toFixed(2))},
      ${parseFloat(roi.toFixed(4))}, ${parseFloat(winRate.toFixed(4))},
      ${elo}, ${parseFloat(divisionScore.toFixed(2))}, ${division},
      ${parseFloat(sharpScore.toFixed(2))}, ${parseFloat(reliabilityScore.toFixed(2))},
      ${clvAvg != null ? parseFloat(clvAvg.toFixed(4)) : null},
      ${parseFloat(clvSum.toFixed(4))}, ${clvCount},
      ${currentStreak}, ${streakType}, ${bestStreak},
      ${archetype}, ${flowState},
      ${isLive ? 1 : 0}, ${lastPickAt},
      ${avgOdds != null ? parseFloat(avgOdds.toFixed(4)) : null}
    )
    ON CONFLICT ("userId") DO UPDATE SET
      username           = EXCLUDED.username,
      "totalPicks"       = EXCLUDED."totalPicks",
      wins               = EXCLUDED.wins,
      losses             = EXCLUDED.losses,
      pushes             = EXCLUDED.pushes,
      "totalStake"       = EXCLUDED."totalStake",
      "totalPnl"         = EXCLUDED."totalPnl",
      roi                = EXCLUDED.roi,
      "winRate"          = EXCLUDED."winRate",
      elo                = EXCLUDED.elo,
      "divisionScore"    = EXCLUDED."divisionScore",
      division           = EXCLUDED.division,
      "sharpScore"       = EXCLUDED."sharpScore",
      "reliabilityScore" = EXCLUDED."reliabilityScore",
      "clvAvg"           = EXCLUDED."clvAvg",
      "clvSum"           = EXCLUDED."clvSum",
      "clvCount"         = EXCLUDED."clvCount",
      "currentStreak"    = EXCLUDED."currentStreak",
      "streakType"       = EXCLUDED."streakType",
      "bestStreak"       = EXCLUDED."bestStreak",
      archetype          = EXCLUDED.archetype,
      "flowState"        = EXCLUDED."flowState",
      "isLive"           = EXCLUDED."isLive",
      "lastPickAt"       = EXCLUDED."lastPickAt",
      "avgOdds"          = EXCLUDED."avgOdds",
      "updatedAt"        = NOW()
  `

  const recent = picks.slice(-3).reverse()
  await prisma.$executeRaw`DELETE FROM recent_picks_cache WHERE "userId" = ${userId}`
  for (let i = 0; i < recent.length; i++) {
    const p = recent[i]
    await prisma.$executeRaw`
      INSERT INTO recent_picks_cache ("userId", slot, result, sport, market, odds, "createdAt")
      VALUES (
        ${userId}, ${i}, ${p.result},
        ${p.sport || null}, ${p.market || null},
        ${p.odds != null ? parseFloat(p.odds.toFixed(4)) : null},
        ${p.createdAt}
      )
    `
  }
}

// ─── Weekly snapshot (cron: 59 23 * * 0) ─────────────────────────────────────
async function snapshotWeeklyRankings(prisma) {
  const now     = new Date()
  const isoWeek = `${now.getUTCFullYear()}-W${String(getISOWeek(now)).padStart(2, '0')}`

  const rows = await prisma.$queryRaw`
    SELECT "userId", username, elo, division, "divisionScore", "sharpScore", roi, "winRate", "totalPicks"
    FROM user_rankings ORDER BY elo DESC
  `

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    await prisma.$executeRaw`
      INSERT INTO ranking_history
        ("userId", username, "isoWeek", elo, division, "divisionScore", "sharpScore", roi, "winRate", "totalPicks", rank)
      VALUES (
        ${r.userId}, ${r.username}, ${isoWeek}, ${r.elo}, ${r.division},
        ${Number(r.divisionScore)}, ${Number(r.sharpScore)},
        ${Number(r.roi)}, ${Number(r.winRate)}, ${r.totalPicks}, ${i + 1}
      )
      ON CONFLICT ("userId", "isoWeek") DO UPDATE SET
        elo             = EXCLUDED.elo,
        division        = EXCLUDED.division,
        "divisionScore" = EXCLUDED."divisionScore",
        "sharpScore"    = EXCLUDED."sharpScore",
        roi             = EXCLUDED.roi,
        "winRate"       = EXCLUDED."winRate",
        "totalPicks"    = EXCLUDED."totalPicks",
        rank            = EXCLUDED.rank,
        "snapshotAt"    = NOW()
    `
  }
  console.log(`[rankings] Weekly snapshot: ${isoWeek}, ${rows.length} tipsters`)
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function _n(v) { return v != null ? Number(v) : null }

function formatRankingRow(r, recentPicks) {
  return {
    userId:           r.userId,
    username:         r.username,
    totalPicks:       r.totalPicks,
    wins:             r.wins,
    losses:           r.losses,
    pushes:           r.pushes,
    totalStake:       _n(r.totalStake),
    totalPnl:         _n(r.totalPnl),
    roi:              _n(r.roi),
    winRate:          _n(r.winRate),
    elo:              r.elo,
    divisionScore:    _n(r.divisionScore),
    division:         r.division,
    sharpScore:       _n(r.sharpScore),
    reliabilityScore: _n(r.reliabilityScore),
    clvAvg:           r.clvAvg != null ? _n(r.clvAvg) : null,
    currentStreak:    r.currentStreak,
    streakType:       r.streakType,
    bestStreak:       r.bestStreak,
    avgOdds:          r.avgOdds != null ? _n(r.avgOdds) : null,
    archetype:        enrichArchetype(r.archetype),
    flowState:        enrichFlowState(r.flowState),
    isLive:           !!r.isLive,
    lastPickAt:       r.lastPickAt,
    recentPicks,
  }
}

async function _computeTodayStats(prisma) {
  try {
    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)

    const graded = await prisma.pick.findMany({
      where:  { createdAt: { gte: todayStart }, result: { in: ['win', 'loss', 'push'] } },
      select: { result: true, pnl: true },
    })

    let winsToday = 0, lossesToday = 0, bigWinPnl = 0
    for (const p of graded) {
      if (p.result === 'win')  winsToday++
      if (p.result === 'loss') lossesToday++
      if ((p.pnl || 0) > bigWinPnl) bigWinPnl = p.pnl || 0
    }

    const activeGroups = await prisma.pick.groupBy({
      by:    ['userId'],
      where: { createdAt: { gte: todayStart } },
    })

    return { winsToday, lossesToday, bigWinPnl: bigWinPnl > 0 ? bigWinPnl : null, activeToday: activeGroups.length }
  } catch (e) {
    console.error('_computeTodayStats error:', e)
    return { winsToday: 0, lossesToday: 0, bigWinPnl: null, activeToday: 0 }
  }
}

// ─── Route registration ───────────────────────────────────────────────────────

function registerRoutes(app, prisma, requireInternal) {

  app.get('/rankings', async (req, res) => {
    try {
      const rows = await prisma.$queryRaw`SELECT * FROM user_rankings ORDER BY elo DESC`
      if (!rows.length) {
        return res.json({ tipsters: [], todayStats: await _computeTodayStats(prisma) })
      }

      const userIds   = rows.map(r => r.userId)
      const cacheRows = await prisma.$queryRaw`
        SELECT "userId", slot, result, sport, market, odds, "createdAt"
        FROM recent_picks_cache
        WHERE "userId" IN (${Prisma.join(userIds)})
        ORDER BY "userId", slot ASC
      `

      const cacheMap = {}
      for (const c of cacheRows) {
        if (!cacheMap[c.userId]) cacheMap[c.userId] = []
        cacheMap[c.userId].push({
          result:    c.result,
          sport:     c.sport,
          market:    c.market,
          odds:      c.odds != null ? _n(c.odds) : null,
          createdAt: c.createdAt,
        })
      }

      const tipsters   = rows.map(r => formatRankingRow(r, cacheMap[r.userId] || []))
      const todayStats = await _computeTodayStats(prisma)
      res.json({ tipsters, todayStats })
    } catch (e) {
      console.error('GET /rankings error:', e)
      res.status(500).json({ error: 'Server error' })
    }
  })

  app.get('/rankings/:username', async (req, res) => {
    const { username } = req.params
    if (!/^[a-zA-Z0-9_\-]{1,50}$/.test(username)) {
      return res.status(400).json({ error: 'Invalid username' })
    }
    try {
      const rows = await prisma.$queryRaw`
        SELECT * FROM user_rankings WHERE username = ${username} LIMIT 1
      `
      if (!rows.length) return res.json(null)

      const r = rows[0]
      const cacheRows = await prisma.$queryRaw`
        SELECT result, sport, market, odds, "createdAt"
        FROM recent_picks_cache WHERE "userId" = ${r.userId} ORDER BY slot ASC
      `
      const recentPicks = cacheRows.map(c => ({
        result:    c.result,
        sport:     c.sport,
        market:    c.market,
        odds:      c.odds != null ? _n(c.odds) : null,
        createdAt: c.createdAt,
      }))

      const rankRows = await prisma.$queryRaw`
        SELECT COUNT(*) + 1 AS rank FROM user_rankings WHERE elo > ${r.elo}
      `
      const rank = Number(rankRows[0].rank)

      res.json({ ...formatRankingRow(r, recentPicks), rank })
    } catch (e) {
      console.error('GET /rankings/:username error:', e)
      res.status(500).json({ error: 'Server error' })
    }
  })

  app.get('/rankings/:username/history', async (req, res) => {
    const { username } = req.params
    if (!/^[a-zA-Z0-9_\-]{1,50}$/.test(username)) {
      return res.status(400).json({ error: 'Invalid username' })
    }
    try {
      const rows = await prisma.$queryRaw`
        SELECT "isoWeek", elo, division, "divisionScore", "sharpScore", roi, "winRate", "totalPicks", rank, "snapshotAt"
        FROM ranking_history
        WHERE username = ${username}
        ORDER BY "isoWeek" ASC
        LIMIT 52
      `
      res.json(rows.map(r => ({
        ...r,
        divisionScore: _n(r.divisionScore),
        sharpScore:    _n(r.sharpScore),
        roi:           _n(r.roi),
        winRate:       _n(r.winRate),
      })))
    } catch (e) {
      console.error('GET /rankings/:username/history error:', e)
      res.status(500).json({ error: 'Server error' })
    }
  })

  app.post('/internal/rankings/recalculate/:userId', requireInternal, async (req, res) => {
    const { userId } = req.params
    if (!userId) return res.status(400).json({ error: 'Invalid userId' })
    try {
      await recalcUserRankings(prisma, userId)
      res.json({ success: true })
    } catch (e) {
      console.error('recalculate error:', e)
      res.status(500).json({ error: 'Server error' })
    }
  })

  app.post('/internal/rankings/recalculate-all', requireInternal, async (req, res) => {
    try {
      const users = await prisma.user.findMany({ select: { id: true } })
      let done = 0, failed = 0
      for (const u of users) {
        try { await recalcUserRankings(prisma, u.id); done++ }
        catch (e) { console.error(`recalc failed for userId=${u.id}:`, e); failed++ }
      }
      res.json({ success: true, done, failed })
    } catch (e) {
      console.error('recalculate-all error:', e)
      res.status(500).json({ error: 'Server error' })
    }
  })
}

module.exports = { recalcUserRankings, snapshotWeeklyRankings, registerRoutes }
