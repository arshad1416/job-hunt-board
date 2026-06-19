/**
 * Job Hunt Dashboard — app.js
 * Reads jobs.json, renders table, handles Generate + Applied via Cloudflare Workers.
 */

// ── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
  // Cloudflare Worker API base
  apiBase: window.location.origin.replace(/\/$/, '') + '/api',
  // Static data file (updated daily by Pi pipeline)
  dataUrl: '/data/jobs.json',
};

// ── State ────────────────────────────────────────────────────────────────────
let allJobs = [];
let filteredJobs = [];
let generationInProgress = new Set(); // job IDs currently being generated

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const tbody = $('#jobs-tbody');
const filterTrack = $('#filter-track');
const filterMinScore = $('#filter-min-score');
const filterStatus = $('#filter-status');
const filterSearch = $('#filter-search');
const btnRefresh = $('#btn-refresh');
const statTotal = $('#stat-total');
const statNew = $('#stat-new');
const statEv = $('#stat-ev');
const statAi = $('#stat-ai');
const statApplied = $('#stat-applied');
const lastUpdated = $('#last-updated');
const jobCountBadge = $('#job-count-badge');
const toast = $('#toast');
const modal = $('#generate-modal');
const modalStatus = $('#modal-status');
const modalBody = $('#modal-body');

// ── Utility ──────────────────────────────────────────────────────────────────
function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const now = new Date();
    const diff = (now - d) / (1000 * 60 * 60 * 24);
    if (diff < 1) return 'Today';
    if (diff < 2) return 'Yesterday';
    return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
  } catch { return dateStr; }
}

function formatSalary(sal) {
  if (!sal || sal === '—') return '—';
  // Already formatted in the data
  return sal;
}

function showToast(message, type = 'info', duration = 4000) {
  toast.textContent = message;
  toast.className = `toast ${type}`;
  setTimeout(() => toast.classList.add('hidden'), duration);
}

function showModal(message) {
  modalStatus.textContent = message || 'Generating materials...';
  modalBody.innerHTML = `
    <div class="spinner"></div>
    <p>${modalStatus.textContent}</p>
  `;
  modal.classList.remove('hidden');
}

