 const axios = require('axios')
const { PrismaClient } = require('@prisma/client')
const cron = require('node-cron')

const prisma = new PrismaClient()
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY

// Run every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  console.log('🔍 Checking pending picks...')
  
  try {
    // Get all pending picks
    const pendingPicks = await prisma.pick.findMany({
      where: { result: 'pending', sport: 'Soccer' }
    })

    if (!pendingPicks.length) {
      console.log('No pending soccer picks.')
      return
    }

    for (const pick of pendingPicks) {
      try {
        // Search for the fixture
        const response = await axios.get('https://v3.football.api-sports.io/fixtures', {
          headers: { 'x-apisports-key': FOOTBALL_API_KEY },
          params: { search: pick.event.split(' vs ')[0].trim(), last: 10 }
        })

        const fixtures = response.data.response
        if (!fixtures.length) continue

        // Find matching fixture
        const match = fixtures.find(f => {
          const home = f.teams.home.name.toLowerCase()
          const away = f.teams.away.name.toLowerCase()
          const eventLower = pick.event.toLowerCase()
          return eventLower.includes(home) || eventLower.includes(away)
        })

        if (!match) continue

        const status = match.fixture.status.short
        if (status !== 'FT') continue // Not finished yet

        const homeGoals = match.goals.home
        const awayGoals = match.goals.away
        const totalGoals = homeGoals + awayGoals

        // Determine result based on market
        let result = 'pending'
        const market = pick.market.toLowerCase()

        if (market.includes('over') && market.includes('1.5')) {
          result = totalGoals > 1 ? 'win' : 'loss'
        } else if (market.includes('over') && market.includes('2.5')) {
          result = totalGoals > 2 ? 'win' : 'loss'
        } else if (market.includes('over') && market.includes('0.5')) {
          result = totalGoals > 0 ? 'win' : 'loss'
        } else if (market.includes('btts') || market.includes('both teams')) {
          result = (homeGoals > 0 && awayGoals > 0) ? 'win' : 'loss'
        } else if (market.includes('home win') || market.includes('1x2') && market.startsWith('1')) {
          result = homeGoals > awayGoals ? 'win' : 'loss'
        } else if (market.includes('away win')) {
          result = awayGoals > homeGoals ? 'win' : 'loss'
        } else if (market.includes('draw')) {
          result = homeGoals === awayGoals ? 'win' : 'loss'
        }

        if (result !== 'pending') {
          const pnl = result === 'win' ? pick.stake * (pick.odds - 1) : -pick.stake
          await prisma.pick.update({
            where: { id: pick.id },
            data: { result, pnl }
          })
          console.log(`✅ Pick ${pick.id} updated: ${result} (${pick.event})`)
        }
      } catch (err) {
        console.log(`Error checking pick ${pick.id}:`, err.message)
      }
    }
  } catch (err) {
    console.log('Auto-verify error:', err.message)
  }
})

console.log('🤖 Auto-verify system started — checking every 5 minutes')

