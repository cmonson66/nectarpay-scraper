import { createClient } from "@supabase/supabase-js";
import type { Lead } from "./types.js";

/**
 * Upserts leads into nectarpay_leads keyed on place_id.
 * Re-runs refresh ratings/reviews/emails without duplicating rows,
 * and never overwrite Eric's pipeline fields (status, notes).
 */
export async function upsertLeads(
  leads: Lead[],
  opts: { includeEnrichment: boolean } = { includeEnrichment: true }
): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("Supabase env not set - skipping upsert (CSV only).");
    return;
  }

  const supabase = createClient(url, key);
  const chunkSize = 200;

  for (let i = 0; i < leads.length; i += chunkSize) {
    const chunk = leads.slice(i, i + chunkSize).map((l) => ({
      place_id: l.place_id,
      name: l.name,
      address: l.address,
      city: l.city,
      phone: l.phone,
      website: l.website,
      latitude: l.latitude,
      longitude: l.longitude,
      // Enrichment fields only when this run actually enriched —
      // a --no-emails fast pass must never blank existing emails/names
      ...(opts.includeEnrichment
        ? {
            emails: l.emails,
            owner_first_name: l.owner_first_name,
            owner_last_name: l.owner_last_name,
            owner_name_source: l.owner_name_source,
          }
        : {}),
      rating: l.rating,
      review_count: l.review_count,
      vertical: l.vertical,
      vertical_label: l.vertical_label,
      source_query: l.source_query,
      score: l.score,
      band: l.band,
      scraped_at: l.scraped_at,
    }));

    const { error } = await supabase
      .from("nectarpay_leads")
      .upsert(chunk, { onConflict: "place_id" });

    if (error) console.error("  ! Supabase upsert error:", error.message);
  }
  console.log(`Supabase upsert complete (${leads.length} leads).`);
}
