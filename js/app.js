'use strict';

// ─── Name normalization ───────────────────────────────────────────────────────
// NAME_ALIASES and AMATEURS are loaded from the database (Neon) or fallback to
// hardcoded defaults if the database is unavailable.
let NAME_ALIASES = {
  'matthew fitzpatrick': 'matt fitzpatrick',
  'mattew fitzpatrick':  'matt fitzpatrick',
  'jj spaun':            'jj spaun',
  'jt poston':           'jt poston',
  'maverick mcnealey':   'maverick mcnealy',
  'charl scwartzel':     'charl schwartzel',
  'billy horshel':       'billy horschel',
  'samuel stevens':      'sam stevens',
  'john keefer':         'johnny keefer',
  'nicolas echavarria':  'nico echavarria',
  'corey connors':       'corey conners',
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

// ─── Amateurs ────────────────────────────────────────────────────────────────
let AMATEURS = new Set([
  'ethan fang', 'jackson herrington', 'mason howell',
  'fifa laopakdee', 'mateo pulcini', 'brandon holtz',
]);
function amateurTag(name) {
  return AMATEURS.has(normalizeName(name)) ? ' (A)' : '';
}

// ─── Favorites ────────────────────────────────────────────────────────────────
const FAV_TEAMS_KEY   = 'ww_fav_teams';
const FAV_PLAYERS_KEY = 'ww_fav_players';

function loadFavorites(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); }
  catch(e) { return new Set(); }
}
function saveFavorites(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch(e) {}
}
function toggleFavorite(key, id) {
  const favs = loadFavorites(key);
  if (favs.has(id)) favs.delete(id); else favs.add(id);
  saveFavorites(key, favs);
  return favs.has(id);
}
function isFavorite(key, id) { return loadFavorites(key).has(id); }

function makeStar(key, id, onClick) {
  const span = document.createElement('span');
  span.className = 'fav-star' + (isFavorite(key, id) ? ' favorited' : '');
  span.textContent = isFavorite(key, id) ? '\u2605' : '\u2606';
  span.title = 'Click to favorite';
  span.addEventListener('click', e => {
    e.stopPropagation();
    const on = toggleFavorite(key, id);
    span.classList.toggle('favorited', on);
    span.textContent = on ? '\u2605' : '\u2606';
    if (onClick) onClick(on);
  });
  return span;
}

// ─── Data ─────────────────────────────────────────────────────────────────────
let picks = [], oddsMap = {}, leaderboard = {}, purseData = {}, priorData = null;

// ─── Live ESPN fetch (client-side) ───────────────────────────────────────────
function scoreToNum(s) {
  if (!s || s === 'E') return 0;
  return parseInt(String(s).replace('+', ''), 10);
}

function prizeForPosition(pos, purse, pctTable) {
  if (pos < 1 || !pctTable.length) return 0;
  const idx = Math.min(pos - 1, pctTable.length - 1);
  return Math.round(purse * pctTable[idx]);
}

function splitPrizeForTies(positions, purse, pctTable) {
  const total = positions.reduce((s, p) => s + prizeForPosition(p, purse, pctTable), 0);
  return positions.length ? Math.round(total / positions.length) : 0;
}

