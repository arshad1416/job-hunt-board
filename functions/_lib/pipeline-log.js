/** Small, non-fatal structured logger for generation pipeline stages. */
const SAFE_FIELDS = new Set([
  'job_id', 'stage', 'status', 'duration_ms', 'cached', 'reused',
  'reused_from_job_id', 'jd_source', 'error_code', 'version'
]);

function safeFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).filter(([key, value]) =>
    SAFE_FIELDS.has(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null)
  ));
}

/** Emit one JSON line; logging must never change request behavior. */
export function logPipelineStage(stage, fields = {}) {
  try {
    console.log(JSON.stringify({ event: 'pipeline_stage', ...safeFields(fields), stage: String(stage) }));
  } catch { /* ponytail: logging ceiling is best-effort; add durable telemetry when needed. */ }
}

export function pipelineStage(stage, fields = {}) {
  const started = Date.now();
  return (extra = {}) => logPipelineStage(stage, { ...fields, ...extra, duration_ms: Date.now() - started });
}
