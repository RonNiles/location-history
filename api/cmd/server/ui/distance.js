// Distance math and the quasi-logarithmic radius grid.
//
// All distances are stored as meters; conversion to/from the user's
// preferred unit happens at the UI boundary.

const M_PER_MI = 1609.344;

/** Convert meters to the user's preferred display unit's value. */
export function metersToUnit(m, units) {
  if (units === 'mi') return m / M_PER_MI;
  return m / 1000; // km
}

/** Convert a user-unit value (km or mi) back to meters. */
export function unitToMeters(v, units) {
  if (units === 'mi') return v * M_PER_MI;
  return v * 1000; // km
}

// The grid the radius picker steps through, in user units. We pick
// values that are "nice" both in writing and in meters: 1, 2, 5
// times powers of ten. That gives a roughly logarithmic feel while
// staying memorable.
//
// Different units get different grid extents because the API caps
// radius at 100km; in miles the highest reasonable grid value is 50
// (≈80km) since 100mi (≈161km) would exceed it.
const KM_GRID = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
const MI_GRID = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];

export function gridForUnits(units) {
  return units === 'mi' ? MI_GRID : KM_GRID;
}

/** Find the index of the grid value that's strictly greater than
 *  `v`. Returns -1 if `v` is at or above the highest grid value. */
function nextAbove(grid, v) {
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] > v) return i;
  }
  return -1;
}

/** Find the index of the grid value that's strictly less than `v`.
 *  Returns -1 if `v` is at or below the lowest grid value. */
function nextBelow(grid, v) {
  for (let i = grid.length - 1; i >= 0; i--) {
    if (grid[i] < v) return i;
  }
  return -1;
}

/** Index of the grid value closest to `v`. Ties break toward the
 *  smaller value, which is the friendlier default for off-grid
 *  inputs (you'd rather snap 1.4 to 1 than to 2). */
function nearestIndex(grid, v) {
  let best = 0;
  let bestDist = Math.abs(grid[0] - v);
  for (let i = 1; i < grid.length; i++) {
    const d = Math.abs(grid[i] - v);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  }
  return best;
}

/** Is `v` already on the grid? Compared with a small epsilon so
 *  floating-point noise from unit conversions doesn't lie. */
export function onGrid(grid, v) {
  return grid.some(g => Math.abs(g - v) < 1e-9);
}

/** Compute the next radius in user units after a +/- nudge.
 *
 *  Rules:
 *    * If `current` is already on a grid value, step by one grid slot
 *      in the requested direction (clamped at endpoints).
 *    * If `current` is off-grid, snap to the nearest grid value
 *      regardless of direction. The snap counts as the action.
 *
 *  This matches the requested behavior: "if the user clicks the
 *  arrow and the value is something other than [grid], snap it to
 *  the nearest value first."
 */
export function nudge(grid, current, direction /* +1 or -1 */) {
  if (!onGrid(grid, current)) {
    return grid[nearestIndex(grid, current)];
  }
  if (direction > 0) {
    const i = nextAbove(grid, current);
    return i === -1 ? current : grid[i];
  } else {
    const i = nextBelow(grid, current);
    return i === -1 ? current : grid[i];
  }
}

/** Format a user-unit value for display in the input. We want
 *  "0.1" not "0.10", "1" not "1.0", "100" not "100.00". */
