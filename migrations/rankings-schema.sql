-- LEDGR — Rankings Schema (PostgreSQL / Supabase)
-- Run Block 1 (profiles) first, then this block, then live-events-schema.sql

-- ── user_rankings ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_rankings (
  "userId"           TEXT NOT NULL PRIMARY KEY,
  username           VARCHAR(50) NOT NULL,
  "totalPicks"       INTEGER NOT NULL DEFAULT 0,
  wins               INTEGER NOT NULL DEFAULT 0,
  losses             INTEGER NOT NULL DEFAULT 0,
  pushes             INTEGER NOT NULL DEFAULT 0,
  "totalStake"       NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  "totalPnl"         NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  roi                NUMERIC(8,4)  NOT NULL DEFAULT 0.0000,
  "winRate"          NUMERIC(6,4)  NOT NULL DEFAULT 0.0000,
  elo                INTEGER NOT NULL DEFAULT 1000,
  "divisionScore"    NUMERIC(6,2)  NOT NULL DEFAULT 0.00,
  division           VARCHAR(20)   NOT NULL DEFAULT 'BRONZE'
                     CHECK (division IN ('BRONZE','SILVER','GOLD','PLATINUM','DIAMOND','ELITE','LEGENDARY')),
  "sharpScore"       NUMERIC(6,2)  NOT NULL DEFAULT 0.00,
  "reliabilityScore" NUMERIC(6,2)  NOT NULL DEFAULT 0.00,
  "clvAvg"           NUMERIC(8,4)  DEFAULT NULL,
  "currentStreak"    INTEGER NOT NULL DEFAULT 0,
  "streakType"       VARCHAR(10)   NOT NULL DEFAULT 'none'
                     CHECK ("streakType" IN ('win','loss','none')),
  "bestStreak"       INTEGER NOT NULL DEFAULT 0,
  archetype          VARCHAR(30)   DEFAULT NULL,
  "flowState"        VARCHAR(30)   DEFAULT NULL,
  "isLive"           SMALLINT NOT NULL DEFAULT 0,
  "lastPickAt"       TIMESTAMP DEFAULT NULL,
  "avgOdds"          NUMERIC(8,4)  DEFAULT NULL,
  "clvSum"           NUMERIC(12,4) NOT NULL DEFAULT 0.0000,
  "clvCount"         INTEGER NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP DEFAULT NOW(),
  "updatedAt"        TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ur_division  ON user_rankings (division);
CREATE INDEX IF NOT EXISTS idx_ur_elo       ON user_rankings (elo DESC);
CREATE INDEX IF NOT EXISTS idx_ur_roi       ON user_rankings (roi DESC);
CREATE INDEX IF NOT EXISTS idx_ur_username  ON user_rankings (username);
CREATE INDEX IF NOT EXISTS idx_ur_updated   ON user_rankings ("updatedAt" DESC);

-- ── ranking_history ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ranking_history (
  id              BIGSERIAL PRIMARY KEY,
  "userId"        TEXT NOT NULL,
  username        VARCHAR(50) NOT NULL,
  "isoWeek"       CHAR(8) NOT NULL,
  elo             INTEGER NOT NULL,
  division        VARCHAR(20) NOT NULL,
  "divisionScore" NUMERIC(6,2) NOT NULL,
  "sharpScore"    NUMERIC(6,2) NOT NULL,
  roi             NUMERIC(8,4) NOT NULL,
  "winRate"       NUMERIC(6,4) NOT NULL,
  "totalPicks"    INTEGER NOT NULL,
  rank            INTEGER DEFAULT NULL,
  "snapshotAt"    TIMESTAMP DEFAULT NOW(),

  UNIQUE ("userId", "isoWeek")
);

CREATE INDEX IF NOT EXISTS idx_rh_userId  ON ranking_history ("userId");
CREATE INDEX IF NOT EXISTS idx_rh_isoWeek ON ranking_history ("isoWeek");

-- ── recent_picks_cache ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recent_picks_cache (
  "userId"    TEXT NOT NULL,
  slot        SMALLINT NOT NULL,
  result      VARCHAR(10) NOT NULL DEFAULT 'pending'
              CHECK (result IN ('win','loss','push','pending')),
  sport       VARCHAR(30) DEFAULT NULL,
  market      VARCHAR(50) DEFAULT NULL,
  odds        NUMERIC(8,4) DEFAULT NULL,
  "createdAt" TIMESTAMP DEFAULT NULL,

  PRIMARY KEY ("userId", slot)
);

CREATE INDEX IF NOT EXISTS idx_rpc_userId ON recent_picks_cache ("userId");
