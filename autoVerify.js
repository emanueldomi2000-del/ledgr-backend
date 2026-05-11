const axios = require('axios')
const { PrismaClient } = require('@prisma/client')
const cron = require('node-cron')
const prisma = new PrismaClient()

const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY

async function recalculateSharpScore(userId) {
  const picks = await prisma.pick.findMany({
    where: { userId, result: { in: ['win', 'loss'] } }
  })
  if (!picks.length) return 0

  const n = picks.length
  const totalStake = picks.reduce((s, p) => s + p.stake, 0)
  const totalPnl = picks.reduce((s, p) => s + p.pnl, 0)
  const roi = totalStake > 0 ? totalPnl / totalStake : 0

  // Shrink toward 0 for small samples; full weight at 30 picks
  const sampleFactor = Math.min(n / 30, 1)

  // Reward picking at higher (harder) odds
  const avgOdds = picks.reduce((s, p) => s + p.odds, 0) / n
  const oddsFactor = 1 + Math.log(Math.max(avgOdds, 1.01)) * 0.2

  // Penalise high variance in per-pick ROI (streak instability)
  const perPickROI = picks.map(p => p.pnl / p.stake)
  const mean = perPickROI.reduce((s, x) => s + x, 0) / n
  const variance = perPickROI.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / n
  const stdDev = Math.sqrt(variance)
  const streakFactor = 1 / (1 + stdDev * 0.5)

  const raw = roi * 100 * sampleFactor * oddsFactor * streakFactor
  return Math.max(-100, Math.min(100, Math.round(raw * 100) / 100))
}

function parseOverUnder(market) {
  const m = market.toLowerCase()
  const overMatch = m.match(/over\s+([\d.]+)/)
  const underMatch = m.match(/under\s+([\d.]+)/)
  if (overMatch) return { type: 'over', line: parseFloat(overMatch[1]) }
  if (underMatch) return { type: 'under', line: parseFloat(underMatch[1]) }
  return null
}

function gradeSoccerPick(market, homeGoals, awayGoals, homeTeam, awayTeam) {
  const m = market.toLowerCase()
  const totalGoals = homeGoals + awayGoals
  if (m.includes('home win') || m === '1' || m.includes('(1)')) return homeGoals > awayGoals ? 'win' : 'loss'
  if (m.includes('away win') || m === '2' || m.includes('(2)')) return awayGoals > homeGoals ? 'win' : 'loss'
  if (m.includes('draw') || m === 'x') return homeGoals === awayGoals ? 'win' : 'loss'
  if (m.includes('1x') || m.includes('home or draw')) return homeGoals >= awayGoals ? 'win' : 'loss'
  if (m.includes('x2') || m.includes('away or draw')) return awayGoals >= homeGoals ? 'win' : 'loss'
  if (m === '12' || m.includes('home or away')) return homeGoals !== awayGoals ? 'win' : 'loss'
  if (m.includes('btts yes') || m.includes('both teams to score yes')) return (homeGoals > 0 && awayGoals > 0) ? 'win' : 'loss'
  if (m.includes('btts no') || m.includes('both teams to score no')) return (homeGoals === 0 || awayGoals === 0) ? 'win' : 'loss'
  const ou = parseOverUnder(m)
  if (ou) {
    const isHome = homeTeam && m.includes(homeTeam.toLowerCase().split(' ').slice(-1)[0])
    const isAway = awayTeam && m.includes(awayTeam.toLowerCase().split(' ').slice(-1)[0])
    const goals = isHome ? homeGoals : isAway ? awayGoals : totalGoals
    return ou.type === 'over' ? (goals > ou.line ? 'win' : 'loss') : (goals < ou.line ? 'win' : 'loss')
  }
  const scoreMatch = m.match(/(\d+)-(\d+)/)
  if (scoreMatch) {
    const h = parseInt(scoreMatch[1]), a = parseInt(scoreMatch[2])
    return (homeGoals === h && awayGoals === a) ? 'win' : 'loss'
  }
  return null
}

function gradeNBAPick(market, homeScore, awayScore) {
  const m = market.toLowerCase()
  const total = homeScore + awayScore
  if (m.includes('home win')) return homeScore > awayScore ? 'win' : 'loss'
  if (m.includes('away win')) return awayScore > homeScore ? 'win' : 'loss'
  const spreadMatch = m.match(/([+-][\d.]+)/)
  if (spreadMatch) {
    const line = parseFloat(spreadMatch[1])
    return (homeScore - awayScore) + line > 0 ? 'win' : 'loss'
  }
  const ou = parseOverUnder(m)
  if (ou) return ou.type === 'over' ? (total > ou.line ? 'win' : 'loss') : (total < ou.line ? 'win' : 'loss')
  return null
}

