const express       = require('express')
const http          = require('http')
const cors          = require('cors')
const bcrypt        = require('bcryptjs')
const jwt           = require('jsonwebtoken')
const nodemailer    = require('nodemailer')
const webpush       = require('web-push')
const WebSocket     = require('ws')
const rateLimit     = require('express-rate-limit')
const { PrismaClient } = require('@prisma/client')
require('dotenv').config()
require('./autoVerify')
const { closeSeason } = require('./seasons')
const axios = require('axios')

// ── WEB PUSH ──────────────────────────────────────────────────
let vapidReady = false
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(
      'mailto:' + (process.env.EMAIL_USER || 'admin@getledgr.bet'),
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    )
    vapidReady = true
    console.log('✅ VAPID keys loaded')
  } catch (err) {
    console.warn('⚠️  VAPID setup failed (invalid keys) — push notifications disabled:', err.message)
  }
} else {
  console.warn('⚠️  VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push notifications disabled')
}

const app    = express()
const prisma = new PrismaClient()

app.use(cors())
app.use(express.json())

// ── RATE LIMITERS ─────────────────────────────────────────────
const TOO_MANY = { error: 'Too many requests. Please slow down.' }

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: TOO_MANY
})

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: TOO_MANY
})

const pickLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 20,
  keyGenerator: (req) => req.body?.userId || req.ip,  // per user, not just IP
  standardHeaders: true,
  legacyHeaders: false,
  message: TOO_MANY
})

const followLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: TOO_MANY
})

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,    // 1 minute
  max: 30,
  keyGenerator: (req) => req.userId || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: TOO_MANY
})

// Apply general limiter to every route
app.use(generalLimiter)

// ── BOT DETECTION & IP BLACKLIST ──────────────────────────────
const ipBlacklist = new Map()   // ip → { reason, blockedAt }

// Per-IP burst tracker: block IPs sending >20 requests in 1 second
const burstTracker  = new Map()  // ip → { count, windowStart }
const BURST_LIMIT   = 20
const BURST_WINDOW  = 1000      // ms

function botProtection(req, res, next) {
  const ip = req.ip

  // 1. Check blacklist
  if (ipBlacklist.has(ip)) {
    return res.status(403).json({ error: 'Your IP has been blocked.' })
  }

  // 2. Block missing User-Agent (bots typically omit it)
  const ua = req.headers['user-agent']
  if (!ua || ua.trim() === '') {
    return res.status(400).json({ error: 'Invalid request.' })
  }

  // 3. Burst detection: >20 requests per second from same IP
  const now    = Date.now()
  const entry  = burstTracker.get(ip)
  if (entry) {
    if (now - entry.windowStart < BURST_WINDOW) {
      entry.count++
      if (entry.count > BURST_LIMIT) {
        ipBlacklist.set(ip, { reason: 'auto-burst', blockedAt: new Date().toISOString() })
        console.warn(`🚫 Auto-blocked ${ip} for burst (${entry.count} req/s)`)
        return res.status(429).json(TOO_MANY)
      }
    } else {
      entry.count      = 1
      entry.windowStart = now
    }
  } else {
    burstTracker.set(ip, { count: 1, windowStart: now })
  }

  next()
}

app.use(botProtection)

// ── AUTH MIDDLEWARE ───────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' })
  try {
    const { userId } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET)
    req.userId = userId
    next()
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' })
  }
}

// ── WEBSOCKET BROADCAST ───────────────────────────────────────
// roomId → Set<WebSocket> — populated when WS server starts
const chatRooms = new Map()

function broadcastToRoom(roomId, payload) {
  const clients = chatRooms.get(roomId)
  if (!clients || !clients.size) return
  const data = JSON.stringify(payload)
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  })
}

// ── ADMIN MIDDLEWARE ──────────────────────────────────────────
async function adminOnly(req, res, next) {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const { userId } = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET)
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } })
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
    req.adminUserId = userId
    next()
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' })
  }
}

// ── EMAIL ─────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS   // Gmail App Password (not account password)
  }
})

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

