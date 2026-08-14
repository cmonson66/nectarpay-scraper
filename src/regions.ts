import { createClient } from "@supabase/supabase-js";
import type { RegionTarget } from "./types.js";

/**
 * Resolves a region CODE from config into the regions.id the CRM uses.
 *
 * This runs BEFORE any Places call. A scrape that finishes and then discovers
 * it has nowhere to put the rows has already spent the money, and leads that
 * land with a NULL region are invisible to that region's campaign (the engine
 * filters on region_id) and to its manager (RLS matches on it). Better to fail
 * in the first second than after nine thousand requests.
 */
export async function resolveRegionId(target: RegionTarget): Promise<string> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required - the scraper has to " +
      "stamp region_id, so a CSV-only run is not allowed for a region scrape."
    );
  }

  const supabase = createClient(url, key);
  const { data, error } = await supabase
    .from("regions")
    .select("id, code, name, is_active")
    .eq("code", target.code);

  if (error) throw new Error(`Could not read regions: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error(
      `No region with code ${target.code} exists in the CRM. Create it on the ` +
      `Regions page first, then re-run.`
    );
  }
  if (data.length > 1) {
    throw new Error(
      `${data.length} regions share the code ${target.code}. Codes are unique per ` +
      `organization, so this database has more than one org - pass the right id by hand.`
    );
  }
  if (!data[0].is_active) {
    console.warn(`  ! Region ${target.code} is turned off in the CRM. Scraping anyway.`);
  }
  return data[0].id as string;
}
