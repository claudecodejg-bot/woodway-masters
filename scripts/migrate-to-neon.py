"""
Migrate static JSON data to Neon Postgres.
Reads picks.json, odds.json, purse.json and inserts into the database.

Usage: python3 scripts/migrate-to-neon.py
"""

import json
import unicodedata
import re
import psycopg2

CONN_STR = "postgresql://neondb_owner:npg_nNlq2XKic5GV@ep-round-mouse-anx5ehzz.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require"
DATA_DIR = "data"

# ─── Name normalization (matches app.js normalizeName) ─────────────────────
def normalize_name(name):
    s = unicodedata.normalize('NFD', name)
    s = re.sub(r'[\u0300-\u036f]', '', s)
    s = s.replace('.', '')
    s = s.replace('ø', 'o').replace('Ø', 'O')
    s = s.replace('đ', 'd').replace('Đ', 'D')
    s = s.replace('ł', 'l').replace('Ł', 'L')
    return s.lower().strip()

# ─── Aliases and amateurs (matching app.js) ────────────────────────────────
NAME_ALIASES = {
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
}

AMATEURS = {
    'ethan fang', 'jackson herrington', 'mason howell',
    'fifa laopakdee', 'mateo pulcini', 'brandon holtz',
}

def main():
    # ── Load JSON files ──
    with open(f'{DATA_DIR}/picks.json') as f:
        picks = json.load(f)
    with open(f'{DATA_DIR}/odds.json') as f:
        odds = json.load(f)
    with open(f'{DATA_DIR}/purse.json') as f:
        purse = json.load(f)

    print(f"Loaded: {len(picks)} entries, {len(odds)} golfers with odds, purse ${purse['purse']:,}")

    conn = psycopg2.connect(CONN_STR)
    cur = conn.cursor()

    try:
        # ── Clear existing data (re-runnable) ──
        cur.execute("DELETE FROM entry_picks")
        cur.execute("DELETE FROM entries")
        cur.execute("DELETE FROM name_aliases")
        cur.execute("DELETE FROM tournament_golfers")
        cur.execute("DELETE FROM tournaments")

        # ── 1. Insert tournament ──
        cur.execute("""
            INSERT INTO tournaments (name, espn_event_id, purse, payout_pcts, is_active)
            VALUES (%s, %s, %s, %s, TRUE)
            RETURNING id
        """, (
            purse['tournament'],
            purse['eventId'],
            purse['purse'],
            json.dumps(purse['payoutPercentages']),
        ))
        tournament_id = cur.fetchone()[0]
        print(f"Tournament inserted: id={tournament_id}")

        # ── 2. Insert golfers ──
        # Collect all unique golfers from odds.json + any in picks not in odds
        all_golfer_names = set(odds.keys())
        for entry in picks:
            for player in entry['players']:
                all_golfer_names.add(player)

        golfer_id_map = {}  # normalized_name -> golfer_id
        golfer_count = 0
        for name in sorted(all_golfer_names):
            norm = normalize_name(name)
            # Check if this normalized name (or its alias target) is already inserted
            canonical = NAME_ALIASES.get(norm, norm)
            if canonical in golfer_id_map:
                # This is an alias variant, skip (the canonical is already in)
                continue

            odds_val = odds.get(name, 0)
            # If no odds under this name, check aliases
            if odds_val == 0:
                for oname, oval in odds.items():
                    if normalize_name(oname) == canonical:
                        odds_val = oval
                        break

            is_amateur = canonical in AMATEURS

            cur.execute("""
                INSERT INTO tournament_golfers
                    (tournament_id, golfer_name, normalized_name, odds_multiplier, is_amateur)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING id
            """, (tournament_id, name, canonical, odds_val, is_amateur))
            gid = cur.fetchone()[0]
            golfer_id_map[canonical] = gid
            golfer_count += 1

        print(f"Golfers inserted: {golfer_count}")

        # ── 3. Insert name aliases ──
        alias_count = 0
        for alias, canonical in NAME_ALIASES.items():
            # Skip self-referencing aliases
            if alias == canonical:
                continue
            cur.execute("""
                INSERT INTO name_aliases (tournament_id, alias_name, canonical_name)
                VALUES (%s, %s, %s)
                ON CONFLICT DO NOTHING
            """, (tournament_id, alias, canonical))
            alias_count += 1
        print(f"Aliases inserted: {alias_count}")

        # ── 4. Insert entries + picks ──
        entry_count = 0
        pick_count = 0
        missing_golfers = set()

        for entry in picks:
            cur.execute("""
                INSERT INTO entries (tournament_id, team_name)
                VALUES (%s, %s)
                RETURNING id
            """, (tournament_id, entry['name']))
            entry_id = cur.fetchone()[0]
            entry_count += 1

            for i, player in enumerate(entry['players']):
                norm = normalize_name(player)
                canonical = NAME_ALIASES.get(norm, norm)
                gid = golfer_id_map.get(canonical)

                if gid is None:
                    missing_golfers.add(player)
                    continue

                cur.execute("""
                    INSERT INTO entry_picks (entry_id, golfer_id, pick_order)
                    VALUES (%s, %s, %s)
                """, (entry_id, gid, i + 1))
                pick_count += 1

        print(f"Entries inserted: {entry_count}")
        print(f"Picks inserted: {pick_count}")

        if missing_golfers:
            print(f"WARNING: Missing golfers (no match): {missing_golfers}")

        # ── Validate ──
        cur.execute("SELECT COUNT(*) FROM tournaments")
        print(f"\nValidation:")
        print(f"  tournaments:        {cur.fetchone()[0]}")
        cur.execute("SELECT COUNT(*) FROM tournament_golfers WHERE tournament_id = %s", (tournament_id,))
        print(f"  tournament_golfers: {cur.fetchone()[0]}")
        cur.execute("SELECT COUNT(*) FROM entries WHERE tournament_id = %s", (tournament_id,))
        print(f"  entries:            {cur.fetchone()[0]}")
        cur.execute("SELECT COUNT(*) FROM entry_picks ep JOIN entries e ON ep.entry_id = e.id WHERE e.tournament_id = %s", (tournament_id,))
        print(f"  entry_picks:        {cur.fetchone()[0]}")
        cur.execute("SELECT COUNT(*) FROM name_aliases WHERE tournament_id = %s", (tournament_id,))
        print(f"  name_aliases:       {cur.fetchone()[0]}")

        # Spot check: verify a known team
        cur.execute("""
            SELECT e.team_name, tg.golfer_name, tg.odds_multiplier
            FROM entries e
            JOIN entry_picks ep ON ep.entry_id = e.id
            JOIN tournament_golfers tg ON tg.id = ep.golfer_id
            WHERE e.team_name = 'Chris McClave'
            ORDER BY ep.pick_order
        """)
        print(f"\nSpot check - Chris McClave's picks:")
        for row in cur.fetchall():
            print(f"  {row[1]} (odds: {row[2]})")

        conn.commit()
        print("\nMigration complete!")

    except Exception as e:
        conn.rollback()
        print(f"ERROR: {e}")
        raise
    finally:
        cur.close()
        conn.close()

if __name__ == '__main__':
    main()
