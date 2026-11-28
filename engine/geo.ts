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

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
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

/**
 * The smallest box that covers the points - and a box that crosses the antimeridian says so.
 *
 * Latitude is a plain min/max. Longitude is not: min/max of 179.9 and -179.9 is a box 359.8 deg
 * wide, so an estate either side of 180 was reported as covering the whole planet - the same raw
 * subtraction `lonDelta` exists to refuse. The covered arc is the complement of the widest gap
 * between the sorted longitudes, and when that gap is an interior one the box runs east from
 * `minLon`, through 180, to `maxLon`, so **`minLon > maxLon` means the box crosses the
 * antimeridian**. Width is `lonDelta(minLon, maxLon)`, and membership is
 * `lonDelta(minLon, lon) <= lonDelta(minLon, maxLon)`; a raw `minLon <= lon <= maxLon` test is only
 * valid on a box that does not cross.
 *
 * A tie between gaps keeps the wrap gap, so nothing about an ordinary drawing moves: longitudes
 * that do not straddle 180 keep exactly the min/max they always had.
 */
export function bbox(points: readonly Coordinate[] | null | undefined): BBox | null {
  if (!points || !points.length) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  const lons: number[] = [];
  for (const p of points) {
    if (!isCoordinate(p)) continue;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    lons.push(p.lon);
  }
  if (minLat === Infinity) return null;
  lons.sort(function (a, b) { return a - b; });
  // The gap that wraps through 180 first: if it is the widest, the box does not cross and its
  // min/max are the plain sorted ends.
  let widest = lons[0] + 360 - lons[lons.length - 1];
  let start = 0;
  for (let i = 1; i < lons.length; i++) {
    const gap = lons[i] - lons[i - 1];
    if (gap > widest) {
      widest = gap;
      start = i;
    }
  }
  if (start === 0) {
    return { minLat: minLat, maxLat: maxLat, minLon: lons[0], maxLon: lons[lons.length - 1] };
  }
  return { minLat: minLat, maxLat: maxLat, minLon: lons[start], maxLon: lons[start - 1] };
}

/**
 * The centre of a set of points, with longitude averaged the short way round.
 *
 * Longitude is an angle, so its mean is the mean *direction*, not the arithmetic mean of the
 * numbers: the midpoint of 179.9 and -179.9 is the meridian, and adding the two and halving put a
 * Fiji estate's centre on the prime meridian, 20000 km from every house. Latitude still averages
 * plainly, because it is not periodic.
 *
 * A set spread evenly round the planet has no centre - the vector sum vanishes and the direction is
 * arbitrary. It resolves to 0 deg deterministically rather than throwing, because a centre is a
 * reporting convenience, not a figure anything is planned against.
 */
export function centroid(points: readonly Coordinate[] | null | undefined): Coordinate | null {
  const pts = (points || []).filter(isCoordinate);
  if (!pts.length) return null;
  if (pts.length === 1) return { lat: pts[0].lat, lon: pts[0].lon };
  let lat = 0;
  let sin = 0;
  let cos = 0;
  for (const p of pts) {
    lat += p.lat;
    sin += Math.sin(toRad(p.lon));
    cos += Math.cos(toRad(p.lon));
  }
  const lon = sin === 0 && cos === 0 ? 0 : toDeg(Math.atan2(sin, cos));
  return { lat: lat / pts.length, lon: wrapLon(lon) };
}

/**
 * Longitude difference `to - from` taken the short way round, in (-180, 180].
 *
 * The antimeridian is a join, not a wall: 179.99 and -179.99 are 0.02 deg apart. A raw subtraction
 * says 359.98, so a planar helper (a projection, a crossing test, a bounding box) that uses it
 * measures the long way round the planet. Only that arithmetic is wrapped here - `distanceM` is a
 * great-circle formula and was already correct.
 */
export function lonDelta(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

/**
 * A longitude in [-180, 180): 180 and -180 are the same meridian, and one value keeps them one node.
 * A longitude inside the range is returned unchanged, so nothing about an ordinary drawing moves.
 */
export function wrapLon(lon: number): number {
  if (lon >= -180 && lon <= 180) return lon === 180 ? -180 : lon;
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

/** Perpendicular distance from `p` to the segment a-b, in metres (planar approximation locally). */
export function pointToSegmentM(p: Coordinate, a: Coordinate, b: Coordinate): number {
  const latRef = toRad((a.lat + b.lat) / 2);
  const mPerDegLat = 111132.95;
  const mPerDegLon = 111319.49 * Math.cos(latRef);
  // Longitudes are taken the short way round: a segment that crosses the antimeridian is 0.2 deg long,
  // not 359.8, and a point beside it is metres away, not half a planet.
  const px = lonDelta(a.lon, p.lon) * mPerDegLon;
  const py = (p.lat - a.lat) * mPerDegLat;
  const bx = lonDelta(a.lon, b.lon) * mPerDegLon;
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
      // Longitude moves the short way: a route from 179.9 to -179.9 is 0.2 deg long, and its
      // midpoint is on the meridian, not half way round the planet at 0 deg. Ordinary routes have
      // a `lonDelta` equal to the plain difference, so nothing linear moves.
      const dLon = lonDelta(pts[i - 1].lon, pts[i].lon);
      return {
        lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * t,
        lon: wrapLon(pts[i - 1].lon + dLon * t)
      };
    }
    walked += seg;
  }
  return { lat: pts[pts.length - 1].lat, lon: pts[pts.length - 1].lon };
}
