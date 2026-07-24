const express       = require('express')
const http          = require('http')
const cors          = require('cors')
const bcrypt        = require('bcryptjs')
const jwt           = require('jsonwebtoken')
const webpush       = require('web-push')
const WebSocket     = require('ws')
const rateLimit        = require('express-rate-limit')
const { ipKeyGenerator } = require('express-rate-limit')
const { PrismaClient } = require('@prisma/client')
require('dotenv').config()
const { settlePick } = require('./autoVerify')
const { closeSeason } = require('./seasons')
const axios = require('axios')
const { Filter } = require('bad-words')
const profanityFilter = new Filter()

// ── WEB PUSH ──────────────────────────────────────────────────
let vapidReady = false
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(
      'mailto:admin@getledgr.bet',
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

app.set('trust proxy', 1)

app.use(cors())

// ── STRIPE ────────────────────────────────────────────────────
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder')

// Webhook MUST be registered before express.json() — needs raw body for signature verification
app.post('/stripe-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET
    if (!secret) {
      console.error('STRIPE_WEBHOOK_SECRET missing — refusing unverified webhook')
      return res.status(500).json({ error: 'Webhook not configured' })
    }
    const sig = req.headers['stripe-signature']
    let event
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret)
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

          // Retrieve subscription to get current_period_end.
          // API 2025-03-31.basil+ moved the field from subscription root to
          // items.data[0].current_period_end — fall back to root for older envs.
          let currentPeriodEnd = null
          if (session.subscription) {
            try {
              const stripeSub = await stripe.subscriptions.retrieve(session.subscription)
              const periodEndTs = stripeSub.items?.data?.[0]?.current_period_end
                               ?? stripeSub.current_period_end
              if (periodEndTs) currentPeriodEnd = new Date(periodEndTs * 1000)
            } catch (e) {
              console.error('stripe.subscriptions.retrieve failed:', e.message)
            }
          }

          await prisma.subscription.upsert({
            where:  { followerId_tipsterId: { followerId, tipsterId } },
            update: {
              stripeCustomerId: session.customer,
              stripeSubId:      session.subscription,
              status:           'active',
              currentPeriodEnd
            },
            create: {
              followerId,
              tipsterId,
              stripeCustomerId: session.customer,
              stripeSubId:      session.subscription,
              status:           'active',
              currentPeriodEnd,
              priceAmount:      session.amount_total ? Math.round(session.amount_total / 100) : null,
              currency:         session.currency || 'eur'
            }
          })
          console.log(`💳 Subscription activated: ${followerId} → ${tipsterId}, expires: ${currentPeriodEnd?.toISOString() ?? 'unknown'}`)
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

app.use(express.json())

// ── RATE LIMITERS ─────────────────────────────────────────────
const TOO_MANY = { error: 'Too many requests. Please slow down.' }

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: TOO_MANY,
  skip: (req) => req.path === '/' || req.path === '/ping' || req.path === '/health'
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
  keyGenerator: (req) => req.body?.userId || ipKeyGenerator(req.ip),
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
  keyGenerator: (req) => req.userId || ipKeyGenerator(req.ip),
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

// ── INPUT SANITIZERS ─────────────────────────────────────────
function _sanitizeReasoning(text) {
  if (!text) return null
  return String(text).replace(/<[^>]*>/g, '').trim().slice(0, 500)
}

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

// ── INTERNAL MIDDLEWARE ───────────────────────────────────────
function requireInternal(req, res, next) {
  const secret = req.headers['x-internal-secret']
  if (!secret || secret !== process.env.INTERNAL_SECRET) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  next()
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
  if (!process.env.RESEND_API_KEY) {
    console.warn('⚠️  RESEND_API_KEY not set — skipping verification email')
    return
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'LEDGR <noreply@getledgr.bet>',
      to: [email],
      subject: `${code} is your LEDGR verification code`,
      html: verifyEmailHTML(username, code)
    })
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Resend API ${res.status}: ${body}`)
  }
}

// ── NEW MODULES ───────────────────────────────────────────────
const rankingsEngine   = require('./rankings-engine')
const profileEndpoints = require('./profile-endpoints')
const wsEvents         = require('./ws-events')

rankingsEngine.registerRoutes(app, prisma, requireInternal)
profileEndpoints.registerRoutes(app, prisma, requireAuth)
wsEvents.registerRoutes(app, prisma, requireAuth)

// Weekly rankings snapshot (Sunday 23:59 UTC)
require('node-cron').schedule('59 23 * * 0', async () => {
  try {
    await rankingsEngine.snapshotWeeklyRankings(prisma)
  } catch (e) {
    console.error('Weekly snapshot error:', e.message)
  }
})

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() })
})

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

    sendVerificationEmail(user.email, user.username, code)
      .catch(err => console.error('Verification email failed:', err))

    res.json({
      message: 'Check your email to verify your account',
      email: user.email
    })
  } catch (err) {
    if (err.code === 'P2002') {
      const field = err.meta?.target?.includes('email') ? 'Email' : 'Username'
      return res.status(400).json({ error: field + ' already taken' })
    }
    console.error('Register error:', err)
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

    sendVerificationEmail(user.email, user.username, code)
      .catch(err => console.error('Verification email failed:', err))

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
    if (!user.emailVerified) {
      return res.status(403).json({ error: 'verify_email', email: user.email })
    }
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

const flatPick = p => ({ ...p, username: p.user?.username ?? null })

// Premium masking rules (shared between global feed and per-tipster views):
// - pending (live, actionable tip): teaser massimo — nasconde anche evento/squadre
// - settled (win/loss/push/void): visibile completo — il track record è pubblico,
//   il paywall protegge solo il consiglio azionabile, non la storia
function maskPremiumPick(p) {
  if (p.result !== 'pending') return flatPick(p)
  return {
    id:         p.id,
    userId:     p.userId,
    username:   p.user?.username ?? null,
    sport:      p.sport,
    createdAt:  p.createdAt,
    result:     'pending',
    visibility: 'PREMIUM',
    _teaser:    true
  }
}

app.get('/picks', async (req, res) => {
  try {
    const { userId } = req.query

    // Decode viewer identity from optional Bearer token
    let viewerId = null
    const authHeader = req.headers.authorization
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET)
        viewerId = decoded.userId
      } catch (_) {}
    }

    if (!userId) {
      // Global feed: return ALL picks — PUBLIC complete, PREMIUM masked per rules
      const picks = await prisma.pick.findMany({
        include: { user: { select: { username: true } } },
        orderBy: { createdAt: 'desc' }
      })
      return res.json(picks.map(p =>
        p.visibility === 'PREMIUM' ? maskPremiumPick(p) : flatPick(p)
      ))
    }

    // Fetch all picks for this tipster
    const picks = await prisma.pick.findMany({
      where: { userId },
      include: { user: { select: { username: true } } },
      orderBy: { createdAt: 'desc' }
    })

    // Owner sees everything
    if (viewerId === userId) return res.json(picks.map(flatPick))

    // Check if viewer has an active subscription to this tipster
    let hasAccess = false
    if (viewerId) {
      const sub = await prisma.subscription.findFirst({
        where: { followerId: viewerId, tipsterId: userId, status: 'active' }
      })
      hasAccess = !!sub
    }

    if (hasAccess) return res.json(picks.map(flatPick))

    // Mask PREMIUM picks for non-subscribers — same rules as global feed
    res.json(picks.map(p =>
      p.visibility === 'PREMIUM' ? maskPremiumPick(p) : flatPick(p)
    ))
  } catch (err) {
    console.error('GET /picks error:', err)
    res.status(500).json({ error: 'Failed to load picks', detail: err.message })
  }
})

app.post('/picks', pickLimiter, requireAuth, async (req, res) => {
  try {
    const {
      userId, sport, event, fixtureId,
      homeTeam, awayTeam, market, odds, stake,
      result, pnl, stakeType, confidence, reasoning, commenceTime,
      visibility
    } = req.body

    const safeVisibility = ['PUBLIC', 'PREMIUM'].includes(visibility) ? visibility : 'PUBLIC'

    if (!userId || !event || !market || !odds || !stake) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const VALID_SPORTS = ['Soccer','Basketball','Football','Tennis','Baseball','MMA/Boxing']
    if (!VALID_SPORTS.includes(sport)) {
      return res.status(400).json({ error: 'invalid_sport', allowed: VALID_SPORTS })
    }

    const parsedOdds = parseFloat(odds)
    if (isNaN(parsedOdds) || parsedOdds < 1.01 || parsedOdds > 1000) {
      return res.status(400).json({ error: 'Odds must be between 1.01 and 1000' })
    }
    if (userId !== req.userId) return res.status(403).json({ error: 'userId mismatch' })

    const safeStakeType = stakeType || 'units'
    if (!['units', 'dollar'].includes(safeStakeType)) {
      return res.status(400).json({ error: 'Stake type must be units or dollar. Percentage stakes are not supported for verified records.' })
    }

    if (commenceTime && new Date(commenceTime) <= new Date()) {
      return res.status(400).json({ error: 'Pick rejected: this fixture has already started' })
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
        stakeType: safeStakeType,
        confidence: confidence || null,
        reasoning: _sanitizeReasoning(reasoning),
        visibility: safeVisibility,
        lockedAt
      },
      include: { user: { select: { username: true } } }
    })
    res.json(flatPick(pick))

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

      // Live event: notify followers via WebSocket
      try {
        await wsEvents.emitPickPosted(prisma, {
          ...pick,
          username: pick.user?.username || '',
        })
      } catch (err) {
        console.error('emitPickPosted error:', err.message)
      }
    })
  } catch (err) {
    console.error('POST /picks error:', err.message)
    res.status(500).json({ error: 'Server error: ' + err.message })
  }
})

// ── REACTIONS ────────────────────────────────────────────────
const VALID_EMOJIS = new Set(['fire','rocket','diamond','clap'])

async function getReactionCounts(pickId) {
  const rows = await prisma.pickReaction.groupBy({
    by: ['emoji'],
    where: { pickId },
    _count: { emoji: true }
  })
  const counts = { fire:0, rocket:0, diamond:0, clap:0 }
  rows.forEach(r => { counts[r.emoji] = r._count.emoji })
  return counts
}

app.post('/picks/:id/react', requireAuth, async (req, res) => {
  try {
    const { emoji } = req.body
    const userId = req.userId
    if (!emoji) return res.status(400).json({ error: 'Missing emoji' })
    if (!VALID_EMOJIS.has(emoji)) return res.status(400).json({ error: 'Invalid emoji' })
    const existing = await prisma.pickReaction.findUnique({
      where: { pickId_userId_emoji: { pickId: req.params.id, userId, emoji } }
    })
    if (existing) {
      await prisma.pickReaction.delete({ where: { id: existing.id } })
    } else {
      await prisma.pickReaction.create({ data: { pickId: req.params.id, userId, emoji } })
    }
    const counts = await getReactionCounts(req.params.id)
    const userRows = await prisma.pickReaction.findMany({
      where: { pickId: req.params.id, userId }, select: { emoji: true }
    })
    res.json({ ...counts, reacted: !existing, userReactions: userRows.map(r => r.emoji) })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.get('/picks/:id/reactions', async (req, res) => {
  try {
    const counts = await getReactionCounts(req.params.id)
    const { userId } = req.query
    let userReactions = []
    if (userId) {
      const rows = await prisma.pickReaction.findMany({
        where: { pickId: req.params.id, userId }, select: { emoji: true }
      })
      userReactions = rows.map(r => r.emoji)
    }
    res.json({ ...counts, userReactions })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── TAILS ────────────────────────────────────────────────────
app.post('/picks/:id/tail', requireAuth, async (req, res) => {
  try {
    const userId = req.userId
    const existing = await prisma.pickTail.findUnique({
      where: { pickId_userId: { pickId: req.params.id, userId } }
    })
    if (existing) {
      await prisma.pickTail.delete({ where: { id: existing.id } })
    } else {
      await prisma.pickTail.create({ data: { pickId: req.params.id, userId } })
    }
    const count = await prisma.pickTail.count({ where: { pickId: req.params.id } })
    res.json({ tailed: !existing, count })

    if (!existing) {
      setImmediate(async () => {
        try {
          const tailedPick = await prisma.pick.findUnique({
            where:   { id: req.params.id },
            include: { user: { select: { username: true } } },
          })
          if (tailedPick) {
            await wsEvents.emitPickTailed(prisma, {
              ...tailedPick,
              username: tailedPick.user?.username || '',
            }, count)
          }
        } catch (_) {}
      })
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.get('/picks/:id/tails', async (req, res) => {
  try {
    const count = await prisma.pickTail.count({ where: { pickId: req.params.id } })
    const { userId } = req.query
    let tailed = false
    if (userId) {
      const existing = await prisma.pickTail.findUnique({
        where: { pickId_userId: { pickId: req.params.id, userId } }
      })
      tailed = !!existing
    }
    res.json({ count, tailed })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── SPORTS NEWS (ESPN proxy) ──────────────────────────────────
const ESPN_PATHS = {
  soccer:     'soccer/all',
  basketball: 'basketball/nba',
  football:   'football/nfl',
  tennis:     'tennis',
  mma:        'mma/ufc',
}
const NEWS_CACHE = new Map()
const NEWS_TTL   = 5 * 60 * 1000 // 5 minutes

async function fetchESPN(sportPath, limit = 40) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/news?limit=${limit}`
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 LEDGR/1.0' } })
  if (!r.ok) throw new Error('ESPN ' + r.status)
  const data = await r.json()
  return (data.articles || []).map(a => ({ ...a, _sport: sportPath.split('/')[0] }))
}