function verifyEmailHTML(username, code) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verify your LEDGR account</title>
</head>
<body style="margin:0;padding:0;background:#07060d;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#07060d;min-height:100vh;padding:48px 16px">
  <tr><td align="center">
    <table width="100%" style="max-width:520px;background:#0d0b18;border:1px solid rgba(184,159,255,0.15);border-radius:20px;overflow:hidden">

      <!-- Top accent bar -->
      <tr><td style="height:4px;background:linear-gradient(90deg,#7c3aed,#b89fff,#fbbf24)"></td></tr>

      <!-- Header -->
      <tr><td style="padding:36px 40px 28px;text-align:center">
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:28px;font-weight:900;letter-spacing:8px;color:#f0edff">
          LEDG<span style="color:#b89fff">R</span>
        </div>
        <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:4px;color:#544f6e;margin-top:6px;text-transform:uppercase">
          Verified Record · Real Edge
        </div>
      </td></tr>

      <!-- Body -->
      <tr><td style="padding:0 40px 36px">
        <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#f0edff;line-height:1.3">
          Hey @${username}, one quick step ✓
        </p>
        <p style="margin:0 0 32px;font-size:14px;color:#9590b8;line-height:1.7">
          Enter this 6-digit code in the app to verify your email and unlock your LEDGR account. The code expires in <strong style="color:#f0edff">24 hours</strong>.
        </p>

        <!-- Code block -->
        <div style="background:#07060d;border:2px solid rgba(251,191,36,0.35);border-radius:16px;padding:32px;text-align:center;margin-bottom:32px">
          <div style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:4px;color:#fbbf24;margin-bottom:14px;text-transform:uppercase">
            Verification Code
          </div>
          <div style="font-size:52px;font-weight:900;letter-spacing:14px;color:#fbbf24;font-family:'Courier New',monospace;text-shadow:0 0 40px rgba(251,191,36,0.3)">
            ${code}
          </div>
        </div>

        <p style="margin:0 0 6px;font-size:12px;color:#544f6e;line-height:1.6">
          Didn't request this? You can safely ignore this email. Your account will not be created until the code is verified.
        </p>
      </td></tr>

      <!-- Footer -->
      <tr><td style="padding:20px 40px 28px;border-top:1px solid rgba(255,255,255,0.05);text-align:center">
        <p style="margin:0;font-family:'Courier New',monospace;font-size:10px;color:#544f6e;letter-spacing:2px">
          LEDGR · getledgr.bet · Real picks. Verified records.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`
}

async function sendVerificationEmail(email, username, code) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('⚠️  EMAIL_USER / EMAIL_PASS not set — skipping verification email')
    return
  }
  await mailer.sendMail({
    from: `"LEDGR" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: `${code} is your LEDGR verification code`,
    html: verifyEmailHTML(username, code)
  })
}

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ message: 'LEDGR API is live! 🔥', timestamp: new Date().toISOString() })
})

app.get('/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now() })
})

// ── AUTH ──────────────────────────────────────────────────────
app.post('/auth/register', authLimiter, async (req, res) => {
  try {
    const { email, username, password } = req.body
    if (!email || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields' })
    }
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
    const code   = genCode()
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000)

    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase().trim(),
        username: username.trim(),
        password: hashed,
        verifyToken: code,
        verifyTokenExpiry: expiry
      }
    })

    await sendVerificationEmail(user.email, user.username, code)

    res.json({
      message: 'Check your email to verify your account',
      email: user.email
    })
  } catch (err) {
    if (err.code === 'P2002') {
      const field = err.meta?.target?.includes('email') ? 'Email' : 'Username'
      return res.status(400).json({ error: field + ' already taken' })
    }
    res.status(500).json({ error: 'Server error — try again' })
  }
})

app.post('/auth/verify-email', authLimiter, async (req, res) => {
  try {
    const { email, code } = req.body
    if (!email || !code) return res.status(400).json({ error: 'Email and code are required' })

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } })
    if (!user) return res.status(400).json({ error: 'No account found with this email' })
    if (user.emailVerified) return res.status(400).json({ error: 'Email already verified' })
    if (!user.verifyToken || user.verifyToken !== String(code)) {
      return res.status(400).json({ error: 'Invalid verification code' })
    }
    if (!user.verifyTokenExpiry || new Date() > user.verifyTokenExpiry) {
      return res.status(400).json({ error: 'Verification code has expired — request a new one' })
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true, verifyToken: null, verifyTokenExpiry: null }
    })

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '90d' })
    res.json({ token, user: { id: user.id, email: user.email, username: user.username } })
  } catch (err) {
    res.status(500).json({ error: 'Server error — try again' })
  }
})

