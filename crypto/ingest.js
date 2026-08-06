#!/usr/bin/env node
/**
 * crypto/ingest.js
 *
 * Collects Arizona crypto touchpoints into the crypto_signals table:
 *   - crypto ATMs        via Google Places API (New) Text Search
 *   - accepting merchants via OpenStreetMap / Overpass (the BTC Map dataset)
 *
 * Usage (PowerShell, from the repo root):
 *   node crypto/ingest.js --dry-run
 *   node crypto/ingest.js
 *   node crypto/ingest.js --source=osm
 *   node crypto/ingest.js --source=places --no-brands
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM has no __dirname
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { textSearch } from './lib/places.js';
import { fetchOsmCryptoPlaces } from './lib/overpass.js';
import { getSupabase, getPlacesKey, fetchAll } from './lib/db.js';
import { inArizona, haversineMeters } from './lib/geo.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};

const DRY_RUN = has('--dry-run');
const SOURCE = val('source', 'all').toLowerCase();
const CITIES_FROM_LEADS = has('--cities-from-leads');
const LEADS_TABLE = 'nectarpay_leads';
const USE_BRANDS = !has('--no-brands');
const OUT_DIR = path.join(process.cwd(), 'out');

const CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'config', 'crypto-sources.json'), 'utf8')
);

// ---------------------------------------------------------------------------

function detectBrand(name) {
  const n = (name || '').toLowerCase();
  return CONFIG.atmBrands.find((b) => n.includes(b)) || null;
}

/**
 * Google tags EVERY bank ATM with the place type `atm`, so a text search for
 * "bitcoin atm" comes back full of Chase and Wells Fargo machines. The place
 * type is therefore worthless as evidence -- the name has to actually say
 * crypto, or match a known kiosk operator.
 *
 * Returns null when it's not a crypto ATM, otherwise the reason it matched.
 */
function classifyAtm(name) {
  const n = (name || '').toLowerCase().trim();
  if (!n) return null;

  if (CONFIG.notCrypto.some((bad) => n.includes(bad))) return null;

  const brand = detectBrand(n);
  if (brand) return `brand:${brand}`;

  const token = CONFIG.cryptoTokens.find((t) => n.includes(t));
  if (token) return `token:${token}`;

  return null;
}

function looksLikeAtm(name) {
  return classifyAtm(name) !== null;
}

/** Counter services get a lower weight -- see counterServiceBrands in config. */
function atmWeightFor(name) {
  const n = (name || '').toLowerCase();
  return CONFIG.counterServiceBrands.some((b) => n.includes(b))
    ? CONFIG.scoring.counterServiceWeight
    : CONFIG.scoring.atmWeight;
}

function cityFromAddress(addr) {
  if (!addr) return null;
  const parts = addr.split(',').map((p) => p.trim());
  return parts.length >= 3 ? parts[parts.length - 3] : null;
}

// ---------------------------------------------------------------------------

/**
 * Derive the sweep list from the lead table instead of the config. The
 * config drifted once already -- it swept Buckeye, which has no leads, and
 * missed Prescott, which has 665 -- so every Prescott lead was scored
 * against merchants only and came out systematically low.
 */
async function citiesFromLeads() {
  const supabase = getSupabase();
  const rows = await fetchAll(supabase, LEADS_TABLE, 'city,latitude,longitude', {
    orderBy: 'place_id',
  });

  const groups = new Map();
  for (const r of rows) {
    const lat = Number(r.latitude);
    const lng = Number(r.longitude);
    if (!r.city || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const key = String(r.city).trim();
    const g = groups.get(key) || [];
    g.push([lat, lng]);
    groups.set(key, g);
  }

  const cities = [];
  for (const [name, pts] of groups) {
    const lat = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const lng = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    // radius = 95th percentile spread, so one stray lead can't blow it up
    const dists = pts.map(([a, b]) => haversineMeters(lat, lng, a, b)).sort((x, y) => x - y);
    const p95 = dists[Math.floor(dists.length * 0.95)] || 0;
    const radiusM = Math.min(50000, Math.max(8000, Math.round(p95 * 1.15)));
    cities.push({ name, lat, lng, radiusM, leadCount: pts.length });
  }

  cities.sort((a, b) => b.leadCount - a.leadCount);
  console.log(`  derived ${cities.length} cities from ${LEADS_TABLE}:`);
  for (const c of cities) {
    console.log(`    ${c.name.padEnd(18)} ${String(c.leadCount).padStart(5)} leads   r=${(c.radiusM / 1000).toFixed(0)}km`);
  }
  return cities;
}

async function collectPlaces(cities) {
  const apiKey = getPlacesKey();
  const queries = USE_BRANDS
    ? [...CONFIG.queries, ...CONFIG.brandQueries]
    : CONFIG.queries;

  const byId = new Map();
  const rejected = [];
  const rejectedIds = new Set();
  let calls = 0;

  for (const city of cities) {
    let cityHits = 0;
    for (const query of queries) {
      let places;
      try {
        places = await textSearch({
          apiKey,
          query,
          lat: city.lat,
          lng: city.lng,
          radiusM: city.radiusM,
        });
        calls++;
      } catch (err) {
        console.warn(`  ! ${city.name} / "${query}": ${err.message}`);
        continue;
      }

      for (const p of places) {
        const lat = p.location?.latitude;
        const lng = p.location?.longitude;
        if (!inArizona(lat, lng)) continue; // reject out-of-state name matches
        if (p.businessStatus === 'CLOSED_PERMANENTLY') continue;

        const name = p.displayName?.text || null;
        const why = classifyAtm(name);
        if (!why) {
          if (!rejectedIds.has(p.id)) {
            rejectedIds.add(p.id);
            rejected.push({ name, address: p.formattedAddress || '', city: city.name, query });
          }
          continue;
        }
        if (byId.has(p.id)) continue;

        byId.set(p.id, {
          source: 'google_places',
          source_id: p.id,
          signal_type: 'atm',
          name,
          brand: detectBrand(name),
          address: p.formattedAddress || null,
          city: cityFromAddress(p.formattedAddress) || city.name,
          lat,
          lng,
          weight: atmWeightFor(name),
          raw: { types: p.types || [], query, searchCity: city.name, matchedOn: why },
        });
        cityHits++;
      }
    }
    console.log(`  ${city.name.padEnd(12)} ${String(cityHits).padStart(4)} ATM hits`);
  }

  console.log(`  -> ${byId.size} crypto ATMs kept, ${rejected.length} non-crypto rejected, from ${calls} Places calls`);

  if (rejected.length) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, 'crypto-rejected.csv');
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    fs.writeFileSync(
      file,
      ['name,address,city,query', ...rejected.map((r) => [r.name, r.address, r.city, r.query].map(esc).join(','))].join('\n'),
      'utf8'
    );
    console.log(`  -> rejects logged to ${file} (check it -- a real kiosk in there means the filter is too tight)`);
  }

  return [...byId.values()];
}

