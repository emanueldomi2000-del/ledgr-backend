// LEDGR ELO System
// Add this to index.js in ledgr-backend

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const BASE_ELO = 1000
const K_BASE = 32

// Market difficulty multiplier
function getMarketDifficulty(market) {
  const m = market.toLowerCase()
  if (m.includes('correct score')) return 2.5
  if (m.includes('ht') && m.includes('ft')) return 2.2
  if (m.includes('winning margin')) return 2.0
  if (m.includes('btts') && m.includes('no')) return 1.6
  if (m.includes('over') || m.includes('under')) {
    const ou = m.match(/[\d.]+/)
    if (ou) {
      const line = parseFloat(ou[0])
      if (line >= 4.5) return 1.8
      if (line >= 3.5) return 1.5
      if (line >= 2.5) return 1.3
    }
  }
  if (m.includes('btts')) return 1.2
  if (m.includes('double chance')) return 0.8
  if (m.includes('home win') || m.includes('away win') || m.includes('draw')) return 1.0
  if (m.includes('spread')) return 1.3
  if (m.includes('total')) return 1.2
  return 1.0
}

// Expected score based on odds (higher odds = lower expected probability)
function getExpectedScore(odds) {
  const impliedProb = 1 / odds
  // Adjust for bookmaker margin
  return Math.min(0.95, Math.max(0.05, impliedProb * 0.9))
}

// Calculate ELO change for a pick
function calcELOChange(currentELO, odds, market, result, streak) {
  const expected = getExpectedScore(odds)
  const difficulty = getMarketDifficulty(market)
  const K = K_BASE * difficulty
  const actual = result === 'win' ? 1 : 0
  const streakBonus = result === 'win' && streak >= 3 ? Math.min(streak - 2, 5) * 2 : 0
  const change = Math.round(K * (actual - expected) + streakBonus)
  return change
}

// Recalculate ELO for ALL users from scratch
async function recalculateAllELO() {
  console.log('🎯 Recalculating ELO for all users...')
  
  try {
    const allPicks = await prisma.pick.findMany({
      where: { result: { in: ['win', 'loss'] } },
      include: { user: true },
      orderBy: { createdAt: 'asc' }
    })

    const userELO = {}
    const userStreak = {}

    for (const pick of allPicks) {
      const uid = pick.userId
      if (!userELO[uid]) userELO[uid] = BASE_ELO
      if (!userStreak[uid]) userStreak[uid] = 0

      const currentELO = userELO[uid]
      const streak = userStreak[uid]
      const change = calcELOChange(currentELO, pick.odds, pick.market, pick.result, streak)

      userELO[uid] = Math.max(100, currentELO + change)

      if (pick.result === 'win') {
        userStreak[uid]++
      } else {
        userStreak[uid] = 0
      }

      // Save ELO to pick for history
      await prisma.pick.update({
        where: { id: pick.id },
        data: { eloChange: change, eloAfter: userELO[uid] }
      })
    }

    // Save final ELO to each user
    for (const [userId, elo] of Object.entries(userELO)) {
      await prisma.user.update({
        where: { id: userId },
        data: { elo: Math.round(elo) }
      })
    }

    console.log(`✅ ELO updated for ${Object.keys(userELO).length} users`)
    return userELO

  } catch (err) {
    console.error('ELO recalc error:', err.message)
  }
}

// Update ELO for a single pick result (called from autoVerify)
async function updateELOForPick(pickId) {
  try {
    const pick = await prisma.pick.findUnique({
      where: { id: pickId },
      include: { user: true }
    })
    if (!pick || (pick.result !== 'win' && pick.result !== 'loss')) return

    const user = await prisma.user.findUnique({ where: { id: pick.userId } })
    const currentELO = user.elo || BASE_ELO

    // Get current streak
    const recentPicks = await prisma.pick.findMany({
      where: { userId: pick.userId, result: { in: ['win', 'loss'] } },
      orderBy: { createdAt: 'desc' },
      take: 20
    })
    let streak = 0
    for (const p of recentPicks) {
      if (p.id === pick.id) continue
      if (p.result === 'win') streak++
      else break
    }

    const change = calcELOChange(currentELO, pick.odds, pick.market, pick.result, streak)
    const newELO = Math.max(100, currentELO + change)

    await prisma.user.update({
      where: { id: pick.userId },
      data: { elo: Math.round(newELO) }
    })

    await prisma.pick.update({
      where: { id: pick.id },
      data: { eloChange: change, eloAfter: Math.round(newELO) }
    })

    console.log(`🎯 ELO: @${pick.user.username} ${currentELO} → ${Math.round(newELO)} (${change >= 0 ? '+' : ''}${change}) | ${pick.result} @ ${pick.odds}`)

  } catch (err) {
    console.error('ELO update error:', err.message)
  }
}

module.exports = { calcELOChange, updateELOForPick, recalculateAllELO, BASE_ELO }