async function verifySoccerPicks() {
  try {
    const picks = await prisma.pick.findMany({ where: { result: 'pending', sport: 'Soccer' } })
    if (!picks.length) return
    console.log(`⚽ Checking ${picks.length} pending soccer picks...`)
    for (const pick of picks) {
      try {
        let fixture = null
        if (pick.fixtureId) {
          const r = await axios.get('https://v3.football.api-sports.io/fixtures', {
            headers: { 'x-apisports-key': FOOTBALL_API_KEY },
            params: { id: pick.fixtureId }
          })
          fixture = r.data.response[0]
        }
        if (!fixture && pick.homeTeam) {
          const r = await axios.get('https://v3.football.api-sports.io/fixtures', {
            headers: { 'x-apisports-key': FOOTBALL_API_KEY },
            params: { team: pick.homeTeam, last: 5 }
          })
          const eventLower = pick.event.toLowerCase()
          fixture = r.data.response.find(f => {
            const home = f.teams.home.name.toLowerCase()
            const away = f.teams.away.name.toLowerCase()
            return eventLower.includes(home) || eventLower.includes(away)
          })
        }
        if (!fixture) continue
        const status = fixture.fixture.status.short
        if (status !== 'FT' && status !== 'AET' && status !== 'PEN') continue
        const homeGoals = fixture.goals.home
        const awayGoals = fixture.goals.away
        if (homeGoals === null || awayGoals === null) continue
        const result = gradeSoccerPick(pick.market, homeGoals, awayGoals, pick.homeTeam, pick.awayTeam)
        if (result) {
          const pnl = result === 'win'
            ? parseFloat(pick.stake) * (parseFloat(pick.odds) - 1)
            : -parseFloat(pick.stake)
          await prisma.pick.update({
            where: { id: pick.id },
            data: { result, pnl: parseFloat(pnl.toFixed(2)) }
          })
          const sharpScore = await recalculateSharpScore(pick.userId)
          await prisma.user.update({ where: { id: pick.userId }, data: { sharpScore } })
          console.log(`✅ Pick ${pick.id} → ${result} | ${pick.event} | sharpScore → ${sharpScore}`)
        }
      } catch (err) {
        console.log(`⚠️ Error pick ${pick.id}:`, err.message)
      }
    }
  } catch (err) {
    console.log('Soccer verify error:', err.message)
  }
}

async function verifyNBAPicks() {
  try {
    const picks = await prisma.pick.findMany({ where: { result: 'pending', sport: 'Basketball' } })
    if (!picks.length) return
    for (const pick of picks) {
      try {
        const r = await axios.get('https://api.the-odds-api.com/v4/sports/basketball_nba/scores', {
          params: { apiKey: process.env.ODDS_API_KEY, daysFrom: 3 }
        })
        const eventLower = pick.event.toLowerCase()
        const game = r.data.find(g =>
          eventLower.includes(g.home_team.toLowerCase()) || eventLower.includes(g.away_team.toLowerCase())
        )
        if (!game || !game.completed) continue
        const homeScore = game.scores?.find(s => s.name === game.home_team)?.score
        const awayScore = game.scores?.find(s => s.name === game.away_team)?.score
        if (!homeScore || !awayScore) continue
        const result = gradeNBAPick(pick.market, parseInt(homeScore), parseInt(awayScore))
        if (result) {
          const pnl = result === 'win'
            ? parseFloat(pick.stake) * (parseFloat(pick.odds) - 1)
            : -parseFloat(pick.stake)
          await prisma.pick.update({
            where: { id: pick.id },
            data: { result, pnl: parseFloat(pnl.toFixed(2)) }
          })
          const sharpScore = await recalculateSharpScore(pick.userId)
          await prisma.user.update({ where: { id: pick.userId }, data: { sharpScore } })
          console.log(`✅ NBA Pick ${pick.id} → ${result} | sharpScore → ${sharpScore}`)
        }
      } catch (err) {
        console.log(`⚠️ NBA error:`, err.message)
      }
    }
  } catch (err) {
    console.log('NBA verify error:', err.message)
  }
}

cron.schedule('*/10 * * * *', async () => {
  console.log('\n🤖 Auto-verify running at', new Date().toLocaleTimeString())
  try {
    await verifySoccerPicks()
    await verifyNBAPicks()
    console.log('✅ Auto-verify complete\n')
  } catch (err) {
    console.log('❌ Error:', err.message)
  }
})

console.log('🤖 Auto-verify system started — every 10 minutes')
