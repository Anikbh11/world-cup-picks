# World Cup Bracket Predictor

A static, GitHub Pages-ready bracket prediction site for the FIFA World Cup Round of 32.

## What Works Without a Server

- Launch page, dashboard, and full bracket prediction page
- One-time bracket locking before kickoff
- Per-player locked bracket submissions
- Live score and final score updates
- Standings, projected points, and bracket updates as scores change
- Champion projection
- Scoring:
  - 1 point for the correct winner
  - 0.5 points for the correct goal difference
  - 1 bonus point for the exact score
- Optional Supabase storage/realtime sync with local browser fallback
- Advanced prediction statistics and scoring breakdowns

Because this is a static site, your laptop does not need to stay on after it is deployed to GitHub Pages.

## Live Updates With Supabase

GitHub Pages hosts the site. Supabase stores locked bracket submissions user-by-user, stores the live bracket state, and broadcasts realtime updates.

The app runs in local mode until Supabase credentials are added. In local mode, each visitor's data is saved only in their browser.

To enable shared live updates:

1. Create a Supabase project.
2. Open the Supabase SQL editor.
3. Run [supabase/schema.sql](./supabase/schema.sql).
4. Open `Project Settings > API`.
5. Copy the project URL and anon public key.
6. Paste them into [js/config.js](./js/config.js):

```js
export const SUPABASE_CONFIG = {
  url: "https://YOUR-PROJECT.supabase.co",
  anonKey: "YOUR_SUPABASE_ANON_KEY",
  table: "bracket_states",
  stateId: "world-cup-r32",
};
```

Locked brackets are written to `bracket_submissions` with the player's name, full bracket state, lock timestamp, and update timestamp. The dashboard reads those rows back for standings and projected points.

For a public production version, the next step is adding admin-only score controls and tighter write policies so only trusted people can update live results.

## Automatic Daily Score Sync

The repo includes a GitHub Actions workflow that can update Supabase every morning:

- Workflow: `.github/workflows/daily-score-sync.yml`
- Schedule: `07:00 UTC`, which is `09:00 Europe/Berlin` during the World Cup summer window
- Sync script: `tools/syncScores.mjs`
- Fixture map: `tools/score-fixture-map.json`

The script reads the current global bracket state from `bracket_states`, fetches mapped match scores from API-Football/API-SPORTS, updates `matches[*].actual`, and writes the state back to Supabase. The website then recalculates live points, projected points, standings, and match-by-match scoring from that updated state.

Add these GitHub repository secrets before enabling real score sync:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
FOOTBALL_API_KEY
```

Then fill each `fixtureId` in `tools/score-fixture-map.json` with the provider's fixture ID for the matching World Cup knockout game. Until fixture IDs are filled in, the workflow exits without changing anything.

Penalty shootouts are handled separately: `home` and `away` store the football score excluding penalties, while `penaltyHome` and `penaltyAway` are stored only to decide the winner if the match ends level. That keeps the scoring rule intact: penalties can decide the winner point, but do not create exact-score or goal-difference bonus points.

## Deploy With GitHub Pages

1. Create a new GitHub repository.
2. Push this folder to the repository.
3. In GitHub, open `Settings > Pages`.
4. Set the source to `Deploy from a branch`.
5. Choose the `main` branch and `/root` folder.
6. Save.

GitHub will publish the site at:

```text
https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/
```

## Local Preview

Run a local static server from this folder:

```bash
python3 -m http.server 8000
```

Then visit:

```text
http://localhost:8000
```
