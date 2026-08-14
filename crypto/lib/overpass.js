
// BTC Map is a rendering layer over OpenStreetMap tags, so querying OSM
// directly via Overpass gives the same dataset, bbox-filtered, no key, no
// 200MB full dump. These are the tags BTC Map's taggers actually use.
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Overpass returns 406 to clients that don't identify themselves, and 429
// when a mirror is busy. Both are fixable: send a real User-Agent, and back
// off before moving on rather than hammering the next host immediately.
const USER_AGENT = 'nectarpay-crypto-signals/1.0 (solo dev; contact via repo)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function buildQuery(bbox) {
  if (!bbox) throw new Error('buildQuery needs a region bbox');
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `
[out:json][timeout:180];
(
  nwr["currency:XBT"="yes"](${b});
  nwr["payment:bitcoin"="yes"](${b});
  nwr["payment:cryptocurrencies"="yes"](${b});
  nwr["currency:BTC"="yes"](${b});
);
out center tags;
`.trim();
}

async function attempt(url, query, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams({ data: query }).toString(),
      signal: controller.signal,
    });

    if (!res.ok) {
      const err = new Error(`Overpass ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    return Array.isArray(json.elements) ? json.elements : [];
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchOsmCryptoPlaces({ bbox, timeoutMs = 190000, rounds = 2 } = {}) {
  const query = buildQuery(bbox);
  let lastErr;

  for (let round = 0; round < rounds; round++) {
    for (const url of MIRRORS) {
      try {
        const host = new URL(url).host;
        const elements = await attempt(url, query, timeoutMs);
        console.log(`  via ${host}`);
        return elements;
      } catch (err) {
        lastErr = err;
        console.warn(`  ! ${new URL(url).host}: ${err.message}`);
        // 429 means busy, not broken -- give it a moment before the next host
        if (err.status === 429) await sleep(2000);
      }
    }
    if (round + 1 < rounds) {
      console.warn('  ! all mirrors busy, waiting 15s before another pass');
      await sleep(15000);
    }
  }

  throw lastErr || new Error('All Overpass mirrors failed');
}