app.get('/news', async (req, res) => {
  try {
    const sport = req.query.sport || 'all'
    const cacheKey = sport
    const cached = NEWS_CACHE.get(cacheKey)
    if (cached && Date.now() - cached.ts < NEWS_TTL) return res.json(cached.data)

    let articles = []
    if (sport === 'all') {
      const results = await Promise.allSettled(
        Object.entries(ESPN_PATHS).map(([k, path]) =>
          fetchESPN(path, 20).then(arr => arr.map(a => ({ ...a, _sport: k })))
        )
      )
      articles = results.flatMap(r => r.status === 'fulfilled' ? r.value : [])
      articles.sort((a, b) => new Date(b.published) - new Date(a.published))
    } else {
      const path = ESPN_PATHS[sport]
      if (!path) return res.status(400).json({ error: 'Unknown sport' })
      articles = await fetchESPN(path, 50)
      articles = articles.map(a => ({ ...a, _sport: sport }))
    }

    NEWS_CACHE.set(cacheKey, { ts: Date.now(), data: articles })
    res.json(articles)
  } catch (err) {
    console.error('News fetch error:', err.message)
    res.status(502).json([])
  }
})

// ── FIXTURES ──────────────────────────────────────────────────
const _fixturesCache = new Map()
const FIXTURES_TTL = 5 * 60 * 1000