async function fetchLiveLeaderboard(purseData) {
  const eventId = purseData.eventId;
  const purse   = purseData.purse;
  const pct     = purseData.payoutPercentages;
  const url     = `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?event=${eventId}`;

  const data   = await fetch(url).then(r => r.json());
  const events = data.events || [];
  if (!events.length) throw new Error('No events from ESPN');

  const event       = events[0];
  const eventStatus = event.status?.type || {};
  const statusName  = eventStatus.name || '';
  const statusDisplay = eventStatus.description || 'In Progress';
  const isComplete  = eventStatus.completed || false;

  const comp        = (event.competitions || [])[0];
  if (!comp) throw new Error('No competition data');
  const competitors = comp.competitors || [];

  // Determine max round with actual data
  let maxRound = 0;
  for (const c of competitors) {
    for (const ls of (c.linescores || [])) {
      const p = ls.period || 0;
      if (p <= 4) {
        const hasHoles = !!(ls.linescores && ls.linescores.length);
        const hasReal  = ls.value != null && !(ls.value === 0 && ls.displayValue === '-');
        if (hasHoles || hasReal) maxRound = Math.max(maxRound, p);
      }
    }
  }

  // Sort by ESPN order
  competitors.sort((a, b) => (a.order || 999) - (b.order || 999));

  // Group by score for tie-splitting
  const scoreGroups = [];
  let currentPos = 1, i = 0;
  while (i < competitors.length) {
    const score = competitors[i].score || 'E';
    const group = [competitors[i]];
    let j = i + 1;
    while (j < competitors.length && (competitors[j].score || 'E') === score) {
      group.push(competitors[j]); j++;
    }
    scoreGroups.push({ startPos: currentPos, group });
    currentPos += group.length;
    i = j;
  }

  const posPrizeMap = {};
  for (const { startPos, group } of scoreGroups) {
    if (group.length === 1) {
      posPrizeMap[group[0].order || 999] = { pos: startPos, prize: prizeForPosition(startPos, purse, pct) };
    } else {
      const tied = Array.from({ length: group.length }, (_, k) => startPos + k);
      const avg  = splitPrizeForTies(tied, purse, pct);
      for (const c of group) posPrizeMap[c.order || 999] = { pos: startPos, prize: avg };
    }
  }

  // Build players
  const players = [];
  for (const c of competitors) {
    const fullName = c.athlete?.fullName || 'Unknown';
    const pos      = c.order || 999;
    const score    = c.score || 'E';
    const linescores = c.linescores || [];

    const rounds = linescores.filter(ls =>
      (ls.period || 0) <= 4 && ls.value != null && !(ls.value === 0 && ls.displayValue === '-')
    );
    const roundsCompleted = rounds.length;

    const roundScores = {};
    for (const ls of rounds) {
      if (ls.period >= 1 && ls.period <= 4) roundScores[`R${ls.period}`] = ls.displayValue || '';
    }

    // Calculate R1+R2 score for cut determination
    let r2Total = 0;
    for (const ls of linescores) {
      if (ls.period === 1 || ls.period === 2) {
        const dv = ls.displayValue;
        if (dv && dv !== '-') r2Total += scoreToNum(dv);
      }
    }

    let thru = null;
    for (const ls of linescores) {
      if (ls.period === maxRound) {
        const holes = (ls.linescores || []).filter(h => h.value != null).length;
        thru = holes < 18 ? holes : 'F';
        break;
      }
    }

    const { pos: tiedPos, prize } = posPrizeMap[pos] || { pos, prize: 0 };

    players.push({
      name: fullName,
      normalizedName: normalizeName(fullName),
      position: tiedPos,
      score,
      roundScores,
      roundsCompleted,
      r2Total,
      thru,
      missedCut: false,
      projectedCut: false,
      estimatedPrize: prize,
    });
  }

  // Determine cut line
  let cutLineScore = null;
  if (maxRound <= 2) {
    // During rounds 1-2: projected cut based on current scores (top 50 + ties)
    const byScore = [...players].sort((a, b) => scoreToNum(a.score) - scoreToNum(b.score));
    if (byScore.length >= 50) {
      const cutScore = byScore[49].score;
      cutLineScore = cutScore;
      const cutNum = scoreToNum(cutScore);
      for (const p of players) {
        if (scoreToNum(p.score) > cutNum) {
          p.projectedCut = true;
          p.estimatedPrize = 0;
        }
      }
    }
  } else {
    // Round 3+: actual cut based on R1+R2 totals (Masters top 50 + ties)
    const r2Scores = players.map(p => p.r2Total).sort((a, b) => a - b);
    const cutNum = r2Scores.length >= 50 ? r2Scores[49] : Infinity;
    cutLineScore = cutNum > 0 ? `+${cutNum}` : cutNum === 0 ? 'E' : String(cutNum);
    for (const p of players) {
      if (p.r2Total > cutNum) {
        p.missedCut = true;
        p.estimatedPrize = 0;
      }
    }
  }

  // Sort: active by position, then cut by score
  const active = players.filter(p => !p.missedCut && !p.projectedCut).sort((a, b) => a.position - b.position);
  const cut    = players.filter(p => p.missedCut || p.projectedCut).sort((a, b) => scoreToNum(a.score) - scoreToNum(b.score));

  return {
    tournament: purseData.tournament,
    eventId,
    purse,
    status: statusName,
    statusDisplay,
    isComplete,
    round: maxRound,
    cutLineScore,
    lastUpdated: new Date().toISOString(),
    players: [...active, ...cut],
  };
}

