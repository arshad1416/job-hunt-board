/* ═══════════════════════════════════════════════════════════════
   Job Hunt Board — Frontend Controller (app.js)
   Static-first: fetches /data/jobs.json, renders table, filters
   client-side, calls /api/* for mutations only.
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────
  let allJobs = [];
  let filteredJobs = [];
  const filters = {
    track: 'all',
    minScore: 0,
    status: 'all',
    search: ''
  };

  // ── DOM refs ───────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const tbody = $('jobs-tbody');
  const emptyState = $('empty-state');
  const loadingState = $('loading-state');

  // ═══════════════════════════════════════════════════════════════
  // AUTH TOKEN MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
  const TOKEN_KEY = 'jhb_auth_token';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function setToken(token) {
    localStorage.setItem(TOKEN_KEY, token.trim());
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  }

  function authHeaders() {
    const token = getToken();
    const h = { 'Content-Type': 'application/json' };
    if (token) h['X-Auth-Token'] = token;
    return h;
  }

  // ═══════════════════════════════════════════════════════════════
  // UTILITY FUNCTIONS
  // ═══════════════════════════════════════════════════════════════

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Encode inline-handler arguments as HTML-safe JSON strings.
  function inlineArg(value) {
    return escapeHtml(JSON.stringify(String(value)));
  }

  /**
   * Validate that a URL uses a safe http(s) protocol before rendering it as
   * a link. Prevents javascript:/data: URLs from being injected into href (W6).
   */
  function isSafeUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
  }

  /**
   * Format a date string (ISO or "YYYY-MM-DD HH:MM:SS") into a
   * human-readable relative or absolute short date.
   */
  function formatDate(dateStr) {
    if (!dateStr) return '—';
    try {
      // Handle "YYYY-MM-DD HH:MM:SS" (SQLite format) by replacing space with T
      let iso = dateStr;
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(iso)) {
        iso = iso.replace(' ', 'T') + 'Z';
      }
      const d = new Date(iso);
      if (isNaN(d.getTime())) return dateStr;

      const now = new Date();
      const diffMs = now - d;
      const diffH = Math.floor(diffMs / 3600000);
      const diffD = Math.floor(diffH / 24);

      if (diffH < 1) return 'just now';
      if (diffH < 24) return diffH + 'h ago';
      if (diffD === 1) return '1d ago';
      if (diffD < 7) return diffD + 'd ago';
      if (diffD < 30) return Math.floor(diffD / 7) + 'w ago';
      return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
    } catch {
      return dateStr || '—';
    }
  }

  function formatSalary(salary) {
    if (!salary || salary === 'null' || salary === 'None') return null;
    return salary;
  }

  function formatAsking(ask) {
    if (ask == null) return null;
    const num = Number(ask);
    if (isNaN(num)) return null;
    return '$' + num.toLocaleString('en-CA');
  }

  /**
   * Derive the "posted" date for a job.
   * The Turso applications table does NOT have a posted_at column,
   * so we fall back to found_at (when the Pi scraped it).
   */
  function getPostedDate(job) {
    return job.posted_date || job.posted_at || job.found_at || '';
  }

  function scoreClass(score) {
    if (score >= 70) return 'score-high';
    if (score >= 50) return 'score-mid';
    return 'score-low';
  }

  function trackLabel(track) {
    switch (track) {
      case 'ev_commercial':   return 'EV';
      case 'ai_engineering':  return 'AI';
      default:                return 'OTHER';
    }
  }

  function trackClass(track) {
    switch (track) {
      case 'ev_commercial':   return 'ev_commercial';
      case 'ai_engineering':  return 'ai_engineering';
      default:                return 'other';
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // EXTENDED STATUS VOCABULARY (portal subset)
  // ═══════════════════════════════════════════════════════════════
  // Mirrors functions/_lib/status.js. The first four values are the
  // legacy statuses; the rest are additive extensions. Old jobs.json
  // files never contain them, so rendering falls back cleanly.
  const STATUS_LABELS = {
    found: 'New',
    materials_ready: 'Materials Ready',
    saved: 'Saved',
    applied: 'Applied',
    screening: 'Screening',
    interview: 'Interview',
    offer: 'Offer',
    rejected: 'Rejected',
    ghosted: 'Ghosted'
  };
  const POST_APPLIED = new Set([
    'applied', 'screening', 'interview', 'offer', 'rejected', 'ghosted'
  ]);
  const FOLLOW_UP_ELIGIBLE = new Set(['applied', 'screening', 'interview', 'offer']);

  function normalizeStatus(raw) {
    if (typeof raw !== 'string') return null;
    const key = raw.trim().toLowerCase();
    if (key === 'not_applied' || key === 'new') return 'found';
    return STATUS_LABELS[key] ? key : null;
  }

  function statusLabel(raw) {
    const s = normalizeStatus(raw);
    return s ? STATUS_LABELS[s] : (raw || 'Unknown');
  }

  function statusClass(raw) {
    const s = normalizeStatus(raw);
    return s ? 'status-' + s : 'status-unknown';
  }

  function isPostApplied(status) {
    const s = normalizeStatus(status);
    return s !== null && POST_APPLIED.has(s);
  }

  /**
   * Readable follow-up due string: 'Due 2026-09-01', 'Follow-up due!',
   * or '' when none applies (never applied / dead end).
   */
  function followUpDisplay(job) {
    if (!job) return '';
    const s = normalizeStatus(job.status);
    if (!FOLLOW_UP_ELIGIBLE.has(s)) return '';
    let due = (typeof job.follow_up_due === 'string' && job.follow_up_due) || '';
    if (!due) {
      const appliedAt = job.applied_at || job.applied_date;
      if (appliedAt && FOLLOW_UP_ELIGIBLE.has(s)) {
        let iso = String(appliedAt).replace(' ', 'T');
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(iso)) iso += 'Z';
        const d = new Date(iso);
        if (!isNaN(d.getTime())) {
          d.setUTCDate(d.getUTCDate() + 7);
          due = d.toISOString().slice(0, 10);
        }
      }
    }
    if (!due) return '';
    const dueDate = new Date(due + 'T00:00:00Z');
    if (isNaN(dueDate.getTime())) return '';
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const overdue = dueDate < today;
    return (overdue ? 'Follow-up due! (was ' + due + ')' : 'Follow-up due ' + due);
  }

  /** Urgency / repost / gate indicators — absent fields render nothing. */
  function indicatorsHtml(job) {
    const parts = [];
    const u = String(job.urgency || '').trim().toLowerCase();
    if (u === 'high' || u === 'medium') {
      parts.push('<span class="indicator indicator-urgency-' + u + '" title="Urgency: ' + u + '">' +
        (u === 'high' ? '🔥 High urgency' : '⚡ Medium urgency') + '</span>');
    }
    const repost = job.is_repost === true || job.is_repost === 1 ||
                   job.is_repost === 'true' || job.is_repost === '1';
    if (repost) {
      parts.push('<span class="indicator indicator-repost" title="Reposted listing">♻ Repost</span>');
    }
    if (typeof job.gate === 'string' && job.gate.trim()) {
      parts.push('<span class="indicator indicator-gate" title="Application gate">🚧 ' +
        escapeHtml(job.gate.trim().slice(0, 40)) + '</span>');
    }
    return parts.join(' ');
  }

  /** Readable status badge (shown for every status, legacy ones included). */
  function statusBadgeHtml(job) {
    const label = statusLabel(job.status);
    return '<span class="status-badge ' + statusClass(job.status) + '">' +
      escapeHtml(label) + '</span>';
  }

  // ═══════════════════════════════════════════════════════════════
  // TOAST
  // ═══════════════════════════════════════════════════════════════
  function showToast(message, type = 'info', duration = 4000) {
    const container = $('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // ═══════════════════════════════════════════════════════════════
  // MODAL
  // ═══════════════════════════════════════════════════════════════
  function showModal(id) {
    $(id).style.display = 'flex';
  }

  function hideModal(id) {
    $(id).style.display = 'none';
  }

  let lastGeneratedJobId = null;

  function showGenerateModal() {
    lastGeneratedJobId = null;
    $('modal-title').textContent = 'Generating Materials…';
    $('modal-status').textContent = 'Calling Claude Opus 5 to tailor your resume and cover letter…';
    $('modal-status').style.display = 'block';
    document.querySelector('.modal-spinner-wrap').style.display = 'flex';
    $('modal-result').style.display = 'none';
    setPdfLinks({ pdf_state: 'pending', pdf_ready: false });
    $('modal-error').style.display = 'none';
    showModal('generate-modal');
  }

  function setPdfLinks(materials = {}) {
    const ready = materials.pdf_ready === true && materials.pdf_state === 'available' && Boolean(materials.resume_pdf && materials.cover_letter_pdf);
    const status = $('pdf-status');
    if (status) status.textContent = ready ? 'PDFs available' : materials.pdf_state === 'failed' ? 'PDF render failed; retry generation.' : 'PDFs pending; refresh later.';
    for (const [id, url] of [['link-resume-pdf', ready ? materials.resume_pdf : null], ['link-cover-pdf', ready ? materials.cover_letter_pdf : null]]) {
      const link = $(id); if (!link) continue; link.hidden = !url; link.toggleAttribute('aria-disabled', !url);
      if (url) link.href = url; else link.removeAttribute('href');
    }
  }

  function showGenerateResult(materials, quality, jobId) {
    document.querySelector('.modal-spinner-wrap').style.display = 'none';
    $('modal-status').style.display = 'none';
    $('modal-title').textContent = 'Materials Ready!';
    $('link-resume').href = materials.resume;
    $('link-cover').href = materials.cover_letter;
    setPdfLinks(materials);
    lastGeneratedJobId = String(jobId);
    const q = quality || {};
    $('quality-summary').textContent = 'ATS ' + (q.ats_score ?? '—') + '/100 · ' +
      (q.facts_ok !== false ? 'facts grounded' : 'fact review needed') +
      (q.keyword_coverage ? ' · keywords checked' : '');
    const job = allJobs.find(j => String(j.id) === String(jobId));
    const followupButton = $('btn-followup-modal');
    followupButton.style.display = job && FOLLOW_UP_ELIGIBLE.has(normalizeStatus(job.status)) ? 'inline-flex' : 'none';
    followupButton.onclick = () => draftFollowup(jobId);
    $('modal-result').style.display = 'block';
  }

  function showGenerateError(msg) {
    document.querySelector('.modal-spinner-wrap').style.display = 'none';
    $('modal-status').style.display = 'none';
    $('modal-title').textContent = 'Generation Failed';
    $('modal-error-text').textContent = msg || 'Something went wrong.';
    $('modal-error').style.display = 'block';
  }

  // ═══════════════════════════════════════════════════════════════
  // DATA LOADING
  // ═══════════════════════════════════════════════════════════════
  async function loadJobs() {
    loadingState.style.display = 'block';
    emptyState.style.display = 'none';
    tbody.innerHTML = '';
    try {
      // Cache-bust to always get fresh data from the Pi's daily push
      const res = await fetch('/data/jobs.json?_=' + Date.now());
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();

      allJobs = (data.jobs || []).map(j => ({
        ...j,
        // Material availability is supplied only by the material API/result; status is not evidence.
        has_materials: j.has_materials === true
      }));

      // Update meta display
      if (data.meta) {
        $('last-updated').textContent = data.meta.updated || data.meta.generated_at || '—';
      }

      applyFilters();
      updateStats();
      showToast('Loaded ' + allJobs.length + ' jobs', 'success', 2000);
    } catch (err) {
      console.error('loadJobs error:', err);
      showToast('Failed to load jobs: ' + err.message, 'error');
      emptyState.style.display = 'block';
      $('empty-text').textContent = 'Could not load job data.';
      $('empty-hint').textContent = 'Check that data/jobs.json exists and is valid.';
    } finally {
      loadingState.style.display = 'none';
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // FILTERING (client-side, no re-fetch)
  // ═══════════════════════════════════════════════════════════════
  function applyFilters() {
    const search = filters.search.toLowerCase().trim();

    filteredJobs = allJobs.filter(job => {
      // Track filter
      if (filters.track !== 'all' && job.track !== filters.track) return false;

      // Min score filter
      if (filters.minScore > 0 && (job.score || 0) < filters.minScore) return false;

      // Status filter. 'applied' keeps its legacy "in the pipeline"
      // meaning (applied + extended post-application statuses) so old
      // filters keep behaving; the extended options match exactly.
      if (filters.status !== 'all') {
        if (filters.status === 'not_applied') {
          if (isPostApplied(job.status)) return false;
        } else if (filters.status === 'applied') {
          const s = normalizeStatus(job.status);
          if (!s || ['applied', 'screening', 'interview', 'offer'].indexOf(s) === -1) return false;
        } else if (normalizeStatus(job.status) !== filters.status) {
          return false;
        }
      }

      // Search filter (title, company, location)
      if (search) {
        const haystack = (
          (job.title || '') + ' ' +
          (job.company || '') + ' ' +
          (job.location || '') + ' ' +
          (formatAsking(job.suggested_ask) || '')
        ).toLowerCase();
        if (!haystack.includes(search)) return false;
      }

      return true;
    });

    // Sort by score descending (rank order)
    filteredJobs.sort((a, b) => (b.score || 0) - (a.score || 0));

    renderTable();
  }

  /** <option> list for the per-row status select. */
  const STATUS_ORDER = ['found', 'materials_ready', 'saved', 'applied',
    'screening', 'interview', 'offer', 'rejected', 'ghosted'];
  function statusOptions(current) {
    return STATUS_ORDER.map(function (s) {
      const sel = normalizeStatus(current) === s ? ' selected' : '';
      return '<option value="' + s + '"' + sel + '>' + STATUS_LABELS[s] + '</option>';
    }).join('');
  }

  // ═══════════════════════════════════════════════════════════════
  // RENDERING
  // ═══════════════════════════════════════════════════════════════
  function renderTable() {
    if (filteredJobs.length === 0) {
      tbody.innerHTML = '';
      emptyState.style.display = 'block';
      $('empty-text').textContent = 'No jobs match the current filters.';
      $('empty-hint').textContent = 'Try adjusting filters or refresh to load new postings.';
      return;
    }

    emptyState.style.display = 'none';

    tbody.innerHTML = filteredJobs.map((job, idx) => {
      const rank = idx + 1;
      const score = Number.isFinite(Number(job.score)) ? Math.max(0, Math.min(100, Number(job.score))) : 0;
      const sc = scoreClass(score);
      const salary = formatSalary(job.salary);
      const posted = getPostedDate(job);
      const asking = formatAsking(job.suggested_ask);
      const hasMaterials = job.has_materials;

      // Action buttons — quote job.id in onclick to keep it a string (C1)
      const pdfState = job.pdf_state || (hasMaterials ? 'pending' : 'pending');
      const materialState = pdfState === 'available' ? 'PDFs available' : pdfState === 'failed' ? 'PDF render failed' : hasMaterials ? 'PDFs pending' : 'Not verified — generate materials';
      const generateBtn = hasMaterials
        ? `<button class="btn btn-sm btn-view" aria-label="View verified Markdown materials" onclick="viewMaterials(${inlineArg(job.id)})">👁 View</button>`
        : `<button class="btn btn-sm btn-generate" aria-label="Generate materials" onclick="generateMaterials(${inlineArg(job.id)}, this)">✨ Generate</button>`;

      // Validate URL protocol before rendering as a link (W6)
      const applyLink = isSafeUrl(job.url)
        ? `<a href="${escapeHtml(job.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-outline">↗ Apply</a>`
        : `<span class="btn btn-sm btn-disabled btn-outline">No link</span>`;

      const titleLink = isSafeUrl(job.url)
        ? `<a href="${escapeHtml(job.url)}" target="_blank" rel="noopener noreferrer" class="title-text">${escapeHtml(job.title || 'Untitled')}</a>`
        : `<span class="title-text">${escapeHtml(job.title || 'Untitled')}</span>`;

      return `
        <tr>
          <td class="rank-cell">${rank}</td>
          <td>
            <div class="score-cell">
              <div class="score-bar-wrap">
                <div class="score-bar ${sc}" style="transform:scaleX(${Math.min(score, 100) / 100})"></div>
              </div>
              <span class="score-value ${sc}">${score}</span>
            </div>
          </td>
          <td>
            <div class="title-cell">
              ${titleLink}
              <span class="track-badge ${trackClass(job.track)}">${trackLabel(job.track)}</span>
              ${statusBadgeHtml(job)}
              ${indicatorsHtml(job)}
            </div>
            ${followUpDisplay(job) ? '<div class="followup-cell">' + escapeHtml(followUpDisplay(job)) + '</div>' : ''}
          </td>
          <td class="company-cell">${escapeHtml(job.company || '—')}</td>
          <td>
            <span class="salary-cell ${salary ? '' : 'salary-na'}">${escapeHtml(salary || 'N/A')}</span>
          </td>
          <td><div class="asking-cell">${asking ? escapeHtml(asking) : '—'}</div></td>
          <td class="posted-cell">${escapeHtml(formatDate(posted))}</td>
          <td class="location-cell">${escapeHtml(job.location || '—')}</td>
          <td>
            <div class="actions-cell">
              ${applyLink}
              <span class="material-state" role="status" aria-live="polite">${materialState}</span>
              ${generateBtn}
              ${FOLLOW_UP_ELIGIBLE.has(normalizeStatus(job.status)) ? '<button class="btn btn-sm btn-outline" onclick="draftFollowup(' + inlineArg(job.id) + ')">✍ Follow-up</button>' : ''}
            </div>
          </td>
          <td class="applied-cell">
            <select class="status-select"
              onchange="setJobStatus(${inlineArg(job.id)}, this.value, this)"
              aria-label="Application status">
              ${statusOptions(job.status)}
            </select>
          </td>
        </tr>
      `;
    }).join('');
  }

  // ═══════════════════════════════════════════════════════════════
  // STATS
  // ═══════════════════════════════════════════════════════════════
  function updateStats() {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    let total = allJobs.length;
    let newCount = 0;
    let evCount = 0;
    let aiCount = 0;
    let appliedCount = 0;
    let materialsCount = 0;
    let followUpCount = 0;

    for (const job of allJobs) {
      // New within 24h (based on found_at)
      if (job.found_at) {
        let iso = job.found_at;
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(iso)) {
          iso = iso.replace(' ', 'T') + 'Z';
        }
        const d = new Date(iso);
        if (!isNaN(d.getTime()) && d > cutoff) newCount++;
      }

      if (job.track === 'ev_commercial') evCount++;
      if (job.track === 'ai_engineering') aiCount++;
      if (isPostApplied(job.status)) appliedCount++;
      if (job.has_materials) materialsCount++;
      if (followUpDisplay(job)) followUpCount++;
    }

    $('stat-total').textContent = total;
    $('stat-new').textContent = newCount;
    $('stat-ev').textContent = evCount;
    $('stat-ai').textContent = aiCount;
    $('stat-applied').textContent = appliedCount;
    $('stat-followup').textContent = followUpCount;
    $('stat-materials').textContent = materialsCount;
    $('job-count-badge').textContent = total + (total === 1 ? ' job' : ' jobs');
  }

  // ═══════════════════════════════════════════════════════════════
  // API ACTIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * POST /api/generate — generate resume + cover letter via Claude Opus 5.
   */
  async function generateMaterials(jobId, btn) {
    if (!getToken()) {
      showToast('Please set your auth token first (🔑 Token button).', 'error');
      showModal('token-modal');
      return;
    }

    // Find the job in our local data for convenience fields.
    // ids are stored as strings in jobs.json — compare as strings (C1).
    const job = allJobs.find(j => String(j.id) === String(jobId));
    if (!job) {
      showToast('Job not found in local data.', 'error');
      return;
    }

    // Disable button during generation
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Working…';
    }

    showGenerateModal();

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          job_id: jobId,
          title: job.title,
          company: job.company
        })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Generation failed (HTTP ' + res.status + ')');
      }

      showGenerateResult(data.materials, data.quality, jobId);

      // Update local state
      job.status = 'materials_ready';
      job.has_materials = true;
      renderTable();

      showToast('Materials generated for ' + job.company, 'success');
    } catch (err) {
      console.error('generateMaterials error:', err);
      showGenerateError(err.message);
      showToast('Generation failed: ' + err.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '✨ Generate';
      }
    }
  }

  /**
   * POST /api/status — set the (extended) application status.
   * Replaces the old applied-checkbox flow; the legacy POST /api/applied
   * endpoint remains available for older clients.
   */
  async function setJobStatus(jobId, status, select) {
    if (!getToken()) {
      showToast('Please set your auth token first (🔑 Token button).', 'error');
      if (select) select.value = normalizeStatus(
        (allJobs.find(j => String(j.id) === String(jobId)) || {}).status
      ) || 'found';
      showModal('token-modal');
      return;
    }

    const job = allJobs.find(j => String(j.id) === String(jobId));
    if (!job) return;

    const prevStatus = job.status;
    const nextStatus = normalizeStatus(status);
    if (!nextStatus) return;

    // Optimistic UI update
    job.status = nextStatus;

    try {
      const res = await fetch('/api/status', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ job_id: jobId, status: nextStatus })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Status update failed (HTTP ' + res.status + ')');
      }

      // Update local state only from the server's canonical bookkeeping.
      job.status = data.status || job.status;
      if (Object.prototype.hasOwnProperty.call(data, 'follow_up_due')) {
        job.follow_up_due = data.follow_up_due || '';
      }
      if (Object.prototype.hasOwnProperty.call(data, 'applied_at')) {
        job.applied_at = data.applied_at || '';
      }
      renderTable();
      updateStats();
      showToast('Status: ' + statusLabel(job.status) + ' ✓', 'success', 2000);
    } catch (err) {
      console.error('setJobStatus error:', err);
      // Rollback
      job.status = prevStatus;
      renderTable();
      updateStats();
      showToast('Failed to update: ' + err.message, 'error');
    }
  }

  async function draftFollowup(jobId) {
    if (!getToken()) {
      showToast('Please set your auth token first (🔑 Token button).', 'error');
      showModal('token-modal');
      return;
    }
    const job = allJobs.find(j => String(j.id) === String(jobId));
    if (!job) return;
    try {
      const res = await fetch('/api/followup-draft', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ job_id: jobId, tone: 'professional' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Follow-up draft failed (HTTP ' + res.status + ')');
      const draft = window.prompt('Follow-up draft — copy before closing', data.draft || '');
      if (draft !== null) showToast('Draft ready to copy', 'success');
    } catch (err) {
      console.error('draftFollowup error:', err);
      showToast('Follow-up draft failed: ' + err.message, 'error');
    }
  }

  /**
   * Open materials in new tabs (resume + cover letter).
   * /api/materials is no longer public, so ask /api/material-links for
   * short-lived signed URLs first. The tabs are opened up front (while
   * still inside the click handler) so popup blockers allow them, then
   * pointed at the signed URLs once the server responds.
   */
  async function viewMaterials(jobId) {
    if (!getToken()) {
      showToast('Please set your auth token first (🔑 Token button).', 'error');
      showModal('token-modal');
      return;
    }

    const resumeTab = window.open('', '_blank');
    const coverTab = window.open('', '_blank');
    showToast('Opening materials in new tabs…', 'info', 2000);

    try {
      const res = await fetch('/api/material-links', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ job_id: jobId })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Could not sign material links (HTTP ' + res.status + ')');
      }
      setPdfLinks(data.materials);

      if (resumeTab && data.materials.resume) resumeTab.location.href = data.materials.resume; else if (resumeTab) resumeTab.close();
      if (coverTab && data.materials.cover_letter) coverTab.location.href = data.materials.cover_letter; else if (coverTab) coverTab.close();
      // PDF links are intentionally omitted until the API reports available.
      // PDF controls remain hidden unless the API returns signed URLs.
    } catch (err) {
      console.error('viewMaterials error:', err);
      if (resumeTab) resumeTab.close();
      if (coverTab) coverTab.close();
      showToast('Failed to open materials: ' + err.message, 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // APPLICATIONS TRACKER
  // ═══════════════════════════════════════════════════════════════

  let appData = { applications: [], pipeline: [] };
  let appsVisible = true;

  async function loadApplications() {
    $('#apps-loading').style.display = 'block';
    $('#apps-table').style.display = 'none';
    $('#pipeline-table').style.display = 'none';
    $('#apps-empty').style.display = 'none';
    try {
      const res = await fetch('/data/applications.json?_=' + Date.now());
      if (!res.ok) throw new Error('HTTP ' + res.status);
      appData = await res.json();
      renderApplications();
    } catch (err) {
      console.error('loadApplications error:', err);
      $('#apps-loading').textContent = 'Could not load application tracker.';
    } finally {
      $('#apps-loading').style.display = 'none';
    }
  }

  function renderApplications() {
    const apps = appData.applications || [];
    const pipeline = appData.pipeline || [];
    const appsTbody = $('#apps-tbody');
    const pipelineTbody = $('#pipeline-tbody');

    // Update badge
    const meta = appData.meta || {};
    $('#applied-count-badge').textContent = meta.applied + ' applied / ' + meta.pipeline + ' waiting';

    // Render applied applications
    if (apps.length > 0) {
      appsTbody.innerHTML = apps.map(a => {
        const outreachClass = a.outreach === 'sent' ? 'outreach-sent' : 'outreach-pending';
        const outreachLabel = a.outreach === 'sent' ? '✅ Sent (' + a.outreach_date + ')' : '⏳ Pending';
        return `
          <tr>
            <td data-label="Company"><strong>${escapeHtml(a.company)}</strong></td>
            <td data-label="Role">${escapeHtml(a.role)}</td>
            <td data-label="Applied" class="apps-date">${escapeHtml(a.applied_date)}</td>
            <td data-label="Manager"><span class="manager-badge">${escapeHtml(a.hiring_manager)}</span></td>
            <td data-label="Outreach"><span class="outreach-status ${outreachClass}">${outreachLabel}</span></td>
            <td data-label="Next Step" class="apps-next">${escapeHtml(a.next_action)}</td>
            <td data-label="Notes" class="apps-notes-cell">${escapeHtml(a.notes)}</td>
          </tr>
        `;
      }).join('');
      $('#apps-table').style.display = '';
    }

    // Render pipeline
    if (pipeline.length > 0) {
      pipelineTbody.innerHTML = pipeline.map(p => {
        const clStatus = p.cover_letter === 'Ready' ? 'cl-ready' : 'cl-pending';
        return `
          <tr>
            <td data-label="Company"><strong>${escapeHtml(p.company)}</strong></td>
            <td data-label="Role">${escapeHtml(p.role)}</td>
            <td data-label="Manager"><span class="manager-badge">${escapeHtml(p.hiring_manager)}</span></td>
            <td data-label="Wait Until" class="apps-next">${escapeHtml(p.wait_until)}</td>
            <td data-label="Cover Letter"><span class="cl-status ${clStatus}">${escapeHtml(p.cover_letter)}</span></td>
          </tr>
        `;
      }).join('');
      $('#pipeline-table').style.display = '';
    }

    // Show empty state if nothing
    if (apps.length === 0 && pipeline.length === 0) {
      $('#apps-empty').style.display = 'block';
    }

    // Apply visibility
    $('#apps-body').style.display = appsVisible ? 'block' : 'none';
  }

  // ═══════════════════════════════════════════════════════════════
  // EVENT LISTENERS
  // ═══════════════════════════════════════════════════════════════
  function initEventListeners() {
    // Track segmented control
    $('track-filter').addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filters.track = btn.dataset.track;
      applyFilters();
    });

    // Min score slider
    $('min-score').addEventListener('input', (e) => {
      filters.minScore = parseInt(e.target.value, 10);
      $('min-score-val').textContent = filters.minScore;
      applyFilters();
    });

    // Status dropdown
    $('status-filter').addEventListener('change', (e) => {
      filters.status = e.target.value;
      applyFilters();
    });

    // Search box (debounced)
    let searchTimer;
    $('search-box').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        filters.search = e.target.value;
        applyFilters();
      }, 200);
    });

    // Clear filters
    $('btn-clear-filters').addEventListener('click', () => {
      filters.track = 'all';
      filters.minScore = 0;
      filters.status = 'all';
      filters.search = '';

      document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('.seg-btn[data-track="all"]').classList.add('active');
      $('min-score').value = 0;
      $('min-score-val').textContent = '0';
      $('status-filter').value = 'all';
      $('search-box').value = '';

      applyFilters();
      showToast('Filters cleared', 'info', 1500);
    });

    // Refresh button
    $('btn-refresh').addEventListener('click', loadJobs);

    // Generate modal close
    $('modal-close').addEventListener('click', () => hideModal('generate-modal'));
    $('generate-modal').addEventListener('click', (e) => {
      if (e.target === $('generate-modal')) hideModal('generate-modal');
    });

    // Token modal
    $('btn-token').addEventListener('click', () => {
      $('token-input').value = getToken();
      showModal('token-modal');
    });
    $('token-modal-close').addEventListener('click', () => hideModal('token-modal'));
    $('token-modal').addEventListener('click', (e) => {
      if (e.target === $('token-modal')) hideModal('token-modal');
    });
    $('token-save').addEventListener('click', () => {
      const val = $('token-input').value.trim();
      if (val) {
        setToken(val);
        hideModal('token-modal');
        showToast('Auth token saved ✓', 'success');
      } else {
        showToast('Token cannot be empty', 'error');
      }
    });
    $('token-clear').addEventListener('click', () => {
      clearToken();
      $('token-input').value = '';
      showToast('Auth token cleared', 'info');
    });

    // Escape key closes modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideModal('generate-modal');
        hideModal('token-modal');
      }
    });

    // Applications toggle
    $('btn-toggle-apps').addEventListener('click', () => {
      appsVisible = !appsVisible;
      $('#apps-body').style.display = appsVisible ? 'block' : 'none';
      $('btn-toggle-apps').textContent = appsVisible ? 'Hide' : 'Show';
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // EXPOSE GLOBALS (for inline onclick handlers)
  // ═══════════════════════════════════════════════════════════════
  window.generateMaterials = generateMaterials;
  window.setJobStatus = setJobStatus;
  window.viewMaterials = viewMaterials;
  window.draftFollowup = draftFollowup;

  // ═══════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', () => {
    initEventListeners();
    loadJobs();
    loadApplications();
  });
})();
