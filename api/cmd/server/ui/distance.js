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
