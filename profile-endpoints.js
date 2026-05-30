'use strict'

const AVATAR_MAX_BYTES = 300 * 1024
const BANNER_MAX_BYTES = 500 * 1024

const _rlMap = new Map()
function _checkRateLimit(userId) {
  const now    = Date.now()
  const window = 60_000
  const limit  = 10
  const calls  = (_rlMap.get(userId) || []).filter(t => now - t < window)
  if (calls.length >= limit) return false
  calls.push(now)
  _rlMap.set(userId, calls)
  return true
}

function _sanitizeBio(bio) {
  if (!bio) return ''
  return String(bio).replace(/<[^>]*>/g, '').trim().slice(0, 160)
}

function _sanitizeHandle(handle) {
  if (!handle) return null
  const clean = String(handle).replace(/^@/, '').replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 50)
  return clean || null
}

const VALID_ARCHETYPES = new Set([
  // Canonical performance keys (current system)
  'sharp','value-hunter','underdog-king','grinder','specialist','data-nerd','high-stakes','contender',
  // Canonical cosmetic keys (stored by some clients)
  'oracle','diamond-mind','dragon-soul','shark','kingmaker','void-emperor','reaper',
  // Legacy keys — kept for backward compat
  'sniper','demon','lock-machine','ice-cold','profit-farmer','momentum-monster',
])
const VALID_BANNERS    = new Set(['default','purple-haze','cyber-teal','gold-rush','fire-wave','ice-storm','diamond','legend-aura','midnight','purple-fade','frost','carbon','dark-smoke','cosmic-nebula','diamond-storm','crimson-energy','electric-void','phantom-pulse','galaxy-motion','dragon-aura','eternal-flame','neon-rift','crown-energy','purple-haze','cyber-teal','fire-wave'])
const VALID_BORDERS    = new Set(['none','clean','pulse','gold','fire','diamond','legend','blue-ring','diamond-ring','cosmic','electric','inferno','royal','dragon','celestial','bronze-frame','silver-frame','gold-frame','diamond-frame','elite-frame'])
const VALID_THEMES     = new Set(['default','purple','gold','emerald','crimson','ice','ember','neon','platinum','cyan','red','green','orange','pink','white'])
const VALID_SPORTS     = new Set(['Soccer','Basketball','Tennis','Football','Baseball','MMA/Boxing'])