async function loadAll() {
  const ts = Date.now();

  // ── Try Neon database first, fall back to static JSON files ──
  let dataSource = 'static';
  try {
    if (typeof loadFromNeon === 'function') {
      const neonData = await loadFromNeon();
      picks     = neonData.picks;
      oddsMap   = neonData.oddsMap;
      purseData = neonData.purseData;
      // Update aliases and amateurs from DB
      NAME_ALIASES = neonData.aliases;
      AMATEURS     = neonData.amateurs;
      dataSource = 'neon';
      console.log(`Loaded pool data from Neon (${picks.length} entries, ${Object.keys(oddsMap).length} golfers)`);
    } else {
      throw new Error('Neon client not loaded');
    }
  } catch (e) {
    console.warn('Neon fetch failed, falling back to static files:', e);
    const [p, o, pu] = await Promise.all([
      fetch(`data/picks.json?t=${ts}`).then(r => r.json()),
      fetch(`data/odds.json?t=${ts}`).then(r => r.json()),
      fetch(`data/purse.json?t=${ts}`).then(r => r.json()),
    ]);
    picks     = p;
    oddsMap   = buildNormalizedOdds(o);
    purseData = pu;
  }

  // ── Live ESPN leaderboard (independent of data source) ──
  try {
    leaderboard = await fetchLiveLeaderboard(purseData);
    console.log('Loaded live leaderboard from ESPN');
  } catch (e) {
    console.warn('ESPN fetch failed, falling back to static file:', e);
    leaderboard = await fetch(`data/leaderboard.json?t=${ts}`).then(r => r.json());
  }
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

    const currentRd = leaderboard.round || 0;
    const todayScore = player && player.roundScores ? player.roundScores[`R${currentRd}`] : null;
    const thru = player ? player.thru : null;

    return {
      pickName,
      espnName:    player ? player.name : null,
      position:    player ? player.position : null,
      score:       player ? player.score : null,
      roundScores: player ? player.roundScores : {},
      todayScore,
      thru,
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

  // Rank teams by prior-round totals
  const teamRanks = {};
  const sorted = Object.entries(teamTotals).sort((a, b) => b[1] - a[1]);
  sorted.forEach(([name], idx) => { teamRanks[name] = idx + 1; });

  return { teamTotals, teamRanks, playerPriorAdj };
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
    let cls = 'round-score';
    if (!v)           cls += ' round-empty';
    else if (isToday) cls += v.startsWith('-') ? ' round-today-under' : (v === 'E' ? ' round-today-even' : ' round-today-over');
    else if (!v.startsWith('-') && v !== 'E') cls += ' round-over';
    else if (v === 'E') cls += ' round-even';
    return `<span class="${cls}">${v || '—'}</span>`;
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

  const priorTotals = priorData ? priorData.teamTotals : null;
  const priorRanks  = priorData ? priorData.teamRanks : null;
  const favTeams    = loadFavorites(FAV_TEAMS_KEY);

  // Split into favorites and non-favorites
  const favList  = rankings.filter(t => favTeams.has(t.name));
  const restList = rankings.filter(t => !favTeams.has(t.name));

  let teamRowUid = 0;
  function addTeamRow(team, idx) {
    const uid = teamRowUid++;
    const rank     = idx + 1;
    const isTied   = idx > 0 && rankings[idx - 1].total === team.total;
    const rankDisp = isTied ? 'T' + rank : rank;
    const rankClass = rank <= 5 ? `rank-${rank}` : '';
    const isFav    = favTeams.has(team.name);
    let todayHtml = '';
    if (priorTotals && priorTotals[team.name] != null) {
      const delta = team.total - priorTotals[team.name];
      if (delta > 0)      todayHtml = `<span class="today-delta delta-up">+${fmtMM(delta)}</span>`;
      else if (delta < 0) todayHtml = `<span class="today-delta delta-down">-${fmtMM(Math.abs(delta))}</span>`;
      else                todayHtml = `<span class="today-delta delta-even">—</span>`;
    }

    const tr = document.createElement('tr');
    tr.className = `team-row ${rankClass}${isFav ? ' fav-highlight' : ''}`;
    tr.setAttribute('data-team', idx);
    tr.innerHTML = `
      <td class="rank">${rankDisp}</td>
      <td class="team-name"><span class="fav-star-slot"></span> ${escHtml(team.name)}</td>
      <td class="earnings">${fmt$(team.total)}${todayHtml}</td>
      <td class="expand-icon">▶</td>
    `;
    // Insert star
    const starSlot = tr.querySelector('.fav-star-slot');
    const star = makeStar(FAV_TEAMS_KEY, team.name, () => {
      renderLeaderboard(sortRankings(allRankings, sortState.pool));
      applySearch(document.getElementById('search').value);
    });
    starSlot.replaceWith(star);
    tr.addEventListener('click', () => toggleDetail(uid));
    tbody.appendChild(tr);

    const detailTr = document.createElement('tr');
    detailTr.className = 'detail-row hidden';
    detailTr.id = `detail-${uid}`;
    detailTr.innerHTML = `<td colspan="4">${renderGolfers(team.golfers)}${renderInsights(team, idx, uid)}</td>`;
    tbody.appendChild(detailTr);
  }

  // Render favorites section
  if (favList.length > 0) {
    const hdr = document.createElement('tr');
    hdr.className = 'fav-section-header';
    hdr.innerHTML = '<td colspan="4">\u2605 Favorites</td>';
    tbody.appendChild(hdr);
    favList.forEach(team => {
      const idx = rankings.indexOf(team);
      addTeamRow(team, idx);
    });
    const allHdr = document.createElement('tr');
    allHdr.className = 'fav-section-header all-section';
    allHdr.innerHTML = '<td colspan="4">All Teams</td>';
    tbody.appendChild(allHdr);
  }

  // Render all teams
  rankings.forEach((team, idx) => addTeamRow(team, idx));

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

    const isCut = g.status === 'cut' || g.status === 'not-in-field';
    const todayDisp = g.todayScore || (g.missedCut ? 'MC' : g.projectedCut ? '--' : '—');
    const thruDisp = g.missedCut ? '—' : (g.thru != null ? g.thru : '—');

    return `
      <tr class="golfer-row ${g.status}">
        <td><span class="player-link" data-name="${escHtml(g.pickName)}">${escHtml(g.pickName)}${amateurTag(g.pickName)}</span></td>
        <td class="pos">${g.status === 'not-in-field' ? 'NIF' : (g.missedCut || g.projectedCut ? 'MC' : posDisp)}</td>
        <td class="score ${scoreClass(g.score)}">${g.status === 'not-in-field' ? '—' : fmtScore(g.score)}</td>
        <td class="score ${scoreClass(g.todayScore)}">${todayDisp}</td>
        <td>${thruDisp}</td>
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
          <th>Golfer</th><th>Pos</th><th>Score</th><th>Today</th><th>Thru</th>
          <th>Odds</th><th>Est. Earnings</th><th>Odds Adj</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ── Insight simulation engine ────────────────────────────────────────────────
// Simulate a golfer moving to a new position: recalculate all 192 team totals,
// re-rank, and return the new rankings array.
function simulateMove(golferName, newPos) {
  const purse = purseData.purse;
  const pct   = purseData.payoutPercentages;
  // Resolve aliases so pick names match leaderboard names
  const gn    = NAME_ALIASES[normalizeName(golferName)] || normalizeName(golferName);

  // Find current prize for this golfer from leaderboard
  const lbPlayer = (leaderboard.players || []).find(p => p.normalizedName === gn);
  if (!lbPlayer) return null;
  const currentPrize = lbPlayer.estimatedPrize || 0;
  const newPrize     = prizeForPosition(newPos, purse, pct);
  const prizeDelta   = newPrize - currentPrize;

  // Recalculate totals for all teams that have this golfer
  const newTotals = allRankings.map(team => {
    let delta = 0;
    for (const g of team.golfers) {
      if (g.status !== 'active' || !g.odds) continue;
      const key = NAME_ALIASES[normalizeName(g.pickName)] || normalizeName(g.pickName);
      if (key === gn) {
        delta = prizeDelta * g.odds;
        break;
      }
    }
    return { name: team.name, total: team.total + delta };
  });

  // Sort descending by total
  newTotals.sort((a, b) => b.total - a.total);
  return newTotals;
}

// Find the smallest move for a golfer where myTeam ends up ahead of rivalTeam.
// direction: 'up' = positions current-1..1, 'drop' = positions current+1..current+20
function findSmallestSimMove(golfer, myTeamName, rivalTeamName, direction) {
  if (!golfer.position || !golfer.odds || golfer.status !== 'active') return null;
  if (direction === 'up' && golfer.position <= 1) return null;

  const start = direction === 'up' ? golfer.position - 1 : golfer.position + 1;
  const end   = direction === 'up' ? 1 : Math.min(54, golfer.position + 20);
  const step  = direction === 'up' ? -1 : 1;

  for (let pos = start; (direction === 'up' ? pos >= end : pos <= end); pos += step) {
    const simRanks = simulateMove(golfer.pickName, pos);
    if (!simRanks) return null;
    const myNewRank    = simRanks.findIndex(t => t.name === myTeamName) + 1;
    const rivalNewRank = simRanks.findIndex(t => t.name === rivalTeamName) + 1;
    // My team must end up strictly ahead of the rival team
    if (myNewRank > 0 && rivalNewRank > 0 && myNewRank < rivalNewRank) {
      const spots = Math.abs(golfer.position - pos);
      return { golfer, newPos: pos, spots, newRank: myNewRank };
    }
  }
  return null;
}

function buildInsightText(team, idx) {
  const rankings = allRankings;
  if (idx === 0) {
    return `<span class="insight-icon">🏆</span><span class="insight-text">You're in 1st place!</span>`;
  }

  // ── ROOT FOR: which of your golfers moving up helps you most ──
  const myActive = team.golfers.filter(g => g.status === 'active' && g.odds && g.position > 1);
  const rootFor = [];
  for (const g of myActive) {
    // Simulate this golfer moving to T1 and see how much rank improves
    const simRanks = simulateMove(g.pickName, 1);
    if (!simRanks) continue;
    const newRank = simRanks.findIndex(t => t.name === team.name) + 1;
    const improvement = (idx + 1) - newRank;
    if (improvement > 0) {
      rootFor.push({ golfer: g, improvement, bestRank: newRank });
    }
  }
  // Sort by most improvement
  rootFor.sort((a, b) => b.improvement - a.improvement);

  // ── ROOT AGAINST: golfers on teams ahead that, if they drop, help you ──
  // Look at teams in the ~5 spots above and find their key golfers
  const teamsAbove = rankings.slice(Math.max(0, idx - 5), idx);
  const rivalGolferMap = new Map(); // golferName -> { golfer, teamsHelped }
  for (const rival of teamsAbove) {
    const rivalActive = rival.golfers.filter(g => g.status === 'active' && g.odds && g.position);
    for (const g of rivalActive) {
      // Skip golfers that are also on my team (shared golfers)
      const gn = NAME_ALIASES[normalizeName(g.pickName)] || normalizeName(g.pickName);
      const isOnMyTeam = team.golfers.some(mg => {
        const mgn = NAME_ALIASES[normalizeName(mg.pickName)] || normalizeName(mg.pickName);
        return mgn === gn;
      });
      if (isOnMyTeam) continue;

      const key = gn;
      if (!rivalGolferMap.has(key)) {
        rivalGolferMap.set(key, { golfer: g, teams: [] });
      }
      rivalGolferMap.get(key).teams.push(rival.name);
    }
  }

  // Simulate each rival golfer dropping 5 spots and see impact
  const rootAgainst = [];
  for (const [key, info] of rivalGolferMap) {
    const g = info.golfer;
    const dropPos = Math.min(54, g.position + 5);
    const simRanks = simulateMove(g.pickName, dropPos);
    if (!simRanks) continue;
    const newRank = simRanks.findIndex(t => t.name === team.name) + 1;
    const improvement = (idx + 1) - newRank;
    if (improvement > 0) {
      rootAgainst.push({ golfer: g, improvement, teamsAffected: info.teams.length });
    }
  }
  rootAgainst.sort((a, b) => b.improvement - a.improvement);

  // ── Build output ──
  let html = '<div class="insight-header">Paths to climb the leaderboard</div>';

  if (rootFor.length) {
    const names = rootFor.slice(0, 3).map(r =>
      `<strong>${escHtml(r.golfer.pickName)}</strong>`
    );
    html += `<div class="insight-line"><span class="insight-text"><strong>Your team:</strong> ${joinNames(names)} moving up the leaderboard ${rootFor.length === 1 ? 'is your' : 'are your'} best path to climb.</span></div>`;
  }

  if (rootAgainst.length) {
    const names = rootAgainst.slice(0, 3).map(r =>
      `<strong>${escHtml(r.golfer.pickName)}</strong>`
    );
    html += `<div class="insight-line"><span class="insight-text"><strong>Other teams:</strong> ${joinNames(names)} falling back would move teams above you down.</span></div>`;
  }

  if (!rootFor.length && !rootAgainst.length) {
    html += `<div class="insight-line"><span class="insight-text">No clear path to move up right now.</span></div>`;
  }

  return html;
}

