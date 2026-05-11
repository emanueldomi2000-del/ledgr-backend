const express = require('express')
const cors = require('cors')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { PrismaClient } = require('@prisma/client')
require('dotenv').config()
require('./autoVerify')
const axios = require('axios')

const app = express()
const prisma = new PrismaClient()

app.use(cors())
app.use(express.json())

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ message: 'LEDGR API is live! 🔥', timestamp: new Date().toISOString() })
})

app.get('/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now() })
})

// ── AUTH ──────────────────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
  try {
    const { email, username, password } = req.body
    if (!email || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields' })
    }
    // Validate username
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: 'Username: letters, numbers and _ only' })
    }
    if (username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' })
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' })
    }
    const hashed = await bcrypt.hash(password, 10)
    const user = await prisma.user.create({
      data: { email: email.toLowerCase().trim(), username: username.trim(), password: hashed }
    })
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '90d' })
    res.json({ token, user: { id: user.id, email: user.email, username: user.username } })
  } catch (err) {
    if (err.code === 'P2002') {
      const field = err.meta?.target?.includes('email') ? 'Email' : 'Username'
      return res.status(400).json({ error: field + ' already taken' })
    }
    res.status(500).json({ error: 'Server error — try again' })
  }
})

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ error: 'Missing email or password' })
    }
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() }
    })
    if (!user) return res.status(400).json({ error: 'No account found with this email' })
    const valid = await bcrypt.compare(password, user.password)
    if (!valid) return res.status(400).json({ error: 'Wrong password' })
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '90d' })
    res.json({ token, user: { id: user.id, email: user.email, username: user.username } })
  } catch (err) {
    res.status(500).json({ error: 'Server error — try again' })
  }
})

