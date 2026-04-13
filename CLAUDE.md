# Woodway Masters Golf Pool - Project Memory

## Overview
A live leaderboard website for the Woodway Masters golf pool (2026 Masters Tournament). Static HTML5 web app (vanilla JS, no framework) hosted on GitHub Pages. Tracks 192 pool entries with 6 golfers each, calculating estimated winnings using odds multipliers.

**GitHub Repo:** `claudecodejg-bot/woodway-masters`
**Live Site:** GitHub Pages deployment
**Local Dev:** `http://localhost:8743`

## Architecture

### Data Flow
- **Live scores:** Client-side JavaScript fetches directly from ESPN PGA API (`site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?event=401580333`)
- **Backup:** GitHub Actions workflow runs every 5 min (10:00-03:59 UTC) to update `data/leaderboard.json` as fallback
- **Pool entries:** Static `data/picks.json` (192 entries, manually maintained)
- **Odds:** Static `data/odds.json` (multipliers per golfer)
- **Purse:** Static `data/purse.json` (eventId, $21M purse, 50-position payout percentages from Golf Digest)

### Key Files
- `index.html` — Main HTML with 4 tabs: Pool Leaderboard, Tournament, Teams & Picks, How to Use
- `js/app.js` — All application logic (~1100+ lines)
- `css/style.css` — All styles including responsive/mobile
- `data/picks.json` — 192 pool entries with 6 golfers each
- `data/odds.json` — Golfer odds multipliers
- `data/purse.json` — Tournament config (eventId: 401580333, purse: $21M, payout percentages)
- `data/leaderboard.json` — Cached leaderboard (fallback if ESPN API unavailable)
- `scripts/fetch_leaderboard.py` — Python script for GitHub Actions to fetch ESPN data
- `.github/workflows/update.yml` — GitHub Actions cron (every 5 min, all week, 6am-midnight ET)

## Features Built

### Core Features
1. **Pool Leaderboard** — All 192 teams ranked by estimated pool earnings (odds-adjusted). Top 3 highlighted gold/silver/bronze. Click to expand and see golfer breakdown with Pos, Score, Today, Thru, Odds, Est. Earnings, Odds Adj.
2. **Tournament Leaderboard** — Live ESPN data with position, score, today, thru, R1-R4, est. earnings, odds, odds adj. Projected cut line (Masters top 50 + ties). Player search bar.
3. **Teams & Picks** — All teams with golfer chips showing position. Players sorted alphabetically by last name. Chips are clickable to open golfer popup.
4. **How to Use** — Instructions page with favorites info and 50-position prize money payout table.

### Favorites System (localStorage)
- Star/pin teams on Pool Leaderboard and Teams & Picks tabs
- Star/pin players on Tournament tab
- Pinned items appear in a "Favorites" section at top
- Stars on left side (mobile-friendly)
- Persists across visits per browser via localStorage
- Keys: `ww_fav_teams`, `ww_fav_players`

### Live ESPN Fetch (Client-Side)
- `fetchLiveLeaderboard()` in app.js fetches directly from ESPN API in browser
- Processes scores, tie-splitting, prize calculations client-side
- Falls back to static `leaderboard.json` if ESPN unavailable
- Auto-refreshes every 5 minutes + manual Refresh button
- Cache-busting with `?t=${Date.now()}` on all fetch calls

### Player Modal (Golfer Popup)
- Click any player name to see all teams that picked them
- Shows team rank, earnings, and all golfers on each team as chips
- Chips are clickable to navigate player-to-player
- Delegated click handler on `.player-link`, `.pick-chip`, `.modal-chip-link`

### Name Handling
- **Normalization:** NFD unicode decomposition, accent stripping, special char replacement (ø→o, đ→d, ł→l)
- **Aliases** (in `NAME_ALIASES`):
  - `matthew fitzpatrick` → `matt fitzpatrick`
  - `maverick mcnealey` → `maverick mcnealy`
  - `charl scwartzel` → `charl schwartzel`
  - `billy horshel` → `billy horschel`
  - `samuel stevens` → `sam stevens`
  - `john keefer` → `johnny keefer`
  - `nicolas echavarria` → `nico echavarria`
  - `corey connors` → `corey conners`

### Amateur Designation
- Six amateurs marked with "(A)" after their name everywhere:
  - Ethan Fang, Jackson Herrington, Mason Howell, Brandon Holtz, Fifa Laopakdee, Mateo Pulcini
- Defined in `AMATEURS` Set, rendered via `amateurTag()` function

### Mobile Responsive
- Tournament tab: hides R1-R4, Est. Earnings, and Odds columns on mobile (< 700px)
- Shows: Pos, Player, Total, Today, Thru, Odds Adj
- Pool leaderboard and picks table also responsive

