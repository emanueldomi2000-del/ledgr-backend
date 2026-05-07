

const express = require('express')
const cors = require('cors')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { PrismaClient } = require('@prisma/client')
require('dotenv').config()
require('./autoVerify')

const app = express()
const prisma = new PrismaClient()

app.use(cors())
app.use(express.json())

// TEST ROUTE
app.get('/', (req, res) => {
  res.json({ message: 'LEDGR API is live! 🔥' })
})

// REGISTER
app.post('/auth/register', async (req, res) => {
  try {
    const { email, username, password } = req.body
    const hashed = await bcrypt.hash(password, 10)
    const user = await prisma.user.create({
      data: { email, username, password: hashed }
    })
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET)
    res.json({ token, user: { id: user.id, email, username } })
  } catch (err) {
    res.status(400).json({ error: 'User already exists' })
  }
})

// LOGIN
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) return res.status(400).json({ error: 'User not found' })
    const valid = await bcrypt.compare(password, user.password)
    if (!valid) return res.status(400).json({ error: 'Wrong password' })
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET)
    res.json({ token, user: { id: user.id, email, username: user.username } })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// GET ALL PICKS
app.get('/picks', async (req, res) => {
  const picks = await prisma.pick.findMany({
    include: { user: { select: { username: true } } },
    orderBy: { createdAt: 'desc' }
  })
  res.json(picks)
})

// ADD PICK
app.post('/picks', async (req, res) => {
  try {
    const { userId, sport, event, fixtureId, homeTeam, awayTeam, market, odds, stake, result, pnl } = req.body
    const pick = await prisma.pick.create({
      data: { userId, sport, event, fixtureId, homeTeam, awayTeam, market, odds, stake, result, pnl }
    })
    res.json(pick)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})
app.post('/picks', async (req, res) => {
  try {
    const { userId, sport, event, market, odds, stake, result, pnl } = req.body
    const pick = await prisma.pick.create({
      data: { userId, sport, event, market, odds, stake, result, pnl }
    })
    res.json(pick)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// UPDATE PICK RESULT
app.put('/picks/:id', async (req, res) => {
  try {
    const { result, pnl } = req.body
    const pick = await prisma.pick.update({
      where: { id: req.params.id },
      data: { result, pnl }
    })
    res.json(pick)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// DELETE PICK
app.delete('/picks/:id', async (req, res) => {
  try {
    await prisma.pick.delete({ where: { id: req.params.id } })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})
// STRIPE
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder')

// CREATE SUBSCRIPTION CHECKOUT
app.post('/create-checkout', async (req, res) => {
  try {
    const { tipsterUsername, priceAmount, userId } = req.body
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
      success_url: `https://getledgr.bet/dashboard?subscribed=true`,
      cancel_url: `https://getledgr.bet/tipster?u=${tipsterUsername}`
    })
    res.json({ url: session.url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
// GET FIXTURES FROM THE ODDS API
app.get('/fixtures', async (req, res) => {
  try {
    const axios = require('axios')
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
            commenceTimeFrom: dateStr+'T00:00:00Z',
            commenceTimeTo: dateStr+'T23:59:59Z'
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
app.get('/players', async (req, res) => {
  try {
    const axios = require('axios')
    const { fixtureId } = req.query
    const r = await axios.get('https://v3.football.api-sports.io/fixtures/players', {
      headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY },
      params: { fixture: fixtureId }
    })
    const teams = r.data.response
    if (!teams || !teams.length) return res.json({ home: [], away: [], homeGK: [], awayGK: [] })
    const mapPlayers = (team) => team.players.map(p => p.player.name)
    const mapGK = (team) => team.players.filter(p => p.statistics[0]?.games?.position === 'G').map(p => p.player.name)
    res.json({
      home: mapPlayers(teams[0]),
      away: mapPlayers(teams[1]),
      homeGK: mapGK(teams[0]),
      awayGK: mapGK(teams[1])
    })
  } catch (err) {
    res.json({ home: [], away: [], homeGK: [], awayGK: [] })
  }
})
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`LEDGR API running on port ${PORT} 🚀`)
})
 