app.get('/fixtures', async (req, res) => {
  try {
    const sport = req.query.sport || 'Soccer'
    const dateOffset = parseInt(req.query.dateOffset) || 0
    const cacheKey = sport + '|' + dateOffset
    const cached = _fixturesCache.get(cacheKey)
    if (cached && Date.now() - cached.ts < FIXTURES_TTL) return res.json(cached.data)

    const date = new Date()
    date.setDate(date.getDate() + dateOffset)
    const dateStr = date.toISOString().split('T')[0]

    const sportMap = {
      'Soccer': ['soccer_epl','soccer_spain_la_liga','soccer_italy_serie_a','soccer_germany_bundesliga','soccer_france_ligue_one','soccer_uefa_champs_league','soccer_uefa_europa_league','soccer_usa_mls','soccer_netherlands_eredivisie','soccer_portugal_primeira_liga','soccer_turkey_super_league','soccer_brazil_campeonato','soccer_argentina_primera_division'],
      'Basketball': ['basketball_nba'],
      'Football': ['americanfootball_nfl'],
      'Baseball': ['baseball_mlb'],
      'Tennis': ['tennis_atp_french_open','tennis_wta_french_open','tennis_atp_wimbledon','tennis_wta_wimbledon','tennis_atp_us_open','tennis_wta_us_open','tennis_atp_australian_open','tennis_wta_australian_open','tennis_atp_double','tennis_wta_double'],
      'MMA/Boxing': ['mma_mixed_martial_arts','boxing_boxing']
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
        const fixtures = r.data.map(g => {
          let homeOdds=null,awayOdds=null,drawOdds=null;
          for(const bk of(g.bookmakers||[])){
            const h2h=bk.markets?.find(x=>x.key==='h2h');
            if(!h2h)continue;
            for(const o of(h2h.outcomes||[])){
              if(o.name===g.home_team&&(!homeOdds||o.price>homeOdds))homeOdds=o.price;
              if(o.name===g.away_team&&(!awayOdds||o.price>awayOdds))awayOdds=o.price;
              if(o.name==='Draw'     &&(!drawOdds||o.price>drawOdds))drawOdds=o.price;
            }
          }
          return{
            id:g.id,
            home:g.home_team,
            away:g.away_team,
            league:league.replace(/soccer_|basketball_|americanfootball_|baseball_|tennis_|mma_/g,'').replace(/_/g,' ').toUpperCase(),
            time:new Date(g.commence_time).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}),
            date:new Date(g.commence_time).toLocaleDateString('en'),
            homeOdds:homeOdds?parseFloat(homeOdds.toFixed(2)):null,
            awayOdds:awayOdds?parseFloat(awayOdds.toFixed(2)):null,
            drawOdds:drawOdds?parseFloat(drawOdds.toFixed(2)):null,
            commenceTime:g.commence_time
          };
        })
        allFixtures = allFixtures.concat(fixtures)
      } catch(e) { console.error('[fixtures] Failed to fetch', league, '-', e.response?.status || e.message); continue }
    }

    if (allFixtures.length > 0) _fixturesCache.set(cacheKey, { data: allFixtures, ts: Date.now() })
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


