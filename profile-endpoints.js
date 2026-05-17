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

const VALID_ARCHETYPES = new Set(['sniper','demon','grinder','sharp','value-hunter','lock-machine','ice-cold','profit-farmer','underdog-king','data-nerd','momentum-monster'])
const VALID_BANNERS    = new Set(['default','purple-haze','cyber-teal','gold-rush','fire-wave','ice-storm','diamond','legend-aura',
  'midnight','purple-fade','frost','carbon','dark-smoke',
  'cosmic-nebula','diamond-storm','crimson-energy','electric-void','phantom-pulse',
  'galaxy-motion','dragon-aura','eternal-flame','neon-rift','crown-energy'])
const VALID_BORDERS    = new Set(['none','clean','blue-ring','diamond-ring','cosmic','electric-pulse','inferno-ring',
  'royal-aura','dragon-border','celestial-orbit','halloween','winter-elite','summer-champion',
  'bronze-frame','silver-frame','gold-frame','diamond-frame','elite-frame',
  'pulse','gold','fire','legend'])
const VALID_THEMES     = new Set(['default','gold','cyan','red','green','orange','pink','white'])
const VALID_THEME_COLORS = new Set(['#7B2CFF','#FFD700','#00E5A0','#FF3355','#4FC3F7','#FF6B35','#E040FB','#FFFFFF'])
const VALID_ODDS_FORMATS = new Set(['decimal','american','fractional'])
const VALID_SPORTS     = new Set(['Soccer','Basketball','Tennis','Football','Baseball','MMA/Boxing'])

async function ensureProfileColumns(prisma) {
  const cols = [
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS profile_theme_color VARCHAR(20) DEFAULT '#7B2CFF'`,
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS banner_pack VARCHAR(50) DEFAULT 'midnight'`,
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_border_type VARCHAR(50) DEFAULT 'none'`,
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS odds_format VARCHAR(20) DEFAULT 'decimal'`,
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS timezone VARCHAR(60) DEFAULT 'UTC'`,
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS hide_from_leaderboard BOOLEAN DEFAULT FALSE`,
  ]
  for (const sql of cols) {
    try { await prisma.$executeRawUnsafe(sql) } catch(e) { /* column may already exist */ }
  }
}

function registerRoutes(app, prisma, requireAuth) {
  // Run column migrations on startup (non-blocking)
  ensureProfileColumns(prisma).catch(e => console.error('Profile migration warning:', e.message))

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
      return res.json({
        archetype:             p.archetype || null,
        banner:                p.banner || 'default',
        border:                p.border || 'clean',
        theme:                 p.theme || 'default',
        fav_sports:            p.fav_sports
                                 ? (typeof p.fav_sports === 'string' ? JSON.parse(p.fav_sports) : p.fav_sports)
                                 : [],
        bio:                   p.bio || '',
        social_twitter:        p.social_twitter || null,
        social_instagram:      p.social_instagram || null,
        avatar_b64:            p.avatar_b64 || null,
        banner_b64:            p.banner_b64 || null,
        profile_theme_color:   p.profile_theme_color || '#7B2CFF',
        banner_pack:           p.banner_pack || 'midnight',
        avatar_border_type:    p.avatar_border_type || 'none',
        odds_format:           p.odds_format || 'decimal',
        timezone:              p.timezone || 'UTC',
        hide_from_leaderboard: p.hide_from_leaderboard || false,
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

    const { archetype, banner, border, theme, favSports, bio, social, avatarB64, bannerB64,
            profileThemeColor, bannerPack, avatarBorderType, oddsFormat, timezone, hideFromLeaderboard } = req.body

    if (avatarB64 != null && avatarB64.length > AVATAR_MAX_BYTES) {
      return res.status(413).json({ error: 'Avatar image too large — max 300 KB' })
    }
    if (bannerB64 != null && bannerB64.length > BANNER_MAX_BYTES) {
      return res.status(413).json({ error: 'Banner image too large — max 500 KB' })
    }

    const safeArchetype       = VALID_ARCHETYPES.has(archetype) ? archetype : null
    const safeBanner          = VALID_BANNERS.has(banner) ? banner : 'default'
    const safeBorder          = VALID_BORDERS.has(border) ? border : 'clean'
    const safeTheme           = VALID_THEMES.has(theme) ? theme : 'default'
    const safeSports          = Array.isArray(favSports) ? favSports.filter(s => VALID_SPORTS.has(s)).slice(0, 4) : []
    const safeBio             = _sanitizeBio(bio)
    const safeTwitter         = _sanitizeHandle(social && social.twitter)
    const safeInstagram       = _sanitizeHandle(social && social.instagram)
    const avatarChanged       = 'avatarB64' in req.body
    const bannerChanged       = 'bannerB64' in req.body
    const safeThemeColor      = VALID_THEME_COLORS.has(profileThemeColor) ? profileThemeColor : null
    const safeBannerPack      = VALID_BANNERS.has(bannerPack) ? bannerPack : null
    const safeAvatarBorder    = VALID_BORDERS.has(avatarBorderType) ? avatarBorderType : null
    const safeOddsFormat      = VALID_ODDS_FORMATS.has(oddsFormat) ? oddsFormat : null
    const safeTimezone        = timezone ? String(timezone).slice(0, 60) : null
    const safeHideLeaderboard = hideFromLeaderboard === true || hideFromLeaderboard === 'true' ? true : null

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

      // Update new identity fields if provided
      if (safeThemeColor || safeBannerPack || safeAvatarBorder || safeOddsFormat || safeTimezone || safeHideLeaderboard !== null) {
        const parts = []
        if (safeThemeColor)            parts.push(`profile_theme_color = '${safeThemeColor}'`)
        if (safeBannerPack)            parts.push(`banner_pack = '${safeBannerPack}'`)
        if (safeAvatarBorder)          parts.push(`avatar_border_type = '${safeAvatarBorder}'`)
        if (safeOddsFormat)            parts.push(`odds_format = '${safeOddsFormat}'`)
        if (safeTimezone)              parts.push(`timezone = '${safeTimezone.replace(/'/g,"''")}'`)
        if (safeHideLeaderboard !== null) parts.push(`hide_from_leaderboard = ${safeHideLeaderboard}`)
        if (parts.length) {
          await prisma.$executeRawUnsafe(
            `UPDATE profiles SET ${parts.join(', ')}, updated_at = NOW() WHERE "userId" = '${userId}'`
          )
        }
      }

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
}

module.exports = { registerRoutes }
