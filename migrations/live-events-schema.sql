-- LEDGR — Live Events Schema (PostgreSQL / Supabase)
-- Run after rankings-schema.sql

-- ── live_events ────────────────────────────────────────────────
-- Persisted for cold-load and reconnect catch-up.
-- Nightly purge: DELETE FROM live_events WHERE "createdAt" < NOW() - INTERVAL '7 days';
CREATE TABLE IF NOT EXISTS live_events (
  id              BIGSERIAL PRIMARY KEY,
  type            VARCHAR(30) NOT NULL,
  rarity          SMALLINT NOT NULL DEFAULT 1,
  username        VARCHAR(50) DEFAULT NULL,
  "targetUserId"  TEXT DEFAULT NULL,
  payload         JSONB NOT NULL,
  "createdAt"     TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_le_broadcast ON live_events ("targetUserId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_le_type      ON live_events (type, "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_le_created   ON live_events ("createdAt" DESC);

-- ── user_notifications ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_notifications (
  id          BIGSERIAL PRIMARY KEY,
  "userId"    TEXT NOT NULL,
  type        VARCHAR(30) NOT NULL,
  rarity      SMALLINT NOT NULL DEFAULT 1,
  payload     JSONB NOT NULL,
  "readAt"    TIMESTAMP DEFAULT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_un_user_created ON user_notifications ("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_un_user_unread  ON user_notifications ("userId", "readAt");