function joinNames(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return names[0] + ' and ' + names[1];
  return names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
}

function renderInsights(team, idx, uid) {
  const rankings = allRankings;
  if (!rankings.length) return '';

  const activeGolfers = team.golfers.filter(g => g.status === 'active' && g.odds);
  if (!activeGolfers.length) {
    return `<div class="team-insights"><div class="insight-section"><span class="insight-icon">📋</span><span class="insight-text">All golfers have missed the cut or are not in the field.</span></div></div>`;
  }

  let html = '<div class="team-insights">';

  if (idx > 0) {
    html += `<div class="insight-section insight-path-up">${buildInsightText(team, idx)}</div>`;
  }

  html += '</div>';
  return html;
}

function toggleDetail(uid) {
  const detailRow = document.getElementById(`detail-${uid}`);
  const teamRow   = detailRow.previousElementSibling;
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
  const favTeams = loadFavorites(FAV_TEAMS_KEY);

  function addPicksRow(team) {
    const isFav = favTeams.has(team.name);
    const sortedGolfers = [...team.golfers].sort((a, b) => {
      const lastA = (a.pickName || '').split(' ').slice(-1)[0].toLowerCase();
      const lastB = (b.pickName || '').split(' ').slice(-1)[0].toLowerCase();
      return lastA.localeCompare(lastB);
    });
    const chips = sortedGolfers.map(g => {
      const chipClass = g.status === 'cut'          ? 'chip-cut'
                      : g.status === 'not-in-field' ? 'chip-nif'
                      : 'chip-active';
      const posLabel = g.status === 'not-in-field' ? 'NIF'
                     : g.missedCut                 ? 'MC'
                     : g.projectedCut              ? 'PC'
                     : g.position                  ? `T${g.position}` : '—';
      return `<span class="pick-chip ${chipClass}" data-name="${escHtml(g.pickName)}">
        ${escHtml(g.pickName)}${amateurTag(g.pickName)}
        <span class="chip-pos">${posLabel}</span>
      </span>`;
    }).join('');

    const tr = document.createElement('tr');
    tr.className = 'picks-row' + (isFav ? ' fav-highlight' : '');
    tr.setAttribute('data-team-name', team.name.toLowerCase());
    tr.innerHTML = `
      <td class="team-name"><span class="fav-star-slot"></span> ${escHtml(team.name)}</td>
      <td class="earnings">${fmt$(team.total)}</td>
      <td><div class="picks-chips">${chips}</div></td>
    `;
    const starSlot = tr.querySelector('.fav-star-slot');
    const star = makeStar(FAV_TEAMS_KEY, team.name, () => {
      renderPicksTab(sortRankings(allRankings, sortState.picks));
      applySearch(document.getElementById('search').value);
    });
    starSlot.replaceWith(star);
    tbody.appendChild(tr);
  }

  const favList  = rankings.filter(t => favTeams.has(t.name));
  const restList = rankings.filter(t => !favTeams.has(t.name));

  if (favList.length > 0) {
    const hdr = document.createElement('tr');
    hdr.className = 'fav-section-header';
    hdr.innerHTML = '<td colspan="3">\u2605 Favorites</td>';
    tbody.appendChild(hdr);
    favList.forEach(addPicksRow);
    const allHdr = document.createElement('tr');
    allHdr.className = 'fav-section-header all-section';
    allHdr.innerHTML = '<td colspan="3">All Teams</td>';
    tbody.appendChild(allHdr);
  }
  rankings.forEach(addPicksRow);
}

