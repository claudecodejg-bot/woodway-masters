'use strict';

// ─── Name normalization ───────────────────────────────────────────────────────
// Aliases: picks name → ESPN leaderboard normalized name
const NAME_ALIASES = {
  'matthew fitzpatrick': 'matt fitzpatrick',
  'mattew fitzpatrick': 'matt fitzpatrick',
  'jj spaun': 'jj spaun',        // periods removed handles this
  'jt poston': 'jt poston',       // ditto
  'maverick mcnealey': 'maverick mcnealy',
  'charl scwartzel': 'charl schwartzel',
  'billy horshel': 'billy horschel',
};

function normalizeName(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // strip accents
    .replace(/\./g, '')               // remove periods (J.J. → JJ)
    .toLowerCase()
    .trim();
}

// ─── Data loading ─────────────────────────────────────────────────────────────
let picks = [], oddsMap = {}, leaderboard = {}, purseData = {};

async function loadAll() {
  const [p, o, l, pu] = await Promise.all([
    fetch('data/picks.json').then(r => r.json()),
    fetch('data/odds.json').then(r => r.json()),
    fetch('data/leaderboard.json').then(r => r.json()),
    fetch('data/purse.json').then(r => r.json()),
  ]);
  picks = p;
  oddsMap = buildNormalizedOdds(o);
  leaderboard = l;
  purseData = pu;
}

