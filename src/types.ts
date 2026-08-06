export type Vertical = {
  key: string;
  label: string;
  weight: number;
  queries: string[];
};

export type Targets = {
  cities: string[];
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
};
