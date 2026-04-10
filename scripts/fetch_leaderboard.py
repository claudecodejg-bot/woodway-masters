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
    # A round counts if it has hole-by-hole data (linescores) OR a real score
    # (not just a placeholder with value=0 and display="-")
    max_round = 0
    for c in competitors:
        for ls in c.get("linescores", []):
            p = ls.get("period", 0)
            if p <= 4:
                has_holes = bool(ls.get("linescores"))
                has_real_score = (ls.get("value") is not None
                                 and not (ls.get("value") == 0 and ls.get("displayValue") == "-"))
                if has_holes or has_real_score:
                    max_round = max(max_round, p)

    # Build position map to handle ties by grouping on SCORE, not ESPN order.
    # ESPN 'order' gives sequential positions even for ties, so we must
    # detect ties by identical scores and split prize money accordingly.
    # Sort competitors by ESPN order first to establish ranking order.
    competitors.sort(key=lambda c: c.get("order", 999))

    # Group consecutive players by score to detect ties
    # We also need to skip missed-cut players (they get no prize)
    score_groups = []  # list of (start_pos, [competitors])
    current_pos = 1
    i = 0
    while i < len(competitors):
        c = competitors[i]
        score = c.get("score", "E")
        group = [c]
        j = i + 1
        while j < len(competitors) and competitors[j].get("score", "E") == score:
            group.append(competitors[j])
            j += 1
        score_groups.append((current_pos, group))
        current_pos += len(group)
        i = j

    # Calculate prize for each group, splitting ties evenly
    # Map ESPN order -> (tied_position, prize)
    position_prize_map = {}  # order -> (position, prize)
    for start_pos, group in score_groups:
        if len(group) == 1:
            c = group[0]
            order = c.get("order", 999)
            position_prize_map[order] = (start_pos, prize_for_position(start_pos, purse, pct_table))
        else:
            tied_positions = list(range(start_pos, start_pos + len(group)))
            avg_prize = split_prize_for_ties(tied_positions, purse, pct_table)
            for c in group:
                order = c.get("order", 999)
                position_prize_map[order] = (start_pos, avg_prize)

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
        # Filter out WD rounds: value=0.0 with displayValue="-" means no actual round played
        rounds = [ls for ls in linescores
                  if ls.get("period", 0) <= 4
                  and ls.get("value") is not None
                  and not (ls.get("value") == 0 and ls.get("displayValue") == "-")]
        rounds_completed = len(rounds)

        # If only 2 rounds and tournament is past round 2, player missed cut or WD
        missed_cut = False
        if max_round >= 3 and rounds_completed <= 2:
            missed_cut = True

        # Round scores
        round_scores = {}
        for ls in rounds:
            period = ls.get("period", 0)
            if 1 <= period <= 4:
                round_scores[f"R{period}"] = ls.get("displayValue", "")

        # Thru: count hole-by-hole scores in the current round
        thru = None
        for ls in linescores:
            if ls.get("period") == max_round:
                hole_scores = ls.get("linescores", [])
                completed_holes = sum(1 for h in hole_scores if h.get("value") is not None)
                thru = completed_holes if completed_holes < 18 else "F"
                break

        tied_pos, prize_amount = position_prize_map.get(pos, (pos, 0))
        estimated_prize = 0 if missed_cut else prize_amount

        players.append({
            "name": full_name,
            "normalizedName": normalize_name(full_name),
            "position": tied_pos,
            "score": score,
            "roundScores": round_scores,
            "roundsCompleted": rounds_completed,
            "thru": thru,
            "missedCut": missed_cut,
            "projectedCut": False,
            "estimatedPrize": estimated_prize
        })

    # Projected cut for Rounds 1-2: Masters uses top 50 + ties
    cut_line_score = None
    if max_round <= 2:
        # Sort by score (best first) to find the 50th player's score
        def score_to_num_sort(s):
            if not s or s == "E":
                return 0
            return int(str(s).replace("+", ""))
        by_score = sorted(players, key=lambda x: score_to_num_sort(x["score"]))
        # The 50th player's score is the cut line (top 50 + ties)
        cut_pos_score = None
        if len(by_score) >= 50:
            cut_pos_score = by_score[49]["score"]  # 0-indexed, so index 49 = 50th player
        if cut_pos_score is not None:
            cut_line_score = cut_pos_score
            for p in players:
                # Players whose score is worse than (higher than) the cut line score
                # need numeric comparison: E=0, -3=-3, +2=2
                def score_to_num(s):
                    if not s or s == "E":
                        return 0
                    return int(s.replace("+", ""))
                player_num = score_to_num(p["score"])
                cut_num = score_to_num(cut_pos_score)
                if player_num > cut_num:
                    p["projectedCut"] = True
                    p["estimatedPrize"] = 0

    # Sort: active players by position, then missed/projected cut players
    active = sorted([p for p in players if not p["missedCut"] and not p["projectedCut"]],
                    key=lambda x: x["position"])
    def score_to_num(s):
        if not s or s == "E":
            return 0
        return int(str(s).replace("+", ""))
    cut = sorted([p for p in players if p["missedCut"] or p["projectedCut"]],
                 key=lambda x: score_to_num(x["score"]))
    players_sorted = active + cut

    output = {
        "tournament": tournament_name,
        "eventId": event_id,
        "purse": purse,
        "status": status_name,
        "statusDisplay": status_display,
        "isComplete": is_complete,
        "round": max_round,
        "cutLineScore": cut_line_score,
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