// ── PICKS ─────────────────────────────────────────────────────
app.get('/picks', async (req, res) => {
  try {
    const picks = await prisma.pick.findMany({
      include: { user: { select: { username: true } } },
      orderBy: { createdAt: 'desc' }
    })
    res.json(picks)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.post('/picks', async (req, res) => {
  try {
    const {
      userId, sport, event, fixtureId,
      homeTeam, awayTeam, market, odds, stake,
      result, pnl, stakeType, confidence, reasoning, commenceTime
    } = req.body

    if (!userId || !event || !market || !odds || !stake) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const lockedAt = commenceTime ? new Date(new Date(commenceTime).getTime() - 5 * 60 * 1000) : null

    const pick = await prisma.pick.create({
      data: {
        userId,
        sport: sport || 'Soccer',
        event,
        fixtureId: fixtureId || null,
        homeTeam: homeTeam || null,
        awayTeam: awayTeam || null,
        market,
        odds: parseFloat(odds),
        stake: parseFloat(stake),
        result: result || 'pending',
        pnl: parseFloat(pnl) || 0,
        stakeType: stakeType || 'units',
        confidence: confidence || null,
        reasoning: reasoning || null,
        lockedAt
      }
    })
    res.json(pick)
  } catch (err) {
    console.error('POST /picks error:', err.message)
    res.status(500).json({ error: 'Server error: ' + err.message })
  }
})

// ── FIXTURES ──────────────────────────────────────────────────
app.get('/fixtures', async (req, res) => {
  try {
    const sport = req.query.sport || 'Soccer'
    const dateOffset = parseInt(req.query.dateOffset) || 0

    const date = new Date()
    date.setDate(date.getDate() + dateOffset)
    const dateStr = date.toISOString().split('T')[0]

    const sportMap = {
      'Soccer': ['soccer_epl','soccer_spain_la_liga','soccer_italy_serie_a','soccer_germany_bundesliga','soccer_france_ligue_one','soccer_uefa_champs_league','soccer_uefa_europa_league'],
      'Basketball': ['basketball_nba'],
      'Football': ['americanfootball_nfl'],
      'Baseball': ['baseball_mlb'],
      'Tennis': ['tennis_atp_french_open','tennis_wta_french_open'],
      'MMA/Boxing': ['mma_mixed_martial_arts']
    }

    const leagues = sportMap[sport] || sportMap['Soccer']
    let allFixtures = []

    for (const league of leagues) {
      try {
        const r = await axios.get(`https://api.the-odds-api.com/v4/sports/${league}/odds`, {
          params: {
            apiKey: process.env.ODDS_API_KEY,
            regions: 'eu',
            markets: 'h2h',
            oddsFormat: 'decimal',
            commenceTimeFrom: dateStr + 'T00:00:00Z',
            commenceTimeTo: dateStr + 'T23:59:59Z'
          }
        })
        const fixtures = r.data.map(g => ({
          id: g.id,
          home: g.home_team,
          away: g.away_team,
          league: league.replace(/soccer_|basketball_|americanfootball_|baseball_|tennis_|mma_/g,'').replace(/_/g,' ').toUpperCase(),
          time: new Date(g.commence_time).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}),
          date: new Date(g.commence_time).toLocaleDateString('en')
        }))
        allFixtures = allFixtures.concat(fixtures)
      } catch(e) { continue }
    }

    res.json(allFixtures)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── PLAYERS ───────────────────────────────────────────────────
app.get('/players', async (req, res) => {
  try {
    const { homeTeam, awayTeam } = req.query

    async function getTeamPlayers(teamName) {
      const search = await axios.get('https://v3.football.api-sports.io/teams', {
        headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY },
        params: { name: teamName }
      })
      const team = search.data.response[0]
      if (!team) return { all: [], gk: [] }
      const players = await axios.get('https://v3.football.api-sports.io/players/squads', {
        headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY },
        params: { team: team.team.id }
      })
      const squad = players.data.response[0]?.players || []
      return {
        all: squad.filter(p => p.position !== 'Goalkeeper').map(p => p.name),
        gk: squad.filter(p => p.position === 'Goalkeeper').map(p => p.name)
      }
    }

    const [home, away] = await Promise.all([
      getTeamPlayers(homeTeam),
      getTeamPlayers(awayTeam)
    ])
    res.json({ home: home.all, away: away.all, homeGK: home.gk, awayGK: away.gk })
  } catch (err) {
    res.json({ home: [], away: [], homeGK: [], awayGK: [] })
  }
})

// ── STRIPE ────────────────────────────────────────────────────
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder')

app.post('/create-checkout', async (req, res) => {
  try {
    const { tipsterUsername, priceAmount } = req.body
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `LEDGR — Subscribe to @${tipsterUsername}`,
            description: `Monthly subscription to @${tipsterUsername} picks`
          },
          unit_amount: priceAmount * 100,
          recurring: { interval: 'month' }
        },
        quantity: 1
      }],
      mode: 'subscription',
      success_url: `https://getledgr.bet/home?subscribed=true`,
      cancel_url: `https://getledgr.bet/tipster?u=${tipsterUsername}`
    })
    res.json({ url: session.url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── FOLLOW SYSTEM ────────────────────────────────────────────
app.post('/follow', async (req, res) => {
  try {
    const { followerId, followingId } = req.body
    if (!followerId || !followingId) return res.status(400).json({ error: 'Missing followerId or followingId' })
    if (followerId === followingId) return res.status(400).json({ error: 'Cannot follow yourself' })
    const follow = await prisma.follow.create({
      data: { followerId, followingId }
    })
    res.json(follow)
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Already following' })
    res.status(500).json({ error: 'Server error' })
  }
})

app.delete('/follow', async (req, res) => {
  try {
    const { followerId, followingId } = req.body
    if (!followerId || !followingId) return res.status(400).json({ error: 'Missing followerId or followingId' })
    await prisma.follow.deleteMany({ where: { followerId, followingId } })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.get('/followers/:userId', async (req, res) => {
  try {
    const { userId } = req.params
    const rows = await prisma.follow.findMany({
      where: { followingId: userId },
      include: { follower: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ count: rows.length, followers: rows.map(r => r.follower) })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.get('/following/:userId', async (req, res) => {
  try {
    const { userId } = req.params
    const rows = await prisma.follow.findMany({
      where: { followerId: userId },
      include: { following: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ count: rows.length, following: rows.map(r => r.following) })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── KEEP ALIVE — ping self every 10 minutes to prevent sleep ──
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`LEDGR API running on port ${PORT} 🚀`)

  // Self-ping every 10 minutes to keep Railway awake
  setInterval(async () => {
    try {
      await axios.get(`http://localhost:${PORT}/ping`)
      console.log('🟢 Keep-alive ping sent')
    } catch(e) {
      console.log('⚠️ Keep-alive ping failed:', e.message)
    }
  }, 10 * 60 * 1000)
})