app.post('/auth/resend-verification', authLimiter, async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ error: 'Email is required' })

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } })
    if (!user) return res.status(400).json({ error: 'No account found with this email' })
    if (user.emailVerified) return res.status(400).json({ error: 'Email already verified' })

    const code   = genCode()
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000)

    await prisma.user.update({
      where: { id: user.id },
      data: { verifyToken: code, verifyTokenExpiry: expiry }
    })

    await sendVerificationEmail(user.email, user.username, code)

    res.json({ message: 'Verification code resent — check your email' })
  } catch (err) {
    res.status(500).json({ error: 'Server error — try again' })
  }
})

app.post('/auth/login', authLimiter, async (req, res) => {
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
app.get('/picks/:id/clv', async (req, res) => {
  try {
    const pick = await prisma.pick.findUnique({
      where: { id: req.params.id },
      select: { id: true, event: true, market: true, result: true, odds: true, closingOdds: true, clv: true }
    })
    if (!pick) return res.status(404).json({ error: 'Pick not found' })

    let interpretation = 'CLV not yet available'
    if (pick.clv !== null && pick.clv !== undefined) {
      if      (pick.clv > 5)  interpretation = 'Sharp — significantly beat the market'
      else if (pick.clv > 2)  interpretation = 'Positive CLV — edge over closing line'
      else if (pick.clv > 0)  interpretation = 'Marginal CLV — slight edge'
      else if (pick.clv > -3) interpretation = 'Near closing line — neutral'
      else                    interpretation = 'Negative CLV — below closing line'
    }

    res.json({
      pickId:       pick.id,
      event:        pick.event,
      market:       pick.market,
      result:       pick.result,
      yourOdds:     pick.odds,
      closingOdds:  pick.closingOdds,
      clv:          pick.clv,
      clvLabel:     pick.clv !== null ? `${pick.clv >= 0 ? '+' : ''}${pick.clv.toFixed(2)}%` : null,
      interpretation
    })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

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

app.post('/picks', pickLimiter, async (req, res) => {
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

    // Tag pick to active season if one exists
    const activeSeason = await prisma.season.findFirst({ where: { isActive: true }, select: { id: true } })
    const seasonId = activeSeason?.id || null

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
        seasonId,
        result: result || 'pending',
        pnl: parseFloat(pnl) || 0,
        stakeType: stakeType || 'units',
        confidence: confidence || null,
        reasoning: reasoning || null,
        lockedAt
      },
      include: { user: { select: { username: true } } }
    })
    res.json(pick)

    // Notify followers asynchronously — do not block the response
    setImmediate(async () => {
      try {
        const tipsterName = pick.user?.username || 'Someone'
        const oddsFormatted = parseFloat(odds).toFixed(2)
        const body = `${event} — ${market} @ ${oddsFormatted}`

        // Get all followers of the tipster who have push subscriptions
        const follows = await prisma.follow.findMany({
          where: { followingId: userId },
          select: { followerId: true }
        })
        if (!follows.length) return

        const followerIds = follows.map(f => f.followerId)
        const subs = await prisma.pushSubscription.findMany({
          where: { userId: { in: followerIds } }
        })
        if (!subs.length) return

        const payload = {
          title: `@${tipsterName} posted a pick`,
          body,
          icon:  '/icon-192.png',
          badge: '/icon-192.png',
          url:   `/tipster?u=${tipsterName}`
        }

        await Promise.all(subs.map(sub => sendPush(sub, payload)))
        console.log(`🔔 Push sent to ${subs.length} follower(s) of @${tipsterName}`)
      } catch (err) {
        console.error('Push notification error:', err.message)
      }
    })
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

// Webhook must receive the raw body — register before express.json() parses it
app.post('/stripe-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig     = req.headers['stripe-signature']
    const secret  = process.env.STRIPE_WEBHOOK_SECRET

    let event
    try {
      event = secret
        ? stripe.webhooks.constructEvent(req.body, sig, secret)
        : JSON.parse(req.body.toString())   // dev fallback: no signature check
    } catch (err) {
      console.error('Webhook signature error:', err.message)
      return res.status(400).json({ error: 'Webhook signature invalid' })
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object
          if (session.mode !== 'subscription') break
          const meta = session.metadata || {}
          const { followerId, tipsterId } = meta
          if (!followerId || !tipsterId) break
          await prisma.subscription.upsert({
            where:  { followerId_tipsterId: { followerId, tipsterId } },
            update: {
              stripeCustomerId: session.customer,
              stripeSubId:      session.subscription,
              status:           'active'
            },
            create: {
              followerId,
              tipsterId,
              stripeCustomerId: session.customer,
              stripeSubId:      session.subscription,
              status:           'active',
              priceAmount:      Math.round((session.amount_total || 1000) / 100),
              currency:         session.currency || 'eur'
            }
          })
          console.log(`💳 Subscription activated: ${followerId} → ${tipsterId}`)
          break
        }

        case 'invoice.payment_succeeded': {
          const inv = event.data.object
          if (!inv.subscription) break
          const periodEnd = new Date(inv.lines?.data?.[0]?.period?.end * 1000 || Date.now())
          await prisma.subscription.updateMany({
            where: { stripeSubId: inv.subscription },
            data:  { status: 'active', currentPeriodEnd: periodEnd }
          })
          break
        }

        case 'invoice.payment_failed': {
          const inv = event.data.object
          if (!inv.subscription) break
          await prisma.subscription.updateMany({
            where: { stripeSubId: inv.subscription },
            data:  { status: 'past_due' }
          })
          break
        }

        case 'customer.subscription.deleted': {
          const sub = event.data.object
          await prisma.subscription.updateMany({
            where: { stripeSubId: sub.id },
            data:  { status: 'cancelled' }
          })
          console.log(`❌ Subscription cancelled: ${sub.id}`)
          break
        }

        case 'customer.subscription.updated': {
          const sub = event.data.object
          const periodEnd = new Date(sub.current_period_end * 1000)
          await prisma.subscription.updateMany({
            where: { stripeSubId: sub.id },
            data:  { status: sub.status, currentPeriodEnd: periodEnd }
          })
          break
        }
      }
    } catch (err) {
      console.error('Webhook handler error:', err.message)
    }

    res.json({ received: true })
  }
)

app.post('/create-checkout', requireAuth, async (req, res) => {
  try {
    const { tipsterId, tipsterUsername, priceAmount } = req.body
    if (!tipsterUsername) return res.status(400).json({ error: 'tipsterUsername required' })

    const amount   = Math.max(100, parseInt(priceAmount) || 1000)   // cents min €1
    const followerId = req.userId

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name:        `LEDGR — Subscribe to @${tipsterUsername}`,
            description: `Monthly premium picks from @${tipsterUsername}`
          },
          unit_amount: amount,
          recurring:   { interval: 'month' }
        },
        quantity: 1
      }],
      mode:        'subscription',
      metadata:    { followerId, tipsterId: tipsterId || '' },
      success_url: `https://getledgr.bet/tipster?u=${tipsterUsername}&subscribed=true`,
      cancel_url:  `https://getledgr.bet/tipster?u=${tipsterUsername}`
    })

    res.json({ url: session.url })
  } catch (err) {
    console.error('Stripe checkout error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.get('/subscriptions/:userId', async (req, res) => {
  try {
    const subs = await prisma.subscription.findMany({
      where:   { followerId: req.params.userId, status: 'active' },
      include: { tipster: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'desc' }
    })
    res.json(subs)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.get('/subscribers/:userId', async (req, res) => {
  try {
    const rows = await prisma.subscription.findMany({
      where:   { tipsterId: req.params.userId, status: 'active' },
      include: { follower: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ count: rows.length, subscribers: rows.map(r => r.follower) })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.delete('/subscriptions/:id', requireAuth, async (req, res) => {
  try {
    const sub = await prisma.subscription.findUnique({ where: { id: req.params.id } })
    if (!sub) return res.status(404).json({ error: 'Subscription not found' })
    if (sub.followerId !== req.userId) return res.status(403).json({ error: 'Forbidden' })

    // Cancel in Stripe if there's an active Stripe subscription
    if (sub.stripeSubId) {
      try {
        await stripe.subscriptions.cancel(sub.stripeSubId)
      } catch (stripeErr) {
        console.warn('Stripe cancel error:', stripeErr.message)
      }
    }

    await prisma.subscription.update({
      where: { id: sub.id },
      data:  { status: 'cancelled' }
    })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── FOLLOW SYSTEM ────────────────────────────────────────────
app.post('/follow', followLimiter, async (req, res) => {
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

// ── PUSH NOTIFICATIONS ────────────────────────────────────────
app.get('/vapid-public-key', (req, res) => {
  if (!vapidReady) return res.status(503).json({ error: 'Push notifications not configured' })
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY })
})

app.post('/push/subscribe', async (req, res) => {
  if (!vapidReady) return res.status(503).json({ error: 'Push notifications not configured' })
  try {
    const { userId, subscription } = req.body
    if (!userId || !subscription?.endpoint) {
      return res.status(400).json({ error: 'userId and subscription required' })
    }
    await prisma.pushSubscription.upsert({
      where:  { endpoint: subscription.endpoint },
      update: { userId, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      create: { userId, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }
    })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.post('/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' })
    await prisma.pushSubscription.deleteMany({ where: { endpoint } })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// Send push to a single subscription, remove it on 404/410 (unsubscribed)
async function sendPush(sub, payload) {
  if (!vapidReady) return
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    )
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      await prisma.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } })
    }
  }
}

// ── SEASONS ───────────────────────────────────────────────────
app.get('/seasons', async (req, res) => {
  try {
    const seasons = await prisma.season.findMany({
      orderBy: { number: 'desc' },
      include: { _count: { select: { results: true, picks: true } } }
    })
    res.json(seasons)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.get('/seasons/active', async (req, res) => {
  try {
    const season = await prisma.season.findFirst({
      where:   { isActive: true },
      include: { _count: { select: { results: true, picks: true } } }
    })
    if (!season) return res.status(404).json({ error: 'No active season' })
    res.json(season)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.get('/seasons/:id/leaderboard', async (req, res) => {
  try {
    const results = await prisma.seasonResult.findMany({
      where:   { seasonId: req.params.id },
      orderBy: { rank: 'asc' },
      include: { user: { select: { id: true, username: true } } }
    })
    res.json(results)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.post('/seasons', adminOnly, async (req, res) => {
  try {
    const { name, number, startDate, endDate } = req.body
    if (!name || !number || !startDate || !endDate) {
      return res.status(400).json({ error: 'name, number, startDate and endDate required' })
    }
    const season = await prisma.season.create({
      data: { name, number: parseInt(number), startDate: new Date(startDate), endDate: new Date(endDate) }
    })
    res.json(season)
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Season number already exists' })
    res.status(500).json({ error: 'Server error' })
  }
})

app.post('/seasons/:id/close', adminOnly, async (req, res) => {
  try {
    const season = await prisma.season.findUnique({ where: { id: req.params.id } })
    if (!season) return res.status(404).json({ error: 'Season not found' })
    if (!season.isActive && season.champion !== null) {
      return res.status(400).json({ error: 'Season already closed' })
    }
    await closeSeason(season)
    const updated = await prisma.season.findUnique({ where: { id: season.id } })
    res.json({ success: true, season: updated })
  } catch (err) {
    console.error('Season close error:', err.message)
    res.status(500).json({ error: 'Server error' })
  }
})

// ── CHAT ──────────────────────────────────────────────────────
app.get('/chat/rooms', async (req, res) => {
  try {
    const rooms = await prisma.chatRoom.findMany({
      where:   { type: 'public' },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { messages: true } } }
    })
    res.json(rooms)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.get('/chat/rooms/:id/messages', async (req, res) => {
  try {
    const messages = await prisma.chatMessage.findMany({
      where:   { roomId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take:    50,
      include: { user: { select: { id: true, username: true } } }
    })
    res.json(messages.reverse())   // oldest first for the client
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.post('/chat/rooms/:id/messages', requireAuth, chatLimiter, async (req, res) => {
  try {
    const { content } = req.body
    if (!content || !content.trim()) return res.status(400).json({ error: 'Message content required' })
    if (content.trim().length > 500) return res.status(400).json({ error: 'Message too long — max 500 characters' })

    const room = await prisma.chatRoom.findUnique({ where: { id: req.params.id } })
    if (!room) return res.status(404).json({ error: 'Room not found' })

    const message = await prisma.chatMessage.create({
      data:    { roomId: req.params.id, userId: req.userId, content: content.trim() },
      include: { user: { select: { id: true, username: true } } }
    })

    broadcastToRoom(req.params.id, { type: 'message', message })

    res.json(message)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.post('/chat/rooms', adminOnly, async (req, res) => {
  try {
    const { name, type, sport } = req.body
    if (!name) return res.status(400).json({ error: 'name required' })
    const room = await prisma.chatRoom.create({ data: { name, type: type || 'public', sport: sport || null } })
    res.json(room)
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Room name already exists' })
    res.status(500).json({ error: 'Server error' })
  }
})

// ── ADMIN — IP BLACKLIST ──────────────────────────────────────
app.post('/admin/blacklist-ip', adminOnly, (req, res) => {
  const { ip, reason } = req.body
  if (!ip) return res.status(400).json({ error: 'ip required' })
  ipBlacklist.set(ip, { reason: reason || 'manual', blockedAt: new Date().toISOString() })
  console.warn(`🚫 Admin blocked IP: ${ip} (${reason || 'manual'})`)
  res.json({ success: true, ip, reason: reason || 'manual' })
})

app.delete('/admin/blacklist-ip', adminOnly, (req, res) => {
  const { ip } = req.body
  if (!ip) return res.status(400).json({ error: 'ip required' })
  const existed = ipBlacklist.delete(ip)
  res.json({ success: true, removed: existed })
})

app.get('/admin/blacklisted-ips', adminOnly, (req, res) => {
  const list = []
  ipBlacklist.forEach((meta, ip) => list.push({ ip, ...meta }))
  res.json({ count: list.length, ips: list })
})

// ── SEED CHAT ROOMS ───────────────────────────────────────────
async function seedChatRooms() {
  const defaults = [
    { name: 'General',          sport: null           },
    { name: 'Soccer',           sport: 'Soccer'       },
    { name: 'NBA',              sport: 'Basketball'   },
    { name: 'Tennis',           sport: 'Tennis'       },
    { name: 'NFL',              sport: 'Football'     },
    { name: 'MMA',              sport: 'MMA/Boxing'   },
    { name: 'Picks Discussion', sport: null           },
  ]
  for (const r of defaults) {
    const exists = await prisma.chatRoom.findUnique({ where: { name: r.name } })
    if (!exists) {
      await prisma.chatRoom.create({ data: { name: r.name, type: 'public', sport: r.sport } })
      console.log(`💬 Seeded chat room: ${r.name}`)
    }
  }
}

// ── SERVER + WEBSOCKET ─────────────────────────────────────────
const PORT   = process.env.PORT || 3000
const server = http.createServer(app)
const wss    = new WebSocket.Server({ server })

wss.on('connection', (ws) => {
  ws._roomId = null

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())

      if (msg.type === 'join' && msg.roomId) {
        // Validate JWT if provided
        if (msg.token) {
          try {
            jwt.verify(msg.token, process.env.JWT_SECRET)
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }))
            return
          }
        }

        // Leave old room
        if (ws._roomId && chatRooms.has(ws._roomId)) {
          chatRooms.get(ws._roomId).delete(ws)
        }

        // Join new room
        ws._roomId = msg.roomId
        if (!chatRooms.has(msg.roomId)) chatRooms.set(msg.roomId, new Set())
        chatRooms.get(msg.roomId).add(ws)

        ws.send(JSON.stringify({ type: 'joined', roomId: msg.roomId }))
      }
    } catch (_) {
      // Ignore malformed frames
    }
  })

  ws.on('close', () => {
    if (ws._roomId && chatRooms.has(ws._roomId)) {
      chatRooms.get(ws._roomId).delete(ws)
    }
  })
})

server.listen(PORT, async () => {
  console.log(`LEDGR API running on port ${PORT} 🚀`)
  await seedChatRooms().catch(e => console.error('Chat seed error:', e.message))

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