function registerRoutes(app, prisma, requireAuth) {

  // GET /profile/:username — public
  app.get('/profile/:username', async (req, res) => {
    const { username } = req.params
    if (!/^[a-zA-Z0-9_\-]{1,50}$/.test(username)) {
      return res.status(400).json({ error: 'Invalid username' })
    }
    try {
      const rows = await prisma.$queryRaw`
        SELECT * FROM profiles WHERE username = ${username} LIMIT 1
      `
      if (!rows.length) return res.json({})
      const p = rows[0]

      // Resolve archetype: manual override takes priority, rankings fallback if null
      let archetype = p.archetype || null
      let archetypeSource = archetype ? 'manual' : null
      if (!archetype) {
        const rankRows = await prisma.$queryRaw`
          SELECT archetype FROM user_rankings WHERE username = ${username} LIMIT 1
        `
        if (rankRows.length && rankRows[0].archetype) {
          archetype = rankRows[0].archetype
          archetypeSource = 'rankings'
        }
      }

      return res.json({
        archetype:        archetype,
        archetypeSource:  archetypeSource,
        banner:           p.banner || 'default',
        border:           p.border || 'clean',
        theme:            p.theme || 'default',
        fav_sports:       p.fav_sports
                            ? (typeof p.fav_sports === 'string' ? JSON.parse(p.fav_sports) : p.fav_sports)
                            : [],
        bio:              p.bio || '',
        social_twitter:   p.social_twitter || null,
        social_instagram: p.social_instagram || null,
        avatar_b64:       p.avatar_b64 || null,
        banner_b64:       p.banner_b64 || null,
      })
    } catch (e) {
      console.error('GET /profile error:', e)
      res.status(500).json({ error: 'Server error' })
    }
  })

  // POST /profile — authenticated upsert
  app.post('/profile', requireAuth, async (req, res) => {
    const userId = req.userId

    if (!_checkRateLimit(userId)) {
      return res.status(429).json({ error: 'Too many requests — wait a minute' })
    }

    const { archetype, banner, border, theme, favSports, bio, social, avatarB64, bannerB64 } = req.body

    if (avatarB64 != null && avatarB64.length > AVATAR_MAX_BYTES) {
      return res.status(413).json({ error: 'Avatar image too large — max 300 KB' })
    }
    if (bannerB64 != null && bannerB64.length > BANNER_MAX_BYTES) {
      return res.status(413).json({ error: 'Banner image too large — max 500 KB' })
    }

    const safeArchetype  = VALID_ARCHETYPES.has(archetype) ? archetype : null
    const safeBanner     = VALID_BANNERS.has(banner) ? banner : 'default'
    const safeBorder     = VALID_BORDERS.has(border) ? border : 'clean'
    const safeTheme      = VALID_THEMES.has(theme) ? theme : 'default'
    const safeSports     = Array.isArray(favSports) ? favSports.filter(s => VALID_SPORTS.has(s)).slice(0, 4) : []
    const safeBio        = _sanitizeBio(bio)
    const safeTwitter    = _sanitizeHandle(social && social.twitter)
    const safeInstagram  = _sanitizeHandle(social && social.instagram)
    const avatarChanged  = 'avatarB64' in req.body
    const bannerChanged  = 'bannerB64' in req.body

    try {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } })
      if (!user) return res.status(404).json({ error: 'User not found' })
      const { username } = user

      await prisma.$executeRaw`
        INSERT INTO profiles
          ("userId", username, bio, social_twitter, social_instagram,
           archetype, banner, border, theme, fav_sports)
        VALUES (
          ${userId}, ${username}, ${safeBio}, ${safeTwitter}, ${safeInstagram},
          ${safeArchetype}, ${safeBanner}, ${safeBorder}, ${safeTheme},
          ${JSON.stringify(safeSports)}::jsonb
        )
        ON CONFLICT ("userId") DO UPDATE SET
          username         = EXCLUDED.username,
          bio              = EXCLUDED.bio,
          social_twitter   = EXCLUDED.social_twitter,
          social_instagram = EXCLUDED.social_instagram,
          archetype        = EXCLUDED.archetype,
          banner           = EXCLUDED.banner,
          border           = EXCLUDED.border,
          theme            = EXCLUDED.theme,
          fav_sports       = EXCLUDED.fav_sports,
          updated_at       = NOW()
      `

      if (avatarChanged) {
        const safeAvatar = avatarB64 || null
        await prisma.$executeRaw`
          UPDATE profiles SET avatar_b64 = ${safeAvatar}, updated_at = NOW() WHERE "userId" = ${userId}
        `
      }
      if (bannerChanged) {
        const safeBannerImg = bannerB64 || null
        await prisma.$executeRaw`
          UPDATE profiles SET banner_b64 = ${safeBannerImg}, updated_at = NOW() WHERE "userId" = ${userId}
        `
      }

      res.json({ success: true })
    } catch (e) {
      console.error('POST /profile error:', e)
      res.status(500).json({ error: 'Server error' })
    }
  })

  // GET /profile — authenticated, returns current user's own profile
  // Called by shared/identity.js syncFromBackend()
  app.get('/profile', requireAuth, async (req, res) => {
    const userId = req.userId
    try {
      const rows = await prisma.$queryRaw`
        SELECT * FROM profiles WHERE "userId" = ${userId} LIMIT 1
      `
      if (!rows.length) return res.json({})
      const p = rows[0]

      // Resolve archetype: manual override takes priority, rankings fallback if null
      let archetype = p.archetype || null
      let archetypeSource = archetype ? 'manual' : null
      if (!archetype) {
        const rankRows = await prisma.$queryRaw`
          SELECT archetype FROM user_rankings WHERE "userId" = ${userId} LIMIT 1
        `
        if (rankRows.length && rankRows[0].archetype) {
          archetype = rankRows[0].archetype
          archetypeSource = 'rankings'
        }
      }

      return res.json({
        archetype:        archetype,
        archetypeSource:  archetypeSource,
        banner:           p.banner || 'default',
        border:           p.border || 'clean',
        theme:            p.theme || 'default',
        fav_sports:       p.fav_sports
                            ? (typeof p.fav_sports === 'string' ? JSON.parse(p.fav_sports) : p.fav_sports)
                            : [],
        bio:              p.bio || '',
        social_twitter:   p.social_twitter || null,
        social_instagram: p.social_instagram || null,
        avatar_b64:       p.avatar_b64 || null,
        banner_b64:       p.banner_b64 || null,
      })
    } catch (e) {
      console.error('GET /profile error:', e)
      res.status(500).json({ error: 'Server error' })
    }
  })

  // PATCH /profile — authenticated, partial field update
  // Called by settings pickers (banner, border, theme) and shared/identity.js save()
  // Accepts both camelCase and snake_case field names from frontend
  app.patch('/profile', requireAuth, async (req, res) => {
    const userId = req.userId
    if (!_checkRateLimit(userId)) {
      return res.status(429).json({ error: 'Too many requests — wait a minute' })
    }
    try {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } })
      if (!user) return res.status(404).json({ error: 'User not found' })
      const { username } = user

      // Accept both naming conventions from frontend callers
      const body      = req.body
      const banner    = body.banner    || body.bannerPack   || body.bannerId   || undefined
      const border    = body.border    || body.avatarBorder || body.borderId   || undefined
      const theme     = body.theme     || body.profileTheme || body.themeId    || undefined
      const archetype = body.archetype || body.manualArchetype                 || undefined

      const safeBanner    = banner    && VALID_BANNERS.has(banner)       ? banner    : undefined
      const safeBorder    = border    && VALID_BORDERS.has(border)       ? border    : undefined
      const safeTheme     = theme     && VALID_THEMES.has(theme)         ? theme     : undefined
      const safeArchetype = archetype && VALID_ARCHETYPES.has(archetype) ? archetype : undefined

      const updatedCount = [safeBanner, safeBorder, safeTheme, safeArchetype].filter(v => v !== undefined).length
      if (updatedCount === 0) return res.json({ success: true, updated: 0 })

      // Read current row so we don't overwrite unrelated fields
      const existing = await prisma.$queryRaw`
        SELECT * FROM profiles WHERE "userId" = ${userId} LIMIT 1
      `
      const curr = existing[0] || {}

      const newBanner    = safeBanner    !== undefined ? safeBanner    : (curr.banner    || 'default')
      const newBorder    = safeBorder    !== undefined ? safeBorder    : (curr.border    || 'clean')
      const newTheme     = safeTheme     !== undefined ? safeTheme     : (curr.theme     || 'default')
      const newArchetype = safeArchetype !== undefined ? safeArchetype : (curr.archetype || null)

      await prisma.$executeRaw`
        INSERT INTO profiles
          ("userId", username, banner, border, theme, archetype,
           bio, social_twitter, social_instagram, fav_sports, updated_at)
        VALUES (
          ${userId}, ${username},
          ${newBanner}, ${newBorder}, ${newTheme}, ${newArchetype},
          ${curr.bio || ''}, ${curr.social_twitter || null}, ${curr.social_instagram || null},
          ${curr.fav_sports ? (typeof curr.fav_sports === 'string' ? curr.fav_sports : JSON.stringify(curr.fav_sports)) : '[]'}::jsonb,
          NOW()
        )
        ON CONFLICT ("userId") DO UPDATE SET
          banner     = EXCLUDED.banner,
          border     = EXCLUDED.border,
          theme      = EXCLUDED.theme,
          archetype  = EXCLUDED.archetype,
          updated_at = NOW()
      `

      res.json({ success: true, updated: updatedCount })
    } catch (e) {
      console.error('PATCH /profile error:', e)
      res.status(500).json({ error: 'Server error' })
    }
  })
}

module.exports = { registerRoutes }
