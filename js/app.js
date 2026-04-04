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
    .replace(/ø/g, 'o').replace(/Ø/g, 'O')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/ł/g, 'l').replace(/Ł/g, 'L')
    .toLowerCase()
    .trim();
}

// ─── Data ─────────────────────────────────────────────────────────────────────
let picks = [], oddsMap = {}, leaderboard = {}, purseData = {}, priorData = null;

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
    if (!player)                                    { status = 'not-in-field'; }
    else if (player.missedCut || player.projectedCut) { status = 'cut'; prize = 0; }
    else                                            { status = 'active'; prize = player.estimatedPrize || 0; }

    if (odds && status === 'active') { poolEarnings = prize * odds; }
    total += poolEarnings;

    return {
      pickName,
      espnName:    player ? player.name : null,
      position:    player ? player.position : null,
      score:       player ? player.score : null,
      roundScores: player ? player.roundScores : {},
      missedCut:   player ? player.missedCut : false,
      projectedCut: player ? player.projectedCut : false,
      odds, prize, poolEarnings, status,
    };
  });

  // Sort golfers: active by poolEarnings desc, then cut/MC players last
  golfers.sort((a, b) => {
    if (a.status === 'cut' && b.status !== 'cut') return 1;
    if (a.status !== 'cut' && b.status === 'cut') return -1;
    return b.poolEarnings - a.poolEarnings;
  });

  return { name: entry.name, total, golfers };
}

function buildRankings() {
  const lbIndex = buildLeaderboardIndex(leaderboard);
  return picks
    .map(e => scoreTeam(e, lbIndex))
    .sort((a, b) => b.total - a.total);
}

// ─── Prior-round standings (for daily movement) ─────────────────────────────
function buildPriorRoundTotals() {
  const currentRound = leaderboard.round || 0;
  if (currentRound <= 1) return null; // no prior round to compare

  const purse = purseData.purse || 0;
  const pct   = purseData.payoutPercentages || [];
  const players = leaderboard.players || [];

  // Calculate each player's score through end of prior round
  const priorScores = [];
  for (const p of players) {
    const rs = p.roundScores || {};
    let total = 0;
    let hasScores = false;
    for (let r = 1; r < currentRound; r++) {
      const v = rs[`R${r}`];
      if (v && v !== '—') {
        total += scoreToNum(v);
        hasScores = true;
      }
    }
    // Skip players who missed cut or had no prior-round scores
    if (p.missedCut && !hasScores) continue;
    priorScores.push({
      normalizedName: p.normalizedName,
      priorTotal: hasScores ? total : 999,
      missedCut: p.missedCut || p.projectedCut
    });
  }

  // Rank by prior-round score (lower is better)
  priorScores.sort((a, b) => a.priorTotal - b.priorTotal);

  // Group by score for tie handling
  const posGroups = {};
  let pos = 1;
  for (let i = 0; i < priorScores.length; i++) {
    if (priorScores[i].missedCut) {
      priorScores[i].prize = 0;
      continue;
    }
    if (i > 0 && priorScores[i].priorTotal === priorScores[i - 1].priorTotal) {
      priorScores[i].pos = priorScores[i - 1].pos;
    } else {
      priorScores[i].pos = pos;
    }
    pos++;
  }

  // Calculate prizes with tie averaging
  const tieGroups = {};
  for (const p of priorScores) {
    if (p.missedCut || p.pos == null) continue;
    if (!tieGroups[p.pos]) tieGroups[p.pos] = [];
    tieGroups[p.pos].push(p);
  }
  for (const [tiePos, group] of Object.entries(tieGroups)) {
    const startPos = parseInt(tiePos);
    let totalPrize = 0;
    for (let i = 0; i < group.length; i++) {
      const idx = Math.min(startPos - 1 + i, pct.length - 1);
      totalPrize += purse * (pct[idx] || 0);
    }
    const avgPrize = totalPrize / group.length;
    for (const p of group) p.prize = Math.round(avgPrize);
  }

  // Build lookup: normalizedName -> prior prize
  const priorPrizeMap = {};
  for (const p of priorScores) {
    priorPrizeMap[p.normalizedName] = p.prize || 0;
  }

  // Build per-player prior odds-adjusted earnings
  const playerPriorAdj = {};
  for (const p of priorScores) {
    const odds = oddsMap[p.normalizedName] || 0;
    playerPriorAdj[p.normalizedName] = (p.prize || 0) * odds;
  }

  // Calculate prior-round team totals
  const lbIndex = buildLeaderboardIndex(leaderboard);
  const teamTotals = {};
  for (const entry of picks) {
    let total = 0;
    for (const pickName of entry.players) {
      const key = NAME_ALIASES[normalizeName(pickName)] || normalizeName(pickName);
      const odds = oddsMap[normalizeName(pickName)] || oddsMap[key] || 0;
      const player = lookupPlayer(pickName, lbIndex);
      if (!player || player.missedCut || player.projectedCut) continue;
      const priorPrize = priorPrizeMap[player.normalizedName] || 0;
      total += priorPrize * odds;
    }
    teamTotals[entry.name] = total;
  }

  return { teamTotals, playerPriorAdj };
}

