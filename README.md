# NectarPay Lead Scraper

Builds a scored lead database of Phoenix/AZ businesses for crypto POS sales.
Pipeline: Google Places API (New) Text Search -> website email harvest -> score -> CSV (+ optional Supabase upsert).

## One-time setup

1. **Google Cloud Console** (console.cloud.google.com):
   - Create project `nectarpay` -> APIs & Services -> enable **Places API (New)** (not the legacy one)
   - Credentials -> Create API Key -> restrict it to Places API (New)
   - Paste into `.env` as `GOOGLE_PLACES_API_KEY`
2. **Supabase (optional):** run `sql/001_leads.sql` in the SQL editor, then fill `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`. Leave blank to run CSV-only.

## Usage

```
npm run scrape                             # everything (all verticals x 15 cities)
npm run scrape -- --vertical smoke-vape    # one vertical
npm run scrape -- --city "Tempe AZ"        # one city
npm run scrape -- --no-emails              # fast pass, skip email harvest
```

Vertical keys: `smoke-vape`, `tattoo`, `firearms`, `barber`, `jewelry-gold`, `auto`, `food-drink`.

Output: `out/nectarpay-leads-YYYY-MM-DD.csv`, sorted by score. Bands:
- **HOT** (14+): Eric walks in this week
- **WARM** (10-13): email sequence first, then visit on open/click
- **COOL**: drip campaign only

## Notes

- Re-runs upsert on `place_id` - ratings/emails refresh, no duplicate rows, and Eric's pipeline fields (`status`, `notes`) are never overwritten.
- Google returns max ~60 results per query; multiple query phrasings per vertical widen coverage.
- Each vertical x city x query = up to 3 API calls. Full run is roughly 1,000-1,300 Text Search calls - start with one vertical to confirm your key works before the full sweep.
- Add verticals/cities in `config/targets.json` - no code changes needed.
