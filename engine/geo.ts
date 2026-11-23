/**
 * Geometry for routes drawn on a map.
 *
 * Everything here is spherical distance on a mean-radius sphere. That is the right accuracy for
 * cable lengths (0.5% against the ellipsoid, well inside the 3% overlength allowance) and it means
 * no projection library and no dependency.
 *
 * Coordinates are `{ lat, lon }` in decimal degrees throughout the project. KML stores
 * `lon,lat,alt`, so `kml.js` is the only place that swaps them.
 */

export interface Coordinate {
  lat: number;
  lon: number;
}

export interface BBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/** IUGG mean radius, metres. */
export const EARTH_RADIUS_M = 6371008.8;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Type guard for anything that claims to be a coordinate. Takes `unknown` because the callers are
 * unmigrated JavaScript and API JSON: this function is the boundary where that gets checked.
 */
export function isCoordinate(p: unknown): p is Coordinate {
  if (typeof p !== 'object' || p === null) return false;
  const c = p as { lat?: unknown; lon?: unknown };
  return typeof c.lat === 'number' && typeof c.lon === 'number' &&
    isFinite(c.lat) && isFinite(c.lon) &&
    Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180;
}

/** Great-circle distance in metres between two `{lat, lon}` points. */
export function distanceM(a: unknown, b: unknown): number {
  if (!isCoordinate(a) || !isCoordinate(b)) throw new TypeError('distanceM needs two { lat, lon } coordinates');
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Length of a polyline in metres. Fewer than two points is a zero-length route, not an error. */
export function pathLengthM(points: readonly Coordinate[] | null | undefined): number {
  const pts = points || [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += distanceM(pts[i - 1], pts[i]);
  return total;
}

export function bbox(points: readonly Coordinate[] | null | undefined): BBox | null {
  if (!points || !points.length) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    if (!isCoordinate(p)) continue;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  if (minLat === Infinity) return null;
  return { minLat: minLat, maxLat: maxLat, minLon: minLon, maxLon: maxLon };
}

export function centroid(points: readonly Coordinate[] | null | undefined): Coordinate | null {
  const pts = (points || []).filter(isCoordinate);
  if (!pts.length) return null;
  let lat = 0;
  let lon = 0;
  for (const p of pts) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / pts.length, lon: lon / pts.length };
}

/** Perpendicular distance from `p` to the segment a-b, in metres (planar approximation locally). */
export function pointToSegmentM(p: Coordinate, a: Coordinate, b: Coordinate): number {
  const latRef = toRad((a.lat + b.lat) / 2);
  const mPerDegLat = 111132.95;
  const mPerDegLon = 111319.49 * Math.cos(latRef);
  const px = (p.lon - a.lon) * mPerDegLon;
  const py = (p.lat - a.lat) * mPerDegLat;
  const bx = (b.lon - a.lon) * mPerDegLon;
  const by = (b.lat - a.lat) * mPerDegLat;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);
  let t = (px * bx + py * by) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - t * bx, py - t * by);
}

/**
 * Douglas-Peucker simplification, so a 400-point trace of a street becomes the 30 bends that
 * define it. `toleranceM` is the maximum deviation in metres; the endpoints are always kept.
 */
export function simplify(points: readonly Coordinate[] | null | undefined, toleranceM: number): Coordinate[] {
  const pts = (points || []).slice();
  if (pts.length < 3 || !(toleranceM > 0)) return pts;
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;

  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const range = stack.pop();
    if (!range) break;
    const first = range[0];
    const last = range[1];
    let worst = -1;
    let worstIdx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = pointToSegmentM(pts[i], pts[first], pts[last]);
      if (d > worst) {
        worst = d;
        worstIdx = i;
      }
    }
    if (worst > toleranceM && worstIdx > 0) {
      keep[worstIdx] = true;
      stack.push([first, worstIdx], [worstIdx, last]);
    }
  }
  return pts.filter(function (_point, i) { return keep[i]; });
}

/** Interpolate a point at `fraction` (0..1) of the polyline's length. */
export function pointAt(points: readonly Coordinate[] | null | undefined, fraction: number): Coordinate | null {
  const pts = points || [];
  if (!pts.length) return null;
  if (pts.length === 1) return { lat: pts[0].lat, lon: pts[0].lon };
  const total = pathLengthM(pts);
  if (total === 0) return { lat: pts[0].lat, lon: pts[0].lon };
  const target = Math.max(0, Math.min(1, fraction)) * total;
  let walked = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = distanceM(pts[i - 1], pts[i]);
    if (walked + seg >= target) {
      const t = seg === 0 ? 0 : (target - walked) / seg;
      return {
        lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * t,
        lon: pts[i - 1].lon + (pts[i].lon - pts[i - 1].lon) * t
      };
    }
    walked += seg;
  }
  return { lat: pts[pts.length - 1].lat, lon: pts[pts.length - 1].lon };
}