function buildNormalizedOdds(raw) {
  const out = {};
  for (const [name, mult] of Object.entries(raw)) {
    out[normalizeName(name)] = mult;
  }
  return out;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────
function buildLeaderboardIndex(lb) {
  const idx = {};
  for (const player of lb.players || []) {
    idx[player.normalizedName] = player;
  }
  return idx;
}

function lookupPlayer(pickName, lbIndex) {
  let key = normalizeName(pickName);
  key = NAME_ALIASES[key] || key;
  return lbIndex[key] || null;
}

function scoreTeam(entry, lbIndex) {
  let total = 0;
  const golfers = entry.players.map(pickName => {
    const key = NAME_ALIASES[normalizeName(pickName)] || normalizeName(pickName);
    const odds = oddsMap[normalizeName(pickName)] || oddsMap[key] || null;
    const player = lookupPlayer(pickName, lbIndex);

    let status, prize = 0, poolEarnings = 0;
    if (!player) {
      status = 'not-in-field';
    } else if (player.missedCut) {
      status = 'cut';
      prize = 0;
    } else {
      status = 'active';
      prize = player.estimatedPrize || 0;
    }

    if (odds && status === 'active') {
      poolEarnings = prize * odds;
    }
    total += poolEarnings;

    return {
      pickName,
      espnName: player ? player.name : null,
      position: player ? player.position : null,
      score: player ? player.score : null,
      roundScores: player ? player.roundScores : {},
      missedCut: player ? player.missedCut : false,
      odds,
      prize,
      poolEarnings,
      status,
    };
  });

  return { name: entry.name, total, golfers };
}

function buildRankings() {
  const lbIndex = buildLeaderboardIndex(leaderboard);
  return picks
    .map(e => scoreTeam(e, lbIndex))
    .sort((a, b) => b.total - a.total);
}

// ─── Formatting helpers ───────────────────────────────────────────────────────
function fmt$(n) {
  return n ? '$' + n.toLocaleString() : '$0';
}

function fmtScore(s) {
  if (!s || s === 'E') return 'E';
  return s;
}

function statusBadge(golfer) {
  if (golfer.status === 'not-in-field') return '<span class="badge badge-nif">Not in Field</span>';
  if (golfer.missedCut) return '<span class="badge badge-cut">MC</span>';
  if (golfer.position === 1) return '<span class="badge badge-lead">Lead</span>';
  return '';
}

function roundBadges(rs) {
  return [1,2,3,4].map(r => {
    const v = rs[`R${r}`];
    return `<span class="round-score ${v ? '' : 'round-empty'}">${v || '—'}</span>`;
  }).join('');
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function renderHeader() {
  const lb = leaderboard;
  const updated = lb.lastUpdated
    ? new Date(lb.lastUpdated).toLocaleString('en-US', { timeZoneName: 'short' })
    : '—';

  document.getElementById('tournament-name').textContent = lb.tournament || 'Tournament';
  document.getElementById('tournament-status').textContent =
    lb.round ? `Round ${lb.round} — ${lb.statusDisplay || ''}` : (lb.statusDisplay || '');
  document.getElementById('purse-display').textContent =
    `Purse: $${(lb.purse || 0).toLocaleString()}`;
  document.getElementById('last-updated').textContent = `Updated: ${updated}`;
}

function renderLeaderboard(rankings) {
  const tbody = document.getElementById('team-tbody');
  tbody.innerHTML = '';

  rankings.forEach((team, idx) => {
    const rank = idx + 1;
    const isTied = idx > 0 && rankings[idx - 1].total === team.total;
    const rankDisplay = isTied ? 'T' + rank : rank;

    // Summary row
    const tr = document.createElement('tr');
    tr.className = 'team-row';
    tr.setAttribute('data-team', idx);
    tr.innerHTML = `
      <td class="rank">${rankDisplay}</td>
      <td class="team-name">${escHtml(team.name)}</td>
      <td class="earnings">${fmt$(team.total)}</td>
      <td class="expand-icon">▶</td>
    `;
    tr.addEventListener('click', () => toggleDetail(idx));
    tbody.appendChild(tr);

    // Detail row (hidden by default)
    const detailTr = document.createElement('tr');
    detailTr.className = 'detail-row hidden';
    detailTr.id = `detail-${idx}`;
    detailTr.innerHTML = `<td colspan="4">${renderGolfers(team.golfers)}</td>`;
    tbody.appendChild(detailTr);
  });
}

function renderGolfers(golfers) {
  const rows = golfers.map(g => {
    const posDisp = g.position ? String(g.position) : '—';
    const oddsDisp = g.odds ? `${g.odds}-1` : 'N/A';
    return `
      <tr class="golfer-row ${g.status}">
        <td>${escHtml(g.pickName)}</td>
        <td class="pos">${g.status === 'not-in-field' ? 'NIF' : (g.missedCut ? 'MC' : posDisp)}</td>
        <td class="score">${g.status === 'not-in-field' ? '—' : fmtScore(g.score)}</td>
        <td class="rounds">${roundBadges(g.roundScores || {})}</td>
        <td class="odds-col">${oddsDisp}</td>
        <td class="prize-col">${fmt$(g.prize)}</td>
        <td class="pool-col">${fmt$(g.poolEarnings)}</td>
        <td>${statusBadge(g)}</td>
      </tr>`;
  }).join('');

  return `<div class="golfer-detail">
    <table class="golfer-table">
      <thead>
        <tr>
          <th>Golfer</th><th>Pos</th><th>Score</th><th>Rounds</th>
          <th>Odds</th><th>Est. Prize</th><th>Pool Earnings</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function toggleDetail(idx) {
  const detailRow = document.getElementById(`detail-${idx}`);
  const teamRow = document.querySelector(`[data-team="${idx}"]`);
  const icon = teamRow.querySelector('.expand-icon');
  if (detailRow.classList.contains('hidden')) {
    detailRow.classList.remove('hidden');
    teamRow.classList.add('expanded');
    icon.textContent = '▼';
  } else {
    detailRow.classList.add('hidden');
    teamRow.classList.remove('expanded');
    icon.textContent = '▶';
  }
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Search / Filter ──────────────────────────────────────────────────────────
let allRankings = [];

function applySearch(query) {
  const q = query.toLowerCase().trim();
  document.querySelectorAll('.team-row').forEach((row, idx) => {
    const name = (row.querySelector('.team-name').textContent || '').toLowerCase();
    const show = !q || name.includes(q);
    row.style.display = show ? '' : 'none';
    const detail = document.getElementById(`detail-${idx}`);
    if (detail && !show) {
      detail.classList.add('hidden');
      detail.style.display = '';
    }
    if (detail) {
      detail.style.display = show ? '' : 'none';
    }
  });
}

// ─── Auto-refresh ─────────────────────────────────────────────────────────────
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function refresh() {
  try {
    // Bust cache with timestamp
    const ts = Date.now();
    const [lb] = await Promise.all([
      fetch(`data/leaderboard.json?t=${ts}`).then(r => r.json()),
    ]);
    leaderboard = lb;
    allRankings = buildRankings();
    renderHeader();
    renderLeaderboard(allRankings);
    const searchVal = document.getElementById('search').value;
    if (searchVal) applySearch(searchVal);
    showToast('Leaderboard refreshed');
  } catch (e) {
    console.error('Refresh failed:', e);
  }
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  try {
    await loadAll();
    allRankings = buildRankings();
    renderHeader();
    renderLeaderboard(allRankings);

    document.getElementById('search').addEventListener('input', e => applySearch(e.target.value));
    document.getElementById('refresh-btn').addEventListener('click', refresh);

    // Auto-refresh every 5 min
    setInterval(refresh, REFRESH_INTERVAL_MS);
  } catch (e) {
    console.error('Init failed:', e);
    document.getElementById('loading').textContent = 'Error loading data. Please refresh.';
  }
}

document.addEventListener('DOMContentLoaded', init);