export function formatUnitValue(v) {
  if (v == null || isNaN(v)) return '';
  // Up to 3 decimals; drop trailing zeros and a bare trailing dot.
  let s = Number(v).toFixed(3);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

// ----------------------------------------------------------- great-circle

const EARTH_RADIUS_M = 6371000;

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Haversine distance in meters between two [lng, lat] points. */
export function haversineMeters(a, b) {
  const lat1 = toRad(a[1]), lat2 = toRad(b[1]);
  const dLat = lat2 - lat1;
  const dLng = toRad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Spherical-linear-interpolate between two [lng, lat] points.
 *  t=0 returns a; t=1 returns b. Returns a new [lng, lat].
 *
 *  Standard slerp on the unit sphere. Falls back to linear when
 *  the angular distance is tiny enough that sin(d) loses precision. */
function slerpLngLat(a, b, t) {
  const lat1 = toRad(a[1]), lng1 = toRad(a[0]);
  const lat2 = toRad(b[1]), lng2 = toRad(b[0]);

  // Convert to 3D unit vectors so we can use a numerically stable
  // angular distance via atan2(|cross|, dot).
  const x1 = Math.cos(lat1) * Math.cos(lng1);
  const y1 = Math.cos(lat1) * Math.sin(lng1);
  const z1 = Math.sin(lat1);
  const x2 = Math.cos(lat2) * Math.cos(lng2);
  const y2 = Math.cos(lat2) * Math.sin(lng2);
  const z2 = Math.sin(lat2);

  const dot = x1*x2 + y1*y2 + z1*z2;
  // |cross| = sin(d), dot = cos(d). atan2 of these is more accurate
  // than acos(dot) near d=0 or d=pi.
  const cx = y1*z2 - z1*y2;
  const cy = z1*x2 - x1*z2;
  const cz = x1*y2 - y1*x2;
  const crossMag = Math.sqrt(cx*cx + cy*cy + cz*cz);
  const d = Math.atan2(crossMag, dot);
  if (d < 1e-9) {
    // Co-located. Linear interpolation degenerates to either point;
    // pick a sensible blend so a caller iterating from 0..1 doesn't
    // see jumps.
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  const sinD = Math.sin(d);
  const A = Math.sin((1 - t) * d) / sinD;
  const B = Math.sin(t * d) / sinD;
  const x = A * x1 + B * x2;
  const y = A * y1 + B * y2;
  const z = A * z1 + B * z2;
  const lat = Math.atan2(z, Math.sqrt(x*x + y*y));
  const lng = Math.atan2(y, x);
  return [toDeg(lng), toDeg(lat)];
}

// Densification threshold. Below this, chord and great circle differ
// by sub-pixel amounts at any zoom we care about. Above it, the
// difference grows quadratically and starts to look noticeably wrong.
const DENSIFY_THRESHOLD_M = 50_000;
// Spacing between interpolated points. ~50km gives a smooth-looking
// arc on transcontinental flights without exploding GeoJSON size.
const DENSIFY_SPACING_M = 50_000;
// Hard caps on points per segment. A min keeps short-but-over-threshold
// segments from looking jagged; the max keeps a SFO–Sydney route from
// producing 250 vertices.
const DENSIFY_MIN_POINTS = 8;
const DENSIFY_MAX_POINTS = 64;

/** Densify a single line segment a→b along a great circle, returning
 *  an array of intermediate points (excluding both endpoints).
 *  Returns [] if the segment is short enough that no densification
 *  is needed. */
function densifyGreatCircle(a, b) {
  const distM = haversineMeters(a, b);
  if (distM < DENSIFY_THRESHOLD_M) return [];
  let n = Math.round(distM / DENSIFY_SPACING_M);
  if (n < DENSIFY_MIN_POINTS) n = DENSIFY_MIN_POINTS;
  if (n > DENSIFY_MAX_POINTS) n = DENSIFY_MAX_POINTS;
  const out = [];
  for (let i = 1; i < n; i++) {
    out.push(slerpLngLat(a, b, i / n));
  }
  return out;
}

/** Densify a LineString's coordinate array. For each consecutive pair
 *  of points, inserts great-circle-interpolated vertices between them
 *  if the chord is longer than DENSIFY_THRESHOLD_M. The endpoints
 *  themselves are preserved exactly.
 *
 *  Used at render time to make long activities (especially flights
 *  stored as 2-point segments) trace their actual path on the map
 *  instead of cutting a chord through it. */
export function densifyLineString(coords) {
  if (!coords || coords.length < 2) return coords;
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const filler = densifyGreatCircle(a, b);
    for (const p of filler) out.push(p);
    out.push(b);
  }
  return out;
}

/** Walk a GeoJSON FeatureCollection and densify every LineString in
 *  place. Returns the same object for chaining. Points and other
 *  geometries are untouched. */
export function densifyFeatureCollection(fc) {
  if (!fc || !fc.features) return fc;
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g || g.type !== 'LineString') continue;
    g.coordinates = densifyLineString(g.coordinates);
  }
  return fc;
}
