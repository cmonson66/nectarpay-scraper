export type Vertical = {
  key: string;
  label: string;
  weight: number;
  queries: string[];
  /** Applied AT INGEST. A held lead is never emailed by the campaign. */
  compliance_hold?: boolean;
  compliance_reason?: string;
};

export type RegionTarget = {
  /** Must match regions.code in the CRM database. */
  code: string;
  name: string;
  /** Two-letter state, used to reject the wrong Peoria. */
  state: string;
  cities: string[];
};

export type HoldKeywords = {
  reason: string;
  /** Matched case-insensitively against the business NAME, whatever vertical
   *  Google filed it under. */
  terms: string[];
};

export type Targets = {
  regions: RegionTarget[];
  hold_keywords?: HoldKeywords;
  verticals: Vertical[];
};

export type PlaceResult = {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  nationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  types?: string[];
};

export type Lead = {
  place_id: string;
  name: string;
  address: string;
  city: string;
  phone: string;
  website: string;
  emails: string[];
  latitude: number | null;
  longitude: number | null;
  owner_first_name: string | null;
  owner_last_name: string | null;
  owner_name_source: "site" | "email" | null;
  rating: number | null;
  review_count: number;
  vertical: string;
  vertical_label: string;
  source_query: string;
  score: number;
  band: "HOT" | "WARM" | "COOL";
  scraped_at: string;
  /** regions.id in the CRM. A NULL region is invisible to that region's
   *  campaign and to its manager, so this is resolved before any search runs. */
  region_id: string;
  compliance_hold: boolean;
  compliance_reason: string | null;
};