### Auto-Refresh Note
- Small italic note "Auto-refreshes every 5 minutes" below the last-updated timestamp

## Cut Line Logic
- **Masters uses top 50 + ties** (not PGA Tour's top 65)
- Determined by 50th player's score (sorted by score, 0-indexed position 49)
- Players worse than cut score marked `projectedCut: true`
- Projected cut players show "--" in Today column if they haven't started their round
- Cut players below the line sorted by total score (best to worst)
- After round 2, actual missed-cut players detected by `roundsCompleted <= 2` when `maxRound >= 3`

## Round Detection
- Checks for actual hole-by-hole data (`ls.linescores`) OR real scores (not placeholder `value=0, displayValue="-"`)
- Handles ESPN's pre-round placeholders correctly

## Prize Calculations
- Tie-splitting: players tied at same position split the combined prize money for those positions
- Payout percentages from Golf Digest for all 50 positions (purse.json)
- Position 1: 20%, Position 2: 10.8%, Position 3: 6.8%, etc.
- Amateurs do not receive prize money

## Roster Changes Made
All changes below were made to `data/picks.json`:

1. Blake Wieczorek — added Ludvig Aberg as 6th golfer (was missing)
2. Greg Monahan 2 — removed Cameron Young, added Maverick McNealy and Collin Morikawa
3. Blake Wieczorek — spelling corrected from "Wiezzorek"
4. Corey Conners — spelling corrected from "Connors" across all 27 entries + odds.json
5. Tim Dwyer 1 — Patrick Cantlay → Sepp Straka
6. Jon Thackeray — Tyrrell Hatton → Patrick Reed
7. Brian Lavigne 5 — Cameron Young → Jon Rahm
8. David Durkin 3 — Danny Willett → Maverick McNealy
9. Nate Skolds — Matt Fitzpatrick → Scottie Scheffler
10. Devon Walsh 1 — Sam Burns → Justin Thomas
11. Devon Walsh 2 — Cameron Young → Russell Henley
12. Rooster — Corey Conners → Brian Harman
13. Chuck Bauer — Justin Rose → Jordan Spieth
14. Tom Moran 1 — Maverick McNealy → Cameron Young
15. Tom Moran 2 — Jake Knapp → Sepp Straka
16. Tom Moran 3 — Patrick Cantlay → Russell Henley
17. Tom Moran 4 — Ryan Fox & Haotong Li → Adam Scott & Nick Taylor
18. Tom Moran 5 — Viktor Hovland → Davis Riley
19. Jayne Tully 1 — Fred Couples → Shane Lowry (note: name is "Jayne" not "Jane")
20. Jayne Tully 2 — Maverick McNealy → Adam Scott
21. Tim Tully — Ben Griffin → J.J. Spaun
22. Don Ross — Max Homa → Adam Scott
23. Rob Duffy 1 — Xander Schauffele → Cameron Young
24. Sloan Bohlen — Ethan Fang → Justin Rose
25. Pete Hunsinger 2 — Max Greyserman → Justin Rose
26. Frankie Granito IV — Brian Harman → Jordan Spieth
27. Sam Sullivan — Hideki Matsuyama → Jordan Spieth
28. Greg Lesko — Shane Lowry → Xander Schauffele
29. Mike Godina 5 — Scottie Scheffler → Sepp Straka

## Common Git Workflow
- GitHub Actions auto-updates leaderboard.json every 5 min, causing frequent merge conflicts
- Resolution: `git pull --rebase origin main`, resolve conflicts by re-running `python3 scripts/fetch_leaderboard.py`, then `git add` and `git rebase --continue`
- Always use `git pull --rebase origin main && git push origin main`

## CSS Structure
- Header: dark green gradient (#1a4c2e to #2d7a4f)
- Favorites: `.fav-star`, `.fav-section-header`, `.fav-highlight`
- Tournament table: tightened padding (8px 6px), player-col min-width 170px, white-space nowrap
- Mobile breakpoint: 700px
- Modal: `.player-modal-overlay`, `.player-modal`
- Chips: `.modal-chip-link` (clickable in modal), `.pick-chip` (in picks tab)

## Important Notes
- Tab order: Pool Leaderboard → Tournament → Teams & Picks → How to Use
- Expanded team detail shows: Golfer, Pos, Score, Today, Thru, Odds, Est. Earnings, Odds Adj (no rounds)
- The team search bar at top works for Pool Leaderboard and Teams & Picks tabs
- Player search bar is on Tournament tab only
- "Jayne Tully" not "Jane Tully" — be careful with spelling