// ─── Render: Tournament Leaderboard (Tab 3) ──────────────────────────────────
function renderTournamentTab() {
  const tbody        = document.getElementById('tournament-tbody');
  const currentRound = leaderboard.round || 0;
  tbody.innerHTML    = '';

  const sameRoundTourn = prevSnapshot.round === currentRound;
  const players = [...(leaderboard.players || [])];
  const totalCols = 12;
  const favPlayers = loadFavorites(FAV_PLAYERS_KEY);

  // Build favorites section first
  const favPlayerList = players.filter(p => favPlayers.has(p.name));
  const hasFavPlayers = favPlayerList.length > 0;

  function buildTournRow(p) {
    const mc         = p.missedCut;
    const pc         = p.projectedCut;
    const isCut      = mc || pc;
    const todayScore = p.roundScores ? p.roundScores[`R${currentRound}`] : null;
    const posDisp    = mc ? 'MC' : pc ? 'PC' : (p.position ? p.position : '—');

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
    const thru = p.thru != null ? p.thru : '—';
    const thruNum = thru === 'F' ? 18 : (typeof thru === 'number' ? thru : -1);
    tr.setAttribute('data-today', todayNum);
    tr.setAttribute('data-thru', thruNum);
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

    const isFavP = favPlayers.has(p.name);
    if (isFavP) tr.classList.add('fav-highlight');

    tr.innerHTML = `
      <td class="pos-col">${escHtml(String(posDisp))}</td>
      <td class="player-cell"><span class="fav-star-slot"></span> <span class="player-link" data-name="${escHtml(p.name || '')}">${escHtml(p.name || '')}${amateurTag(p.name || '')}</span></td>
      <td class="score-col ${scoreClass(p.score)}">${fmtScore(p.score)}</td>
      <td class="score-col today-col ${scoreClass(todayScore)}">${todayScore || (mc ? 'MC' : pc ? '--' : '—')}</td>
      <td class="score-col">${mc ? '—' : thru}</td>
      ${roundCells}
      <td class="prize-col">${isCut ? '—' : fmt$(p.estimatedPrize)}</td>
      <td class="odds-col" style="text-align:center">${odds ? odds + '-1' : '—'}</td>
      <td class="prize-col">${isCut ? '—' : (odds ? fmt$(oddsAdj) + tournDelta : '—')}</td>
    `;
    // Insert star
    const starSlot = tr.querySelector('.fav-star-slot');
    const star = makeStar(FAV_PLAYERS_KEY, p.name, () => renderTournamentTab());
    starSlot.replaceWith(star);
    return tr;
  }

  // Render favorites section
  if (hasFavPlayers) {
    const favHdr = document.createElement('tr');
    favHdr.className = 'fav-section-header';
    favHdr.innerHTML = `<td colspan="${totalCols}">\u2605 Favorites</td>`;
    tbody.appendChild(favHdr);
    favPlayerList.forEach(p => tbody.appendChild(buildTournRow(p)));
    const allHdr = document.createElement('tr');
    allHdr.className = 'fav-section-header all-section';
    allHdr.innerHTML = `<td colspan="${totalCols}">All Players</td>`;
    tbody.appendChild(allHdr);
  }

  // Render all players with cut line
  let cutLineInserted = false;
  players.forEach(p => {
    const isCut = p.missedCut || p.projectedCut;
    if (isCut && !cutLineInserted) {
      cutLineInserted = true;
      const divider = document.createElement('tr');
      divider.className = 'cut-line-row';
      const label = currentRound >= 3 ? 'Missed Cut' : 'Projected Cut Line';
      const cutScore = leaderboard.cutLineScore || '';
      const scoreLabel = cutScore ? ` (${cutScore})` : '';
      divider.innerHTML = `<td colspan="${totalCols}" class="cut-line-cell">\u2702 ${label}${scoreLabel}</td>`;
      tbody.appendChild(divider);
    }
    tbody.appendChild(buildTournRow(p));
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

  // Search bar: visible on leaderboard + teams, hidden on tournament + instructions
  const search = document.getElementById('search');
  const hideSearch = tabName === 'tournament' || tabName === 'instructions';
  search.style.display = hideSearch ? 'none' : '';
  if (hideSearch) search.value = '';

  // Re-apply any active search
  if (!hideSearch) applySearch(search.value);
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

  function getVal(row) {
    const col = state.col;
    if (col === 'name')   return row.dataset.name;
    if (col === 'score')  return parseFloat(row.dataset.score);
    if (col === 'prize')  return parseFloat(row.dataset.prize);
    if (col === 'oddsAdj') return parseFloat(row.dataset.oddsAdj);
    if (col === 'odds')   return parseFloat(row.dataset.odds);
    if (col === 'today')  return parseFloat(row.dataset.today);
    if (col === 'thru')   return parseFloat(row.dataset.thru);
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

  // Collect all children and split into fav section, "All Players" header, and main section
  const allChildren = Array.from(tbody.children);
  const favHeader = allChildren.find(r => r.classList.contains('fav-section-header') && !r.classList.contains('all-section'));
  const allHeader = allChildren.find(r => r.classList.contains('fav-section-header') && r.classList.contains('all-section'));

  let favRows = [];
  let mainRows = [];

  if (favHeader && allHeader) {
    // Rows between favHeader and allHeader are favorites
    let inFav = false;
    let pastAll = false;
    for (const child of allChildren) {
      if (child === favHeader) { inFav = true; continue; }
      if (child === allHeader) { inFav = false; pastAll = true; continue; }
      if (child.classList.contains('tourn-row')) {
        if (inFav) favRows.push(child);
        else if (pastAll) mainRows.push(child);
      }
      // skip cut-line-row, will be re-inserted
    }
  } else {
    // No favorites section — all rows are main
    mainRows = allChildren.filter(r => r.classList.contains('tourn-row'));
  }

  // Sort favorites
  favRows.sort(compare);

  // Split main into active and cut, sort each group
  const mainActive = mainRows.filter(r => r.dataset.cut === '0');
  const mainCut    = mainRows.filter(r => r.dataset.cut === '1');
  mainActive.sort(compare);
  mainCut.sort(compare);

  // Rebuild tbody
  tbody.innerHTML = '';

  if (favHeader && allHeader) {
    tbody.appendChild(favHeader);
    favRows.forEach(r => tbody.appendChild(r));
    tbody.appendChild(allHeader);
  }

  mainActive.forEach(r => tbody.appendChild(r));

  // Re-insert cut line divider
  if (mainCut.length > 0) {
    const currentRound = leaderboard.round || 0;
    const divider = document.createElement('tr');
    divider.className = 'cut-line-row';
    const label = currentRound >= 3 ? 'Missed Cut' : 'Projected Cut Line';
    const cutScore = leaderboard.cutLineScore || '';
    const scoreLabel = cutScore ? ` (${cutScore})` : '';
    divider.innerHTML = `<td colspan="12" class="cut-line-cell">✂ ${label}${scoreLabel}</td>`;
    tbody.appendChild(divider);
  }

  mainCut.forEach(r => tbody.appendChild(r));
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
      row.style.display = show ? '' : 'none';
      const detail = row.nextElementSibling;
      if (detail && detail.classList.contains('detail-row')) detail.style.display = show ? '' : 'none';
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

function applyPlayerSearch(query) {
  const q = query.toLowerCase().trim();
  document.querySelectorAll('#tournament-table tbody .tourn-row').forEach(row => {
    const name = (row.dataset.name || '').toLowerCase();
    row.style.display = (!q || name.includes(q)) ? '' : 'none';
  });
  // Also show/hide section headers and cut line
  document.querySelectorAll('#tournament-table tbody .fav-section-header, #tournament-table tbody .cut-line-row').forEach(row => {
    row.style.display = q ? 'none' : '';
  });
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
    // Capture state before refresh for notifications
    preRefreshState = capturePreRefreshState();

    try {
      leaderboard = await fetchLiveLeaderboard(purseData);
    } catch (e) {
      const ts = Date.now();
      leaderboard = await fetch(`data/leaderboard.json?t=${ts}`).then(r => r.json());
    }
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

    // Fire notifications for favorite changes
    checkAndNotify(preRefreshState);
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
          return `<span class="${chipClass} modal-chip-link" data-name="${escHtml(g.pickName)}">${escHtml(g.pickName)}${amateurTag(g.pickName)}<span class="modal-chip-pos">${posLabel}${earningsLabel}</span></span>`;
        }).join('');
        return `<li><span class="modal-team-name"><span class="modal-team-rank">${rankDisp}</span>${escHtml(team.name)}</span><span class="modal-team-earnings">${fmt$(team.total)}</span><div class="modal-chips">${chips}</div></li>`;
      }).join('')
    : '<li class="modal-no-teams">Not picked by any team</li>';

  document.getElementById('player-modal-name').textContent  = playerName + amateurTag(playerName);
  document.getElementById('player-modal-info').textContent  = infoText;
  document.getElementById('player-modal-teams').innerHTML   = teamsHtml;
  document.getElementById('player-modal').classList.add('open');
}

