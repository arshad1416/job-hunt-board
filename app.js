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

  function showGenerateModal() {
    $('modal-title').textContent = 'Generating Materials…';
    $('modal-status').textContent = 'Calling GLM-5.2 to tailor your resume and cover letter…';
    $('modal-status').style.display = 'block';
    document.querySelector('.modal-spinner-wrap').style.display = 'flex';
    $('modal-result').style.display = 'none';
    $('modal-error').style.display = 'none';
    showModal('generate-modal');
  }

  function showGenerateResult(materials) {
    document.querySelector('.modal-spinner-wrap').style.display = 'none';
    $('modal-status').style.display = 'none';
    $('modal-title').textContent = 'Materials Ready!';
    $('link-resume').href = materials.resume;
    $('link-cover').href = materials.cover_letter;
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
        has_materials: j.status === 'materials_ready' || j.has_materials === true
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

      // Status filter
      if (filters.status !== 'all') {
        switch (filters.status) {
          case 'found':
            if (job.status !== 'found') return false;
            break;
          case 'materials_ready':
            if (job.status !== 'materials_ready') return false;
            break;
          case 'applied':
            if (job.status !== 'applied') return false;
            break;
          case 'saved':
            if (job.status !== 'saved') return false;
            break;
          case 'not_applied':
            if (job.status === 'applied') return false;
            break;
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
      const score = job.score || 0;
      const sc = scoreClass(score);
      const salary = formatSalary(job.salary);
      const posted = getPostedDate(job);
      const asking = formatAsking(job.suggested_ask);
      const applied = job.status === 'applied';
      const hasMaterials = job.has_materials;

      // Action buttons — quote job.id in onclick to keep it a string (C1)
      const generateBtn = hasMaterials
        ? `<button class="btn btn-sm btn-view" onclick="viewMaterials('${job.id}')">👁 View</button>`
        : `<button class="btn btn-sm btn-generate" onclick="generateMaterials('${job.id}', this)">✨ Generate</button>`;

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
            </div>
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
              ${generateBtn}
            </div>
          </td>
          <td class="applied-cell">
            <input type="checkbox" class="applied-check" ${applied ? 'checked' : ''}
              onchange="toggleApplied('${job.id}', this.checked, this)"
              title="Mark as applied"
              aria-label="Mark as applied" />
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
      if (job.status === 'applied') appliedCount++;
      if (job.status === 'materials_ready') materialsCount++;
    }

    $('stat-total').textContent = total;
    $('stat-new').textContent = newCount;
    $('stat-ev').textContent = evCount;
    $('stat-ai').textContent = aiCount;
    $('stat-applied').textContent = appliedCount;
    $('stat-materials').textContent = materialsCount;
    $('job-count-badge').textContent = total + (total === 1 ? ' job' : ' jobs');
  }

  // ═══════════════════════════════════════════════════════════════
  // API ACTIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * POST /api/generate — generate resume + cover letter via GLM-5.2.
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

      showGenerateResult(data.materials);

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
   * POST /api/applied — toggle applied status.
   */
  async function toggleApplied(jobId, checked, checkbox) {
    if (!getToken()) {
      showToast('Please set your auth token first (🔑 Token button).', 'error');
      if (checkbox) checkbox.checked = !checked; // rollback
      showModal('token-modal');
      return;
    }

    const job = allJobs.find(j => String(j.id) === String(jobId));
    if (!job) return;

    const prevStatus = job.status;
    // Optimistic UI update
    job.status = checked ? 'applied' : 'found';

    try {
      const res = await fetch('/api/applied', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          job_id: jobId,
          applied: checked
        })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Status update failed (HTTP ' + res.status + ')');
      }

      // Update local state with server response
      job.status = data.status || job.status;
      updateStats();
      showToast(
        checked ? 'Marked as applied ✓' : 'Marked as not applied',
        'success',
        2000
      );
    } catch (err) {
      console.error('toggleApplied error:', err);
      // Rollback
      job.status = prevStatus;
      if (checkbox) checkbox.checked = !checked;
      renderTable();
      updateStats();
      showToast('Failed to update: ' + err.message, 'error');
    }
  }

  /**
   * Open materials in new tabs (resume + cover letter).
   * The /api/materials route is public (no auth header needed) so
   * direct browser navigation works.
   */
  function viewMaterials(jobId) {
    const resumeUrl = '/api/materials/' + jobId + '/resume.md';
    const coverUrl = '/api/materials/' + jobId + '/cover_letter.md';
    window.open(resumeUrl, '_blank');
    window.open(coverUrl, '_blank');
    showToast('Opening materials in new tabs…', 'info', 2000);
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
  }

  // ═══════════════════════════════════════════════════════════════
  // EXPOSE GLOBALS (for inline onclick handlers)
  // ═══════════════════════════════════════════════════════════════
  window.generateMaterials = generateMaterials;
  window.toggleApplied = toggleApplied;
  window.viewMaterials = viewMaterials;

  // ═══════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', () => {
    initEventListeners();
    loadJobs();
  });
})();
