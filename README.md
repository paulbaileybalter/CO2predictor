# Balter CO2 Predictor

Static site (in `public/`) behind a password-gating Cloudflare Worker (`src/worker.js`).

## Deploy (GitHub → Cloudflare)
1. Push this folder to a GitHub repo.
2. Cloudflare dashboard → **Workers & Pages → Create → Import a repository**. Build command: none. Deploy command: `npx wrangler deploy`.
3. Worker → **Settings → Variables and Secrets → Add** → type **Secret**, name `SITE_PASSWORD`, value = your password. Redeploy.
4. Open the site; it shows a password-only sign-in page (no username). Cookie lasts 30 days.
5. Shared data: the `DATA` KV namespace in `wrangler.jsonc` is created automatically on first deploy. If it isn't, create a KV namespace in the dashboard and bind it to the Worker as `DATA`. Readings, board uploads and plan changes are then shared by everyone (last save wins).

Local test: create `.dev.vars` with `SITE_PASSWORD=test`, then `npm i && npm run dev`.
(Alternative with no code: put Cloudflare Access in front of the Worker.)

## Updating the data
- In the site: add readings, or use *Import CO2 handover sheet* / *Import Live Brewery Board*. Saved per browser.
- To bake new data into the deployed site for everyone: `npm i` then
  `node tools/build-seed.cjs <Live_Brewery_Board.xlsx> <Co2_tracking.xlsx> 2026`, commit `public/data.js`, push.
  (Keep the .xlsx files out of the repo.)

## Notes
- Gauge readings are treated as % of the 30 t vessel; change capacity, load, floor, notice and delivery days in Settings.
- Dates in the CO2 sheet: text like `28/10` is day/month; real date cells are swapped back (Excel read `12/10` as 10 Dec).
