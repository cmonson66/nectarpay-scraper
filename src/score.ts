import type { Lead } from "./types.js";

/**
 * Raw score = vertical weight (1-10) + signal bonuses.
 * Bands are assigned AFTER scoring, by percentile within each vertical
 * (assignBands below) - fixed thresholds don't work when a vertical's
 * weight alone nearly clears the bar.
 */
export function scoreLead(
  lead: Omit<Lead, "score" | "band">
): number {
  let score = 0;

  score += verticalWeightCache.get(lead.vertical) ?? 5;

  const reviews = lead.review_count;
  if (reviews >= 200) score += 3;
  else if (reviews >= 50) score += 2;
  else if (reviews >= 10) score += 1;

  if ((lead.rating ?? 0) >= 4.0) score += 1;

  if (lead.phone) score += 1;
  if (lead.website) score += 1;
  if (lead.emails.length > 0) score += 2;

  return score;
}

/**
 * Percentile banding, per vertical:
 *   HOT  = top 15% of scores (and must have a phone - can't route an uncallable door)
 *   WARM = next 25%
 *   COOL = everything else
 * HOT stays scarce by construction: it's the week's walk-in route, not a label
 * for every viable business.
 */
export function assignBands(leads: Lead[]): void {
  const byVertical = new Map<string, Lead[]>();
  for (const l of leads) {
    const group = byVertical.get(l.vertical) ?? [];
    group.push(l);
    byVertical.set(l.vertical, group);
  }

  for (const group of byVertical.values()) {
    group.sort((a, b) => b.score - a.score);
    const hotCut = Math.max(1, Math.ceil(group.length * 0.15));
    const warmCut = Math.max(hotCut, Math.ceil(group.length * 0.4));

    group.forEach((lead, i) => {
      if (i < hotCut && lead.phone) lead.band = "HOT";
      else if (i < warmCut) lead.band = "WARM";
      else lead.band = "COOL";
    });
  }
}

export const verticalWeightCache = new Map<string, number>();