function closePlayerModal() {
  document.getElementById('player-modal').classList.remove('open');
}

// ─── Notifications ───────────────────────────────────────────────────────────
const NOTIFY_KEY = 'ww_notify_enabled';
let notifyEnabled = localStorage.getItem(NOTIFY_KEY) === 'true';
let preRefreshState = null; // captured before each refresh

function capturePreRefreshState() {
  const favTeams   = loadFavorites(FAV_TEAMS_KEY);
  const favPlayers = loadFavorites(FAV_PLAYERS_KEY);
  if (!favTeams.size && !favPlayers.size) return null;

  const teamState = {};
  allRankings.forEach((team, idx) => {
    if (favTeams.has(team.name)) {
      teamState[team.name] = { rank: idx + 1, total: team.total };
    }
  });

  const playerState = {};
  (leaderboard.players || []).forEach(p => {
    if (favPlayers.has(p.name)) {
      playerState[p.name] = {
        position: p.position,
        score: p.score,
        missedCut: p.missedCut,
        projectedCut: p.projectedCut,
      };
    }
  });

  return { teamState, playerState };
}

function checkAndNotify(oldState) {
  if (!notifyEnabled || !oldState || Notification.permission !== 'granted') return;

  const favTeams   = loadFavorites(FAV_TEAMS_KEY);
  const favPlayers = loadFavorites(FAV_PLAYERS_KEY);
  const alerts = [];

  // Check favorite teams for rank changes
  allRankings.forEach((team, idx) => {
    if (!favTeams.has(team.name)) return;
    const prev = oldState.teamState[team.name];
    if (!prev) return;
    const newRank = idx + 1;
    const rankDiff = prev.rank - newRank;
    const earningsDiff = team.total - prev.total;

    if (rankDiff !== 0 || Math.abs(earningsDiff) > 1000) {
      let msg = `${team.name}: `;
      if (rankDiff > 0)       msg += `⬆️ moved up to #${newRank} (was #${prev.rank})`;
      else if (rankDiff < 0)  msg += `⬇️ dropped to #${newRank} (was #${prev.rank})`;
      else                    msg += `holds at #${newRank}`;

      if (Math.abs(earningsDiff) > 1000) {
        const sign = earningsDiff > 0 ? '+' : '-';
        msg += ` | ${sign}${fmt$(Math.abs(earningsDiff))}`;
      }
      alerts.push(msg);
    }
  });

  // Check favorite players for position changes
  (leaderboard.players || []).forEach(p => {
    if (!favPlayers.has(p.name)) return;
    const prev = oldState.playerState[p.name];
    if (!prev) return;

    // Newly missed cut
    if ((p.missedCut || p.projectedCut) && !prev.missedCut && !prev.projectedCut) {
      alerts.push(`${p.name}: ✂️ missed the cut`);
      return;
    }

    if (p.position && prev.position && p.position !== prev.position) {
      const diff = prev.position - p.position;
      if (diff > 0)       alerts.push(`${p.name}: ⬆️ moved to ${posLabel(p.position)} (was ${posLabel(prev.position)})`);
      else if (diff < 0)  alerts.push(`${p.name}: ⬇️ dropped to ${posLabel(p.position)} (was ${posLabel(prev.position)})`);
    }
  });

  if (alerts.length === 0) return;

  // Group into a single notification (max 4 lines, truncate if more)
  const shown = alerts.slice(0, 4);
  if (alerts.length > 4) shown.push(`...and ${alerts.length - 4} more updates`);
  const body = shown.join('\n');

  try {
    new Notification('🏌️ Woodway Pool Update', {
      body,
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">⛳</text></svg>',
      tag: 'woodway-update', // replaces previous notification
      silent: false,
    });
  } catch(e) {
    console.warn('Notification failed:', e);
  }
}

