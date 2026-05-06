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

/** Format an RFC3339 string from a YYYY-MM-DD date input value. */
export function dayStartUTC(ymd) {
  return `${ymd}T00:00:00Z`;
}
export function dayEndUTC(ymd) {
  return `${ymd}T23:59:59Z`;
}

/** Convert a Date to YYYY-MM-DD in UTC. */
export function toYMD(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Pretty-print a millisecond timestamp in the user's local time. */
export function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
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
