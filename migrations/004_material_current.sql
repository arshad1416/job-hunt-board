-- Atomic, immutable current pointer: first successful version wins.
CREATE TABLE IF NOT EXISTS material_current (
  job_id INTEGER PRIMARY KEY REFERENCES applications(id),
  material_version_id INTEGER NOT NULL UNIQUE REFERENCES material_versions(id),
  version TEXT NOT NULL,
  set_at TEXT NOT NULL DEFAULT (datetime('now'))
);
