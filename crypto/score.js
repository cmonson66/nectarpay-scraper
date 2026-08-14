#!/usr/bin/env node
/**
 * crypto/score.js
 *
 * Scores every lead by crypto density around it and writes crypto_score
 * (0-100) back via the apply_crypto_scores RPC, which touches only the five
 * crypto_* columns. Nothing else on the row can be modified by this script.
 *
 * SCORED PER REGION, and --region is required. crypto_score is a PERCENTILE
 * within the dataset, so scoring two metros together silently re-ranks both:
 * a Phoenix lead's 80 would start meaning "80th percentile across Arizona and
 * Texas", and every existing Phoenix score would shift the first time DFW
 * signals landed. Each region is ranked against itself.
 *
 * Usage (PowerShell, from the repo root):
 *   node crypto/score.js --region=DFW --dry-run
 *   node crypto/score.js --region=DFW
 *   node crypto/score.js --region=PHX --radius=3200
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM has no __dirname
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { getSupabase, fetchAll } from './lib/db.js';

// The scraper's lead table. Named nectarpay_leads, not leads.
const LEADS_TABLE = 'nectarpay_leads';
import { haversineMeters, GridIndex } from './lib/geo.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const val = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};

const CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'config', 'crypto-sources.json'), 'utf8')
);

const REGION_CODE = (val('region', '') || '').toUpperCase();
const KNOWN = Object.keys(CONFIG.regions);
if (!REGION_CODE) {
  console.error(`--region=CODE is required. Known: ${KNOWN.join(', ')}`);
  process.exit(1);
}
const REGION = CONFIG.regions[REGION_CODE];
if (!REGION) {
  console.error(`No region "${REGION_CODE}" in crypto-sources.json. Known: ${KNOWN.join(', ')}`);
  process.exit(1);
}

const RADIUS_M = Number(val('radius', CONFIG.scoring.radiusM));
const { atmWeight, merchantWeight, falloffPower } = CONFIG.scoring;
const OUT_DIR = path.join(process.cwd(), 'out');

/**
 * Smooth falloff: full weight at the lead's doorstep, zero at the radius edge.
 * An ATM two blocks away means far more than one at the edge of the ring.
 */
function falloff(distanceM) {
  if (distanceM >= RADIUS_M) return 0;
  return 1 - Math.pow(distanceM / RADIUS_M, falloffPower);
}

function percentileRanks(values) {
  // values: array of raw scores > 0. Returns Map(raw -> 1..100) using
  // midrank for ties. Single pass over the sorted array -- O(n log n).
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const map = new Map();

  let i = 0;
  while (i < n) {
    const v = sorted[i];
    let j = i;
    while (j < n && sorted[j] === v) j++;
    const below = i;
    const ties = j - i;
    const pct = (below + ties / 2) / n;
    map.set(v, Math.max(1, Math.round(pct * 100)));
    i = j;
  }

  return map;
}

