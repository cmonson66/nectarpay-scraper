import type { PlaceResult } from "./types.js";

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "places.types",
  "nextPageToken",
].join(",");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Text Search on Places API (New). Returns up to ~60 results per query
 * (3 pages of 20). Google requires a short delay before a nextPageToken
 * becomes valid, so we pause between pages.
 */
export async function textSearch(
  apiKey: string,
  textQuery: string,
  maxPages = 3
): Promise<PlaceResult[]> {
  const results: PlaceResult[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const body: Record<string, unknown> = { textQuery, pageSize: 20 };
    if (pageToken) body.pageToken = pageToken;

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`  ! Places API ${res.status} for "${textQuery}": ${text.slice(0, 300)}`);
      break;
    }

    const data = (await res.json()) as {
      places?: PlaceResult[];
      nextPageToken?: string;
    };

    if (data.places?.length) results.push(...data.places);

    pageToken = data.nextPageToken;
    if (!pageToken) break;
    await sleep(2000); // token warm-up
  }

  return results;
}