function hideModal() {
  modal.classList.add('hidden');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Data Loading ─────────────────────────────────────────────────────────────
async function loadJobs() {
  try {
    const res = await fetch(CONFIG.dataUrl + '?_=' + Date.now());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allJobs = Array.isArray(data) ? data : (data.jobs || []);
    // Sort by score descending
    allJobs.sort((a, b) => (b.score || 0) - (a.score || 0));
    applyFilters();
    updateStats();
    updateLastUpdated();
    jobCountBadge.textContent = `${allJobs.length} jobs`;
  } catch (err) {
    console.error('Failed to load jobs:', err);
    tbody.innerHTML = `<tr><td colspan="10" class="loading-msg">
      ❌ Failed to load jobs. ${err.message}<br>
      <button class="btn btn-outline" onclick="location.reload()" style="margin-top:12px">Retry</button>
    </td></tr>`;
  }
}

// ── Filtering ────────────────────────────────────────────────────────────────
function applyFilters() {
  const track = filterTrack.value;
  const minScore = parseInt(filterMinScore.value) || 0;
  const status = filterStatus.value;
  const search = filterSearch.value.toLowerCase().trim();

  filteredJobs = allJobs.filter(job => {
    // Track filter
    if (track !== 'all' && job.track !== track) return false;
    // Score filter
    if ((job.score || 0) < minScore) return false;
    // Status filter
    if (status !== 'all' && job.status !== status) return false;
    // Search filter
    if (search) {
      const haystack = `${job.title} ${job.company} ${job.location} ${job.description || ''}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  renderTable();
}

// ── Rendering ────────────────────────────────────────────────────────────────
function renderTable() {
  if (filteredJobs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="loading-msg">
      🔍 No jobs match your filters.
    </td></tr>`;
    return;
  }

  let html = '';
  filteredJobs.forEach((job, idx) => {
    const score = job.score || 0;
    const isApplied = job.status === 'applied';
    const isGenerating = generationInProgress.has(job.id);
    const hasMaterials = job.status === 'materials_ready' || job.status === 'saved';
    const appliedClass = isApplied ? 'status-applied' : '';

    // Score color class
    const scoreClass = score >= 70 ? 'score-high' : score >= 50 ? 'score-mid' : 'score-low';

    // Track badge
    const trackClass = job.track === 'ev_commercial' ? 'track-ev' : 'track-ai';
    const trackLabel = job.track === 'ev_commercial' ? 'EV' : 'AI';

    // Salary
    const salaryDisplay = job.salary && job.salary !== '—'
      ? escapeHtml(job.salary)
      : job.suggested_ask
        ? `<span class="text-muted">Ask: $${(+job.suggested_ask).toLocaleString()}</span>`
        : '—';

    // Description (truncated)
    const desc = (job.description || job.summary || '')
      .replace(/<[^>]+>/g, '')
      .substring(0, 120);
    const descDisplay = desc ? escapeHtml(desc) + (desc.length >= 120 ? '...' : '') : '—';

    html += `
    <tr class="${appliedClass}" data-job-id="${escapeHtml(job.id)}">
      <td class="col-rank">${idx + 1}</td>
      <td class="col-score">
        <div class="score-bar ${scoreClass}">
          <span>${score}</span>
          <div class="score-fill">
            <div class="score-fill-inner" style="width:${Math.min(100, score)}%"></div>
          </div>
        </div>
      </td>
      <td class="col-title">
        <strong>${escapeHtml(job.title)}</strong>
        <span class="track-badge ${trackClass}">${trackLabel}</span>
      </td>
      <td class="col-company">${escapeHtml(job.company)}</td>
      <td class="col-salary">${salaryDisplay}</td>
      <td class="col-desc">${descDisplay}</td>
      <td class="col-posted">${formatDate(job.posted_date || job.found_at)}</td>
      <td class="col-location">${escapeHtml(job.location || '—')}</td>
      <td class="col-actions">
        <div class="action-group">
          <a href="${escapeHtml(job.url || '#')}" target="_blank" rel="noopener" class="btn-sm btn-apply">Apply</a>
          <button class="btn-sm btn-generate" onclick="generateMaterials('${escapeHtml(job.id)}', this)"
            ${isGenerating ? 'disabled' : ''}>
            ${isGenerating ? '⏳' : hasMaterials ? '📄 View' : 'Generate'}
          </button>
        </div>
      </td>
      <td class="col-applied">
        <input type="checkbox" class="applied-check"
          onchange="toggleApplied('${escapeHtml(job.id)}', this.checked)"
          ${isApplied ? 'checked' : ''}>
      </td>
    </tr>`;
  });

  tbody.innerHTML = html;
}

// ── Stats ────────────────────────────────────────────────────────────────────
function updateStats() {
  const total = allJobs.length;
  const newJobs = allJobs.filter(j => j.status === 'found').length;
  const ev = allJobs.filter(j => j.track === 'ev_commercial').length;
  const ai = allJobs.filter(j => j.track === 'ai_engineering').length;
  const applied = allJobs.filter(j => j.status === 'applied').length;

  statTotal.textContent = total;
  statNew.textContent = newJobs;
  statEv.textContent = ev;
  statAi.textContent = ai;
  statApplied.textContent = applied;
}

function updateLastUpdated() {
  const now = new Date();
  lastUpdated.textContent = `Updated: ${now.toLocaleString('en-CA', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  })}`;
}

// ── API: Generate Materials ──────────────────────────────────────────────────
async function generateMaterials(jobId, btn) {
  if (generationInProgress.has(jobId)) return;

  const job = allJobs.find(j => String(j.id) === String(jobId));
  if (!job) return showToast('Job not found', 'error');

  generationInProgress.add(jobId);
  btn.disabled = true;
  btn.textContent = '⏳';

  showModal(`Generating resume & cover letter for\n${job.title} @ ${job.company}...`);

  try {
    const res = await fetch(`${CONFIG.apiBase}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, title: job.title, company: job.company }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(err.substring(0, 200));
    }

    const result = await res.json();
    job.status = 'materials_ready';

    hideModal();
    showToast(`✅ Materials generated for ${job.title}`, 'success');
    renderTable();
    updateStats();
  } catch (err) {
    hideModal();
    showToast(`❌ Generation failed: ${err.message}`, 'error');
    console.error('Generate error:', err);
  } finally {
    generationInProgress.delete(jobId);
  }
}

// ── API: Toggle Applied ──────────────────────────────────────────────────────
async function toggleApplied(jobId, isApplied) {
  const job = allJobs.find(j => String(j.id) === String(jobId));
  if (!job) return;

  // Optimistic update
  job.status = isApplied ? 'applied' : 'found';

  try {
    const res = await fetch(`${CONFIG.apiBase}/applied`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, applied: isApplied }),
    });

    if (!res.ok) {
      // Rollback
      job.status = isApplied ? 'found' : 'applied';
      showToast('Failed to update status', 'error');
    } else {
      const label = isApplied ? 'marked as applied' : 'unmarked';
      showToast(`${job.title} ${label}`, 'success');
    }
  } catch (err) {
    job.status = isApplied ? 'found' : 'applied';
    showToast(`Error: ${err.message}`, 'error');
  }

  renderTable();
  updateStats();
}

// ── Event Listeners ──────────────────────────────────────────────────────────
filterTrack.addEventListener('change', applyFilters);
filterMinScore.addEventListener('change', applyFilters);
filterStatus.addEventListener('change', applyFilters);
filterSearch.addEventListener('input', applyFilters);
btnRefresh.addEventListener('click', loadJobs);
$('#modal-close').addEventListener('click', hideModal);
$('#modal-close-btn').addEventListener('click', hideModal);

// Close modal on backdrop click
modal.addEventListener('click', (e) => {
  if (e.target === modal) hideModal();
});

// ── Load on boot ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadJobs);
