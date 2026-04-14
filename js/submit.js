'use strict';

// ─── State ──────────────────────────────────────────────────────────────────
let tournament = null;
let golfers = [];              // [{id, golfer_name, odds_multiplier, is_amateur}]
let selectedIds = new Set();   // golfer IDs currently picked
let editingEntryId = null;     // non-null when editing existing entry
let existingAccessCode = null; // set when editing

const MAX_PICKS = 6;

// ─── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

async function init() {
  try {
    tournament = await loadActiveTournament();
    if (!tournament) {
      showClosed('No active tournament found.');
      return;
    }

    document.getElementById('tournament-name').textContent = tournament.name;

    // Check deadline
    const now = new Date();
    const deadline = tournament.submissions_deadline ? new Date(tournament.submissions_deadline) : null;
    const isOpen = tournament.submissions_open && (!deadline || now < deadline);

    if (!isOpen) {
      let msg = 'Submissions for this tournament are closed.';
      if (deadline) {
        msg += ` The deadline was ${deadline.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}.`;
      }
      showClosed(msg);
      return;
    }

    // Load golfers
    golfers = await loadTournamentGolfers(tournament.id);
    golfers.sort((a, b) => a.golfer_name.localeCompare(b.golfer_name));

    renderGolferList();
    bindEvents();

    document.getElementById('loading').classList.add('hidden');
    document.getElementById('mode-select').classList.remove('hidden');
  } catch (e) {
    console.error('Init failed:', e);
    document.getElementById('loading').innerHTML = `<p>Failed to load: ${e.message}</p>`;
  }
}

function showClosed(msg) {
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('closed').classList.remove('hidden');
  document.getElementById('closed-message').textContent = msg;
}

// ─── Event Binding ──────────────────────────────────────────────────────────
function bindEvents() {
  // Mode tabs
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const mode = tab.dataset.mode;
      document.getElementById('edit-lookup').classList.toggle('hidden', mode !== 'edit');
      document.getElementById('pick-form').classList.toggle('hidden', mode === 'edit' && !editingEntryId);
    });
  });

  // Golfer search
  document.getElementById('golfer-search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.golfer-item').forEach(item => {
      const name = item.dataset.name.toLowerCase();
      item.style.display = name.includes(q) ? '' : 'none';
    });
  });

  // Submit button
  document.getElementById('submit-btn').addEventListener('click', handleSubmit);

  // Edit lookup
  document.getElementById('edit-lookup-btn').addEventListener('click', handleEditLookup);

  // New entry after success
  document.getElementById('new-entry-btn').addEventListener('click', () => {
    editingEntryId = null;
    existingAccessCode = null;
    selectedIds.clear();
    document.getElementById('team-name').value = '';
    document.getElementById('team-name').disabled = false;
    document.getElementById('email').value = '';
    updatePicksDisplay();
    renderGolferList();
    document.getElementById('success').classList.add('hidden');
    document.getElementById('mode-select').classList.remove('hidden');
    // Reset to "New Entry" tab
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.mode-tab[data-mode="new"]').classList.add('active');
    document.getElementById('edit-lookup').classList.add('hidden');
    document.getElementById('pick-form').classList.remove('hidden');
  });
}

// ─── Golfer List ────────────────────────────────────────────────────────────
function renderGolferList() {
  const list = document.getElementById('golfer-list');
  list.innerHTML = '';
  for (const g of golfers) {
    const item = document.createElement('div');
    item.className = 'golfer-item' + (selectedIds.has(g.id) ? ' selected' : '');
    item.dataset.id = g.id;
    item.dataset.name = g.golfer_name;

    const isAmateur = g.is_amateur === true || g.is_amateur === 't';
    const aTag = isAmateur ? ' <span class="amateur-tag">(A)</span>' : '';

    item.innerHTML = `
      <div class="golfer-info">
        <span class="golfer-name">${escHtml(g.golfer_name)}${aTag}</span>
        <span class="golfer-odds">${g.odds_multiplier}-1 odds</span>
      </div>
      <div class="golfer-check">&#10003;</div>
    `;

    item.addEventListener('click', () => toggleGolfer(g.id));
    list.appendChild(item);
  }
  updateDisabledState();
}

function toggleGolfer(id) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
  } else if (selectedIds.size < MAX_PICKS) {
    selectedIds.add(id);
  }
  // Update item classes
  document.querySelectorAll('.golfer-item').forEach(item => {
    item.classList.toggle('selected', selectedIds.has(Number(item.dataset.id)));
  });
  updateDisabledState();
  updatePicksDisplay();
}

function updateDisabledState() {
  const full = selectedIds.size >= MAX_PICKS;
  document.querySelectorAll('.golfer-item').forEach(item => {
    const id = Number(item.dataset.id);
    item.classList.toggle('disabled', full && !selectedIds.has(id));
  });
}

