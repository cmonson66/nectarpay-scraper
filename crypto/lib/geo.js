export const R_EARTH_M = 6371008.8;
export const toRad = (d) => (d * Math.PI) / 180;

// Arizona bounding box. Used to reject Google's name-matched out-of-state
// hits (the Peoria IL problem) before anything reaches the database.
export const AZ_BBOX = { south: 31.2, west: -115.0, north: 37.05, east: -108.95 };

export function inArizona(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= AZ_BBOX.south &&
    lat <= AZ_BBOX.north &&
    lng >= AZ_BBOX.west &&
    lng <= AZ_BBOX.east
  );
}

export function haversineMeters(aLat, aLng, bLat, bLng) {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Uniform lat/lng grid index. Cell size is set to the query radius, so any
 * point within the radius is guaranteed to sit in the 3x3 block of cells
 * around the query point. Turns an O(leads * signals) scan into something
 * that finishes in a couple of seconds on 10k leads.
 */
export class GridIndex {
  constructor(cellMeters, refLat = 33.4) {
    this.cellLat = cellMeters / 111320;
    this.cellLng = cellMeters / (111320 * Math.cos(toRad(refLat)));
    this.cells = new Map();
  }

  _key(lat, lng) {
    return `${Math.floor(lat / this.cellLat)}:${Math.floor(lng / this.cellLng)}`;
  }

  add(item) {
    const k = this._key(item.lat, item.lng);
    let bucket = this.cells.get(k);
    if (!bucket) {
      bucket = [];
      this.cells.set(k, bucket);
    }
    bucket.push(item);
  }

  near(lat, lng) {
    const gi = Math.floor(lat / this.cellLat);
    const gj = Math.floor(lng / this.cellLng);
    const out = [];
    for (let i = gi - 1; i <= gi + 1; i++) {
      for (let j = gj - 1; j <= gj + 1; j++) {
        const bucket = this.cells.get(`${i}:${j}`);
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }
}