async function collectOsm() {
  const elements = await fetchOsmCryptoPlaces();
  const rows = [];

  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (!inArizona(lat, lng)) continue;

    const tags = el.tags || {};
    const name = tags.name || tags.operator || null;
    const isAtm = tags.amenity === 'atm' || looksLikeAtm(name);

    const addrParts = [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']]
      .filter(Boolean)
      .join(' ');

    rows.push({
      source: 'osm',
      source_id: `${el.type}/${el.id}`,
      signal_type: isAtm ? 'atm' : 'merchant',
      name,
      brand: detectBrand(name),
      address: addrParts || null,
      city: tags['addr:city'] || null,
      lat,
      lng,
      weight: isAtm ? atmWeightFor(name) : CONFIG.scoring.merchantWeight,
      raw: { tags },
    });
  }

  const atms = rows.filter((r) => r.signal_type === 'atm').length;
  console.log(`  -> ${rows.length} OSM crypto places in AZ (${atms} ATM, ${rows.length - atms} merchant)`);
  return rows;
}

/** Drop OSM rows that duplicate a Google row at the same physical spot. */
function dedupeCrossSource(rows) {
  const google = rows.filter((r) => r.source === 'google_places');
  const others = rows.filter((r) => r.source !== 'google_places');
  const limit = CONFIG.scoring.dedupeMeters;

  const kept = others.filter((o) => {
    return !google.some(
      (g) =>
        g.signal_type === o.signal_type &&
        haversineMeters(g.lat, g.lng, o.lat, o.lng) <= limit
    );
  });

  const dropped = others.length - kept.length;
  if (dropped) console.log(`  -> deduped ${dropped} overlapping OSM rows`);
  return [...google, ...kept];
}

// ---------------------------------------------------------------------------

function writeCsv(rows) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, 'crypto-signals.csv');
  const cols = ['source', 'source_id', 'signal_type', 'name', 'brand', 'address', 'city', 'lat', 'lng', 'weight'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  fs.writeFileSync(file, csv, 'utf8');
  console.log(`\nWrote ${rows.length} rows -> ${file}`);
}

async function upsert(rows) {
  const supabase = getSupabase();
  const CHUNK = 500;
  let done = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK).map((r) => ({ ...r, last_seen_at: new Date().toISOString() }));
    const { error } = await supabase
      .from('crypto_signals')
      .upsert(batch, { onConflict: 'source,source_id' });
    if (error) throw new Error(`upsert crypto_signals: ${error.message}`);
    done += batch.length;
    console.log(`  upserted ${done}/${rows.length}`);
  }
}

// ---------------------------------------------------------------------------

(async function main() {
  console.log(`\nNectarPay crypto signal ingest${DRY_RUN ? '  [DRY RUN - no writes]' : ''}`);
  console.log(`source: ${SOURCE}\n`);

  let rows = [];

  if (SOURCE === 'all' || SOURCE === 'places') {
    let cities = CONFIG.cities;
    if (CITIES_FROM_LEADS) {
      console.log(`Deriving sweep list from ${LEADS_TABLE}`);
      cities = await citiesFromLeads();
      console.log('');
    }
    console.log('Google Places -- crypto ATMs');
    rows.push(...(await collectPlaces(cities)));
  }

  if (SOURCE === 'all' || SOURCE === 'osm') {
    console.log('\nOpenStreetMap / Overpass -- bitcoin-accepting places');
    try {
      rows.push(...(await collectOsm()));
    } catch (err) {
      console.warn(`  ! OSM pass failed: ${err.message}`);
    }
  }

  if (rows.length === 0) {
    console.log('\nNo signals collected. Nothing written.');
    return;
  }

  rows = dedupeCrossSource(rows);

  const atms = rows.filter((r) => r.signal_type === 'atm').length;
  console.log(`\nTotal: ${rows.length} signals  (${atms} ATM, ${rows.length - atms} merchant)`);

  const byBrand = {};
  for (const r of rows.filter((x) => x.signal_type === 'atm')) {
    const k = r.brand || '(unbranded - name matched a crypto keyword)';
    byBrand[k] = (byBrand[k] || 0) + 1;
  }
  console.log('\nATMs by operator');
  Object.entries(byBrand)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));

  if (DRY_RUN) {
    writeCsv(rows);
    console.log('Dry run complete. Re-run without --dry-run to write to Supabase.');
    return;
  }

  writeCsv(rows);
  await upsert(rows);
  console.log('\nDone. Next: node crypto/score.js --dry-run');
})().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
