# Woodway Golf Pool

Live leaderboard for the Woodway golf pool. Tracks team standings during PGA Tour events using the multiplier scoring system.

## How Scoring Works

Each team picks 6 golfers. Score = Σ (estimated prize money × odds multiplier) for each golfer.
- Missed cut → $0
- Not in field → $0
- Example: Golfer finishes 3rd ($1.725M prize) with 7-1 odds → $12,075,000 pool earnings

## GitHub Pages Setup

1. Push this repo to your GitHub account
2. Go to **Settings → Pages**
3. Under **Source**, select `Deploy from a branch`
4. Choose branch `main`, folder `/ (root)`, click **Save**
5. Your site will be live at `https://<your-username>.github.io/<repo-name>/`

## Enabling Auto-Refresh (GitHub Actions)

The workflow in `.github/workflows/update.yml` runs automatically during tournament days (Thu–Sun) and updates `data/leaderboard.json` every 20 minutes.

**Required:** Give Actions write permission:
1. Go to **Settings → Actions → General**
2. Under **Workflow permissions**, select **Read and write permissions**
3. Click **Save**

You can also trigger a manual update any time from the **Actions** tab → **Update Leaderboard** → **Run workflow**.

## Updating for a New Tournament

1. Edit `data/purse.json` — update `tournament`, `eventId`, and `purse`
2. Find the ESPN event ID by visiting `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard`
   and looking in the `calendar` array for your tournament
3. If using new picks, replace `data/picks.json`
4. If using new odds, replace `data/odds.json`

## Masters 2026

- ESPN event ID: `401811941`
- Update `data/purse.json` with the Masters purse (typically ~$20M) and the Masters event ID
- Replace `data/picks.json` with the Masters entries
- Replace `data/odds.json` with the Masters odds

## File Structure

```
data/picks.json       — Team entries (168 teams, 6 golfers each)
data/odds.json        — Player odds multipliers
data/purse.json       — Tournament purse and payout % table
data/leaderboard.json — Live data (auto-updated by GitHub Actions)
scripts/fetch_leaderboard.py — ESPN data fetcher
.github/workflows/update.yml — Scheduled refresh
```
