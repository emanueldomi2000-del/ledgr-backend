'use strict'

const BIG_WIN_THRESHOLD     = parseFloat(process.env.BIG_WIN_THRESHOLD || '5')
const UNDERDOG_MIN_ODDS     = parseFloat(process.env.UNDERDOG_MIN_ODDS  || '3.0')
const RANK_UP_BROADCAST_MAX = parseInt(process.env.RANK_UP_MAX || '20', 10)
const ONLINE_INTERVAL_MS    = 60_000
const RATE_WINDOW_MS        = 5 * 60_000

// Live-events message types routed by handleLiveMessage
const LIVE_MSG_TYPES = new Set(['subscribe', 'ping', 'catch_up', 'low_power'])

// Map<WebSocket, { userId, lowPower, lastEventId }>
const _clients = new Map()

// ─── Rarity ───────────────────────────────────────────────────────────────────
function computeRarity(type, payload) {
  switch (type) {
    case 'pick_win': case 'pick_result': case 'followed_posted':
    case 'pick_tailed': case 'rank_change':
      return 1
    case 'big_win':
      return payload.pnl >= 20 ? 4 : payload.pnl >= 10 ? 3 : 2
    case 'underdog_hit':
      return payload.odds >= 5.0 ? 4 : 3
    case 'streak_milestone':
      if (payload.streak >= 10) return 5
      if (payload.streak >= 7)  return 4
      if (payload.streak >= 5)  return 3
      return 2
    case 'division_up': {
      const map = { SILVER:1, GOLD:2, PLATINUM:3, DIAMOND:4, ELITE:4, LEGENDARY:5 }
      return map[payload.toDivision] || 2
    }
    case 'rank_up':
      if (payload.newRank === 1) return 5
      if (payload.newRank <= 3)  return 4
      if (payload.newRank <= 10) return 3
      return 2
    case 'badge_unlock':
      return payload.badgeRarity || 2
    case 'milestone_pick':
      return payload.count >= 200 ? 4 : payload.count >= 100 ? 3 : 2
    default:
      return 1
  }
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────
const _rateMap = new Map()
function _isRateLimited(username, type) {
  const key  = `${username}:${type}`
  const last = _rateMap.get(key) || 0
  if (Date.now() - last < RATE_WINDOW_MS) return true
  _rateMap.set(key, Date.now())
  return false
}

// ─── Broadcast / unicast ──────────────────────────────────────────────────────
function _sendTo(ws, msg) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(msg)) } catch (_) {}
}

function _broadcast(msg) {
  _clients.forEach((meta, ws) => _sendTo(ws, msg))
}

function _unicast(userId, msg) {
  _clients.forEach((meta, ws) => { if (meta.userId === userId) _sendTo(ws, msg) })
}

function _formatRow(row) {
  return {
    eventId:  Number(row.id),
    type:     row.type,
    rarity:   row.rarity,
    username: row.username,
    payload:  typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
  }
}

// ─── Persist + emit ───────────────────────────────────────────────────────────
async function _emit(prisma, { type, username, targetUserId, payload }) {
  const rarity = computeRarity(type, payload)

  let eventId = null
  try {
    const rows = await prisma.$queryRaw`
      INSERT INTO live_events (type, rarity, username, "targetUserId", payload)
      VALUES (${type}, ${rarity}, ${username || null}, ${targetUserId || null}, ${JSON.stringify(payload)}::jsonb)
      RETURNING id
    `
    eventId = rows[0] ? Number(rows[0].id) : null
  } catch (e) {
    console.error('[ws-events] persist error:', e)
  }

  const msg = { eventId, type, rarity, username, payload }

  if (targetUserId) {
    _unicast(targetUserId, msg)
    try {
      await prisma.$executeRaw`
        INSERT INTO user_notifications ("userId", type, rarity, payload)
        VALUES (${targetUserId}, ${type}, ${rarity}, ${JSON.stringify(payload)}::jsonb)
      `
    } catch (_) {}
  } else {
    _broadcast(msg)
  }
}

// ─── WS lifecycle hooks ───────────────────────────────────────────────────────
// Call these from the existing wss.on('connection') handler in index.js
// to avoid registering a second 'connection' listener.

function onWsConnect(ws) {
  _clients.set(ws, { userId: null, lowPower: false, lastEventId: 0 })
}

function onWsClose(ws) {
  _clients.delete(ws)
}

