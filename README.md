This site is an unofficial community information page for Serpentine Jarrahdale SES.

## How the live data works

BOM doesn't allow browsers to call its feeds directly (no CORS), so the old Cloudflare
Worker proxy has been replaced by a scheduled GitHub Action:

1. `.github/workflows/update-data.yml` runs every ~10 minutes.
2. `scripts/fetch-data.mjs` pulls BOM observations, the BOM district forecast, BOM WA warnings
   and the Emergency WA CAP-AU feed, filters Emergency WA to the Serpentine Jarrahdale area
   ("local" and "nearby"), and writes `live.json`.
3. The file is force-pushed to a single-commit `data` branch (no history build-up on `main`).
4. `assets/js/bom.js` reads it from `raw.githubusercontent.com` and updates the page.

If one source fails, its last good data is kept and flagged as stale.

## Setup

- Repo → Settings → Actions → General → Workflow permissions: **Read and write**.
- Actions tab → "Update SES data" → **Run workflow** once to create the `data` branch.
- Settings are at the top of `scripts/fetch-data.mjs` (station, radius, feed URLs).

## Local test (no network)

    npm install
    npm test        # uses tests/fixtures; the obs/forecast/warnings fixtures are synthetic

Data: Bureau of Meteorology (non-commercial use, see bom.gov.au/copyright) and
Emergency WA / DFES (credit: "Supplied by EmergencyWA. © Government of Western Australia (DFES)").
