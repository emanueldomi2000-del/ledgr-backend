const { PrismaClient } = require('@prisma/client')
const cron = require('node-cron')

const prisma = new PrismaClient()

// ── Division helper (mirrors frontend formula) ─────────────────
function getDivision(wins, losses, stake, pnl, totalPicks) {
  const roi = stake > 0 ? (pnl / stake) * 100 : 0
  const wr  = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0
  const sc  = Math.round(
    Math.min(40, Math.max(0, (roi / 20) * 40)) +
    Math.min(30, Math.max(0, (wr  / 70) * 30)) +
    Math.min(20, Math.max(0, (totalPicks / 100) * 20)) +
    Math.min(10, totalPicks)
  )
  if (sc >= 90) return 'LEGEND'
  if (sc >= 75) return 'ELITE'
  if (sc >= 60) return 'DIAMOND'
  if (sc >= 45) return 'PLATINUM'
  if (sc >= 30) return 'GOLD'
  if (sc >= 15) return 'SILVER'
  return 'BRONZE'
}

// Sharp Score from picks array (same formula as autoVerify)
function calcSharpScore(picks) {
  const settled = picks.filter(p => p.result === 'win' || p.result === 'loss')
  if (!settled.length) return 0
  const n         = settled.length
  const totalStake = settled.reduce((s, p) => s + p.stake, 0)
  const totalPnl   = settled.reduce((s, p) => s + p.pnl,   0)
  const roi        = totalStake > 0 ? totalPnl / totalStake : 0
  const sampleFactor = Math.min(n / 30, 1)
  const avgOdds    = settled.reduce((s, p) => s + p.odds, 0) / n
  const oddsFactor = 1 + Math.log(Math.max(avgOdds, 1.01)) * 0.2
  const perPickROI = settled.map(p => (p.stake > 0 ? p.pnl / p.stake : 0))
  const mean       = perPickROI.reduce((s, x) => s + x, 0) / n
  const variance   = perPickROI.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / n
  const stdDev     = Math.sqrt(variance)
  const streakFactor = 1 / (1 + stdDev * 0.5)
  const clvPicks   = settled.filter(p => p.clv != null)
  let clvFactor    = 1
  if (clvPicks.length >= 5) {
    const avgCLV = clvPicks.reduce((s, p) => s + p.clv, 0) / clvPicks.length
    clvFactor = 1 + Math.max(-0.2, Math.min(0.2, avgCLV / 50))
  }
  const raw = roi * 100 * sampleFactor * oddsFactor * streakFactor * clvFactor
  return Math.max(-100, Math.min(100, Math.round(raw * 100) / 100))
}

// ── Core close logic (shared by cron + API route) ──────────────
async function closeSeason(season) {
  console.log(`📊 Closing season: ${season.name}`)

  // Get all picks for this season (by seasonId OR by date window)
  const picks = await prisma.pick.findMany({
    where: {
      OR: [
        { seasonId: season.id },
        {
          createdAt: { gte: season.startDate, lte: season.endDate },
          seasonId:  null
        }
      ]
    },
    include: { user: { select: { id: true, username: true } } }
  })

  // Aggregate by user — require min 5 picks for ranking
  const byUser = {}
  picks.forEach(p => {
    if (!p.user) return
    const u = p.user.id
    if (!byUser[u]) byUser[u] = { userId: u, username: p.user.username, picks: [] }
    byUser[u].picks.push(p)
  })

  const MIN_PICKS = 5
  const standings = Object.values(byUser)
    .filter(u => u.picks.filter(p => p.result !== 'pending').length >= MIN_PICKS)
    .map(u => {
      const settled = u.picks.filter(p => p.result !== 'pending')
      const wins    = settled.filter(p => p.result === 'win').length
      const losses  = settled.filter(p => p.result === 'loss').length
      const stake   = settled.reduce((s, p) => s + p.stake, 0)
      const pnl     = settled.reduce((s, p) => s + p.pnl,   0)
      const roi     = stake > 0 ? (pnl / stake) * 100 : 0
      const wr      = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0
      const ss      = calcSharpScore(u.picks)
      const div     = getDivision(wins, losses, stake, pnl, settled.length)
      return { userId: u.userId, username: u.username, roi, wr, totalPicks: settled.length, totalPnL: pnl, sharpScore: ss, division: div }
    })
    .sort((a, b) => b.roi - a.roi)

  // Upsert SeasonResult records
  for (let i = 0; i < standings.length; i++) {
    const s = standings[i]
    await prisma.seasonResult.upsert({
      where:  { seasonId_userId: { seasonId: season.id, userId: s.userId } },
      update: { rank: i + 1, roi: s.roi, winRate: s.wr, totalPicks: s.totalPicks, totalPnL: s.totalPnL, sharpScore: s.sharpScore, division: s.division },
      create: { seasonId: season.id, userId: s.userId, rank: i + 1, roi: s.roi, winRate: s.wr, totalPicks: s.totalPicks, totalPnL: s.totalPnL, sharpScore: s.sharpScore, division: s.division }
    })
  }

  const champion = standings.length > 0 ? standings[0].username : null

  // Mark season closed
  await prisma.season.update({
    where: { id: season.id },
    data:  { isActive: false, champion }
  })

  console.log(`✅ Season "${season.name}" closed. Champion: @${champion || '—'} | ${standings.length} tipsters ranked`)

  // Activate next season if it exists
  const next = await prisma.season.findFirst({
    where: { number: season.number + 1, isActive: false, champion: null }
  })
  if (next) {
    await prisma.season.update({ where: { id: next.id }, data: { isActive: true } })
    console.log(`🏁 Season "${next.name}" is now active`)
  }
}

// ── Seed seasons 1–3 ───────────────────────────────────────────
async function seedSeasons() {
  const seeds = [
    {
      name:      'Season 1',
      number:    1,
      startDate: new Date('2024-09-01T00:00:00Z'),
      endDate:   new Date('2024-12-31T23:59:59Z'),
      isActive:  false
    },
    {
      name:      'Season 2',
      number:    2,
      startDate: new Date('2025-01-01T00:00:00Z'),
      endDate:   new Date('2025-06-30T23:59:59Z'),
      isActive:  false
    },
    {
      name:      'Season 3',
      number:    3,
      startDate: new Date('2025-07-01T00:00:00Z'),
      endDate:   new Date('2026-08-31T23:59:59Z'),
      isActive:  true         // Currently active
    }
  ]

  for (const s of seeds) {
    const existing = await prisma.season.findUnique({ where: { number: s.number } })
    if (!existing) {
      await prisma.season.create({ data: s })
      console.log(`🌱 Seeded: ${s.name}`)
    }
  }
}

// ── Daily cron — check if active season has ended ──────────────
cron.schedule('0 0 * * *', async () => {
  console.log('\n📅 Season check running at', new Date().toISOString())
  try {
    const now    = new Date()
    const active = await prisma.season.findFirst({ where: { isActive: true } })
    if (!active) { console.log('No active season.'); return }
    if (now > new Date(active.endDate)) {
      console.log(`⏰ Season "${active.name}" has ended — auto-closing`)
      await closeSeason(active)
    } else {
      const daysLeft = Math.ceil((new Date(active.endDate) - now) / 86400000)
      console.log(`✅ Season "${active.name}" active — ${daysLeft} day(s) remaining`)
    }
  } catch (err) {
    console.error('Season cron error:', err.message)
  }
})

// Run seed on startup, then export closeSeason for use in routes
seedSeasons().catch(e => console.error('Season seed error:', e.message))

module.exports = { closeSeason }
