#!/usr/bin/env python3
"""
Fetches live leaderboard data from ESPN and saves to data/leaderboard.json.
Run by GitHub Actions every 20 minutes during tournament.
"""
import json
import os
import unicodedata
from datetime import datetime, timezone
from urllib.request import urlopen, Request
from urllib.error import URLError

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(ROOT_DIR, "data")

PURSE_FILE = os.path.join(DATA_DIR, "purse.json")
OUTPUT_FILE = os.path.join(DATA_DIR, "leaderboard.json")

ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard"


def fetch_json(url):
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def normalize_name(name):
    """Lowercase, strip accents, remove periods for fuzzy matching."""
    name = unicodedata.normalize("NFD", name)
    name = "".join(c for c in name if unicodedata.category(c) != "Mn")
    name = name.replace(".", "")   # J.J. Spaun → JJ Spaun
    # Handle special characters not decomposed by NFD
    name = name.replace("ø", "o").replace("Ø", "O")
    name = name.replace("đ", "d").replace("Đ", "D")
    name = name.replace("ł", "l").replace("Ł", "L")
    return name.lower().strip()


def prize_for_position(pos, purse, pct_table):
    """Return prize money for a given 1-based position.
    Any position beyond the payout table earns the last-place amount
    (PGA Tour pays all players who make the cut)."""
    if pos < 1 or not pct_table:
        return 0
    idx = min(pos - 1, len(pct_table) - 1)
    return round(purse * pct_table[idx])


def split_prize_for_ties(positions, purse, pct_table):
    """
    Given a list of tied 1-based positions (e.g. [3,3,3] for three players tied 3rd),
    returns the average prize money they each receive.
    """
    total = sum(prize_for_position(p, purse, pct_table) for p in positions)
    return round(total / len(positions)) if positions else 0


def main():
    with open(PURSE_FILE) as f:
        purse_data = json.load(f)

    purse = purse_data["purse"]
    pct_table = purse_data["payoutPercentages"]
    event_id = purse_data["eventId"]
    tournament_name = purse_data["tournament"]

    url = f"{ESPN_SCOREBOARD}?event={event_id}"
    print(f"Fetching: {url}")

    try:
        data = fetch_json(url)
    except URLError as e:
        print(f"ERROR fetching ESPN data: {e}")
        # Write an error state so the site shows something useful
        output = {
            "tournament": tournament_name,
            "eventId": event_id,
            "purse": purse,
            "status": "error",
            "statusDisplay": "Data unavailable",
            "round": None,
            "lastUpdated": datetime.now(timezone.utc).isoformat(),
            "players": []
        }
        with open(OUTPUT_FILE, "w") as f:
            json.dump(output, f, indent=2)
        return

    events = data.get("events", [])
    if not events:
        print("No events found in ESPN response")
        return

    event = events[0]
    event_status = event.get("status", {}).get("type", {})
    status_name = event_status.get("name", "")
    status_display = event_status.get("description", "In Progress")
    is_complete = event_status.get("completed", False)

    competitions = event.get("competitions", [])
    if not competitions:
        print("No competitions found")
        return

    comp = competitions[0]
    competitors = comp.get("competitors", [])

    # Determine current round from linescores
    def get_rounds_played(competitor):
        ls = competitor.get("linescores", [])
        completed = 0
        for r in ls:
            if r.get("value") is not None and r.get("period", 0) <= 4:
                # Check if the round has actual scores (not just an empty period placeholder)
                if r.get("linescores"):  # Has hole-by-hole data = complete or in progress
                    completed = r.get("period", completed)
        return completed

    # Find the max round in progress
    max_round = 0
    for c in competitors:
        for ls in c.get("linescores", []):
            p = ls.get("period", 0)
            if p <= 4 and ls.get("value") is not None:
                max_round = max(max_round, p)

    # Build position map to handle ties (group by order)
    # ESPN 'order' field = position rank (ties share the same order)
    position_groups = {}
    for c in competitors:
        pos = c.get("order", 999)
        if pos not in position_groups:
            position_groups[pos] = []
        position_groups[pos].append(c)

    # Calculate prize for tied groups
    prize_cache = {}
    for pos, group in position_groups.items():
        if len(group) == 1:
            prize_cache[pos] = prize_for_position(pos, purse, pct_table)
        else:
            tied_positions = list(range(pos, pos + len(group)))
            avg_prize = split_prize_for_ties(tied_positions, purse, pct_table)
            prize_cache[pos] = avg_prize

    # Build player list
    players = []
    for c in competitors:
        athlete = c.get("athlete", {})
        full_name = athlete.get("fullName", "Unknown")
        pos = c.get("order", 999)
        score = c.get("score", "E")

        # Determine cut status
        # ESPN doesn't always expose status field clearly — use position >65 heuristic
        # or check if linescores only have 2 rounds with no round 3/4 data
        linescores = c.get("linescores", [])
        rounds = [ls for ls in linescores if ls.get("period", 0) <= 4 and ls.get("value") is not None]
        rounds_completed = len(rounds)

        # If only 2 rounds and tournament is past round 2, player missed cut
        missed_cut = False
        if max_round >= 3 and rounds_completed <= 2:
            missed_cut = True

        # Round scores
        round_scores = {}
        for ls in rounds:
            period = ls.get("period", 0)
            if 1 <= period <= 4:
                round_scores[f"R{period}"] = ls.get("displayValue", "")

        estimated_prize = 0 if missed_cut else prize_cache.get(pos, 0)

        players.append({
            "name": full_name,
            "normalizedName": normalize_name(full_name),
            "position": pos,
            "score": score,
            "roundScores": round_scores,
            "roundsCompleted": rounds_completed,
            "missedCut": missed_cut,
            "estimatedPrize": estimated_prize
        })

    # Sort: active players by position, then missed cut players
    active = sorted([p for p in players if not p["missedCut"]], key=lambda x: x["position"])
    cut = sorted([p for p in players if p["missedCut"]], key=lambda x: x["name"])
    players_sorted = active + cut

    output = {
        "tournament": tournament_name,
        "eventId": event_id,
        "purse": purse,
        "status": status_name,
        "statusDisplay": status_display,
        "isComplete": is_complete,
        "round": max_round,
        "lastUpdated": datetime.now(timezone.utc).isoformat(),
        "players": players_sorted
    }

    with open(OUTPUT_FILE, "w") as f:
        json.dump(output, f, indent=2)

    active_count = len(active)
    cut_count = len(cut)
    print(f"Done. {active_count} active, {cut_count} missed cut. Round {max_round}. Saved to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
