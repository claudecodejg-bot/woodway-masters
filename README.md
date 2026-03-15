# Woodway Golf Pool

Live leaderboard for the Woodway golf pool. Tracks team standings during PGA Tour events using the multiplier scoring system.

**Live site:** https://claudecodejg-bot.github.io/woodway-masters/

> **Note:** Always share the direct URL above. Gmail and some email clients rewrite links and may produce broken redirect URLs.

---

## Project Progress Log

### Session 1 — March 15, 2026

#### What was built
A fully functional golf pool leaderboard website hosted on GitHub Pages, tested live during The Players Championship (March 2026) weekend.

#### Features completed
- **3-tab layout:**
  - 🏆 **Pool Leaderboard** — teams ranked by estimated pool earnings, click any row to expand golfer breakdown
  - 👥 **Teams & Picks** — all teams with their golfer picks shown as color-coded chips (green=active, red=MC, gray=NIF), filterable by team name
  - ⛳ **Tournament** — ESPN-style leaderboard with Pos, Score, Today (current round), R1–R4, and Est. Winnings columns
- **Sortable columns** on all three tabs (click any column header to sort, click again to reverse)
- **Search/filter** by team name (active on Pool Leaderboard and Teams & Picks tabs)
- **Auto-refresh** every 5 minutes via GitHub Actions scheduled workflow (runs Thu–Sun during tournament hours)
- **Manual refresh** button in the header, plus on-demand trigger from the GitHub Actions tab
- **Gold/silver/bronze** rank highlights for top 3 teams
- **Today's round** highlighted in green across all tabs
- Missed cut players shown in red with strikethrough; not-in-field in gray/italic
- Mobile responsive — R1–R4 columns hidden on small screens to save space

#### Data sources
- **Golfer scores/positions:** ESPN PGA Tour API (fetched automatically by `scripts/fetch_leaderboard.py`)
- **Team entries:** `data/picks.json` (imported from Excel spreadsheet)
- **Odds multipliers:** `data/odds.json` (from last year's Masters PDF rules sheet)
- **Purse/payouts:** `data/purse.json`

#### Scoring formula
`Pool Earnings = Σ (estimated prize money × odds multiplier)` for each active golfer on the team
- Missed cut → $0 contribution
- Not in field → $0 contribution
- Example: Golfer finishes 3rd ($1.725M prize) with 7-1 odds → $12,075,000 pool earnings

#### GitHub setup completed
- Repo: `https://github.com/claudecodejg-bot/woodway-masters`
- GitHub Pages enabled: Settings → Pages → Deploy from branch `main`
- Actions write permissions enabled: Settings → Actions → General → Read and write permissions
- Personal Access Token requires both `repo` and `workflow` scopes
- Auto-update workflow runs every 5 minutes on Thu–Sun, 11:00–23:59 UTC

#### Known issues / notes
- Gmail rewrites shared links — always share the direct URL: `https://claudecodejg-bot.github.io/woodway-masters/`
- GitHub Actions scheduled workflows can run a few minutes late under load (real-world refresh ~5–7 min)
- The Node.js 20 deprecation warning on Actions is cosmetic — no action needed until June 2026

#### Next steps — Masters 2026 (April)
- [ ] Get new Masters picks spreadsheet from club members
- [ ] Get Masters odds from the PDF rules sheet
- [ ] Update `data/purse.json` with Masters event ID (`401811941`) and purse amount (~$20M)
- [ ] Replace `data/picks.json` with Masters entries
- [ ] Replace `data/odds.json` with Masters odds
- [ ] Test a manual workflow run to confirm data loads correctly before tournament starts

---

## How Scoring Works

Each team picks golfers. Score = Σ (estimated prize money × odds multiplier) for each golfer.
- Missed cut → $0
- Not in field → $0
- Example: Golfer finishes 3rd ($1.725M prize) with 7-1 odds → $12,075,000 pool earnings

---

## Updating for a New Tournament

1. Edit `data/purse.json` — update `tournament`, `eventId`, and `purse`
2. Find the ESPN event ID by visiting:
   `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard`
   and looking in the `calendar` array for your tournament
3. Replace `data/picks.json` with the new entries
4. Replace `data/odds.json` with the new odds
5. Trigger a manual workflow run from the Actions tab to verify

### Masters 2026
- ESPN event ID: `401811941`
- Purse: ~$20M (confirm closer to the event)
- Tournament dates: April 10–13, 2026

---

## GitHub Pages Setup (for reference)

1. Push repo to GitHub
2. Go to **Settings → Pages**
3. Source: `Deploy from a branch` → branch `main`, folder `/ (root)` → **Save**
4. Go to **Settings → Actions → General** → **Read and write permissions** → **Save**
5. Site goes live at `https://<username>.github.io/<repo-name>/`

---

## File Structure

```
index.html                        — Main site (3-tab layout)
css/style.css                     — Styles
js/app.js                         — App logic (scoring, rendering, tabs, sort, search)
data/picks.json                   — Team entries
data/odds.json                    — Player odds multipliers
data/purse.json                   — Tournament purse and payout % table
data/leaderboard.json             — Live data (auto-updated by GitHub Actions)
scripts/fetch_leaderboard.py      — ESPN data fetcher
.github/workflows/update.yml      — Scheduled refresh (every 5 min, Thu–Sun)
```
