const axios = require('axios')
const { PrismaClient } = require('@prisma/client')
const cron = require('node-cron')
const prisma = new PrismaClient()

const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY

// ── HELPERS ───────────────────────────────────────────────────

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

  // Result
  if (m.includes('home win') || m === '1' || m.includes('(1)')) {
    return homeGoals > awayGoals ? 'win' : 'loss'
  }
  if (m.includes('away win') || m === '2' || m.includes('(2)')) {
    return awayGoals > homeGoals ? 'win' : 'loss'
  }
  if (m.includes('draw') || m === 'x') {
    return homeGoals === awayGoals ? 'win' : 'loss'
  }

  // Double Chance
  if (m.includes('1x') || m.includes('home or draw')) {
    return homeGoals >= awayGoals ? 'win' : 'loss'
  }
  if (m.includes('x2') || m.includes('away or draw')) {
    return awayGoals >= homeGoals ? 'win' : 'loss'
  }
  if (m === '12' || m.includes('home or away')) {
    return homeGoals !== awayGoals ? 'win' : 'loss'
  }

  // BTTS
  if (m.includes('btts yes') || m.includes('both teams to score yes') || m.includes('both teams yes')) {
    return (homeGoals > 0 && awayGoals > 0) ? 'win' : 'loss'
  }
  if (m.includes('btts no') || m.includes('both teams to score no') || m.includes('both teams no')) {
    return (homeGoals === 0 || awayGoals === 0) ? 'win' : 'loss'
  }

  // Total Goals Over/Under
  const ou = parseOverUnder(m)
  if (ou && (m.includes('goal') || (!m.includes('corner') && !m.includes('card') && !m.includes('shot')))) {
    // Check if team-specific
    const isHome = homeTeam && m.includes(homeTeam.toLowerCase().split(' ').slice(-1)[0])
    const isAway = awayTeam && m.includes(awayTeam.toLowerCase().split(' ').slice(-1)[0])
    const goals = isHome ? homeGoals : isAway ? awayGoals : totalGoals
    return ou.type === 'over' ? (goals > ou.line ? 'win' : 'loss') : (goals < ou.line ? 'win' : 'loss')
  }

  // Correct Score
  const scoreMatch = m.match(/(\d+)-(\d+)/)
  if (scoreMatch) {
    const h = parseInt(scoreMatch[1]), a = parseInt(scoreMatch[2])
    return (homeGoals === h && awayGoals === a) ? 'win' : 'loss'
  }

  // HT/FT
  if (m.includes('ht') && m.includes('ft')) {
    // Can't grade without HT score — skip
    return null
  }

  return null
}

function gradeNBAPick(market, homeScore, awayScore, spread) {
  const m = market.toLowerCase()
  const total = homeScore + awayScore
  const homeDiff = homeScore - awayScore

  // Winner
  if (m.includes('home win')) return homeScore > awayScore ? 'win' : 'loss'
  if (m.includes('away win')) return awayScore > homeScore ? 'win' : 'loss'

  // Spread
  if (m.match(/[+-][\d.]+/)) {
    const spreadMatch = m.match(/([+-][\d.]+)/)
    if (spreadMatch) {
      const line = parseFloat(spreadMatch[1])
      if (line < 0) {
        // Favorite covers
        return homeDiff + line > 0 ? 'win' : 'loss'
      } else {
        // Underdog covers
        return homeDiff + line > 0 ? 'win' : 'loss'
      }
    }
  }

  // Total Points
  const ou = parseOverUnder(m)
  if (ou && m.includes('pts')) {
    return ou.type === 'over' ? (total > ou.line ? 'win' : 'loss') : (total < ou.line ? 'win' : 'loss')
  }
  if (ou) {
    return ou.type === 'over' ? (total > ou.line ? 'win' : 'loss') : (total < ou.line ? 'win' : 'loss')
  }

  return null
}

