'use strict';

// ─── Name normalization ───────────────────────────────────────────────────────
const NAME_ALIASES = {
  'matthew fitzpatrick': 'matt fitzpatrick',
  'mattew fitzpatrick':  'matt fitzpatrick',
  'jj spaun':            'jj spaun',
  'jt poston':           'jt poston',
  'maverick mcnealey':   'maverick mcnealy',
  'charl scwartzel':     'charl schwartzel',
  'billy horshel':       'billy horschel',
};

function normalizeName(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, '')
    .toLowerCase()
    .trim();
}

// ─── Data ─────────────────────────────────────────────────────────────────────
let picks = [], oddsMap = {}, leaderboard = {}, purseData = {};

async function loadAll() {
  const [p, o, l, pu] = await Promise.all([
    fetch('data/picks.json').then(r => r.json()),
    fetch('data/odds.json').then(r => r.json()),
    fetch('data/leaderboard.json').then(r => r.json()),
    fetch('data/purse.json').then(r => r.json()),
  ]);
  picks      = p;
  oddsMap    = buildNormalizedOdds(o);
  leaderboard = l;
  purseData  = pu;
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
    const key    = NAME_ALIASES[normalizeName(pickName)] || normalizeName(pickName);
    const odds   = oddsMap[normalizeName(pickName)] || oddsMap[key] || null;
    const player = lookupPlayer(pickName, lbIndex);

    let status, prize = 0, poolEarnings = 0;
    if (!player)             { status = 'not-in-field'; }
    else if (player.missedCut) { status = 'cut'; prize = 0; }
    else                     { status = 'active'; prize = player.estimatedPrize || 0; }

    if (odds && status === 'active') { poolEarnings = prize * odds; }
    total += poolEarnings;

    return {
      pickName,
      espnName:    player ? player.name : null,
      position:    player ? player.position : null,
      score:       player ? player.score : null,
      roundScores: player ? player.roundScores : {},
      missedCut:   player ? player.missedCut : false,
      odds, prize, poolEarnings, status,
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

// ─── Formatting ───────────────────────────────────────────────────────────────
function fmt$(n) { return n ? '$' + Math.round(n).toLocaleString() : '$0'; }

function fmtScore(s) { return (!s || s === 'E') ? 'E' : s; }

function scoreClass(s) {
  if (!s || s === 'E') return 'score-even';
  return s.startsWith('-') ? 'score-under' : 'score-over';
}

function statusBadge(golfer) {
  if (golfer.status === 'not-in-field') return '<span class="badge badge-nif">NIF</span>';
  if (golfer.missedCut)                 return '<span class="badge badge-cut">MC</span>';
  if (golfer.position === 1)            return '<span class="badge badge-lead">🏆 Lead</span>';
  return '';
}

function roundBadges(rs, currentRound) {
  return [1,2,3,4].map(r => {
    const v = rs[`R${r}`];
    const isToday = r === currentRound && v;
    return `<span class="round-score ${v ? (isToday ? 'round-today' : '') : 'round-empty'}">${v || '—'}</span>`;
  }).join('');
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Render: Header ───────────────────────────────────────────────────────────
function renderHeader() {
  const lb      = leaderboard;
  const updated = lb.lastUpdated
    ? new Date(lb.lastUpdated).toLocaleString('en-US', { timeZoneName: 'short' })
    : '—';
  document.getElementById('tournament-name').textContent   = lb.tournament || 'Tournament';
  document.getElementById('tournament-status').textContent =
    lb.round ? `Round ${lb.round} — ${lb.statusDisplay || ''}` : (lb.statusDisplay || '');
  document.getElementById('purse-display').textContent     = `Purse: $${(lb.purse || 0).toLocaleString()}`;
  document.getElementById('last-updated').textContent      = `Updated: ${updated}`;

  const todayLbl = document.getElementById('today-label');
  if (todayLbl && lb.round) todayLbl.textContent = `"Today" column = Round ${lb.round} in progress`;
}

// ─── Render: Pool Leaderboard (Tab 1) ────────────────────────────────────────
function renderLeaderboard(rankings) {
  const tbody = document.getElementById('team-tbody');
  tbody.innerHTML = '';

  const sameRoundPool = prevSnapshot.round === (leaderboard.round || 0);

  rankings.forEach((team, idx) => {
    const rank     = idx + 1;
    const isTied   = idx > 0 && rankings[idx - 1].total === team.total;
    const rankDisp = isTied ? 'T' + rank : rank;
    const rankClass = rank <= 5 ? `rank-${rank}` : '';
    const prevRank  = sameRoundPool ? (prevSnapshot.poolRanks || {})[team.name] : null;
    const move      = movementBadge(prevRank, rank);

    const tr = document.createElement('tr');
    tr.className = `team-row ${rankClass}`;
    tr.setAttribute('data-team', idx);
    tr.innerHTML = `
      <td class="rank">${rankDisp}${move}</td>
      <td class="team-name">${escHtml(team.name)}</td>
      <td class="earnings">${fmt$(team.total)}</td>
      <td class="expand-icon">▶</td>
    `;
    tr.addEventListener('click', () => toggleDetail(idx));
    tbody.appendChild(tr);

    const detailTr = document.createElement('tr');
    detailTr.className = 'detail-row hidden';
    detailTr.id = `detail-${idx}`;
    detailTr.innerHTML = `<td colspan="4">${renderGolfers(team.golfers)}</td>`;
    tbody.appendChild(detailTr);
  });

  document.getElementById('loading').style.display        = 'none';
  document.getElementById('pool-table-wrap').style.display = '';
}

function renderGolfers(golfers) {
  const currentRound = leaderboard.round || 0;
  const rows = golfers.map(g => {
    const posDisp  = g.position ? String(g.position) : '—';
    const oddsDisp = g.odds ? `${g.odds}-1` : 'N/A';
    return `
      <tr class="golfer-row ${g.status}">
        <td><span class="player-link" data-name="${escHtml(g.pickName)}">${escHtml(g.pickName)}</span></td>
        <td class="pos">${g.status === 'not-in-field' ? 'NIF' : (g.missedCut ? 'MC' : posDisp)}</td>
        <td class="score ${scoreClass(g.score)}">${g.status === 'not-in-field' ? '—' : fmtScore(g.score)}</td>
        <td><div class="rounds">${roundBadges(g.roundScores || {}, currentRound)}</div></td>
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
  const teamRow   = document.querySelector(`[data-team="${idx}"]`);
  const icon      = teamRow.querySelector('.expand-icon');
  const isHidden  = detailRow.classList.contains('hidden');
  detailRow.classList.toggle('hidden', !isHidden);
  teamRow.classList.toggle('expanded', isHidden);
  icon.textContent = isHidden ? '▼' : '▶';
}

// ─── Render: Teams & Picks (Tab 2) ───────────────────────────────────────────
function renderPicksTab(rankings) {
  const tbody = document.getElementById('picks-tbody');
  tbody.innerHTML = '';

  rankings.forEach(team => {
    const chips = team.golfers.map(g => {
      const chipClass = g.status === 'cut'          ? 'chip-cut'
                      : g.status === 'not-in-field' ? 'chip-nif'
                      : 'chip-active';
      const posLabel = g.status === 'not-in-field' ? 'NIF'
                     : g.missedCut                 ? 'MC'
                     : g.position                  ? `T${g.position}` : '—';
      return `<span class="pick-chip ${chipClass}" data-name="${escHtml(g.pickName)}">
        ${escHtml(g.pickName)}
        <span class="chip-pos">${posLabel}</span>
      </span>`;
    }).join('');

    const tr = document.createElement('tr');
    tr.className = 'picks-row';
    tr.setAttribute('data-team-name', team.name.toLowerCase());
    tr.innerHTML = `
      <td class="team-name">${escHtml(team.name)}</td>
      <td class="earnings">${fmt$(team.total)}</td>
      <td><div class="picks-chips">${chips}</div></td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── Render: Tournament Leaderboard (Tab 3) ──────────────────────────────────
function renderTournamentTab() {
  const tbody        = document.getElementById('tournament-tbody');
  const currentRound = leaderboard.round || 0;
  tbody.innerHTML    = '';

  const sameRoundTourn = prevSnapshot.round === currentRound;
  const players = [...(leaderboard.players || [])];

  players.forEach(p => {
    const mc         = p.missedCut;
    const todayScore = p.roundScores ? p.roundScores[`R${currentRound}`] : null;
    const posDisp    = mc ? 'MC' : (p.position ? p.position : '—');
    const prevPos    = (!mc && sameRoundTourn) ? (prevSnapshot.tournamentPositions || {})[p.name] : null;
    const move       = movementBadge(prevPos, p.position);

    const roundCells = [1,2,3,4].map(r => {
      const v        = p.roundScores ? p.roundScores[`R${r}`] : null;
      const isToday  = r === currentRound && v && !mc;
      return `<td class="score-col ${isToday ? 'today-col' : ''} ${scoreClass(v)}">${v || '—'}</td>`;
    }).join('');

    const tr = document.createElement('tr');
    tr.className = `tourn-row${mc ? ' missed-cut' : ''}${p.position === 1 ? ' pos-1' : ''}`;
    tr.setAttribute('data-pos', mc ? 9999 : (p.position || 9998));
    tr.setAttribute('data-name', (p.name || '').toLowerCase());
    tr.setAttribute('data-score', scoreToNum(p.score));
    tr.setAttribute('data-prize', p.estimatedPrize || 0);

    tr.innerHTML = `
      <td class="pos-col">${escHtml(String(posDisp))}${move}</td>
      <td><span class="player-link" data-name="${escHtml(p.name || '')}">${escHtml(p.name || '')}</span></td>
      <td class="score-col ${scoreClass(p.score)}">${fmtScore(p.score)}</td>
      <td class="score-col today-col ${scoreClass(todayScore)}">${todayScore || (mc ? 'MC' : '—')}</td>
      ${roundCells}
      <td class="prize-col">${mc ? '—' : fmt$(p.estimatedPrize)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function scoreToNum(s) {
  if (!s || s === 'E') return 0;
  return parseInt(s.replace('+',''), 10) || 0;
}

// ─── Tab switching ────────────────────────────────────────────────────────────
let activeTab = 'leaderboard';

function switchTab(tabName) {
  activeTab = tabName;

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });

  // Search bar: visible on leaderboard + teams, hidden on tournament
  const search = document.getElementById('search');
  search.style.display = tabName === 'tournament' ? 'none' : '';
  if (tabName === 'tournament') search.value = '';

  // Re-apply any active search
  if (tabName !== 'tournament') applySearch(search.value);
}

// ─── Sort state ───────────────────────────────────────────────────────────────
const sortState = {
  pool:       { col: 'earnings', dir: 'desc' },
  picks:      { col: 'earnings', dir: 'desc' },
  tournament: { col: 'pos',      dir: 'asc'  },
};

function attachSortListeners() {
  // Pool Leaderboard
  document.querySelectorAll('#pool-table thead th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      toggleSort('pool', col);
      renderLeaderboard(sortRankings(allRankings, sortState.pool));
      applySearch(document.getElementById('search').value);
      updateSortIcons('#pool-table', sortState.pool);
    });
  });

  // Teams & Picks
  document.querySelectorAll('#picks-table thead th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      toggleSort('picks', col);
      renderPicksTab(sortRankings(allRankings, sortState.picks));
      applySearch(document.getElementById('search').value);
      updateSortIcons('#picks-table', sortState.picks);
    });
  });

  // Tournament
  document.querySelectorAll('#tournament-table thead th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      toggleSort('tournament', col);
      sortTournamentTable(sortState.tournament);
      updateSortIcons('#tournament-table', sortState.tournament);
    });
  });
}

function toggleSort(table, col) {
  const state = sortState[table];
  if (state.col === col) {
    state.dir = state.dir === 'asc' ? 'desc' : 'asc';
  } else {
    state.col = col;
    state.dir = col === 'name' ? 'asc' : (col === 'pos' ? 'asc' : 'desc');
  }
}

function updateSortIcons(tableSelector, state) {
  document.querySelectorAll(`${tableSelector} thead th.sortable`).forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === state.col) {
      th.classList.add(state.dir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

function sortRankings(rankings, state) {
  return [...rankings].sort((a, b) => {
    let va, vb;
    if (state.col === 'name') {
      va = a.name.toLowerCase(); vb = b.name.toLowerCase();
      return state.dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    va = a.total; vb = b.total;
    return state.dir === 'asc' ? va - vb : vb - va;
  });
}

function sortTournamentTable(state) {
  const tbody = document.getElementById('tournament-tbody');
  const rows  = Array.from(tbody.querySelectorAll('tr.tourn-row'));
  rows.sort((a, b) => {
    let va, vb;
    if (state.col === 'name') {
      va = a.dataset.name; vb = b.dataset.name;
      const r = va.localeCompare(vb);
      return state.dir === 'asc' ? r : -r;
    }
    if (state.col === 'score') {
      va = parseFloat(a.dataset.score); vb = parseFloat(b.dataset.score);
    } else if (state.col === 'prize') {
      va = parseFloat(a.dataset.prize); vb = parseFloat(b.dataset.prize);
    } else { // pos
      va = parseFloat(a.dataset.pos); vb = parseFloat(b.dataset.pos);
    }
    return state.dir === 'asc' ? va - vb : vb - va;
  });
  rows.forEach(r => tbody.appendChild(r));
}

// ─── Search / Filter ──────────────────────────────────────────────────────────
let allRankings = [];

function applySearch(query) {
  const q = query.toLowerCase().trim();

  if (activeTab === 'leaderboard') {
    let visIdx = 0;
    document.querySelectorAll('#team-tbody .team-row').forEach(row => {
      const name  = (row.querySelector('.team-name').textContent || '').toLowerCase();
      const show  = !q || name.includes(q);
      const teamIdx = parseInt(row.dataset.team, 10);
      row.style.display = show ? '' : 'none';
      const detail = document.getElementById(`detail-${teamIdx}`);
      if (detail) detail.style.display = show ? '' : 'none';
      if (show) visIdx++;
    });
  }

  if (activeTab === 'teams') {
    document.querySelectorAll('#picks-tbody .picks-row').forEach(row => {
      const name = row.dataset.teamName || '';
      row.style.display = (!q || name.includes(q)) ? '' : 'none';
    });
  }
}

// ─── Movement Tracking ────────────────────────────────────────────────────────
let prevSnapshot = {};

function loadSnapshot() {
  try {
    prevSnapshot = JSON.parse(localStorage.getItem('ww_snapshot') || '{}');
  } catch(e) {
    prevSnapshot = {};
  }
}

function saveSnapshot(rankings) {
  const round = leaderboard.round || 0;
  const poolRanks = {};
  rankings.forEach((team, idx) => { poolRanks[team.name] = idx + 1; });

  const tournamentPositions = {};
  (leaderboard.players || []).forEach(p => {
    if (!p.missedCut && p.position) tournamentPositions[p.name] = p.position;
  });

  try {
    localStorage.setItem('ww_snapshot', JSON.stringify({ round, poolRanks, tournamentPositions }));
  } catch(e) {}
}

function movementBadge(prevPos, currPos) {
  if (prevPos == null || currPos == null) return '';
  const diff = prevPos - currPos; // positive = moved up (smaller number = better)
  if (diff === 0) return '';
  if (diff > 0) return `<span class="move-up">▲${diff}</span>`;
  return `<span class="move-down">▼${Math.abs(diff)}</span>`;
}

// ─── Auto-refresh ─────────────────────────────────────────────────────────────
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

async function refresh() {
  try {
    const ts = Date.now();
    leaderboard = await fetch(`data/leaderboard.json?t=${ts}`).then(r => r.json());
    allRankings = buildRankings();
    loadSnapshot();
    renderHeader();
    renderLeaderboard(sortRankings(allRankings, sortState.pool));
    renderPicksTab(sortRankings(allRankings, sortState.picks));
    renderTournamentTab();
    saveSnapshot(allRankings);
    updateSortIcons('#pool-table',       sortState.pool);
    updateSortIcons('#picks-table',      sortState.picks);
    updateSortIcons('#tournament-table', sortState.tournament);
    applySearch(document.getElementById('search').value);
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

// ─── Player Modal ─────────────────────────────────────────────────────────────
function buildPlayerToTeamsMap() {
  const map = {};
  allRankings.forEach((team, idx) => {
    team.golfers.forEach(g => {
      const key = NAME_ALIASES[normalizeName(g.pickName)] || normalizeName(g.pickName);
      if (!map[key]) map[key] = [];
      map[key].push({ team, rank: idx + 1 });
    });
  });
  return map;
}

function showPlayerModal(playerName) {
  const clickedKey = NAME_ALIASES[normalizeName(playerName)] || normalizeName(playerName);
  const map        = buildPlayerToTeamsMap();
  const teams      = map[clickedKey] || [];

  const lbIndex = buildLeaderboardIndex(leaderboard);
  const player  = lookupPlayer(playerName, lbIndex);

  let infoText = 'Not in field';
  if (player) {
    const pos   = player.missedCut ? 'MC' : (player.position ? `T${player.position}` : '—');
    const score = fmtScore(player.score);
    infoText    = `Position: ${pos}  |  Score: ${score}`;
  }

  // detect ties for rank display
  const teamsHtml = teams.length
    ? teams.map(({ team, rank }) => {
        const isTied   = allRankings.filter(t => t.total === team.total).length > 1;
        const rankDisp = isTied ? `T${rank}` : `${rank}`;
        const chips = team.golfers.map(g => {
          const gKey      = NAME_ALIASES[normalizeName(g.pickName)] || normalizeName(g.pickName);
          const isSelected = gKey === clickedKey;
          const chipClass = isSelected              ? 'modal-chip modal-chip-selected'
                          : g.status === 'cut'      ? 'modal-chip modal-chip-cut'
                          : g.status === 'not-in-field' ? 'modal-chip modal-chip-nif'
                          : 'modal-chip modal-chip-active';
          const posLabel  = g.status === 'not-in-field' ? 'NIF'
                          : g.missedCut                 ? 'MC'
                          : g.position                  ? `T${g.position}` : '—';
          return `<span class="${chipClass}">${escHtml(g.pickName)}<span class="modal-chip-pos">${posLabel}</span></span>`;
        }).join('');
        return `<li><span class="modal-team-name"><span class="modal-team-rank">${rankDisp}</span>${escHtml(team.name)}</span><div class="modal-chips">${chips}</div></li>`;
      }).join('')
    : '<li class="modal-no-teams">Not picked by any team</li>';

  document.getElementById('player-modal-name').textContent  = playerName;
  document.getElementById('player-modal-info').textContent  = infoText;
  document.getElementById('player-modal-teams').innerHTML   = teamsHtml;
  document.getElementById('player-modal').classList.add('open');
}

function closePlayerModal() {
  document.getElementById('player-modal').classList.remove('open');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  try {
    await loadAll();
    allRankings = buildRankings();
    loadSnapshot();
    renderHeader();
    renderLeaderboard(sortRankings(allRankings, sortState.pool));
    renderPicksTab(sortRankings(allRankings, sortState.picks));
    renderTournamentTab();
    saveSnapshot(allRankings);
    updateSortIcons('#pool-table',       sortState.pool);
    updateSortIcons('#picks-table',      sortState.picks);
    updateSortIcons('#tournament-table', sortState.tournament);

    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Search
    document.getElementById('search').addEventListener('input', e => applySearch(e.target.value));

    // Refresh button
    document.getElementById('refresh-btn').addEventListener('click', refresh);

    // Sort listeners
    attachSortListeners();

    // Auto-refresh
    setInterval(refresh, REFRESH_INTERVAL_MS);

    // Player modal
    document.getElementById('modal-close-btn').addEventListener('click', closePlayerModal);
    document.getElementById('player-modal').addEventListener('click', e => {
      if (e.target === document.getElementById('player-modal')) closePlayerModal();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closePlayerModal();
    });
    document.addEventListener('click', e => {
      const link = e.target.closest('.player-link');
      if (link && link.dataset.name) { showPlayerModal(link.dataset.name); return; }
      const chip = e.target.closest('.pick-chip');
      if (chip && chip.dataset.name) showPlayerModal(chip.dataset.name);
    });

  } catch (e) {
    console.error('Init failed:', e);
    document.getElementById('loading').textContent = 'Error loading data. Please refresh.';
  }
}

document.addEventListener('DOMContentLoaded', init);
