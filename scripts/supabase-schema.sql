-- Woodway Golf Pool — Database Schema
-- Run against Neon Postgres to set up all tables

-- ─── Tournaments (replaces purse.json) ─────────────────────────────────────
CREATE TABLE tournaments (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  espn_event_id TEXT NOT NULL,
  purse         BIGINT NOT NULL,
  payout_pcts   JSONB NOT NULL,            -- array of floats, one per position
  entry_fee     NUMERIC(8,2) DEFAULT 0,
  rules_text    TEXT,
  submissions_open BOOLEAN DEFAULT FALSE,
  is_active     BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Tournament Golfers (replaces odds.json + AMATEURS set) ────────────────
CREATE TABLE tournament_golfers (
  id              SERIAL PRIMARY KEY,
  tournament_id   INT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  golfer_name     TEXT NOT NULL,            -- display name (e.g., "Rory McIlroy")
  normalized_name TEXT NOT NULL,            -- lowercase, no accents (e.g., "rory mcilroy")
  odds_multiplier INT NOT NULL DEFAULT 1,
  is_amateur      BOOLEAN DEFAULT FALSE,
  UNIQUE(tournament_id, normalized_name)
);

CREATE INDEX idx_tg_tournament ON tournament_golfers(tournament_id);
CREATE INDEX idx_tg_normalized ON tournament_golfers(normalized_name);

-- ─── Entries / Teams (replaces picks.json team names) ──────────────────────
CREATE TABLE entries (
  id            SERIAL PRIMARY KEY,
  tournament_id INT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_name     TEXT NOT NULL,
  email         TEXT,
  access_code   CHAR(6),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tournament_id, team_name)
);

CREATE INDEX idx_entries_tournament ON entries(tournament_id);

-- ─── Entry Picks (replaces picks.json player arrays) ──────────────────────
CREATE TABLE entry_picks (
  id         SERIAL PRIMARY KEY,
  entry_id   INT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  golfer_id  INT NOT NULL REFERENCES tournament_golfers(id) ON DELETE CASCADE,
  pick_order SMALLINT NOT NULL CHECK (pick_order BETWEEN 1 AND 6),
  UNIQUE(entry_id, golfer_id),
  UNIQUE(entry_id, pick_order)
);

CREATE INDEX idx_picks_entry ON entry_picks(entry_id);

-- ─── Name Aliases (replaces NAME_ALIASES in app.js) ───────────────────────
CREATE TABLE name_aliases (
  id              SERIAL PRIMARY KEY,
  tournament_id   INT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  alias_name      TEXT NOT NULL,            -- normalized misspelling
  canonical_name  TEXT NOT NULL,            -- normalized correct name
  UNIQUE(tournament_id, alias_name)
);

-- ─── Read-only role for browser access ─────────────────────────────────────
-- (Neon manages roles differently; we'll use the default role with
--  the serverless driver for reads. Admin writes happen via migration
--  scripts and eventually the admin panel.)