// ── SOCCER AUTO-VERIFY ────────────────────────────────────────
async function verifySoccerPicks() {
  const picks = await prisma.pick.findMany({
    where: { result: 'pending', sport: 'Soccer' }
  })
  if (!picks.length) return

  console.log(`⚽ Checking ${picks.length} pending soccer picks...`)

  for (const pick of picks) {
    try {
      // Try by fixtureId first (more accurate)
      let fixture = null

      if (pick.fixtureId) {
        const r = await axios.get('https://v3.football.api-sports.io/fixtures', {
          headers: { 'x-apisports-key': FOOTBALL_API_KEY },
          params: { id: pick.fixtureId }
        })
        fixture = r.data.response[0]
      }

      // Fallback: search by team name
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

      const result = gradeSoccerPick(
        pick.market,
        homeGoals,
        awayGoals,
        pick.homeTeam,
        pick.awayTeam
      )

      if (result && result !== 'pending') {
        const pnl = result === 'win'
          ? parseFloat(pick.stake) * (parseFloat(pick.odds) - 1)
          : -parseFloat(pick.stake)

        await prisma.pick.update({
          where: { id: pick.id },
          data: { result, pnl: parseFloat(pnl.toFixed(2)) }
        })
        console.log(`✅ Pick ${pick.id} → ${result} | ${pick.event} | ${pick.market}`)
      }

    } catch (err) {
      console.log(`⚠️  Error checking pick ${pick.id}:`, err.message)
    }
  }
}

// ── NBA AUTO-VERIFY ───────────────────────────────────────────
async function verifyNBAPicks() {
  const picks = await prisma.pick.findMany({
    where: { result: 'pending', sport: 'Basketball' }
  })
  if (!picks.length) return

  console.log(`🏀 Checking ${picks.length} pending NBA picks...`)

  for (const pick of picks) {
    try {
      // Use The Odds API scores endpoint
      const r = await axios.get('https://api.the-odds-api.com/v4/sports/basketball_nba/scores', {
        params: {
          apiKey: process.env.ODDS_API_KEY,
          daysFrom: 3
        }
      })

      const eventLower = pick.event.toLowerCase()
      const game = r.data.find(g => {
        return eventLower.includes(g.home_team.toLowerCase()) ||
               eventLower.includes(g.away_team.toLowerCase())
      })

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
        console.log(`✅ NBA Pick ${pick.id} → ${result} | ${pick.event}`)
      }

    } catch (err) {
      console.log(`⚠️  NBA error pick ${pick.id}:`, err.message)
    }
  }
}

// ── TENNIS AUTO-VERIFY ────────────────────────────────────────
async function verifyTennisPicks() {
  const picks = await prisma.pick.findMany({
    where: { result: 'pending', sport: 'Tennis' }
  })
  if (!picks.length) return

  for (const pick of picks) {
    try {
      const leagues = ['tennis_atp_french_open', 'tennis_wta_french_open', 'tennis_atp_us_open', 'tennis_wta_us_open']
      for (const league of leagues) {
        const r = await axios.get(`https://api.the-odds-api.com/v4/sports/${league}/scores`, {
          params: { apiKey: process.env.ODDS_API_KEY, daysFrom: 3 }
        })
        const eventLower = pick.event.toLowerCase()
        const game = r.data.find(g =>
          eventLower.includes(g.home_team.toLowerCase()) ||
          eventLower.includes(g.away_team.toLowerCase())
        )
        if (!game || !game.completed) continue

        const m = pick.market.toLowerCase()
        const homeWon = game.scores?.[0]?.name === game.home_team
        let result = null
        if (m.includes('home win')) result = homeWon ? 'win' : 'loss'
        if (m.includes('away win')) result = !homeWon ? 'win' : 'loss'

        if (result) {
          const pnl = result === 'win'
            ? parseFloat(pick.stake) * (parseFloat(pick.odds) - 1)
            : -parseFloat(pick.stake)
          await prisma.pick.update({
            where: { id: pick.id },
            data: { result, pnl: parseFloat(pnl.toFixed(2)) }
          })
          console.log(`✅ Tennis Pick ${pick.id} → ${result}`)
        }
        break
      }
    } catch (err) {
      console.log(`⚠️  Tennis error pick ${pick.id}:`, err.message)
    }
  }
}

// ── CRON JOB ─────────────────────────────────────────────────
// Runs every 10 minutes
cron.schedule('*/10 * * * *', async () => {
  console.log('\n🤖 Auto-verify running at', new Date().toLocaleTimeString())
  try {
    await verifySoccerPicks()
    await verifyNBAPicks()
    await verifyTennisPicks()
    console.log('✅ Auto-verify complete\n')
  } catch (err) {
    console.log('❌ Auto-verify failed:', err.message)
  }
})

console.log('🤖 Auto-verify system started — running every 10 minutes')
