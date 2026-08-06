import "dotenv/config";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { textSearch } from "./places.js";
import { harvestSite, nameFromEmail } from "./enrichEmails.js";
import { scoreLead, assignBands, verticalWeightCache } from "./score.js";
import { writeCsv } from "./csv.js";
import { upsertLeads } from "./supabase.js";
import type { Targets, Lead } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// --- CLI flags ---------------------------------------------------------
// npm run scrape                          -> all verticals, all cities
// npm run scrape -- --vertical smoke-vape -> one vertical
// npm run scrape -- --city "Tempe AZ"     -> one city
// npm run scrape -- --no-emails           -> skip site enrichment (fast pass)
const argv = process.argv.slice(2);
function flagValue(name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}
const onlyVertical = flagValue("vertical");
const onlyCity = flagValue("city");
const skipEnrich = argv.includes("--no-emails");

async function main() {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.error("Missing GOOGLE_PLACES_API_KEY in .env");
    process.exit(1);
  }

  const targets: Targets = JSON.parse(
    readFileSync(join(ROOT, "config", "targets.json"), "utf8")
  );

  const verticals = onlyVertical
    ? targets.verticals.filter((v) => v.key === onlyVertical)
    : targets.verticals;
  const cities = onlyCity
    ? targets.cities.filter((c) => c.toLowerCase() === onlyCity.toLowerCase())
    : targets.cities;

  if (verticals.length === 0) {
    console.error(`No vertical matches "${onlyVertical}". Keys: ${targets.verticals.map((v) => v.key).join(", ")}`);
    process.exit(1);
  }

  for (const v of targets.verticals) verticalWeightCache.set(v.key, v.weight);

  const byPlaceId = new Map<string, Lead>();
  const now = new Date().toISOString();

  for (const vertical of verticals) {
    for (const city of cities) {
      for (const q of vertical.queries) {
        const textQuery = `${q} in ${city}`;
        process.stdout.write(`Searching: ${textQuery} ... `);
        const places = await textSearch(apiKey, textQuery);
        console.log(`${places.length} results`);

        for (const p of places) {
          if (!p.id || byPlaceId.has(p.id)) continue;
          if (p.businessStatus && p.businessStatus !== "OPERATIONAL") continue;
          // Google sometimes ignores the state qualifier and returns
          // name-matched cities elsewhere (Peoria IL, Glendale CA, Mesa WA).
          // Arizona only.
          if (!/,\s*AZ\b/.test(p.formattedAddress ?? "")) continue;

          const partial = {
            place_id: p.id,
            name: p.displayName?.text ?? "",
            address: p.formattedAddress ?? "",
            city,
            phone: p.nationalPhoneNumber ?? "",
            website: p.websiteUri ?? "",
            emails: [] as string[],
            latitude: p.location?.latitude ?? null,
            longitude: p.location?.longitude ?? null,
            owner_first_name: null as string | null,
            owner_last_name: null as string | null,
            owner_name_source: null as Lead["owner_name_source"],
            rating: p.rating ?? null,
            review_count: p.userRatingCount ?? 0,
            vertical: vertical.key,
            vertical_label: vertical.label,
            source_query: textQuery,
            scraped_at: now,
          };
          byPlaceId.set(p.id, {
            ...partial,
            score: scoreLead(partial),
            band: "COOL", // placeholder - real bands assigned after enrichment
          });
        }
      }
    }
  }

  let leads = [...byPlaceId.values()];
  console.log(`\n${leads.length} unique businesses found.`);

  // --- Site enrichment: emails + owner names (concurrency-limited) -----
  if (!skipEnrich) {
    const withSites = leads.filter((l) => l.website);
    console.log(`Enriching ${withSites.length} sites (emails + owner names)...`);
    const CONCURRENCY = 8;
    let done = 0;
    for (let i = 0; i < withSites.length; i += CONCURRENCY) {
      const batch = withSites.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (lead) => {
          const info = await harvestSite(lead.website, lead.name);
          lead.emails = info.emails;
          lead.owner_first_name = info.ownerFirst;
          lead.owner_last_name = info.ownerLast;
          lead.owner_name_source = info.ownerSource;
          done++;
          if (done % 25 === 0) console.log(`  ...${done}/${withSites.length}`);
        })
      );
    }

    const withEmail = leads.filter((l) => l.emails.length > 0).length;
    const withName = leads.filter((l) => l.owner_first_name).length;
    const fromSite = leads.filter((l) => l.owner_name_source === "site").length;
    console.log(`Email found for ${withEmail}/${leads.length} leads.`);
    console.log(`Owner name found for ${withName}/${leads.length} leads (${fromSite} from site, ${withName - fromSite} from email).`);
  }

  // --- Final scoring + percentile banding ------------------------------
  leads = leads.map((l) => ({ ...l, score: scoreLead(l) }));
  assignBands(leads);

  // --- Output ----------------------------------------------------------
  leads.sort((a, b) => b.score - a.score);
  mkdirSync(join(ROOT, "out"), { recursive: true });
  const stamp = now.slice(0, 10);
  const suffix = onlyVertical ? `-${onlyVertical}` : "";
  const csvPath = join(ROOT, "out", `nectarpay-leads-${stamp}${suffix}.csv`);
  writeCsv(csvPath, leads);
  console.log(`CSV written: ${csvPath}`);

  const hot = leads.filter((l) => l.band === "HOT").length;
  const warm = leads.filter((l) => l.band === "WARM").length;
  console.log(`Bands: ${hot} HOT / ${warm} WARM / ${leads.length - hot - warm} COOL`);

  await upsertLeads(leads, { includeEnrichment: !skipEnrich });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
