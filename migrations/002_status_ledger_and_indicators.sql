-- 002_status_ledger_and_indicators.sql
--
-- Additive migration for the portal status subset:
--   * status_events — append-only status ledger per job
--   * nullable follow-up/indicator columns on applications
--     (follow_up_due, urgency, is_repost, gate)
--
-- Additive only: no column is dropped, renamed, retyped or reordered,
-- and no existing row is modified. Old readers that SELECT explicit
-- column lists are unaffected; new columns default to NULL / 0.
--
-- BACK UP FIRST. Turso is live production:
--   turso db shell <db> ".dump" > applications-backup-$(date +%F).sql
--
-- Apply directly:
--   turso db shell <db> < migrations/002_status_ledger_and_indicators.sql
--
-- CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS statements are
-- safe to re-run. SQLite has no ADD COLUMN IF NOT EXISTS, so re-running
-- the ALTER TABLE block raises "duplicate column name: ..." — that error
-- is harmless and means the migration is already applied (same convention
-- as migrations/001).

CREATE TABLE IF NOT EXISTS status_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL,
  status     TEXT    NOT NULL,
  note       TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_status_events_job
  ON status_events (job_id, created_at);

ALTER TABLE applications ADD COLUMN follow_up_due TEXT;
ALTER TABLE applications ADD COLUMN urgency TEXT;
ALTER TABLE applications ADD COLUMN is_repost INTEGER DEFAULT 0;
ALTER TABLE applications ADD COLUMN gate TEXT;
-- applied_at already exists in the applications table created by the Pi scraper.
-- Do not re-add it here: SQLite has no ADD COLUMN IF NOT EXISTS.
