// Manually plant a door card for a business Eric meets in the field.
//
//   npm run card -- "Legends Bar & Grill" "Anthem AZ"
//   npm run card -- "Some Shop" "Mesa AZ" --vertical smoke-vape
//   npm run card -- "Some Shop" "Mesa AZ" --pick 2      (choose 2nd match)
//
// Looks the business up on Google Places, infers the vertical, inserts a
// HOT lead (which auto-creates the CRM account + contact and mints the
// Pulse token), harvests the site for email/owner, and prints the card URL.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { textSearch } from "./places.js";
import { harvestSite } from "./enrichEmails.js";
import { scoreLead, verticalWeightCache } from "./score.js";
import type { Targets, Lead } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PULSE_BASE = process.env.PULSE_BASE_URL ?? "https://nectarpayaz.com";

// Google place types -> our vertical keys
const TYPE_MAP: [RegExp, string][] = [
  [/bar|restaurant|cafe|coffee|bakery|food|meal|night_club|brewery|brewpub/, "food-drink"],
  [/barber|hair_salon|hair_care/, "barber"],
  [/jewelry|pawn/, "jewelry-gold"],
  [/car_repair|car_wash|auto_parts|car_detail/, "auto"],
  [/gym|fitness/, "gym-supps"],
  [/shoe_store|clothing_store/, "sneaker-street"],
  [/book_store|hobby/, "collectibles"],
  [/motorcycle|atv/, "powersports"],
  [/cell_phone|electronics_store/, "phone-repair"],
  [/cigar/, "cigar-hookah"],
  [/tattoo|piercing/, "tattoo"],
  [/gun|sporting_goods/, "firearms"],
];

// Business-name hints beat types (Google files smoke shops under plain "store")
const NAME_MAP: [RegExp, string][] = [
  [/smoke|vape|cbd|dispensar|cannabis|head\s?shop/i, "smoke-vape"],
  [/kava|kratom/i, "kava-kratom"],
  [/cigar|hookah|shisha/i, "cigar-hookah"],
  [/tattoo|piercing|ink\b/i, "tattoo"],
  [/gun|firearm|ammo|tactical|pawn.*gun/i, "firearms"],
  [/barber/i, "barber"],
  [/jewel|gold|coin|bullion|pawn/i, "jewelry-gold"],
  [/repair.*(phone|cell|computer|screen)|(phone|cell|computer).*repair|ifix/i, "phone-repair"],
  [/card|comic|collectib|hobby/i, "collectibles"],
  [/sneaker|streetwear|kicks/i, "sneaker-street"],
  [/tint|detail|auto|car care|glass/i, "auto"],
  [/motorcycle|powersport|atv|utv/i, "powersports"],
  [/gym|muay|jiu|boxing|crossfit|supplement|nutrition/i, "gym-supps"],
  [/bar\b|grill|tavern|pub|coffee|cafe|brew/i, "food-drink"],
];

function inferVertical(name: string, types: string[]): string | null {
  for (const [re, v] of NAME_MAP) if (re.test(name)) return v;
  const joined = types.join(" ");
  for (const [re, v] of TYPE_MAP) if (re.test(joined)) return v;
  return null;
}

function flagValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const vertOverride = flagValue(argv, "vertical");
  const pick = Number(flagValue(argv, "pick") ?? "1");
  const flagVals = new Set([vertOverride, flagValue(argv, "pick")].filter(Boolean));
  const args = argv.filter((a) => !a.startsWith("--") && !flagVals.has(a));
  if (args.length < 2) {
    console.error('Usage: npm run card -- "Business Name" "City AZ" [--vertical key] [--pick N]');
    process.exit(1);
  }
  const bizName = args.slice(0, -1).join(" ");
  const city = args[args.length - 1];

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!apiKey || !supaUrl || !supaKey) {
    console.error("Missing GOOGLE_PLACES_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
  }
  const supabase = createClient(supaUrl, supaKey);

  const targets: Targets = JSON.parse(readFileSync(join(ROOT, "config", "targets.json"), "utf8"));
  for (const v of targets.verticals) verticalWeightCache.set(v.key, v.weight);
  const labelFor = (key: string) =>
    targets.verticals.find((v) => v.key === key)?.label ?? key;

  console.log(`Searching: ${bizName} in ${city} ...`);
  const places = (await textSearch(apiKey, `${bizName} in ${city}`, 1)).slice(0, 3);
  if (places.length === 0) {
    console.error("No Places results. Check spelling / try adding the street.");
    process.exit(1);
  }

  places.forEach((p, i) =>
    console.log(`  ${i + 1}. ${p.displayName?.text} — ${p.formattedAddress}`)
  );
  const p = places[Math.min(Math.max(pick, 1), places.length) - 1];
  console.log(`\nUsing #${Math.min(pick, places.length)}: ${p.displayName?.text}`);

  if (!p.id) {
    console.error("Result has no place id — bailing.");
    process.exit(1);
  }
  if (!/,\s*AZ\b/.test(p.formattedAddress ?? "")) {
    console.error(`Not an Arizona address: ${p.formattedAddress}`);
    process.exit(1);
  }

  const vertical =
    vertOverride ?? inferVertical(p.displayName?.text ?? bizName, p.types ?? []);
  if (!vertical || !targets.verticals.some((v) => v.key === vertical)) {
    console.error(
      `Couldn't infer the vertical — rerun with --vertical <key>. Keys: ${targets.verticals.map((v) => v.key).join(", ")}`
    );
    process.exit(1);
  }
  console.log(`Vertical: ${vertical} (${labelFor(vertical)})`);

  // Already in the pool? Promote to HOT, never clobber status/history.
  const { data: existing } = await supabase
    .from("nectarpay_leads")
    .select("place_id, name, status, band, pulse_token")
    .eq("place_id", p.id)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("nectarpay_leads")
      .update({ band: "HOT", source_query: "manual: Eric prospect" })
      .eq("place_id", p.id);
    console.log(`\nAlready in the pool (status ${existing.status}) — promoted to HOT.`);
    console.log(`\n  CARD: ${PULSE_BASE}/s/${existing.pulse_token}\n`);
    return;
  }

  // Enrich from their site if they have one
  const website = p.websiteUri ?? "";
  let emails: string[] = [];
  let ownerFirst: string | null = null;
  let ownerLast: string | null = null;
  let ownerSource: Lead["owner_name_source"] = null;
  if (website) {
    process.stdout.write("Harvesting site for email/owner ... ");
    const info = await harvestSite(website, p.displayName?.text ?? bizName);
    emails = info.emails;
    ownerFirst = info.ownerFirst;
    ownerLast = info.ownerLast;
    ownerSource = info.ownerSource;
    console.log(
      `${emails.length} email(s)${ownerFirst ? `, owner: ${ownerFirst}${ownerLast ? " " + ownerLast : ""}` : ""}`
    );
  }

  const partial = {
    place_id: p.id,
    name: p.displayName?.text ?? bizName,
    address: p.formattedAddress ?? "",
    city,
    phone: p.nationalPhoneNumber ?? "",
    website,
    emails,
    latitude: p.location?.latitude ?? null,
    longitude: p.location?.longitude ?? null,
    owner_first_name: ownerFirst,
    owner_last_name: ownerLast,
    owner_name_source: ownerSource,
    rating: p.rating ?? null,
    review_count: p.userRatingCount ?? 0,
    vertical,
    vertical_label: labelFor(vertical),
    source_query: "manual: Eric prospect",
    scraped_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("nectarpay_leads").insert({
    ...partial,
    score: scoreLead(partial),
    band: "HOT",
    status: "NEW",
  });
  if (error) {
    console.error("Insert failed:", error.message);
    process.exit(1);
  }

  const { data: fresh } = await supabase
    .from("nectarpay_leads")
    .select("pulse_token")
    .eq("place_id", p.id)
    .single();

  console.log(`\nPlanted: ${partial.name} — HOT, in the CRM and on the map.`);
  console.log(`\n  CARD: ${PULSE_BASE}/s/${fresh?.pulse_token}\n`);
  if (emails.length > 0)
    console.log(`Heads up: has an email on file — the campaign WILL sequence them unless Eric moves the lifecycle first.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
