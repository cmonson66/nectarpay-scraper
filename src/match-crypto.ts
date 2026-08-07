// Convert crypto-density MERCHANT signals (OSM-tagged crypto-accepting
// businesses) into full leads — the warmest list in the database.
//
//   npm run match-crypto            # do it
//   npm run match-crypto -- --dry   # show matches, write nothing
//
// For each merchant signal: Places text search biased to its coordinates,
// then a confidence gate (distance + name similarity). Confident matches:
//   · already a lead  -> flag crypto_native=true, promote to HOT
//   · new             -> insert as vertical 'crypto-native', HOT, with
//                        site harvest for email/owner
// Ambiguous/missed matches land in out/crypto-match-review.csv for a
// human eyeball — never guessed.
//
// Requires sql/030_crypto_native.sql first (adds the crypto_native flag).

import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { harvestSite } from "./enrichEmails.js";
import type { Lead } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DRY = process.argv.includes("--dry");

type Signal = {
  id: string;
  name: string;
  brand: string | null;
  city: string | null;
  lat: number;
  lng: number;
};

type PlaceHit = {
  id?: string;
  displayName?: { text: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  websiteUri?: string;
  nationalPhoneNumber?: string;
  rating?: number;
  userRatingCount?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

function nameSimilar(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(" ").filter((w) => w.length > 2));
  const tb = new Set(nb.split(" ").filter((w) => w.length > 2));
  if (ta.size === 0 || tb.size === 0) return false;
  let overlap = 0;
  for (const w of ta) if (tb.has(w)) overlap++;
  return overlap / Math.min(ta.size, tb.size) >= 0.5;
}

function cityFromAddress(addr: string, fallback: string | null): string {
  // "123 Main St, Phoenix, AZ 85001, USA" -> "Phoenix AZ"
  const parts = addr.split(",").map((p) => p.trim());
  const azIdx = parts.findIndex((p) => /^AZ\b/.test(p));
  if (azIdx > 0) return `${parts[azIdx - 1]} AZ`;
  return fallback ? `${fallback.replace(/\s+AZ$/, "")} AZ` : "Phoenix AZ";
}

async function searchNear(apiKey: string, query: string, lat: number, lng: number): Promise<PlaceHit[]> {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.websiteUri,places.nationalPhoneNumber,places.rating,places.userRatingCount",
    },
    body: JSON.stringify({
      textQuery: query,
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 500 } },
      pageSize: 5,
    }),
  });
  if (!res.ok) {
    console.error(`  ! Places ${res.status} for "${query}"`);
    return [];
  }
  const data = (await res.json()) as { places?: PlaceHit[] };
  return data.places ?? [];
}

async function main() {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!apiKey || !url || !key) {
    console.error("Missing GOOGLE_PLACES_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const { data: signals, error } = await supabase
    .from("crypto_signals")
    .select("id, name, brand, city, lat, lng")
    .eq("signal_type", "merchant");
  if (error) {
    console.error("crypto_signals read failed:", error.message);
    process.exit(1);
  }
  console.log(`${signals?.length ?? 0} merchant signals to match${DRY ? " (DRY RUN)" : ""}.`);

  const review: string[] = ["signal_name,signal_city,reason,best_candidate,candidate_address"];
  let flagged = 0, inserted = 0, unmatched = 0, already = 0;

  for (const sig of (signals ?? []) as Signal[]) {
    const q = sig.brand && norm(sig.brand) !== norm(sig.name) ? `${sig.name}` : sig.name;
    const hits = await searchNear(apiKey, q, sig.lat, sig.lng);
    await sleep(120);

    // Confidence gate: close by AND similarly named
    const match = hits.find(
      (h) =>
        h.id &&
        h.location &&
        haversineM(sig.lat, sig.lng, h.location.latitude, h.location.longitude) <= 400 &&
        nameSimilar(sig.name, h.displayName?.text ?? "")
    );

    if (!match || !match.id) {
      unmatched++;
      const best = hits[0];
      review.push(
        `"${sig.name}","${sig.city ?? ""}",${match ? "no_id" : "no_confident_match"},"${best?.displayName?.text ?? ""}","${best?.formattedAddress ?? ""}"`
      );
      continue;
    }
    if (!/,\s*AZ\b/.test(match.formattedAddress ?? "")) {
      unmatched++;
      review.push(`"${sig.name}","${sig.city ?? ""}",non_az,"${match.displayName?.text}","${match.formattedAddress}"`);
      continue;
    }

    const { data: existing } = await supabase
      .from("nectarpay_leads")
      .select("place_id, crypto_native, band, name")
      .eq("place_id", match.id)
      .maybeSingle();

    if (existing) {
      if (existing.crypto_native) { already++; continue; }
      console.log(`  FLAG  ${existing.name} — already a lead, now marked crypto-native + HOT`);
      flagged++;
      if (!DRY) {
        await supabase
          .from("nectarpay_leads")
          .update({ crypto_native: true, band: "HOT" })
          .eq("place_id", match.id);
      }
      continue;
    }

    // Fresh crypto-native lead — harvest their site if they have one
    const website = match.websiteUri ?? "";
    let emails: string[] = [];
    let ownerFirst: string | null = null;
    let ownerLast: string | null = null;
    let ownerSource: Lead["owner_name_source"] = null;
    if (website && !DRY) {
      const info = await harvestSite(website, match.displayName?.text ?? sig.name);
      emails = info.emails;
      ownerFirst = info.ownerFirst;
      ownerLast = info.ownerLast;
      ownerSource = info.ownerSource;
    }

    console.log(
      `  NEW   ${match.displayName?.text} (${cityFromAddress(match.formattedAddress ?? "", sig.city)})` +
        (emails.length ? ` · ${emails.length} email(s)` : "")
    );
    inserted++;
    if (!DRY) {
      const { error: insErr } = await supabase.from("nectarpay_leads").insert({
        place_id: match.id,
        name: match.displayName?.text ?? sig.name,
        address: match.formattedAddress ?? "",
        city: cityFromAddress(match.formattedAddress ?? "", sig.city),
        phone: match.nationalPhoneNumber ?? "",
        website,
        emails,
        latitude: match.location?.latitude ?? null,
        longitude: match.location?.longitude ?? null,
        owner_first_name: ownerFirst,
        owner_last_name: ownerLast,
        owner_name_source: ownerSource,
        rating: match.rating ?? null,
        review_count: match.userRatingCount ?? 0,
        vertical: "crypto-native",
        vertical_label: "Crypto Native",
        source_query: "crypto-map",
        score: 16,
        band: "HOT",
        status: "NEW",
        crypto_native: true,
        scraped_at: new Date().toISOString(),
      });
      if (insErr) console.error(`  ! insert failed for ${match.displayName?.text}: ${insErr.message}`);
    }
  }

  // Bridge the flag to CRM accounts (031 defines the function)
  if (!DRY) {
    const { data: synced, error: syncErr } = await supabase.rpc("sync_crypto_native");
    if (syncErr) console.error("  ! sync_crypto_native failed:", syncErr.message);
    else console.log(`CRM accounts flagged: ${synced}`);
  }

  mkdirSync(join(ROOT, "out"), { recursive: true });
  writeFileSync(join(ROOT, "out", "crypto-match-review.csv"), review.join("\n"), "utf8");
  console.log(
    `\nDone: ${inserted} new crypto-native leads, ${flagged} existing leads flagged, ` +
      `${already} already flagged, ${unmatched} for review (out/crypto-match-review.csv).`
  );
}

main().catch((err) => { console.error(err); process.exit(1); });
