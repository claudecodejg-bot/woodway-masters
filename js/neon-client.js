'use strict';

// ─── Neon Serverless Client (loaded via ESM CDN) ────────────────────────────
// Uses @neondatabase/serverless tagged template queries over HTTP.

const NEON_CONN_STR = 'postgresql://neondb_owner:npg_nNlq2XKic5GV@ep-round-mouse-anx5ehzz.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require';

let _sql = null;

async function getNeonSQL() {
  if (_sql) return _sql;
  const { neon } = await import('https://esm.sh/@neondatabase/serverless@1');
  _sql = neon(NEON_CONN_STR);
  return _sql;
}

// ─── Data loaders that return the same shapes app.js expects ────────────────

async function loadFromNeon() {
  const sql = await getNeonSQL();

  // Fetch all data in parallel
  const [tournamentRows, golferRows, entryRows, aliasRows] = await Promise.all([
    sql`SELECT * FROM tournaments WHERE is_active = TRUE LIMIT 1`,
    sql`
      SELECT tg.golfer_name, tg.normalized_name, tg.odds_multiplier, tg.is_amateur
      FROM tournament_golfers tg
      JOIN tournaments t ON t.id = tg.tournament_id
      WHERE t.is_active = TRUE
    `,
    sql`
      SELECT e.team_name, tg.golfer_name
      FROM entries e
      JOIN entry_picks ep ON ep.entry_id = e.id
      JOIN tournament_golfers tg ON tg.id = ep.golfer_id
      JOIN tournaments t ON t.id = e.tournament_id
      WHERE t.is_active = TRUE
      ORDER BY e.id, ep.pick_order
    `,
    sql`
      SELECT na.alias_name, na.canonical_name
      FROM name_aliases na
      JOIN tournaments t ON t.id = na.tournament_id
      WHERE t.is_active = TRUE
    `,
  ]);

  if (!tournamentRows.length) throw new Error('No active tournament found in database');
  const t = tournamentRows[0];

  // ── Build purseData (same shape as purse.json) ──
  const purseData = {
    tournament: t.name,
    eventId: t.espn_event_id,
    purse: Number(t.purse),
    payoutPercentages: typeof t.payout_pcts === 'string'
      ? JSON.parse(t.payout_pcts)
      : t.payout_pcts,
  };

  // ── Build oddsMap (normalized_name -> multiplier) ──
  const oddsMap = {};
  for (const g of golferRows) {
    oddsMap[g.normalized_name] = Number(g.odds_multiplier);
  }

  // ── Build amateurs Set (normalized names) ──
  const amateurs = new Set();
  for (const g of golferRows) {
    if (g.is_amateur === true || g.is_amateur === 't') {
      amateurs.add(g.normalized_name);
    }
  }

  // ── Build picks array (same shape as picks.json) ──
  const picksMap = new Map(); // team_name -> [player1, player2, ...]
  for (const row of entryRows) {
    if (!picksMap.has(row.team_name)) {
      picksMap.set(row.team_name, []);
    }
    picksMap.get(row.team_name).push(row.golfer_name);
  }
  const picks = [];
  for (const [name, players] of picksMap) {
    picks.push({ name, players });
  }

  // ── Build aliases map (alias -> canonical) ──
  const aliases = {};
  for (const row of aliasRows) {
    aliases[row.alias_name] = row.canonical_name;
  }

  return { picks, oddsMap, purseData, amateurs, aliases };
}