function posLabel(pos) {
  return pos ? `T${pos}` : '—';
}

function toggleNotifications() {
  const btn = document.getElementById('notify-btn');
  if (!notifyEnabled) {
    // Turning on — request permission first
    if (!('Notification' in window)) {
      showToast('Notifications not supported in this browser');
      return;
    }
    if (Notification.permission === 'granted') {
      notifyEnabled = true;
      localStorage.setItem(NOTIFY_KEY, 'true');
      btn.classList.add('active');
      btn.textContent = '🔔 Alerts On';
      showToast('Alerts enabled for your favorites');
    } else if (Notification.permission === 'denied') {
      showToast('Notifications blocked — check browser settings');
    } else {
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') {
          notifyEnabled = true;
          localStorage.setItem(NOTIFY_KEY, 'true');
          btn.classList.add('active');
          btn.textContent = '🔔 Alerts On';
          showToast('Alerts enabled for your favorites');
        } else {
          showToast('Notification permission denied');
        }
      });
    }
  } else {
    // Turning off
    notifyEnabled = false;
    localStorage.setItem(NOTIFY_KEY, 'false');
    btn.classList.remove('active');
    btn.textContent = '🔔 Alerts';
    showToast('Alerts disabled');
  }
}

function initNotifyButton() {
  const btn = document.getElementById('notify-btn');
  // Restore saved state
  if (notifyEnabled && Notification.permission === 'granted') {
    btn.classList.add('active');
    btn.textContent = '🔔 Alerts On';
  }
  btn.addEventListener('click', toggleNotifications);
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
    document.getElementById('player-search').addEventListener('input', e => applyPlayerSearch(e.target.value));

    // Refresh button
    document.getElementById('refresh-btn').addEventListener('click', refresh);

    // Sort listeners
    attachSortListeners();

    // Notifications
    initNotifyButton();

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
      if (chip && chip.dataset.name) { showPlayerModal(chip.dataset.name); return; }
      const modalChip = e.target.closest('.modal-chip-link');
      if (modalChip && modalChip.dataset.name) showPlayerModal(modalChip.dataset.name);
    });

  } catch (e) {
    console.error('Init failed:', e);
    document.getElementById('loading').textContent = 'Error loading data. Please refresh.';
  }
}

document.addEventListener('DOMContentLoaded', init);
