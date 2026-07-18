// Thin wrapper around the read API. Every method returns a Promise
// for the parsed JSON, or throws if the request failed.
//
// We resolve URLs relative to the current page so the UI works
// whether served from the API itself (the default deployment) or
// from a separate origin during development.

const BASE = '';  // same origin

async function get(path, params) {
  const u = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        u.searchParams.set(k, v);
      }
    }
  }
  const r = await fetch(u.toString());
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`${r.status} ${r.statusText}: ${text}`);
  }
  return r.json();
}

export const API = {
  health:  ()        => get('/health'),
  extent:  ()        => get('/extent'),
  coverage: (start, end) => get('/coverage', { start, end }),
  segments: (params) => get('/segments', params),
  signals:  (params) => get('/signals',  params),
  pointsNear: (params) => get('/points-near', params),
  places:  (params) => get('/places', params || {}),
};

/** Format an RFC3339 string for the start of a YMD in the browser's
 *  local timezone. Includes the offset so the absolute moment is
 *  unambiguous. We construct via the (year, month, day, ...) Date
 *  constructor — this respects DST and ambiguous-hour edge cases
 *  (e.g. spring-forward days that have only 23 hours).
 *
 *  Example: dayStartLocal("2024-05-06") in America/Los_Angeles →
 *  "2024-05-06T00:00:00.000-07:00" */
export function dayStartLocal(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
  // Note: toISOString() always returns UTC ('Z'). That's still
  // correct — it represents the same absolute moment as the local
  // midnight we constructed. The point isn't the formatting, it's
  // that the moment is "midnight local" rather than "midnight UTC".
}

/** Format an RFC3339 string for the end of a YMD in the browser's
 *  local timezone. We use 23:59:59.999 rather than the next day's
 *  midnight to keep parity with the existing API's <= end semantics. */
export function dayEndLocal(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

/** Convert a Date to YYYY-MM-DD in the browser's local timezone.
 *  Used for date-input values and any "what day is this" question
 *  the user asks (which they always ask in their local frame). */
export function toYMD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Convert a YMD string into a Date at local midnight. Symmetrical
 *  with toYMD(). Used by the coverage strip when walking a day
 *  series and by the timeline buckets. */
export function ymdToLocalDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/** Pretty-print a millisecond timestamp in the user's local time.
 *  Pass `{seconds: true}` to include :SS precision — useful for
 *  raw GPS signals where the interesting information is often "this
 *  fix is 3 seconds after that one." */
export function fmtTime(ms, opts = {}) {
  const d = new Date(ms);
  const fmtOpts = {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  };
  if (opts.seconds) fmtOpts.second = '2-digit';
  return d.toLocaleString(undefined, fmtOpts);
}

/** Format a duration in ms into a compact human string. */
export function fmtDuration(ms) {
  if (ms < 0) ms = 0;
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

/** Format meters into a compact human string. */
/** Format meters into a compact human string in the user's preferred
 *  units (km or mi). Reads from prefs at call time so changing units
 *  takes effect on the next render without callers needing to know. */
export function fmtMeters(m) {
  if (m == null) return '—';
  // Inline import-cycle dodge: read prefs lazily so this module
  // doesn't need to import prefs.js at top level (which would create
  // an import cycle since prefs may eventually need formatting).
  const units = (window.__lhPrefs && window.__lhPrefs.units) || 'km';
  if (units === 'mi') {
    const FT_PER_M = 3.28084;
    const MI_PER_M = 0.000621371;
    if (m < 161) {  // < 0.1 mi -> show feet
      return `${Math.round(m * FT_PER_M)}ft`;
    }
    const mi = m * MI_PER_M;
    if (mi < 10) return `${mi.toFixed(2)}mi`;
    if (mi < 100) return `${mi.toFixed(1)}mi`;
    return `${Math.round(mi)}mi`;
  }
  // km (default)
  if (m < 1000) return `${Math.round(m)}m`;
  const km = m / 1000;
  if (km < 10) return `${km.toFixed(2)}km`;
  if (km < 100) return `${km.toFixed(1)}km`;
  return `${Math.round(km)}km`;
}