// Returns true if the message was a live-events message (caller should return early).
// Make the ws.on('message') handler async before calling this.
async function handleLiveMessage(ws, msg, prisma) {
  if (!LIVE_MSG_TYPES.has(msg.type)) return false

  const meta = _clients.get(ws) || {}

  if (msg.type === 'subscribe') {
    meta.userId      = msg.userId      || null
    meta.lowPower    = !!msg.lowPower
    meta.lastEventId = msg.lastEventId || 0
    _clients.set(ws, meta)
    if (msg.lastEventId) {
      try {
        const since = msg.lastEventId
        const rows = await prisma.$queryRaw`
          SELECT * FROM live_events
          WHERE id > ${since} AND "targetUserId" IS NULL
          ORDER BY id ASC LIMIT 50
        `
        rows.forEach(ev => _sendTo(ws, _formatRow(ev)))
      } catch (_) {}
    }
    return true
  }

  if (msg.type === 'ping') {
    _sendTo(ws, { type: 'pong' })
    return true
  }

  if (msg.type === 'catch_up') {
    const since  = msg.since || meta.lastEventId || 0
    const userId = meta.userId || ''
    try {
      const rows = await prisma.$queryRaw`
        SELECT * FROM live_events
        WHERE id > ${since} AND ("targetUserId" IS NULL OR "targetUserId" = ${userId})
        ORDER BY id ASC LIMIT 50
      `
      rows.forEach(ev => _sendTo(ws, _formatRow(ev)))
    } catch (_) {}
    return true
  }

  if (msg.type === 'low_power') {
    meta.lowPower = !!msg.active
    _clients.set(ws, meta)
    return true
  }

  return false
}

// Call once in server.listen callback
function startOnlineCountBroadcast() {
  setInterval(() => {
    _broadcast({ type: 'online_count', n: _clients.size })
  }, ONLINE_INTERVAL_MS)
}

// ─── Triggers ─────────────────────────────────────────────────────────────────

// Call after recalcUserRankings() in autoVerify settlePick.
// prevSnapshot = { elo, division, picks, streak, streakType, rank } from user_rankings BEFORE recalc.
async function emitPickGraded(prisma, pick, prevSnapshot) {
  const { username, result, odds, pnl, event: matchEvent, market, sport, id: pickId } = pick
  if (!username || !result || result === 'pending') return

  if (pick.userId) {
    await _emit(prisma, {
      type: 'pick_result',
      username,
      targetUserId: pick.userId,
      payload: { pickId, result, pnl: parseFloat(pnl || 0), event: matchEvent, market, odds: parseFloat(odds || 0) },
    })
  }

  if (result !== 'win') return

  const pnlNum  = parseFloat(pnl  || 0)
  const oddsNum = parseFloat(odds || 0)

  if (!_isRateLimited(username, 'pick_win')) {
    await _emit(prisma, {
      type: 'pick_win',
      username,
      payload: { pickId, event: matchEvent, market, odds: oddsNum, pnl: pnlNum, sport },
    })
  }

  if (pnlNum >= BIG_WIN_THRESHOLD && !_isRateLimited(username, 'big_win')) {
    await _emit(prisma, {
      type: 'big_win',
      username,
      payload: { pickId, event: matchEvent, market, odds: oddsNum, pnl: pnlNum, sport },
    })
  }

  if (oddsNum >= UNDERDOG_MIN_ODDS && !_isRateLimited(username, 'underdog_hit')) {
    await _emit(prisma, {
      type: 'underdog_hit',
      username,
      payload: { pickId, event: matchEvent, market, odds: oddsNum, pnl: pnlNum, sport },
    })
  }

  if (!prevSnapshot) return

  const STREAK_THRESHOLDS = new Set([3, 5, 7, 10])
  try {
    const rows = await prisma.$queryRaw`
      SELECT "currentStreak", "streakType", division
      FROM user_rankings WHERE username = ${username} LIMIT 1
    `
    if (rows.length) {
      const { currentStreak, streakType, division: divNow } = rows[0]
      const prevStreak = prevSnapshot.streakType === 'win' ? (prevSnapshot.streak || 0) : 0

      if (streakType === 'win' && STREAK_THRESHOLDS.has(currentStreak) && currentStreak > prevStreak) {
        await _emit(prisma, {
          type: 'streak_milestone',
          username,
          payload: { streak: currentStreak, division: prevSnapshot.division },
        })
      }

      if (divNow && prevSnapshot.division && divNow !== prevSnapshot.division) {
        const DIV_ORDER = ['BRONZE','SILVER','GOLD','PLATINUM','DIAMOND','ELITE','LEGENDARY']
        if (DIV_ORDER.indexOf(divNow) > DIV_ORDER.indexOf(prevSnapshot.division)) {
          await _emit(prisma, {
            type: 'division_up',
            username,
            payload: { fromDivision: prevSnapshot.division, toDivision: divNow },
          })
          if (pick.userId) {
            await _emit(prisma, {
              type: 'division_up',
              username,
              targetUserId: pick.userId,
              payload: { fromDivision: prevSnapshot.division, toDivision: divNow },
            })
          }
        }
      }

      const rankNow = rows[0].rank
      if (rankNow && prevSnapshot.rank &&
          rankNow < prevSnapshot.rank &&
          rankNow <= RANK_UP_BROADCAST_MAX &&
          !_isRateLimited(username, 'rank_up')) {
        await _emit(prisma, {
          type: 'rank_up',
          username,
          payload: { newRank: rankNow, oldRank: prevSnapshot.rank },
        })
        if (pick.userId) {
          await _emit(prisma, {
            type: 'rank_change',
            username,
            targetUserId: pick.userId,
            payload: { newRank: rankNow, oldRank: prevSnapshot.rank, delta: prevSnapshot.rank - rankNow },
          })
        }
      }
    }
  } catch (e) {
    console.error('[ws-events] post-grade event error:', e)
  }

  const MILESTONES = [25, 50, 100, 200]
  const prevPicks  = prevSnapshot.picks || 0
  try {
    const rows = await prisma.$queryRaw`
      SELECT "totalPicks" FROM user_rankings WHERE username = ${username} LIMIT 1
    `
    if (rows.length) {
      const total = rows[0].totalPicks
      for (const m of MILESTONES) {
        if (total >= m && prevPicks < m) {
          await _emit(prisma, { type: 'milestone_pick', username, payload: { count: m } })
          break
        }
      }
    }
  } catch (_) {}
}