(async function main() {
  console.log(`\nNectarPay crypto scoring${DRY_RUN ? '  [DRY RUN - no writes]' : ''}`);
  console.log(`region: ${REGION_CODE} (${REGION.name})`);
  console.log(`radius: ${RADIUS_M}m   atm:${atmWeight}  merchant:${merchantWeight}\n`);

  const supabase = getSupabase();

  const { data: regionRows, error: regionErr } = await supabase
    .from('regions').select('id, is_active').eq('code', REGION_CODE);
  if (regionErr) throw new Error(`Could not read regions: ${regionErr.message}`);
  if (!regionRows || regionRows.length !== 1) {
    throw new Error(`Expected exactly one region with code ${REGION_CODE}, found ${regionRows?.length ?? 0}.`);
  }
  const regionId = regionRows[0].id;

  const signals = await fetchAll(supabase, 'crypto_signals', 'id,signal_type,lat,lng,weight', {
    filter: (q) => q.eq('region_id', regionId),
  });
  console.log(`Loaded ${signals.length} crypto signals in ${REGION_CODE}`);
  if (signals.length === 0) {
    console.log(`No signals for ${REGION_CODE}. Run: node crypto/ingest.js --region=${REGION_CODE}`);
    return;
  }

  // The coordinate columns are named differently across this schema
  // (accounts uses latitude/longitude). Probe the likely pairs rather than
  // hardcoding, and report which one matched.
  // This table has no surrogate `id` column -- place_id is the key the
  // scraper upserts on and the CRM sync triggers join on, so it doubles as
  // the stable pagination sort. Coordinate column names also vary across
  // this schema (accounts uses latitude/longitude), so probe rather than
  // assume, and report what matched.
  const COORD_PAIRS = [
    ['latitude', 'longitude'],
    ['lat', 'lng'],
    ['lat', 'lon'],
    ['lat', 'long'],
  ];
  const EXTRAS = 'name,city,vertical';

  async function loadLeads() {
    const failures = [];
    for (const [latCol, lngCol] of COORD_PAIRS) {
      const attempts = [
        `place_id,${EXTRAS},${latCol},${lngCol}`,
        `place_id,${latCol},${lngCol}`,
      ];
      for (const cols of attempts) {
        try {
          const rows = await fetchAll(supabase, LEADS_TABLE, cols, {
            orderBy: 'place_id',
            filter: (q) => q.eq('region_id', regionId),
          });
          console.log(`Columns: place_id + ${latCol}/${lngCol}${cols.includes(EXTRAS) ? ' + name/city/vertical' : ''}`);
          return rows.map((r) => ({ ...r, lat: Number(r[latCol]), lng: Number(r[lngCol]) }));
        } catch (err) {
          failures.push(`${cols}: ${err.message}`);
        }
      }
    }
    throw new Error(
      `Could not read coordinates from ${LEADS_TABLE}. Tried:\n  ` +
        failures.join('\n  ') +
        `\n\nRun this in Supabase and send me the output:\n` +
        `  select column_name, data_type from information_schema.columns\n` +
        `   where table_schema='public' and table_name='${LEADS_TABLE}' order by ordinal_position;`
    );
  }

  const leads = await loadLeads();
  const geocoded = leads.filter((l) => l.place_id && Number.isFinite(l.lat) && Number.isFinite(l.lng));
  console.log(`Loaded ${leads.length} leads (${geocoded.length} with coordinates)\n`);

  const grid = new GridIndex(RADIUS_M, REGION.refLat);
  for (const s of signals) grid.add(s);

  const scored = [];
  for (const lead of geocoded) {
    let raw = 0;
    let atmCount = 0;
    let merchantCount = 0;
    let nearestAtm = null;

    for (const s of grid.near(lead.lat, lead.lng)) {
      const d = haversineMeters(lead.lat, lead.lng, s.lat, s.lng);
      if (d >= RADIUS_M) continue;

      const isAtm = s.signal_type === 'atm';
      if (isAtm) {
        atmCount++;
        if (nearestAtm === null || d < nearestAtm) nearestAtm = d;
      } else {
        merchantCount++;
      }

      raw += (Number(s.weight) || (isAtm ? atmWeight : merchantWeight)) * falloff(d);
    }

    scored.push({
      place_id: lead.place_id,
      name: lead.name,
      city: lead.city,
      vertical: lead.vertical,
      raw: Number(raw.toFixed(6)),
      atm_count: atmCount,
      merchant_count: merchantCount,
      nearest_atm_m: nearestAtm === null ? null : Number(nearestAtm.toFixed(1)),
    });
  }

  const nonzero = scored.filter((s) => s.raw > 0);
  const ranks = percentileRanks(nonzero.map((s) => s.raw));
  for (const s of scored) s.crypto_score = s.raw > 0 ? ranks.get(s.raw) : 0;

  // ---- summary --------------------------------------------------------
  const buckets = [0, 0, 0, 0, 0];
  for (const s of scored) {
    if (s.crypto_score === 0) buckets[0]++;
    else if (s.crypto_score < 40) buckets[1]++;
    else if (s.crypto_score < 70) buckets[2]++;
    else if (s.crypto_score < 90) buckets[3]++;
    else buckets[4]++;
  }
  console.log('Score distribution');
  console.log(`  0        (no signal nearby) : ${buckets[0]}`);
  console.log(`  1-39     (thin)             : ${buckets[1]}`);
  console.log(`  40-69    (moderate)         : ${buckets[2]}`);
  console.log(`  70-89    (dense)            : ${buckets[3]}`);
  console.log(`  90-100   (hottest corridor) : ${buckets[4]}`);

  const byCity = {};
  for (const s of scored) {
    const c = s.city || 'unknown';
    byCity[c] = byCity[c] || { n: 0, sum: 0 };
    byCity[c].n++;
    byCity[c].sum += s.crypto_score;
  }
  console.log('\nMean crypto_score by city');
  Object.entries(byCity)
    .map(([c, v]) => [c, v.sum / v.n, v.n])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .forEach(([c, mean, n]) => console.log(`  ${c.padEnd(16)} ${mean.toFixed(1).padStart(5)}  (n=${n})`));

  // ---- output ---------------------------------------------------------
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, 'crypto-scores.csv');
  const cols = ['place_id', 'name', 'city', 'vertical', 'crypto_score', 'raw', 'atm_count', 'merchant_count', 'nearest_atm_m'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  fs.writeFileSync(
    file,
    [cols.join(','), ...scored.map((s) => cols.map((c) => esc(s[c])).join(','))].join('\n'),
    'utf8'
  );
  console.log(`\nWrote ${scored.length} rows -> ${file}`);

  if (DRY_RUN) {
    console.log('Dry run complete. Re-run without --dry-run to write scores to Supabase.');
    return;
  }

  const CHUNK = 500;
  let touched = 0;
  for (let i = 0; i < scored.length; i += CHUNK) {
    const payload = scored.slice(i, i + CHUNK).map((s) => ({
      place_id: s.place_id,
      crypto_score: s.crypto_score,
      atm_count: s.atm_count,
      merchant_count: s.merchant_count,
      nearest_atm_m: s.nearest_atm_m,
    }));
    const { data, error } = await supabase.rpc('apply_crypto_scores', { payload });
    if (error) throw new Error(`apply_crypto_scores: ${error.message}`);
    touched += data ?? 0;
    console.log(`  wrote ${Math.min(i + CHUNK, scored.length)}/${scored.length}`);
  }

  console.log(`\nDone. ${touched} lead rows updated.`);

  // Push the scores through to the CRM's accounts table so they're sortable
  // and filterable in the UI, not just on the map. No-op until migration 019
  // has been applied.
  const { data: synced, error: syncErr } = await supabase.rpc('sync_crypto_to_accounts');
  if (syncErr) {
    console.warn(`\n  ! account sync skipped: ${syncErr.message}`);
    console.warn('  ! (run sql/019_crypto_accounts_sync.sql to enable it)');
  } else {
    console.log(`Synced crypto scores to ${synced ?? 0} CRM accounts.`);
  }
})().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
