# NectarPay — Crypto Density Layer (scraper side)

Adds a crypto adoption signal layer and folds it into lead scoring.

**This package edits zero existing files.** Everything lands in new `crypto/`
and `sql/` folders, and nothing runs unless you run it. No `package.json`
change is needed — the scripts are invoked with `node` directly.

---

## What it does

| Step | Script | Output |
|---|---|---|
| 1 | `crypto/ingest.js` | Populates `crypto_signals` — AZ crypto ATMs (Google Places) + bitcoin-accepting merchants (OpenStreetMap) |
| 2 | `crypto/score.js` | Writes `nectarpay_leads.crypto_score` (0–100) based on distance-decayed signal density around each lead |

No new dependencies. It reuses `@supabase/supabase-js` and `dotenv`, and Node 18+'s built-in `fetch`.

---

## Install

```powershell
cd C:\Users\cmons\nectarpay-scraper
Expand-Archive -Path "$HOME\Downloads\nectarpay-crypto-layer.zip" -DestinationPath . -Force
```

Verify:

```powershell
Get-ChildItem -Recurse crypto, sql | Select-Object FullName
```

---

## 1. Apply the migration

Open the Supabase SQL editor for the **nectarpay** project, paste the contents of
`sql\017_crypto_signals.sql`, and run it.

```powershell
notepad sql\017_crypto_signals.sql
```

The whole file is additive — `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT
EXISTS`, `CREATE OR REPLACE` — inside one transaction. There is no `DELETE`,
`DROP`, or `TRUNCATE` anywhere in the forward path. The rollback block at the
bottom is commented out and destructive; leave it alone unless you mean it.

---

## 2. Ingest signals (dry run first)

```powershell
node crypto\ingest.js --dry-run
```

Writes `out\crypto-signals.csv` and prints a per-city ATM count. Open the CSV
and confirm the addresses are real Arizona locations before writing anything.

```powershell
Import-Csv out\crypto-signals.csv | Group-Object city | Sort-Object Count -Descending | Select-Object Count, Name -First 20
```

When it looks right:

```powershell
node crypto\ingest.js
```

Other flags:

```powershell
node crypto\ingest.js --source=places      # ATMs only
node crypto\ingest.js --source=osm         # accepting merchants only
node crypto\ingest.js --no-brands          # skip the brand-name queries (cheaper)
```

Cost: roughly 11 queries × 15 cities × up to 3 pages ≈ 300–450 Text Search
calls for a full sweep. Re-runs upsert on `(source, source_id)`, so repeats
are cheap and idempotent.

---

## 3. Score the leads (dry run first)

```powershell
node crypto\score.js --dry-run
```

Prints the score distribution and mean score by city, and writes
`out\crypto-scores.csv`. Nothing touches the database on a dry run.

```powershell
node crypto\score.js
```

Widen or tighten the catchment:

```powershell
node crypto\score.js --radius=3200
```

### Why the write is safe

Scores go in through the `apply_crypto_scores(jsonb)` RPC, which runs a single
`UPDATE ... FROM jsonb_to_recordset` against five named columns, matched on
`place_id`. It has no `WHERE` clause that can widen and no way to reach
`email`, `owner_first_name`, or Eric's `status`/`notes`. Worst case on a bad
run is wrong numbers in `crypto_score`, fixable by re-running.

---

## 4. Using the score

`crypto_score` is a percentile (0 = nothing crypto-adjacent within the radius,
100 = densest corridor in the dataset). It is deliberately **not** folded into
the HOT/WARM/COOL bands — those measure merchant fit, and mixing the two would
let a bad-fit shop in a dense ZIP outrank a good-fit shop in a quiet one.

Use it as a **tiebreaker inside a vertical**. Route planning query:

```sql
select name, city, vertical, phone, crypto_score, crypto_atm_count
  from nectarpay_leads
 where vertical = 'smoke-vape'
   and status is distinct from 'dnc'
   and crypto_score >= 70
 order by crypto_score desc
 limit 50;
```

Or straight off the view the migration creates:

```sql
select * from crypto_priority_leads limit 100;
```

---

## Tuning

`crypto\config\crypto-sources.json`:

- `cities` — centres and search radii. Add Yuma, Prescott, Casa Grande here if you extend the sweep.
- `scoring.radiusM` — catchment per lead. Default 2400 m (~1.5 mi).
- `scoring.merchantWeight` — currently 2.5× an ATM. A shop that already takes bitcoin is a much stronger signal than a kiosk, and it's also a warm referral target.
- `scoring.falloffPower` — 2 makes nearby signals dominate. Set to 1 for linear falloff.

---

## Known limits — read before you lean on it

**This is a proxy, not a census.** No dataset places crypto holders
geographically; on-chain addresses carry no location. What you're mapping is
where crypto *infrastructure* has been profitable to install, which correlates
with crypto usage but is not the same thing.

**ATM density tracks cash-heavy corridors.** Crypto kiosk operators site near
check-cashing, convenience, and remittance traffic. That overlaps with your
walk-in retail thesis, but it also overlaps with neighbourhoods where a
merchant can't clear $499. Read `crypto_score` alongside the vertical fit and
Eric's door intel, never instead of them.

**OSM merchant coverage is volunteer-maintained** and thin in Arizona — expect
tens of rows, not thousands. Low counts mean nobody has tagged the area, not
that nobody accepts crypto.