// ─── Selected Picks Display ─────────────────────────────────────────────────
function updatePicksDisplay() {
  const container = document.getElementById('selected-chips');
  const countEl = document.getElementById('picks-count');
  const submitBtn = document.getElementById('submit-btn');

  countEl.textContent = `${selectedIds.size} of ${MAX_PICKS}`;
  countEl.classList.toggle('complete', selectedIds.size === MAX_PICKS);
  submitBtn.disabled = selectedIds.size !== MAX_PICKS;

  if (selectedIds.size === 0) {
    container.innerHTML = '<span class="empty-picks">Select 6 golfers below</span>';
    return;
  }

  container.innerHTML = '';
  for (const id of selectedIds) {
    const g = golfers.find(g => g.id === id);
    if (!g) continue;
    const chip = document.createElement('span');
    chip.className = 'pick-chip-selected';
    chip.innerHTML = `${escHtml(g.golfer_name)} <span class="chip-remove" data-id="${id}">&times;</span>`;
    container.appendChild(chip);
  }

  // Chip remove clicks
  container.querySelectorAll('.chip-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleGolfer(Number(btn.dataset.id));
    });
  });
}

// ─── Submit ─────────────────────────────────────────────────────────────────
async function handleSubmit() {
  const teamName = document.getElementById('team-name').value.trim();
  const email = document.getElementById('email').value.trim();
  const nameError = document.getElementById('name-error');
  const submitError = document.getElementById('submit-error');
  nameError.classList.add('hidden');
  submitError.classList.add('hidden');

  if (!teamName) {
    nameError.textContent = 'Team name is required.';
    nameError.classList.remove('hidden');
    return;
  }

  if (selectedIds.size !== MAX_PICKS) return;

  const submitBtn = document.getElementById('submit-btn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting...';

  try {
    const golferIds = [...selectedIds];

    if (editingEntryId) {
      // Update existing
      await updatePicks(editingEntryId, golferIds);
      showSuccess(teamName, existingAccessCode, true);
    } else {
      // Check name uniqueness
      const exists = await checkTeamNameExists(tournament.id, teamName);
      if (exists) {
        nameError.textContent = 'This team name is already taken. Choose another or edit your existing entry.';
        nameError.classList.remove('hidden');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Picks';
        return;
      }

      // Insert new entry
      const accessCode = generateAccessCode();
      const entryId = await insertEntry(tournament.id, teamName, email, accessCode);
      await insertPicks(entryId, golferIds);
      showSuccess(teamName, accessCode, false);
    }
  } catch (e) {
    console.error('Submit failed:', e);
    submitError.textContent = 'Submission failed: ' + e.message;
    submitError.classList.remove('hidden');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit Picks';
  }
}

function showSuccess(teamName, accessCode, isEdit) {
  document.getElementById('mode-select').classList.add('hidden');
  document.getElementById('success').classList.remove('hidden');
  document.getElementById('success-title').textContent = isEdit ? 'Picks Updated!' : 'Picks Submitted!';
  document.getElementById('success-message').textContent = isEdit
    ? `Your picks for "${teamName}" have been updated.`
    : `Your entry "${teamName}" has been saved.`;
  document.getElementById('code-display').textContent = accessCode;
  // Hide the access code box on edits (they already have it)
  document.getElementById('access-code-box').classList.toggle('hidden', isEdit);
}

// ─── Edit Lookup ────────────────────────────────────────────────────────────
async function handleEditLookup() {
  const teamName = document.getElementById('edit-team').value.trim();
  const code = document.getElementById('edit-code').value.trim().toUpperCase();
  const errorEl = document.getElementById('edit-error');
  errorEl.classList.add('hidden');

  if (!teamName || !code) {
    errorEl.textContent = 'Enter both team name and access code.';
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    const entry = await lookupEntry(teamName, code);
    if (!entry) {
      errorEl.textContent = 'No matching entry found. Check your team name and access code.';
      errorEl.classList.remove('hidden');
      return;
    }

    // Load existing picks into the form
    editingEntryId = entry.id;
    existingAccessCode = code;
    selectedIds.clear();
    for (const pick of entry.picks) {
      selectedIds.add(Number(pick.golfer_id));
    }

    document.getElementById('team-name').value = entry.team_name;
    document.getElementById('team-name').disabled = true; // can't rename
    document.getElementById('pick-form').classList.remove('hidden');
    document.getElementById('submit-btn').textContent = 'Update Picks';

    renderGolferList();
    updatePicksDisplay();
  } catch (e) {
    errorEl.textContent = 'Lookup failed: ' + e.message;
    errorEl.classList.remove('hidden');
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function generateAccessCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 to avoid confusion
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
