-- 003_material_lifecycle.sql
-- Separate material generation state from applications.status.
-- Apply after migrations 001 and 002. Additive and safe to re-run.

CREATE TABLE IF NOT EXISTS material_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES applications(id),
  version TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'claimed', 'succeeded', 'failed')),
  source_exists INTEGER NOT NULL DEFAULT 0,
  hard_gates_pass INTEGER NOT NULL DEFAULT 0,
  reused_from_job_id INTEGER,
  profile_revision TEXT,
  template_revision TEXT,
  renderer_revision TEXT,
  artifact_prefix TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE (job_id, version)
);

CREATE INDEX IF NOT EXISTS idx_material_versions_job
  ON material_versions (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_material_versions_claimable
  ON material_versions (state, lease_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_material_versions_one_active
  ON material_versions (job_id) WHERE state IN ('pending', 'claimed');

CREATE TABLE IF NOT EXISTS render_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_version_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'claimed', 'succeeded', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (material_version_id) REFERENCES material_versions(id),
  UNIQUE (material_version_id)
);

CREATE INDEX IF NOT EXISTS idx_render_jobs_claimable
  ON render_jobs (state, lease_expires_at);