app.patch('/profile/subscription-price', requireAuth, async (req, res) => {
  try {
    const { priceCents } = req.body
    const price = parseInt(priceCents)
    if (!Number.isInteger(price) || price < 100 || price > 50000) {
      return res.status(400).json({ error: 'priceCents must be an integer between 100 (€1) and 50000 (€500)' })
    }
    const user = await prisma.user.update({
      where: { id: req.userId },
      data:  { subscriptionPriceCents: price },
      select: { id: true, username: true, subscriptionPriceCents: true }
    })
    res.json(user)
  } catch (err) {
    console.error('subscription-price error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/create-checkout', requireAuth, async (req, res) => {
  try {
    const { tipsterId } = req.body
    if (!tipsterId) return res.status(400).json({ error: 'tipsterId required' })

    const tipster = await prisma.user.findUnique({ where: { id: tipsterId } })
    if (!tipster) return res.status(404).json({ error: 'Tipster not found' })

    if (!tipster.subscriptionPriceCents) {
      return res.status(400).json({ error: 'This tipster has not set a subscription price yet' })
    }
    if (!tipster.stripeConnectedAccountId) {
      return res.status(400).json({ error: 'This tipster has not completed payout setup yet' })
    }

    const account = await stripe.accounts.retrieve(tipster.stripeConnectedAccountId)
    if (!account.charges_enabled) {
      return res.status(400).json({ error: 'This tipster has not completed payout setup yet' })
    }

    const existingSub = await prisma.subscription.findFirst({
      where: { followerId: req.userId, tipsterId, status: 'active' }
    })
    if (existingSub) return res.status(409).json({ error: 'already_subscribed' })

    const commissionPercent = tipster.commissionOverridePercent ?? 15

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name:        `LEDGR — Subscribe to @${tipster.username}`,
            description: `Monthly premium picks from @${tipster.username}`
          },
          unit_amount: tipster.subscriptionPriceCents,
          recurring:   { interval: 'month' }
        },
        quantity: 1
      }],
      mode:              'subscription',
      subscription_data: {
        application_fee_percent: commissionPercent,
        transfer_data:           { destination: tipster.stripeConnectedAccountId }
      },
      metadata:    { followerId: req.userId, tipsterId },
      success_url: `https://getledgr.bet/subscribe/success?u=${tipster.username}`,
      cancel_url:  `https://getledgr.bet/subscribe/cancel?u=${tipster.username}`
    })

    res.json({ url: session.url })
  } catch (err) {
    console.error('Stripe checkout error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── STRIPE CONNECT — ONBOARDING ───────────────────────────────
app.post('/stripe/connect/onboard', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } })

    let accountId = user.stripeConnectedAccountId

    // Create Express account only if tipster doesn't have one yet
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        capabilities: {
          card_payments: { requested: true },
          transfers:     { requested: true }
        }
      })
      accountId = account.id
      await prisma.user.update({
        where: { id: req.userId },
        data:  { stripeConnectedAccountId: accountId }
      })
    }

    const accountLink = await stripe.accountLinks.create({
      account:     accountId,
      type:        'account_onboarding',
      refresh_url: 'https://getledgr.bet/settings?stripe=refresh',
      return_url:  'https://getledgr.bet/settings?stripe=success'
    })

    res.json({ url: accountLink.url })
  } catch (err) {
    console.error('Stripe Connect onboard error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.get('/stripe/connect/status', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } })

    if (!user.stripeConnectedAccountId) {
      return res.json({ connected: false, onboardingComplete: false })
    }

    const account = await stripe.accounts.retrieve(user.stripeConnectedAccountId)

    res.json({
      connected:          true,
      onboardingComplete: account.charges_enabled,
      detailsSubmitted:   account.details_submitted
    })
  } catch (err) {
    console.error('Stripe Connect status error:', err.message)
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
app.post('/follow', followLimiter, requireAuth, async (req, res) => {
  try {
    const { followingId } = req.body
    const followerId = req.userId
    if (!followingId) return res.status(400).json({ error: 'Missing followingId' })
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

app.delete('/follow', requireAuth, async (req, res) => {
  try {
    const { followingId } = req.body
    const followerId = req.userId
    if (!followingId) return res.status(400).json({ error: 'Missing followingId' })
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

    // ── MODERATION ────────────────────────────────────────────────
    const sender = await prisma.user.findUnique({ where: { id: req.userId } })

    // 1. Mute check
    if (sender.mutedUntil && sender.mutedUntil > new Date()) {
      return res.status(403).json({
        error: `You are temporarily muted until ${sender.mutedUntil.toUTCString()}`
      })
    }

    // 2. Profanity check
    if (profanityFilter.isProfane(content.trim())) {
      const now = new Date()
      // Reset violation counter if last violation was >24h ago
      const windowExpired = !sender.lastViolationAt ||
        (now - sender.lastViolationAt) > 24 * 60 * 60 * 1000
      const newCount = windowExpired ? 1 : sender.violationCount + 1

      if (newCount >= 3) {
        // 3 violations in window → mute for 1 hour, reset counter
        const mutedUntil = new Date(now.getTime() + 60 * 60 * 1000)
        await prisma.user.update({
          where: { id: req.userId },
          data: { mutedUntil, violationCount: 0, lastViolationAt: now }
        })
        // Log the mute
        await prisma.moderationFlag.create({
          data: {
            userId: req.userId,
            reason: 'auto-mute',
            detail: `@${sender.username} muted until ${mutedUntil.toISOString()} after 3 violations in 24h`
          }
        })
        // If ≥3 auto-mutes in last 30 days → flag for manual admin review
        const muteCount30d = await prisma.moderationFlag.count({
          where: {
            userId: req.userId,
            reason: 'auto-mute',
            createdAt: { gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) }
          }
        })
        if (muteCount30d >= 3) {
          await prisma.moderationFlag.create({
            data: {
              userId: req.userId,
              reason: 'admin-review',
              detail: `@${sender.username} accumulated ${muteCount30d} auto-mutes in 30 days — manual ban decision required`
            }
          })
          console.warn(`🚨 MODERATION: @${sender.username} flagged for admin review (${muteCount30d} mutes/30d)`)
        }
      } else {
        // Accumulate violation within current 24h window
        await prisma.user.update({
          where: { id: req.userId },
          data: { violationCount: newCount, lastViolationAt: now }
        })
      }

      return res.status(400).json({ error: 'Message blocked — please keep the community respectful' })
    }
    // ── END MODERATION ────────────────────────────────────────────

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

// ── BETTING CIRCLES ───────────────────────────────────────────
function genInviteCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase()
}

app.post('/circles', requireAuth, async (req, res) => {
  try {
    const { name, description, sport, isPrivate } = req.body
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' })
    let inviteCode = genInviteCode()
    // ensure uniqueness
    while (await prisma.circle.findUnique({ where: { inviteCode } })) {
      inviteCode = genInviteCode()
    }
    const circle = await prisma.circle.create({
      data: {
        name: name.trim(),
        description: description?.trim() || null,
        sport: sport || null,
        isPrivate: !!isPrivate,
        inviteCode,
        ownerId: req.userId,
        members: { create: { userId: req.userId, role: 'admin' } }
      },
      include: { members: true }
    })
    res.status(201).json(circle)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.get('/circles', async (req, res) => {
  try {
    const circles = await prisma.circle.findMany({
      where: { isPrivate: false },
      include: {
        owner: { select: { id: true, username: true } },
        _count: { select: { members: true, messages: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
    res.json(circles)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.get('/circles/my', requireAuth, async (req, res) => {
  try {
    const memberships = await prisma.circleMember.findMany({
      where: { userId: req.userId },
      include: {
        circle: {
          include: {
            owner: { select: { id: true, username: true } },
            _count: { select: { members: true, messages: true } }
          }
        }
      },
      orderBy: { joinedAt: 'desc' }
    })
    res.json(memberships.map(m => ({ ...m.circle, role: m.role, joinedAt: m.joinedAt })))
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.post('/circles/join', requireAuth, async (req, res) => {
  try {
    const { inviteCode } = req.body
    if (!inviteCode) return res.status(400).json({ error: 'inviteCode required' })
    const circle = await prisma.circle.findUnique({ where: { inviteCode: inviteCode.toUpperCase() } })
    if (!circle) return res.status(404).json({ error: 'Circle not found' })
    const existing = await prisma.circleMember.findUnique({
      where: { circleId_userId: { circleId: circle.id, userId: req.userId } }
    })
    if (existing) return res.status(409).json({ error: 'Already a member' })
    const member = await prisma.circleMember.create({
      data: { circleId: circle.id, userId: req.userId, role: 'member' }
    })
    res.json({ circle, member })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.get('/circles/:id', requireAuth, async (req, res) => {
  try {
    const circle = await prisma.circle.findUnique({
      where: { id: req.params.id },
      include: {
        owner: { select: { id: true, username: true } },
        members: { include: { user: { select: { id: true, username: true, elo: true } } }, orderBy: { joinedAt: 'asc' } }
      }
    })
    if (!circle) return res.status(404).json({ error: 'Circle not found' })
    const isMember = circle.members.some(m => m.userId === req.userId)
    if (circle.isPrivate && !isMember) return res.status(403).json({ error: 'Private circle' })
    res.json(circle)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.get('/circles/:id/messages', requireAuth, async (req, res) => {
  try {
    const member = await prisma.circleMember.findUnique({
      where: { circleId_userId: { circleId: req.params.id, userId: req.userId } }
    })
    if (!member) return res.status(403).json({ error: 'Not a member' })
    const messages = await prisma.circleMessage.findMany({
      where: { circleId: req.params.id },
      include: { user: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50
    })
    res.json(messages.reverse())
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.post('/circles/:id/messages', requireAuth, chatLimiter, async (req, res) => {
  try {
    const { content } = req.body
    if (!content || !content.trim()) return res.status(400).json({ error: 'content required' })
    if (content.trim().length > 500) return res.status(400).json({ error: 'Message too long — max 500 characters' })
    const member = await prisma.circleMember.findUnique({
      where: { circleId_userId: { circleId: req.params.id, userId: req.userId } }
    })
    if (!member) return res.status(403).json({ error: 'Not a member' })
    const message = await prisma.circleMessage.create({
      data: { circleId: req.params.id, userId: req.userId, content: content.trim() },
      include: { user: { select: { id: true, username: true } } }
    })
    broadcastToRoom(req.params.id, { type: 'circle_message', message })
    res.json(message)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.delete('/circles/:id', requireAuth, async (req, res) => {
  try {
    const circle = await prisma.circle.findUnique({ where: { id: req.params.id } })
    if (!circle) return res.status(404).json({ error: 'Circle not found' })
    if (circle.ownerId !== req.userId) return res.status(403).json({ error: 'Owner only' })
    await prisma.circleMessage.deleteMany({ where: { circleId: req.params.id } })
    await prisma.circleMember.deleteMany({ where: { circleId: req.params.id } })
    await prisma.circle.delete({ where: { id: req.params.id } })
    res.json({ success: true })
  } catch (err) {
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

// ── ADMIN: MODERATION FLAGS ───────────────────────────────────
app.get('/admin/moderation-flags', adminOnly, async (req, res) => {
  try {
    const flags = await prisma.moderationFlag.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200
    })
    res.json(flags)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── ADMIN: UNMUTE USER ────────────────────────────────────────
app.post('/admin/users/:id/unmute', adminOnly, async (req, res) => {
  try {
    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { mutedUntil: null, violationCount: 0 }
    })
    res.json({ ok: true, username: updated.username })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ── ADMIN: FORCE SETTLE PICK ──────────────────────────────────
app.put('/admin/picks/:id/settle', adminOnly, async (req, res) => {
  try {
    const { result } = req.body
    if (!['win', 'loss', 'push'].includes(result)) {
      return res.status(400).json({ error: 'result must be win, loss, or push' })
    }

    const pick = await prisma.pick.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { username: true } } }
    })
    if (!pick) return res.status(404).json({ error: 'Pick not found' })
    if (pick.result !== 'pending') {
      return res.status(400).json({ error: `Pick already settled: ${pick.result}` })
    }

    const adminId = req.adminUserId
    await settlePick(pick, result)

    const adminSettledAt = new Date()
    await prisma.pick.update({
      where: { id: pick.id },
      data: { adminSettledBy: adminId, adminSettledAt }
    })

    console.warn(`[ADMIN SETTLE] pick=${pick.id} | owner=@${pick.user?.username} | event="${pick.event}" | market="${pick.market}" | result=${result} | adminId=${adminId} | at=${adminSettledAt.toISOString()}`)

    const updated = await prisma.pick.findUnique({ where: { id: pick.id } })
    res.json({ success: true, pick: updated })
  } catch (err) {
    console.error('Admin settle error:', err)
    res.status(500).json({ error: err.message })
  }
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
  wsEvents.onWsConnect(ws)

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString())

      // Live-events messages (subscribe/ping/catch_up/low_power) handled first
      if (await wsEvents.handleLiveMessage(ws, msg, prisma)) return

      // Chat: join room
      if (msg.type === 'join' && msg.roomId) {
        if (msg.token) {
          try {
            jwt.verify(msg.token, process.env.JWT_SECRET)
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }))
            return
          }
        }
        if (ws._roomId && chatRooms.has(ws._roomId)) {
          chatRooms.get(ws._roomId).delete(ws)
        }
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
    wsEvents.onWsClose(ws)
    if (ws._roomId && chatRooms.has(ws._roomId)) {
      chatRooms.get(ws._roomId).delete(ws)
    }
  })
})

server.listen(PORT, async () => {
  console.log(`LEDGR API running on port ${PORT} 🚀`)
  await seedChatRooms().catch(e => console.error('Chat seed error:', e.message))
  wsEvents.startOnlineCountBroadcast()

  // Self-ping every 10 minutes to keep Render awake
  setInterval(async () => {
    try {
      await axios.get(`http://localhost:${PORT}/ping`)
      console.log('🟢 Keep-alive ping sent')
    } catch(e) {
      console.log('⚠️ Keep-alive ping failed:', e.message)
    }
  }, 10 * 60 * 1000)
})
