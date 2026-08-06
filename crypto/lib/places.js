const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.primaryType',
  'places.types',
  'places.businessStatus',
  'nextPageToken',
].join(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Text Search against Places API (New), biased to a city centre.
 * Returns a flat array of raw place objects across all pages.
 */
export async function textSearch({
  apiKey,
  query,
  lat,
  lng,
  radiusM = 25000,
  maxPages = 3,
  pauseMs = 400,
}) {
  const results = [];
  let pageToken = null;

  for (let page = 0; page < maxPages; page++) {
    const body = {
      textQuery: query,
      pageSize: 20,
      locationBias: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: Math.min(radiusM, 50000),
        },
      },
    };
    if (pageToken) body.pageToken = pageToken;

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Places searchText ${res.status} for "${query}": ${text.slice(0, 300)}`
      );
    }

    const json = await res.json();
    if (Array.isArray(json.places)) results.push(...json.places);

    pageToken = json.nextPageToken || null;
    if (!pageToken) break;
    await sleep(pauseMs);
  }

  return results;
}