// Call in POST /picks/:id/tail after a new tail is created
async function emitPickTailed(prisma, pick, tailCount) {
  if (!pick || !pick.userId) return
  await _emit(prisma, {
    type: 'pick_tailed',
    username: pick.username,
    targetUserId: pick.userId,
    payload: { pickId: pick.id, count: tailCount, event: pick.event },
  })
}

// Call in POST /picks after pick creation
async function emitPickPosted(prisma, pick) {
  if (!pick || !pick.userId) return
  try {
    const followers = await prisma.follow.findMany({
      where:  { followingId: pick.userId },
      select: { followerId: true },
    })
    for (const row of followers) {
      await _emit(prisma, {
        type: 'followed_posted',
        username: pick.username,
        targetUserId: row.followerId,
        payload: {
          pickId: pick.id,
          event:  pick.event,
          market: pick.market,
          odds:   parseFloat(pick.odds || 0),
          sport:  pick.sport,
        },
      })
    }
  } catch (e) {
    console.error('[ws-events] emitPickPosted error:', e)
  }
}

// ─── REST routes ──────────────────────────────────────────────────────────────

function registerRoutes(app, prisma, requireAuth) {

  // Cold load for feed page and reconnect catch-up
  app.get('/live-events', async (req, res) => {
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50)
    const since = parseInt(req.query.since, 10) || 0
    try {
      const rows = await prisma.$queryRaw`
        SELECT id AS "eventId", type, rarity, username, payload, "createdAt"
        FROM live_events
        WHERE "targetUserId" IS NULL AND id > ${since}
        ORDER BY id DESC LIMIT ${limit}
      `
      res.json(rows.map(r => ({
        ...r,
        eventId: Number(r.eventId),
        payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      })))
    } catch (e) {
      console.error('GET /live-events error:', e)
      res.status(500).json({ error: 'Server error' })
    }
  })

  app.get('/notifications', requireAuth, async (req, res) => {
    const userId = req.userId
    const limit  = Math.min(50, parseInt(req.query.limit, 10) || 30)
    try {
      const rows = await prisma.$queryRaw`
        SELECT id, type, rarity, payload, "readAt", "createdAt"
        FROM user_notifications
        WHERE "userId" = ${userId}
        ORDER BY "createdAt" DESC LIMIT ${limit}
      `
      res.json(rows.map(r => ({
        ...r,
        id:      Number(r.id),
        payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      })))
    } catch (e) {
      res.status(500).json({ error: 'Server error' })
    }
  })

  app.patch('/notifications/read/:id', requireAuth, async (req, res) => {
    const userId = req.userId
    const id     = parseInt(req.params.id, 10)
    if (!id) return res.status(400).json({ error: 'Invalid id' })
    try {
      await prisma.$executeRaw`
        UPDATE user_notifications SET "readAt" = NOW() WHERE id = ${id} AND "userId" = ${userId}
      `
      res.json({ success: true })
    } catch (e) {
      res.status(500).json({ error: 'Server error' })
    }
  })

  app.patch('/notifications/read-all', requireAuth, async (req, res) => {
    const userId = req.userId
    try {
      await prisma.$executeRaw`
        UPDATE user_notifications SET "readAt" = NOW() WHERE "userId" = ${userId} AND "readAt" IS NULL
      `
      res.json({ success: true })
    } catch (e) {
      res.status(500).json({ error: 'Server error' })
    }
  })
}

module.exports = {
  onWsConnect,
  onWsClose,
  handleLiveMessage,
  startOnlineCountBroadcast,
  emitPickGraded,
  emitPickTailed,
  emitPickPosted,
  registerRoutes,
}
