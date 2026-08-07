// Recover a scrape from its CSV without re-running the searches.
//
//   npm run import -- "out/nectarpay-leads-2026-08-07.csv"
//
// Reads the CSV, resolves vertical labels back to keys, and upserts through
// the same (fixed) upsertLeads path. Coordinates aren't in older CSVs, so
// for leads the database doesn't already know, it backfills lat/lng with a
// location-only Place Details call (cheap SKU) before upserting. Leads the
// DB already has keep their stored coords and classification.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { upsertLeads } from "./supabase.js";
import type { Lead, Targets } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ---- RFC4180-ish parser (quotes, escaped quotes, newlines in quotes) ----
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchLocation(apiKey: string, placeId: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "location" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { location?: { latitude: number; longitude: number } };
    if (!data.location) return null;
    return { lat: data.location.latitude, lng: data.location.longitude };
  } catch {
    return null;
  }
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: npm run import -- "out/nectarpay-leads-YYYY-MM-DD.csv"');
    process.exit(1);
  }

  const targets: Targets = JSON.parse(readFileSync(join(ROOT, "config", "targets.json"), "utf8"));
  const keyByLabel = new Map(targets.verticals.map((v) => [v.label, v.key]));
  const labelByKey = new Map(targets.verticals.map((v) => [v.key, v.label]));

  const rows = parseCsv(readFileSync(csvPath, "utf8"));
  const headers = rows[0];
  const col = (name: string) => headers.indexOf(name);
  const c = {
    band: col("band"), score: col("score"), vertical: col("vertical"),
    name: col("name"), owner: col("owner_name"), address: col("address"),
    city: col("city"), phone: col("phone"), emails: col("emails"),
    website: col("website"), rating: col("rating"), reviews: col("review_count"),
    source: col("source_query"), place: col("place_id"), scraped: col("scraped_at"),
    // Newer CSVs carry these; older ones don't
    vkey: col("vertical_key"), lat: col("latitude"), lng: col("longitude"),
    ofirst: col("owner_first"), olast: col("owner_last"), osource: col("owner_source"),
  };

  const leads: Lead[] = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const placeId = r[c.place];
    if (!placeId) { skipped++; continue; }
    const vkey = c.vkey >= 0 && r[c.vkey] ? r[c.vkey] : keyByLabel.get(r[c.vertical]);
    if (!vkey) { skipped++; continue; }

    let ownerFirst: string | null = null;
    let ownerLast: string | null = null;
    let ownerSource: Lead["owner_name_source"] = null;
    if (c.ofirst >= 0 && r[c.ofirst]) {
      ownerFirst = r[c.ofirst] || null;
      ownerLast = r[c.olast] || null;
      ownerSource = (r[c.osource] as Lead["owner_name_source"]) || null;
    } else if (r[c.owner]) {
      const parts = r[c.owner].trim().split(/\s+/);
      ownerFirst = parts[0] ?? null;
      ownerLast = parts.slice(1).join(" ") || null;
      ownerSource = "site"; // best available guess for legacy CSVs
    }

    leads.push({
      place_id: placeId,
      name: r[c.name],
      address: r[c.address],
      city: r[c.city],
      phone: r[c.phone],
      website: r[c.website],
      emails: r[c.emails] ? r[c.emails].split(";").map((e) => e.trim()).filter(Boolean) : [],
      latitude: c.lat >= 0 && r[c.lat] ? Number(r[c.lat]) : null,
      longitude: c.lng >= 0 && r[c.lng] ? Number(r[c.lng]) : null,
      owner_first_name: ownerFirst,
      owner_last_name: ownerLast,
      owner_name_source: ownerSource,
      rating: r[c.rating] ? Number(r[c.rating]) : null,
      review_count: r[c.reviews] ? Number(r[c.reviews]) : 0,
      vertical: vkey,
      vertical_label: labelByKey.get(vkey) ?? r[c.vertical],
      source_query: r[c.source] || "csv-import",
      score: r[c.score] ? Number(r[c.score]) : 0,
      band: (r[c.band] as Lead["band"]) || "COOL",
      scraped_at: r[c.scraped] || new Date().toISOString(),
    });
  }
  console.log(`Parsed ${leads.length} leads from CSV (${skipped} rows skipped).`);

  // ---- Coordinate backfill: only for leads the DB doesn't already have ----
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!url || !key) { console.error("Supabase env missing."); process.exit(1); }
  const supabase = createClient(url, key);

  const known = new Set<string>();
  const ids = leads.map((l) => l.place_id);
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await supabase
      .from("nectarpay_leads")
      .select("place_id")
      .in("place_id", ids.slice(i, i + 500));
    for (const row of data ?? []) known.add(row.place_id);
  }

  const needCoords = leads.filter((l) => !known.has(l.place_id) && l.latitude == null);
  console.log(`${known.size} already in DB (coords kept) · ${needCoords.length} new leads need coordinates.`);

  if (needCoords.length > 0) {
    if (!apiKey) {
      console.error("GOOGLE_PLACES_API_KEY missing — cannot backfill coordinates. Aborting before upsert.");
      process.exit(1);
    }
    let done = 0, failed = 0;
    for (const l of needCoords) {
      const loc = await fetchLocation(apiKey, l.place_id);
      if (loc) { l.latitude = loc.lat; l.longitude = loc.lng; }
      else failed++;
      done++;
      if (done % 250 === 0) console.log(`  coords ${done}/${needCoords.length} (${failed} failed)`);
      await sleep(60);
    }
    console.log(`Coordinate backfill complete: ${needCoords.length - failed} filled, ${failed} unresolved (imported without coords).`);
  }

  await upsertLeads(leads, { includeEnrichment: true });
  console.log("Import complete.");
}

main().catch((err) => { console.error(err); process.exit(1); });
