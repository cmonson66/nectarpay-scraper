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

  // Vertical stability: a lead's FIRST vertical assignment is permanent.
  // Implementation note (learned the hard way): bulk upserts need UNIFORM
  // columns — omitting keys on some rows writes NULLs through ON CONFLICT
  // and rolls the whole chunk back at the accounts trigger. So instead of
  // omitting classification columns for known leads, we substitute their
  // STORED values, keeping one uniform statement that can't null anything.
  // region_id and compliance_hold join the locked set for the same reason
  // vertical did, plus one of their own: a human may have CLEARED a hold in
  // the CRM after checking a shop, and a re-scrape must not silently put it
  // back. First assignment wins; changes are a person's decision, not a
  // scraper's.
  type Locked = {
    vertical: string; vertical_label: string; band: string;
    score: number; source_query: string;
    region_id: string | null; compliance_hold: boolean; compliance_reason: string | null;
  };
  const lockedByPlace = new Map<string, Locked>();
  const allIds = leads.map((l) => l.place_id);
  for (let i = 0; i < allIds.length; i += 500) {
    const { data } = await supabase
      .from("nectarpay_leads")
      .select("place_id, vertical, vertical_label, band, score, source_query, region_id, compliance_hold, compliance_reason")
      .in("place_id", allIds.slice(i, i + 500));
    for (const row of data ?? []) {
      lockedByPlace.set(row.place_id, {
        vertical: row.vertical,
        vertical_label: row.vertical_label,
        band: row.band,
        score: row.score,
        source_query: row.source_query,
        region_id: row.region_id,
        compliance_hold: row.compliance_hold,
        compliance_reason: row.compliance_reason,
      });
    }
  }
  console.log(`Upserting ${leads.length} leads (${lockedByPlace.size} already known — verticals locked).`);

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
      // Known leads re-assert their stored classification (uniform columns,
      // nothing can go null); new leads land with the fresh one
      vertical: lockedByPlace.get(l.place_id)?.vertical ?? l.vertical,
      vertical_label: lockedByPlace.get(l.place_id)?.vertical_label ?? l.vertical_label,
      source_query: lockedByPlace.get(l.place_id)?.source_query ?? l.source_query,
      score: lockedByPlace.get(l.place_id)?.score ?? l.score,
      band: lockedByPlace.get(l.place_id)?.band ?? l.band,
      // Uniform columns, same rule as above: every row carries these keys or
      // ON CONFLICT writes NULLs through and the chunk rolls back.
      region_id: lockedByPlace.get(l.place_id)?.region_id ?? l.region_id,
      compliance_hold: lockedByPlace.get(l.place_id)?.compliance_hold ?? l.compliance_hold,
      compliance_reason: lockedByPlace.get(l.place_id)?.compliance_reason ?? l.compliance_reason,
      scraped_at: l.scraped_at,
    }));

    const { error } = await supabase
      .from("nectarpay_leads")
      .upsert(chunk, { onConflict: "place_id" });

    if (error) console.error("  ! Supabase upsert error:", error.message);
  }
  console.log(`Supabase upsert complete (${leads.length} leads).`);

  // Nothing should ever land without a region. If it did, those rows are
  // invisible to every campaign and every manager, and nobody would notice.
  const { count } = await supabase
    .from("nectarpay_leads")
    .select("place_id", { count: "exact", head: true })
    .is("region_id", null);
  if ((count ?? 0) > 0) {
    console.error(`  ! ${count} leads in the pool have NO region and will never be emailed.`);
  }
}