// ─── Formatting ───────────────────────────────────────────────────────────────
function fmt$(n) { return n ? '$' + Math.round(n).toLocaleString() : '$0'; }

function fmtMM(n) {
  if (!n) return '0.0mm';
  const mm = n / 1000000;
  return mm >= 10 ? mm.toFixed(1) + 'mm' : mm.toFixed(1) + 'mm';
}

function fmtScore(s) { return (!s || s === 'E') ? 'E' : s; }

function scoreClass(s) {
  if (!s || s === 'E') return 'score-even';
  return s.startsWith('-') ? 'score-under' : 'score-over';
}

function statusBadge(golfer) {
  if (golfer.status === 'not-in-field') return '<span class="badge badge-nif">NIF</span>';
  if (golfer.missedCut || golfer.projectedCut) return '<span class="badge badge-cut">MC</span>';
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
  document.getElementById('header-tournament').textContent = lb.tournament || 'Tournament';
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
  const priorTotals = priorData ? priorData.teamTotals : null;

  rankings.forEach((team, idx) => {
    const rank     = idx + 1;
    const isTied   = idx > 0 && rankings[idx - 1].total === team.total;
    const rankDisp = isTied ? 'T' + rank : rank;
    const rankClass = rank <= 5 ? `rank-${rank}` : '';
    const prevRank  = sameRoundPool ? (prevSnapshot.poolRanks || {})[team.name] : null;
    const move      = movementBadge(prevRank, rank);

    // Today's earnings change (computed from prior round standings)
    let todayHtml = '';
    if (priorTotals && priorTotals[team.name] != null) {
      const delta = team.total - priorTotals[team.name];
      if (delta > 0)      todayHtml = `<span class="today-delta delta-up">+${fmtMM(delta)}</span>`;
      else if (delta < 0) todayHtml = `<span class="today-delta delta-down">-${fmtMM(Math.abs(delta))}</span>`;
      else                todayHtml = `<span class="today-delta delta-even">—</span>`;
    }

    const tr = document.createElement('tr');
    tr.className = `team-row ${rankClass}`;
    tr.setAttribute('data-team', idx);
    tr.innerHTML = `
      <td class="rank">${rankDisp}${move}</td>
      <td class="team-name">${escHtml(team.name)}</td>
      <td class="earnings">${fmt$(team.total)}${todayHtml}</td>
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
  const playerPrior = priorData ? priorData.playerPriorAdj : null;
  const rows = golfers.map(g => {
    const posDisp  = g.position ? String(g.position) : '—';
    const oddsDisp = g.odds ? `${g.odds}-1` : 'N/A';

    let deltaHtml = '';
    if (playerPrior) {
      const gKey = NAME_ALIASES[normalizeName(g.pickName)] || normalizeName(g.pickName);
      const prior = playerPrior[gKey] || 0;
      const delta = g.poolEarnings - prior;
      if (delta > 0)      deltaHtml = `<span class="today-delta delta-up">+${fmtMM(delta)}</span>`;
      else if (delta < 0) deltaHtml = `<span class="today-delta delta-down">-${fmtMM(Math.abs(delta))}</span>`;
      else                deltaHtml = `<span class="today-delta delta-even">—</span>`;
    }

    return `
      <tr class="golfer-row ${g.status}">
        <td><span class="player-link" data-name="${escHtml(g.pickName)}">${escHtml(g.pickName)}</span></td>
        <td class="pos">${g.status === 'not-in-field' ? 'NIF' : (g.missedCut || g.projectedCut ? 'MC' : posDisp)}</td>
        <td class="score ${scoreClass(g.score)}">${g.status === 'not-in-field' ? '—' : fmtScore(g.score)}</td>
        <td><div class="rounds">${roundBadges(g.roundScores || {}, currentRound)}</div></td>
        <td class="odds-col">${oddsDisp}</td>
        <td class="prize-col">${fmt$(g.prize)}</td>
        <td class="pool-col">${fmt$(g.poolEarnings)}${deltaHtml}</td>
        <td>${statusBadge(g)}</td>
      </tr>`;
  }).join('');

  return `<div class="golfer-detail">
    <table class="golfer-table">
      <thead>
        <tr>
          <th>Golfer</th><th>Pos</th><th>Score</th><th>Rounds</th>
          <th>Odds</th><th>Est. Earnings</th><th>Odds Adj Earnings</th><th></th>
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
                     : g.projectedCut              ? 'PC'
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
  const totalCols = 11; // pos, player, total, today, R1-R4, winnings, odds, odds adj

  // Determine if we need a cut line divider
  let cutLineInserted = false;

  players.forEach(p => {
    const mc         = p.missedCut;
    const pc         = p.projectedCut;
    const isCut      = mc || pc;
    const todayScore = p.roundScores ? p.roundScores[`R${currentRound}`] : null;
    const posDisp    = mc ? 'MC' : pc ? 'PC' : (p.position ? p.position : '—');
    const prevPos    = (!isCut && sameRoundTourn) ? (prevSnapshot.tournamentPositions || {})[p.name] : null;
    const move       = isCut ? '' : movementBadge(prevPos, p.position);

    // Insert cut line divider before the first cut/projected-cut player
    if (isCut && !cutLineInserted) {
      cutLineInserted = true;
      const divider = document.createElement('tr');
      divider.className = 'cut-line-row';
      const label = currentRound >= 3 ? 'Missed Cut' : 'Projected Cut Line';
      const cutScore = leaderboard.cutLineScore || '';
      const scoreLabel = cutScore ? ` (${cutScore})` : '';
      divider.innerHTML = `<td colspan="${totalCols}" class="cut-line-cell">✂ ${label}${scoreLabel}</td>`;
      tbody.appendChild(divider);
    }

    const roundCells = [1,2,3,4].map(r => {
      const v        = p.roundScores ? p.roundScores[`R${r}`] : null;
      const isToday  = r === currentRound && v && !isCut;
      return `<td class="score-col ${isToday ? 'today-col' : ''} ${scoreClass(v)}">${v || '—'}</td>`;
    }).join('');

    const tr = document.createElement('tr');
    tr.className = `tourn-row${isCut ? ' missed-cut' : ''}${p.position === 1 ? ' pos-1' : ''}`;
    tr.setAttribute('data-pos', isCut ? 9999 : (p.position || 9998));
    tr.setAttribute('data-name', (p.name || '').toLowerCase());
    tr.setAttribute('data-score', scoreToNum(p.score));
    tr.setAttribute('data-prize', p.estimatedPrize || 0);
    tr.setAttribute('data-cut', isCut ? '1' : '0');

    const todayNum = todayScore ? scoreToNum(todayScore) : 999;
    tr.setAttribute('data-today', todayNum);
    tr.setAttribute('data-r1', p.roundScores && p.roundScores.R1 ? scoreToNum(p.roundScores.R1) : 999);
    tr.setAttribute('data-r2', p.roundScores && p.roundScores.R2 ? scoreToNum(p.roundScores.R2) : 999);
    tr.setAttribute('data-r3', p.roundScores && p.roundScores.R3 ? scoreToNum(p.roundScores.R3) : 999);
    tr.setAttribute('data-r4', p.roundScores && p.roundScores.R4 ? scoreToNum(p.roundScores.R4) : 999);

    const odds = oddsMap[p.normalizedName] || 0;
    const oddsAdj = isCut ? 0 : (p.estimatedPrize || 0) * odds;

    tr.setAttribute('data-odds-adj', oddsAdj);
    tr.setAttribute('data-odds', odds || 0);

    // Per-player daily delta for tournament tab
    let tournDelta = '';
    const playerPrior = priorData ? priorData.playerPriorAdj : null;
    if (playerPrior && !isCut) {
      const prior = playerPrior[p.normalizedName] || 0;
      const delta = oddsAdj - prior;
      if (delta > 0)      tournDelta = `<span class="today-delta delta-up">+${fmtMM(delta)}</span>`;
      else if (delta < 0) tournDelta = `<span class="today-delta delta-down">-${fmtMM(Math.abs(delta))}</span>`;
      else                tournDelta = `<span class="today-delta delta-even">—</span>`;
    }

    tr.innerHTML = `
      <td class="pos-col">${escHtml(String(posDisp))}${move}</td>
      <td><span class="player-link" data-name="${escHtml(p.name || '')}">${escHtml(p.name || '')}</span></td>
      <td class="score-col ${scoreClass(p.score)}">${fmtScore(p.score)}</td>
      <td class="score-col today-col ${scoreClass(todayScore)}">${todayScore || (isCut ? (mc ? 'MC' : 'PC') : '—')}</td>
      ${roundCells}
      <td class="prize-col">${isCut ? '—' : fmt$(p.estimatedPrize)}</td>
      <td class="odds-col" style="text-align:center">${odds ? odds + '-1' : '—'}</td>
      <td class="prize-col">${isCut ? '—' : (odds ? fmt$(oddsAdj) + tournDelta : '—')}</td>
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
  picks:      { col: 'name',     dir: 'asc'  },
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
    const ascCols = ['name', 'pos', 'score', 'today', 'r1', 'r2', 'r3', 'r4'];
    state.dir = ascCols.includes(col) ? 'asc' : 'desc';
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

  // Remove existing cut line row before re-sorting
  const cutLine = tbody.querySelector('.cut-line-row');
  if (cutLine) cutLine.remove();

  // Separate active and cut players
  const active = rows.filter(r => r.dataset.cut === '0');
  const cut    = rows.filter(r => r.dataset.cut === '1');

  function getVal(row) {
    const col = state.col;
    if (col === 'name')   return row.dataset.name;
    if (col === 'score')  return parseFloat(row.dataset.score);
    if (col === 'prize')  return parseFloat(row.dataset.prize);
    if (col === 'oddsAdj') return parseFloat(row.dataset.oddsAdj);
    if (col === 'odds')   return parseFloat(row.dataset.odds);
    if (col === 'today')  return parseFloat(row.dataset.today);
    if (col === 'r1')     return parseFloat(row.dataset.r1);
    if (col === 'r2')     return parseFloat(row.dataset.r2);
    if (col === 'r3')     return parseFloat(row.dataset.r3);
    if (col === 'r4')     return parseFloat(row.dataset.r4);
    return parseFloat(row.dataset.pos); // pos default
  }

  function compare(a, b) {
    const va = getVal(a), vb = getVal(b);
    if (state.col === 'name') {
      const r = va.localeCompare(vb);
      return state.dir === 'asc' ? r : -r;
    }
    return state.dir === 'asc' ? va - vb : vb - va;
  }

  active.sort(compare);
  cut.sort(compare);

  // Re-append: active rows, then cut line, then cut rows
  tbody.innerHTML = '';
  active.forEach(r => tbody.appendChild(r));

  // Re-insert cut line divider
  if (cut.length > 0) {
    const currentRound = leaderboard.round || 0;
    const divider = document.createElement('tr');
    divider.className = 'cut-line-row';
    const label = currentRound >= 3 ? 'Missed Cut' : 'Projected Cut Line';
    const cutScore = leaderboard.cutLineScore || '';
    const scoreLabel = cutScore ? ` (${cutScore})` : '';
    divider.innerHTML = `<td colspan="11" class="cut-line-cell">✂ ${label}${scoreLabel}</td>`;
    tbody.appendChild(divider);
  }

  cut.forEach(r => tbody.appendChild(r));
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
  rankings.forEach((team, idx) => {
    poolRanks[team.name] = idx + 1;
  });

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
    priorData = buildPriorRoundTotals();
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
  let playerOddsAdj = '';
  if (player) {
    const pos   = player.missedCut ? 'MC' : player.projectedCut ? 'PC' : (player.position ? `T${player.position}` : '—');
    const score = fmtScore(player.score);
    const odds  = oddsMap[player.normalizedName] || 0;
    const prize = player.estimatedPrize || 0;
    const isCut = player.missedCut || player.projectedCut;
    const oddsAdj = isCut ? 0 : prize * odds;
    playerOddsAdj = odds ? fmtMM(oddsAdj) : '—';
    infoText    = `Position: ${pos}  |  Score: ${score}  |  Odds: ${odds ? odds + '-1' : '—'}  |  Odds Adj: ${playerOddsAdj}`;
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
                          : g.projectedCut              ? 'PC'
                          : g.position                  ? `T${g.position}` : '—';
          const earningsLabel = ` ${fmtMM(g.poolEarnings)}`;
          return `<span class="${chipClass}">${escHtml(g.pickName)}<span class="modal-chip-pos">${posLabel}${earningsLabel}</span></span>`;
        }).join('');
        return `<li><span class="modal-team-name"><span class="modal-team-rank">${rankDisp}</span>${escHtml(team.name)}</span><span class="modal-team-earnings">${fmt$(team.total)}</span><div class="modal-chips">${chips}</div></li>`;
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
    priorData = buildPriorRoundTotals();
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
