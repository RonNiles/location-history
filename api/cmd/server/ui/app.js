// Main application. Orchestrates the map, the date picker, layer
// toggles, hover popups, and the radius-search workflow.

import { API, dayStartLocal, dayEndLocal, toYMD, ymdToLocalDate, fmtTime, fmtDuration, fmtMeters } from './api.js';
import { CoverageStrip } from './coverage.js';
import { prefs } from './prefs.js';
import {
  gridForUnits, nudge, metersToUnit, unitToMeters, formatUnitValue,
  densifyFeatureCollection,
} from './distance.js';

// ------------------------------ map setup ------------------------------

// MapLibre style with a single OSM raster source. Tiles are
// requested from our own /tiles endpoint, which proxies and caches
// upstream OSM. This means:
//   * We respect OSM's tile usage policy by only requesting each
//     tile from them once (then caching).
//   * Repeated visits to the same area are instant (filesystem read).
//   * The browser's HTTP cache *also* caches them on top of that
//     (Cache-Control: max-age=604800 set by the API).
const MAP_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: [
        'tiles/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [
    { id: 'osm', type: 'raster', source: 'osm' },
  ],
};

// Attempt to construct the map. If WebGL is unavailable (or the
// constructor throws for any reason), surface a helpful message
// but DON'T abort module execution — the rest of the app (prefs
// panel, radius spinner, date controls) is still useful and the
// user might want to interact with it.
let map = null;
try {
  map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: [-122.42, 37.77], // sane default; replaced once /extent loads
    zoom: 11,
    attributionControl: false,
  });
} catch (e) {
  console.warn('map construction failed:', e);
  showFatalError('webgl');
}

if (map) {
  // MapLibre also fires an 'error' event for runtime issues (e.g.
  // WebGL context lost). Catch those too.
  map.on('error', (e) => {
    console.warn('map error:', e && e.error);
    if (e && e.error && /webgl/i.test(String(e.error.message || ''))) {
      showFatalError('webgl');
    }
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true }));
  // ScaleControl is installed by applyScaleControl() once the map
  // loads, so it can be re-created when the unit preference changes.
}

function showFatalError(kind) {
  const m = document.getElementById('map');
  let msg;
  if (kind === 'webgl') {
    msg = 'WebGL is unavailable in this browser. The map renderer requires WebGL to draw tiles. ' +
          'Try a different browser, or check that hardware acceleration is enabled in your settings.';
  } else {
    msg = String(kind);
  }
  m.style.display = 'flex';
  m.style.alignItems = 'center';
  m.style.justifyContent = 'center';
  m.style.padding = '40px';
  m.innerHTML = `<div style="
    max-width: 380px;
    font-family: var(--f-serif);
    font-size: 15px;
    color: var(--c-ink);
    background: var(--c-paper);
    padding: 22px 26px;
    border: 1px solid var(--c-ink);
    box-shadow: 3px 3px 0 var(--c-ink-dim);
    line-height: 1.5;">
    <strong style="color: var(--c-accent); font-size: 17px;">Cannot display map</strong>
    <p style="margin: 10px 0 0; font-style: italic;">${escapeHTML(msg)}</p>
  </div>`;
  const status = document.getElementById('status');
  if (status) status.textContent = 'Map error';
}

// ---------------------------- color palette ----------------------------

// MapLibre `match` expression maps activity_type strings to colors.
// Read from CSS vars so palette stays consistent with the sidebar.
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const ACTIVITY_COLOR = [
  'match', ['get', 'act'],
  'WALKING',                cssVar('--c-walking'),
  'ON_FOOT',                cssVar('--c-walking'),
  'RUNNING',                cssVar('--c-walking'),
  'CYCLING',                cssVar('--c-cycling'),
  'IN_PASSENGER_VEHICLE',   cssVar('--c-driving'),
  'IN_VEHICLE',             cssVar('--c-driving'),
  'IN_ROAD_VEHICLE',        cssVar('--c-driving'),
  'IN_BUS',                 cssVar('--c-transit'),
  'IN_TRAIN',               cssVar('--c-transit'),
  'IN_SUBWAY',              cssVar('--c-transit'),
  'IN_TRAM',                cssVar('--c-transit'),
  'FLYING',                 cssVar('--c-flying'),
  cssVar('--c-unknown'),     // default
];

// --------------------------- state & elements --------------------------

const els = {
  status:        document.getElementById('status'),
  dateStart:     document.getElementById('date-start'),
  dateEnd:       document.getElementById('date-end'),
  quickRanges:   document.querySelector('.quick-ranges'),
  btnFitRange:   document.getElementById('btn-fit-range'),
  layerVisits:   document.getElementById('layer-visits'),
  layerActivities: document.getElementById('layer-activities'),
  layerSignals:  document.getElementById('layer-signals'),
  layerPlaces:   document.getElementById('layer-places'),
  layerHeatmap:  document.getElementById('layer-heatmap'),
  countVisits:   document.getElementById('count-visits'),
  countActivities: document.getElementById('count-activities'),
  countSignals:  document.getElementById('count-signals'),
  countPlaces:   document.getElementById('count-places'),
  btnRadius:     document.getElementById('btn-radius'),
  radiusHint:    document.getElementById('radius-hint'),
  radiusControls: document.getElementById('radius-controls'),
  radiusValue:   document.getElementById('radius-value'),
  radiusUp:      document.getElementById('radius-up'),
  radiusDown:    document.getElementById('radius-down'),
  radiusUnit:    document.getElementById('radius-unit'),
  btnRadiusCancel: document.getElementById('btn-radius-cancel'),
  unitsKm:       document.getElementById('units-km'),
  unitsMi:       document.getElementById('units-mi'),
  resultsPanel:  document.getElementById('results-panel'),
  resultsCount:  document.getElementById('results-count'),
  resultsList:   document.getElementById('results-list'),
  popup:         document.getElementById('hover-popup'),
  mapEl:         document.getElementById('map'),
  coverageSvg:   document.getElementById('coverage-svg'),
  coverageAxis:  document.getElementById('coverage-axis'),
};

const state = {
  extent: null,         // {start, end, bbox_geojson}
  currentRange: '30d',
  radiusMode: false,
  radiusMarker: null,
  radiusCircleId: null,
  // Source of truth for the search radius. The input field shows
  // this converted to user units. Default 200m feels right for a
  // "find this specific spot" search; the user changes it via the
  // spinner or by typing.
  radiusMeters: 200,
  lastRadiusCenter: null,  // [lng, lat] of last radius search
  lastRadiusMeters: null,
  lastRadiusHits: [],      // most-recent hits, used by timeline drill-down
  activeRadiusMonth: null, // YYYY-MM currently expanded into days, if any
  // We re-fetch segments whenever the date range changes; stash a
  // generation counter to ignore stale responses.
  segmentsGen: 0,
  signalsGen: 0,
};

const coverage = new CoverageStrip(els.coverageSvg, els.coverageAxis,
  (ymd) => {
    // The strip click gives us a local YMD. Shift the date range so
    // its start lands on the picked day, preserving the current span.
    const curStart = ymdToLocalDate(els.dateStart.value).getTime();
    const curEnd = ymdToLocalDate(els.dateEnd.value).getTime();
    const span = curEnd - curStart;
    const picked = ymdToLocalDate(ymd).getTime();
    els.dateStart.value = ymd;
    els.dateEnd.value = toYMD(new Date(picked + span));
    onDateRangeChange();
  }
);

// ------------------------------ helpers --------------------------------

const setStatus = (msg) => { els.status.textContent = msg; };

function setMapCursor(mode) {
  if (mode === 'radius') els.mapEl.classList.add('radius-mode');
  else els.mapEl.classList.remove('radius-mode');
}

/** Debounce — fire `fn` only after `wait` ms of quiet. */
function debounce(fn, wait) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), wait);
  };
}

// --------------------- map sources & layers (added once) ---------------

if (map) map.on('load', async () => {
  // Install the unit-aware scale control now that the map is ready.
  applyScaleControl();

  // Empty sources; we replace data in setData calls.
  const empty = { type: 'FeatureCollection', features: [] };

  map.addSource('segments', { type: 'geojson', data: empty });
  map.addSource('signals',  { type: 'geojson', data: empty });
  map.addSource('radius',   { type: 'geojson', data: empty });

  // Activities first (under visits, since visits are smaller and
  // should be on top).
  map.addLayer({
    id: 'activities-line',
    type: 'line',
    source: 'segments',
    filter: ['==', ['get', 'type'], 'activity'],
    paint: {
      'line-color': ACTIVITY_COLOR,
      'line-width': [
        'interpolate', ['linear'], ['zoom'],
        8, 1.0, 14, 2.5, 18, 4,
      ],
      'line-opacity': 0.85,
    },
  });

  // Visits as small "fort" markers (concentric rings would be
  // overkill; plain circles read clearly at all zooms).
  map.addLayer({
    id: 'visits-circle',
    type: 'circle',
    source: 'segments',
    filter: ['==', ['get', 'type'], 'visit'],
    paint: {
      'circle-radius': [
        'interpolate', ['linear'],
        ['coalesce', ['get', 'duration_min'], 0],
        0,    3,
        60,   5,
        480,  7,        // 8h
        1440, 10,       // 24h
      ],
      'circle-color':        cssVar('--c-paper'),
      'circle-stroke-color': cssVar('--c-visit'),
      'circle-stroke-width': 1.5,
      'circle-opacity':      0.95,
    },
  });

  // Raw signals — small dots. Hidden by default (toggleable).
  map.addLayer({
    id: 'signals-circle',
    type: 'circle',
    source: 'signals',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        12, 1.5, 16, 3, 18, 4,
      ],
      'circle-color':         cssVar('--c-signal'),
      'circle-opacity':       0.7,
      'circle-stroke-width':  0,
    },
  });

  // Heatmap — visit centers + sampled along activity paths. We
  // generate a denser secondary source for this so it isn't tied
  // to whatever the segments layer is showing.
  map.addSource('heatmap', { type: 'geojson', data: empty });
  map.addLayer({
    id: 'heatmap',
    type: 'heatmap',
    source: 'heatmap',
    layout: { visibility: 'none' },
    paint: {
      'heatmap-weight': 1,
      'heatmap-intensity': [
        'interpolate', ['linear'], ['zoom'],
        0, 1, 14, 3,
      ],
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0,    'rgba(0,0,0,0)',
        0.2,  'rgba(177,59,39,0.3)',
        0.5,  'rgba(177,59,39,0.6)',
        1,    'rgba(177,59,39,0.85)',
      ],
      'heatmap-radius': [
        'interpolate', ['linear'], ['zoom'],
        0, 8, 14, 30,
      ],
    },
  }, 'activities-line');  // place beneath the segment layers

  // Places — labeled spots and frequently-visited unlabeled ones.
  // We deliberately don't render text labels on the map: that would
  // require loading a glyph stack (MapLibre's symbol layer needs
  // `glyphs` on the style root) which conflicts with our offline-
  // first design. Hover popups carry the label instead.
  map.addSource('places', { type: 'geojson', data: empty });
  map.addLayer({
    id: 'places-circle',
    type: 'circle',
    source: 'places',
    paint: {
      // Size by sqrt of visits so a place visited 100x isn't 10x
      // bigger than one visited 1x. Clamp the floor so a brand-new
      // place is still visible.
      'circle-radius': [
        'interpolate', ['linear'],
        ['sqrt', ['max', ['coalesce', ['get', 'visits'], 0], 1]],
        1,  4,
        4,  6,
        10, 9,
        30, 13,
      ],
      'circle-color':         cssVar('--c-paper'),
      'circle-stroke-color':  cssVar('--c-place'),
      'circle-stroke-width':  2,
      'circle-opacity':       0.95,
    },
  });

  // Radius indicator (filled circle layer driven by GeoJSON Polygon).
  map.addLayer({
    id: 'radius-fill',
    type: 'fill',
    source: 'radius',
    paint: {
      'fill-color':   cssVar('--c-radius'),
      'fill-opacity': 0.12,
    },
  });
  map.addLayer({
    id: 'radius-outline',
    type: 'line',
    source: 'radius',
    paint: {
      'line-color': cssVar('--c-radius'),
      'line-width': 1.5,
      'line-dasharray': [2, 2],
    },
  });

  // Hover popups for visits, activities, places, and raw signals.
  attachHover('visits-circle', renderVisitPopup);
  attachHover('activities-line', renderActivityPopup);
  attachHover('places-circle', renderPlacePopup);
  attachHover('signals-circle', renderSignalPopup);

  // Map click → if in radius mode, do the search.
  map.on('click', onMapClick);

  // Refetch raw signals on map move (debounced) when that layer is on.
  map.on('moveend', debounce(() => {
    if (els.layerSignals.checked) loadSignals();
  }, 500));

  await initialLoad();
});

// ----------------------- hover popups --------------------------

function attachHover(layerId, renderer) {
  map.on('mousemove', layerId, (e) => {
    if (!e.features || !e.features.length) return;
    map.getCanvas().style.cursor = 'pointer';
    const f = e.features[0];
    els.popup.hidden = false;
    els.popup.innerHTML = renderer(f);
    // Position popup near cursor, but inside viewport.
    const x = e.point.x + 12;
    const y = e.point.y + 12;
    els.popup.style.left = `${x}px`;
    els.popup.style.top  = `${y}px`;
  });
  map.on('mouseleave', layerId, () => {
    map.getCanvas().style.cursor = '';
    els.popup.hidden = true;
  });
}

function renderVisitPopup(f) {
  const p = f.properties || {};
  const start = Number(p.start_ms);
  const end = Number(p.end_ms);
  const dur = end - start;
  const lines = [
    `<div class="h visit">visit</div>`,
    `<div>${fmtTime(start)}</div>`,
    `<div class="meta">duration ${fmtDuration(dur)}</div>`,
  ];
  if (p.place_id) lines.push(`<div class="meta">place ${escapeHTML(p.place_id)}</div>`);
  if (p.conf != null) lines.push(`<div class="meta">conf ${(+p.conf).toFixed(2)}</div>`);
  return lines.join('');
}

function renderActivityPopup(f) {
  const p = f.properties || {};
  const start = Number(p.start_ms);
  const end = Number(p.end_ms);
  const dur = end - start;
  const act = p.act || 'unknown';
  const lines = [
    `<div class="h act">${escapeHTML(act.toLowerCase().replace(/_/g,' '))}</div>`,
    `<div>${fmtTime(start)}</div>`,
    `<div class="meta">duration ${fmtDuration(dur)}</div>`,
  ];
  if (p.dist_m != null) lines.push(`<div class="meta">distance ${fmtMeters(+p.dist_m)}</div>`);
  if (p.conf != null) lines.push(`<div class="meta">conf ${(+p.conf).toFixed(2)}</div>`);
  return lines.join('');
}

function renderPlacePopup(f) {
  const p = f.properties || {};
  // The label gets the visual emphasis. Unlabeled places fall back
  // to the place_id, which is at least diagnostic.
  const head = p.label
    ? `<div class="h place">${escapeHTML(p.label)}</div>`
    : `<div class="h place" style="color:var(--c-ink-dim);font-style:italic;">unlabeled place</div>`;
  const lines = [head];
  lines.push(`<div class="meta">${(+p.visits || 0).toLocaleString()} visits`);
  if (p.total_seconds) {
    lines.push(` · ${fmtDuration((+p.total_seconds) * 1000)} total`);
  }
  lines.push(`</div>`);
  if (p.first_seen) {
    const first = p.first_seen.slice(0, 10);
    const last = (p.last_seen || '').slice(0, 10);
    lines.push(`<div class="meta">${first}${last && last !== first ? ' → ' + last : ''}</div>`);
  }
  if (!p.label && p.id) {
    // Show place_id only if there's no friendly label, so users can
    // copy it for `make place-label ID=...`
    lines.push(`<hr/><div class="meta" style="user-select:text;font-size:9px;">${escapeHTML(p.id)}</div>`);
  }
  return lines.join('');
}

// Format a lng/lat pair as a compact user-selectable string. Six
// decimals is ~11 cm precision at the equator — more than the
// underlying GPS accuracy, so no useful bits are truncated.
function fmtCoord(lng, lat) {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

// Popup for a single raw signal point. The two headline pieces of
// information are timestamp (down to the second — consecutive raw
// signals are often seconds apart) and coordinates (selectable so
// the user can copy-paste them elsewhere). Accuracy, altitude, and
// speed are shown when the underlying record had them; missing
// fields are silently dropped rather than shown as "—" so a sparse
// signal doesn't look like a broken one.
function renderSignalPopup(f) {
  const p = f.properties || {};
  const g = f.geometry || {};
  const coords = Array.isArray(g.coordinates) ? g.coordinates : [null, null];
  const [lng, lat] = coords;

  const lines = [`<div class="h signal">raw signal</div>`];
  if (p.ts_ms != null) {
    lines.push(`<div>${fmtTime(+p.ts_ms, { seconds: true })}</div>`);
  }
  if (lng != null && lat != null) {
    // `user-select: text` makes the coordinate string highlightable
    // for copy/paste. Tabular figures keep the digits aligned so the
    // eye can compare consecutive signals easily.
    lines.push(
      `<div class="meta" style="user-select:text;font-variant-numeric:tabular-nums;">`
      + fmtCoord(lng, lat) + `</div>`
    );
  }
  if (p.acc_m != null) {
    lines.push(`<div class="meta">accuracy ±${fmtMeters(+p.acc_m)}</div>`);
  }
  if (p.alt_m != null) {
    lines.push(`<div class="meta">alt ${fmtMeters(+p.alt_m)}</div>`);
  }
  if (p.spd != null && +p.spd > 0) {
    // spd is m/s from the underlying record. Convert to km/h or mph
    // based on the user's units preference so it reads consistently
    // with everything else in the app.
    const u = window.__lhPrefs?.units || 'km';
    const speedText = u === 'mi'
      ? `${(+p.spd * 2.23694).toFixed(1)} mph`
      : `${(+p.spd * 3.6).toFixed(1)} km/h`;
    lines.push(`<div class="meta">speed ${speedText}</div>`);
  }
  if (p.src) {
    lines.push(`<div class="meta">source ${escapeHTML(String(p.src))}</div>`);
  }
  return lines.join('');
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  }[c]));
}

// ----------------------- initial load --------------------------

async function initialLoad() {
  setStatus('Connecting…');
  try {
    await API.health();
  } catch (e) {
    setStatus('API unreachable');
    return;
  }

  // Get extent for sensible defaults & coverage strip.
  let extent;
  try { extent = await API.extent(); }
  catch { extent = {}; }
  state.extent = extent;

  // Default to last 30 days, ending at the data's max time.
  const maxTime = extent.end ? new Date(extent.end) : new Date();
  const minTime = extent.start ? new Date(extent.start) : new Date(maxTime.getTime() - 30*86400000);
  const startDefault = new Date(maxTime.getTime() - 30*86400000);
  // Don't go earlier than the data's actual start.
  const startClamped = startDefault < minTime ? minTime : startDefault;
  els.dateStart.value = toYMD(startClamped);
  els.dateEnd.value   = toYMD(maxTime);
  els.dateStart.min = toYMD(minTime);
  els.dateStart.max = toYMD(maxTime);
  els.dateEnd.min   = toYMD(minTime);
  els.dateEnd.max   = toYMD(maxTime);

  // Mark "30d" quick-range as active.
  highlightQuickRange('30d');
  refreshFitButtonEnabled();

  // Fit map to data extent if we have it. We use the same helper as
  // the "all" preset and the manual fit button, but with a tighter
  // maxZoom so an account whose data is in a single city doesn't
  // boot at street level.
  if (extent.bbox_geojson) {
    const bbox = bboxFromExtentPolygon(extent.bbox_geojson);
    if (bbox && map) {
      try {
        map.fitBounds(
          [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
          { padding: 40, duration: 0, maxZoom: 13 },
        );
      } catch (_) { /* ignore parse errors */ }
    }
  }

  // Fetch coverage for the entire data range — small enough that
  // we can afford it once and repaint sub-ranges client-side.
  setStatus('Loading coverage…');
  try {
    const cov = await API.coverage(extent.start, extent.end);
    coverage.setData(cov.days || []);
  } catch (e) {
    console.warn('coverage', e);
  }
  coverage.setRange(els.dateStart.value, els.dateEnd.value);

  // First segments fetch.
  await loadSegments();
  // Places are independent of date range — load once. They are
  // refreshed only when the user toggles the layer back on after
  // an ingest, which they can do from the sidebar.
  loadPlaces();
  setStatus(`${state.extent.start?.slice(0,10) ?? '?'} → ${state.extent.end?.slice(0,10) ?? '?'}`);
}

// ----------------------- places loading -----------------------

async function loadPlaces() {
  if (!els.layerPlaces.checked) {
    els.countPlaces.textContent = '—';
    return;
  }
  els.countPlaces.textContent = '…';
  let data;
  try {
    data = await API.places({ limit: 5000 });
  } catch (e) {
    console.warn('places', e);
    els.countPlaces.textContent = '!';
    return;
  }
  map.getSource('places').setData(data);
  els.countPlaces.textContent = (data.count || 0).toLocaleString();
}

// ----------------------- segment loading -----------------------

async function loadSegments() {
  const start = dayStartLocal(els.dateStart.value);
  const end   = dayEndLocal(els.dateEnd.value);
  const gen = ++state.segmentsGen;

  // Pick a simplification tolerance based on current map zoom.
  // Lower zoom -> coarser. Tuned roughly: zoom 4 ≈ 1km, 10 ≈ 30m, 15+ ≈ 0.
  const z = map.getZoom();
  const simplifyM = Math.max(0, Math.round(2000 * Math.pow(0.55, z)));

  setStatus('Loading segments…');
  els.countVisits.textContent = '…';
  els.countActivities.textContent = '…';
  let data;
  try {
    data = await API.segments({ start, end, limit: 50000, simplify_m: simplifyM });
  } catch (e) {
    console.warn('segments', e);
    setStatus('Error loading segments');
    return null;
  }
  if (gen !== state.segmentsGen) return null; // stale

  // Annotate features with duration_min for the visits radius
  // expression.
  for (const f of data.features) {
    const p = f.properties;
    if (p && p.start_ms != null && p.end_ms != null) {
      p.duration_min = Math.max(0, (p.end_ms - p.start_ms) / 60000);
    }
  }

  // Replace long chord segments with great-circle-interpolated arcs.
  // Activities stored as 2-point LineStrings (e.g. flights — Google
  // sometimes records them with only departure/arrival fixes) would
  // otherwise render as a Mercator-projected straight line that cuts
  // visibly south of the actual flight path. The 50km threshold
  // means short walks/drives are unaffected; the underlying stored
  // geometry isn't mutated, only the rendered copy.
  //
  // The densification also flows through to the heatmap source below
  // (so a flight contributes density along its actual path, not just
  // its endpoints) and to the day-click bbox computation (so fitBounds
  // follows the great-circle extent, including its northward bulge).
  densifyFeatureCollection(data);

  map.getSource('segments').setData(data);

  // Heatmap source: visit centers + first vertex of each activity.
  // (For a denser heatmap we'd sample each line; this is good enough
  // for v1.)
  const hf = [];
  for (const f of data.features) {
    if (!f.geometry) continue;
    if (f.geometry.type === 'Point') hf.push(f);
    else if (f.geometry.type === 'LineString') {
      for (const c of f.geometry.coordinates) {
        hf.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: {} });
      }
    }
  }
  map.getSource('heatmap').setData({ type: 'FeatureCollection', features: hf });

  // Counts.
  let nv = 0, na = 0;
  for (const f of data.features) {
    if (f.properties.type === 'visit') nv++; else na++;
  }
  els.countVisits.textContent = nv.toLocaleString();
  els.countActivities.textContent = na.toLocaleString();
  setStatus(`${data.count.toLocaleString()} segments` + (data.count >= data.limit ? ' (limit hit)' : ''));
  return data;
}

// ----------------------- raw signals loading -----------------------

async function loadSignals() {
  if (!els.layerSignals.checked) return;
  if (map.getZoom() < 13) {
    els.countSignals.textContent = '—';
    map.getSource('signals').setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  const b = map.getBounds();
  const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
  const gen = ++state.signalsGen;
  els.countSignals.textContent = '…';
  let data;
  try {
    data = await API.signals({
      bbox,
      start: dayStartLocal(els.dateStart.value),
      end: dayEndLocal(els.dateEnd.value),
      limit: 100000,
    });
  } catch (e) {
    console.warn('signals', e);
    return;
  }
  if (gen !== state.signalsGen) return;
  map.getSource('signals').setData(data);
  els.countSignals.textContent = data.count.toLocaleString() +
    (data.count >= data.limit ? '+' : '');
}

// ----------------------- date / quick-range -----------------------

function highlightQuickRange(name) {
  document.querySelectorAll('.quick-ranges button').forEach(b => {
    b.classList.toggle('active', b.dataset.range === name);
  });
  state.currentRange = name;
}

// Apply one of the preset date ranges. Sets the date inputs, kicks
// off a fresh segments load (skipping the debounce so we can wait
// on it), then fits the map to whatever the chosen range covers.
//
// The two-step flow — set dates, await load, fit — is deliberate:
// the alternative (fit-then-load, or fit-from-stale-data) would
// flash the map to the wrong place before the right data arrived.
async function applyQuickRange(name) {
  if (!state.extent || !state.extent.end) return;
  const maxTime = new Date(state.extent.end);
  const minTime = state.extent.start ? new Date(state.extent.start) : maxTime;
  let start;
  if (name === 'all') {
    start = minTime;
  } else if (name === '30d') {
    start = new Date(maxTime.getTime() - 30 * 86400000);
  } else if (name === '90d') {
    start = new Date(maxTime.getTime() - 90 * 86400000);
  } else if (name === '1y') {
    start = new Date(maxTime.getTime() - 365 * 86400000);
  }
  if (start < minTime) start = minTime;
  els.dateStart.value = toYMD(start);
  els.dateEnd.value   = toYMD(maxTime);
  highlightQuickRange(name);
  refreshFitButtonEnabled();

  // Skip the debounce: the user asked for a complete range in a
  // single click, no further input is coming.
  coverage.setRange(els.dateStart.value, els.dateEnd.value);
  await fitMapToCurrentRange({ presetName: name });
  if (els.layerSignals.checked) loadSignals();
}

// Manual date entry path — the user might still be editing (changed
// `from` but not `to` yet, or vice versa). We refresh the data so
// they can see what they're typing affects, but we deliberately do
// NOT auto-fit the map. That would zoom and pan in the middle of an
// edit, which feels jarring. The "fit map to range" button lets the
// user explicitly request a fit when they're done.
const onDateRangeChange = debounce(() => {
  coverage.setRange(els.dateStart.value, els.dateEnd.value);
  loadSegments();
  if (els.layerSignals.checked) loadSignals();
}, 250);

els.dateStart.addEventListener('change', () => {
  highlightQuickRange(null);
  refreshFitButtonEnabled();
  onDateRangeChange();
});
els.dateEnd.addEventListener('change', () => {
  highlightQuickRange(null);
  refreshFitButtonEnabled();
  onDateRangeChange();
});
els.quickRanges.addEventListener('click', (e) => {
  const r = e.target.dataset.range;
  if (r) applyQuickRange(r);
});

els.btnFitRange.addEventListener('click', () => {
  // We don't pass presetName — manual fit always uses the segment
  // bbox (not the extent shortcut). If the user typed dates that
  // happen to span the full extent, segment bbox produces the same
  // result anyway, modulo the limit-hit edge case.
  fitMapToCurrentRange({ presetName: null });
});

// Enable the fit button only when both date inputs have parseable
// values. We don't validate semantically (start <= end) because the
// browser's date input already constrains via its own validation,
// and a momentarily-inverted range during editing is harmless.
function refreshFitButtonEnabled() {
  const ok = !!(els.dateStart.value && els.dateEnd.value);
  els.btnFitRange.disabled = !ok;
}

// Convert the GeoJSON polygon stored in state.extent.bbox_geojson
// (an envelope from PostGIS via /extent) into a flat
// [minLng, minLat, maxLng, maxLat] tuple. Returns null on parse
// errors — caller falls back to a segment bbox in that case.
function bboxFromExtentPolygon(g) {
  try {
    const poly = typeof g === 'string' ? JSON.parse(g) : g;
    if (!poly || !poly.coordinates || !poly.coordinates[0]) return null;
    const ring = poly.coordinates[0];
    let minLng =  Infinity, minLat =  Infinity;
    let maxLng = -Infinity, maxLat = -Infinity;
    for (const p of ring) {
      if (p[0] < minLng) minLng = p[0];
      if (p[1] < minLat) minLat = p[1];
      if (p[0] > maxLng) maxLng = p[0];
      if (p[1] > maxLat) maxLat = p[1];
    }
    if (!isFinite(minLng) || !isFinite(maxLng)) return null;
    return [minLng, minLat, maxLng, maxLat];
  } catch {
    return null;
  }
}

// Fit the map to the currently-displayed date range. For "all" we
// prefer the server-provided extent envelope (computed over every
// segment in the database, so it's not subject to the /segments
// fetch limit). For everything else we await fresh segments and
// fit to their bbox.
async function fitMapToCurrentRange({ presetName } = {}) {
  if (!map) return;

  // "all" shortcut: the extent endpoint already gave us a true bbox
  // over every segment. Use that and skip the segment-fetch wait.
  if (presetName === 'all' && state.extent && state.extent.bbox_geojson) {
    const bbox = bboxFromExtentPolygon(state.extent.bbox_geojson);
    if (bbox) {
      // Trigger the data fetch in parallel — the user still expects
      // segments to update in the panel, just don't await them.
      loadSegments();
      fitToBbox(bbox);
      return;
    }
  }

  // Default path: refresh segments, then fit to whatever they cover.
  const data = await loadSegments();
  const bbox = featureCollectionBBox(data);
  if (!bbox) {
    // No segments in this range. Leave the map alone — better than
    // jumping to some arbitrary fallback.
    return;
  }
  fitToBbox(bbox);
}

function fitToBbox(bbox) {
  if (bbox[2] > bbox[0] && bbox[3] > bbox[1]) {
    map.fitBounds(
      [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
      { padding: 60, duration: 800, maxZoom: 17 },
    );
  } else {
    // Degenerate (single point). flyTo with sensible zoom.
    map.flyTo({ center: [bbox[0], bbox[1]], zoom: 15, duration: 800 });
  }
}

// ----------------------- layer toggles --------------------------

function setLayerVisible(layerId, visible) {
  if (!map || !map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
}

els.layerVisits.addEventListener('change', () => {
  setLayerVisible('visits-circle', els.layerVisits.checked);
});
els.layerActivities.addEventListener('change', () => {
  setLayerVisible('activities-line', els.layerActivities.checked);
});
els.layerSignals.addEventListener('change', () => {
  setLayerVisible('signals-circle', els.layerSignals.checked);
  if (els.layerSignals.checked) loadSignals();
});
els.layerPlaces.addEventListener('change', () => {
  setLayerVisible('places-circle', els.layerPlaces.checked);
  if (els.layerPlaces.checked) loadPlaces();
});
els.layerHeatmap.addEventListener('change', () => {
  setLayerVisible('heatmap', els.layerHeatmap.checked);
});

// ----------------------- preferences ----------------------------

// Initialize the units toggle from saved prefs and wire it up.
// Changing units rerenders the radius display and re-creates the
// MapLibre scale control (its `unit` is set at construction time).
let scaleControl = null;
function applyScaleControl() {
  if (!map) return;
  if (scaleControl) {
    map.removeControl(scaleControl);
    scaleControl = null;
  }
  const unit = prefs.get('units') === 'mi' ? 'imperial' : 'metric';
  scaleControl = new maplibregl.ScaleControl({ unit });
  map.addControl(scaleControl, 'bottom-left');
}

function refreshUnitsUI() {
  const u = prefs.get('units');
  els.unitsKm.classList.toggle('active', u === 'km');
  els.unitsMi.classList.toggle('active', u === 'mi');
  els.radiusUnit.textContent = u;
  // Re-render the radius input value in the new unit.
  els.radiusValue.value = formatUnitValue(metersToUnit(state.radiusMeters, u));
}

els.unitsKm.addEventListener('click', () => prefs.set('units', 'km'));
els.unitsMi.addEventListener('click', () => prefs.set('units', 'mi'));

prefs.subscribe(() => {
  refreshUnitsUI();
  if (map && map.loaded && map.loaded()) applyScaleControl();
});

// ----------------------- radius spinner --------------------------

// Range constraints in meters — match the API's clamping.
const RADIUS_MIN_M = 100;
const RADIUS_MAX_M = 100_000;

/** Read the input field, convert to meters, clamp, and update state.
 *  Tolerates whitespace and a trailing unit. Used after manual
 *  edits and after Enter / blur. */
function commitRadiusInput() {
  const u = prefs.get('units');
  const raw = (els.radiusValue.value || '').trim().replace(/[a-zA-Z]/g, '');
  const v = parseFloat(raw);
  if (isNaN(v) || v <= 0) {
    // Restore the displayed value — don't let an empty/invalid
    // input clobber state.
    els.radiusValue.value = formatUnitValue(metersToUnit(state.radiusMeters, u));
    return;
  }
  let m = unitToMeters(v, u);
  if (m < RADIUS_MIN_M) m = RADIUS_MIN_M;
  if (m > RADIUS_MAX_M) m = RADIUS_MAX_M;
  state.radiusMeters = m;
  els.radiusValue.value = formatUnitValue(metersToUnit(m, u));
}

function nudgeRadius(direction) {
  const u = prefs.get('units');
  const grid = gridForUnits(u);
  // Read whatever's currently displayed (may be off-grid if the user
  // just typed a number) — the grid logic snaps if needed.
  const currentDisplay = parseFloat(els.radiusValue.value);
  const startVal = isNaN(currentDisplay)
    ? metersToUnit(state.radiusMeters, u)
    : currentDisplay;
  const next = nudge(grid, startVal, direction);
  let m = unitToMeters(next, u);
  if (m < RADIUS_MIN_M) m = RADIUS_MIN_M;
  if (m > RADIUS_MAX_M) m = RADIUS_MAX_M;
  state.radiusMeters = m;
  els.radiusValue.value = formatUnitValue(metersToUnit(m, u));
}

els.radiusUp.addEventListener('click',   () => nudgeRadius(+1));
els.radiusDown.addEventListener('click', () => nudgeRadius(-1));

// Manual entry: commit on Enter or blur.
els.radiusValue.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitRadiusInput();
    els.radiusValue.blur();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    nudgeRadius(+1);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    nudgeRadius(-1);
  }
});
els.radiusValue.addEventListener('blur', commitRadiusInput);

// Bootstrap: paint initial unit/state into the UI.
refreshUnitsUI();

// ----------------------- radius search --------------------------

els.btnRadius.addEventListener('click', () => {
  state.radiusMode = !state.radiusMode;
  els.btnRadius.classList.toggle('active', state.radiusMode);
  els.btnRadius.textContent = state.radiusMode ? 'Click on map…' : 'Radius search…';
  els.radiusHint.hidden = !state.radiusMode;
  els.radiusControls.hidden = !state.radiusMode;
  setMapCursor(state.radiusMode ? 'radius' : null);
});

els.btnRadiusCancel.addEventListener('click', clearRadius);

function clearRadius() {
  state.radiusMode = false;
  state.lastRadiusHits = [];
  state.activeRadiusMonth = null;
  els.btnRadius.classList.remove('active');
  els.btnRadius.textContent = 'Radius search…';
  els.radiusHint.hidden = true;
  els.radiusControls.hidden = true;
  els.resultsPanel.hidden = true;
  setMapCursor(null);
  if (map.getSource('radius')) {
    map.getSource('radius').setData({ type: 'FeatureCollection', features: [] });
  }
}

async function onMapClick(e) {
  if (!state.radiusMode) return;
  // Make sure any in-progress manual edit gets committed first.
  commitRadiusInput();
  const lat = e.lngLat.lat;
  const lng = e.lngLat.lng;
  const radiusM = state.radiusMeters;

  // Stash the search center for click-to-jump in the results panel.
  state.lastRadiusCenter = [lng, lat];
  state.lastRadiusMeters = radiusM;
  // A new search resets timeline drill-down state.
  state.activeRadiusMonth = null;

  // Draw the circle.
  map.getSource('radius').setData({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [circleRingLngLat(lng, lat, radiusM)] },
    properties: {},
  });

  setStatus('Searching…');
  let resp;
  try {
    resp = await API.pointsNear({
      lat, lng, radius_m: radiusM,
      start: state.extent.start, end: state.extent.end,
      limit: 1000,
    });
  } catch (err) {
    setStatus('Search failed');
    return;
  }
  renderResults(resp);

  // Fit the map to the bbox returned by the API. The bbox brackets
  // every matched geometry plus the search circle, so the user
  // sees the full spatial extent of what they matched (not just
  // the immediate neighborhood of the click). Padding leaves a
  // visual margin on each side; maxZoom prevents an over-zoom on
  // tiny clusters where everything is essentially one point.
  if (map && Array.isArray(resp.bbox) && resp.bbox.length === 4) {
    const [minLng, minLat, maxLng, maxLat] = resp.bbox;
    // Guard against degenerate boxes (single-point results before
    // the circle is included; shouldn't happen given the SQL, but
    // belt-and-braces). MapLibre will throw on a zero-area bbox.
    if (maxLng > minLng && maxLat > minLat) {
      map.fitBounds(
        [[minLng, minLat], [maxLng, maxLat]],
        { padding: 60, duration: 800, maxZoom: 17 },
      );
    } else {
      map.flyTo({ center: [lng, lat], zoom: 15 });
    }
  }
}

function renderResults(resp) {
  const seg = resp.segment_hits || [];
  const raw = resp.raw_hits || [];
  els.resultsPanel.hidden = false;
  els.resultsCount.textContent = `${seg.length} segments · ${raw.length} signals`;

  const list = els.resultsList;
  list.textContent = '';
  if (!seg.length && !raw.length) {
    const p = document.createElement('p');
    p.textContent = 'No matches in your data.';
    p.style.color = 'var(--c-ink-muted)';
    p.style.fontStyle = 'italic';
    list.appendChild(p);
    setStatus('No matches');
    return;
  }

  // Stash the hits so the timeline can re-bucket them when the
  // user clicks between months.
  state.lastRadiusHits = seg;

  renderRadiusTimeline(seg);
  setStatus(`${seg.length + raw.length} matches`);
}

// ---------- radius timeline (months ⇒ days) ----------

// Build {ym: hit[]} and {ymd: hit[]} maps from a flat hit list.
// Bucketing is by local time, since the user's mental model of
// "what day was this" is unambiguously local. A 11pm-PT visit on
// May 5 should bucket as May 5, not May 6 (which is its UTC date).
function bucketHits(hits) {
  const byMonth = new Map();
  const byDay = new Map();
  for (const h of hits) {
    const d = new Date(h.start_ms);
    const ymd = toYMD(d);
    const ym  = ymd.slice(0, 7);
    if (!byMonth.has(ym)) byMonth.set(ym, []);
    byMonth.get(ym).push(h);
    if (!byDay.has(ymd)) byDay.set(ymd, []);
    byDay.get(ymd).push(h);
  }
  return { byMonth, byDay };
}

// Generate every YYYY-MM (or YYYY-MM-DD) string between two dates,
// inclusive. Used to draw zero-bars for empty months/days so the
// chart shows time density honestly rather than collapsing gaps.
function eachMonth(fromYM, toYM) {
  const [fy, fm] = fromYM.split('-').map(Number);
  const [ty, tm] = toYM.split('-').map(Number);
  const out = [];
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}
function eachDayOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  // Last day of month: day 0 of next month, evaluated in local time
  // for consistency with the rest of the timeline.
  const last = new Date(y, m, 0).getDate();
  const out = [];
  for (let d = 1; d <= last; d++) {
    out.push(`${ym}-${String(d).padStart(2, '0')}`);
  }
  return out;
}

// Render the timeline. Top-level dispatch: if a month is active,
// show only the days view; otherwise show only the months view.
// Earlier versions stacked both rows, which forced the user to scroll
// inside an already-shallow sidebar to see the day bars. Replacing
// the months row with the days row (with a "back" affordance) keeps
// the relevant content in view without scrolling.
function renderRadiusTimeline(hits) {
  const list = els.resultsList;
  list.textContent = '';
  if (!hits.length) return;

  if (state.activeRadiusMonth) {
    renderDaysView(hits, state.activeRadiusMonth);
  } else {
    renderMonthsView(hits);
  }
}

function renderMonthsView(hits) {
  const { byMonth } = bucketHits(hits);
  const list = els.resultsList;

  const ymKeys = [...byMonth.keys()].sort();
  if (!ymKeys.length) return;
  const allMonths = eachMonth(ymKeys[0], ymKeys[ymKeys.length - 1]);

  // Caption.
  const cap = document.createElement('div');
  cap.className = 'tl-caption';
  cap.textContent = `${hits.length} matches across ${allMonths.length} months. Click a month to expand.`;
  list.appendChild(cap);

  // Find max count for bar scaling.
  let maxMonth = 0;
  for (const ym of allMonths) {
    maxMonth = Math.max(maxMonth, (byMonth.get(ym) || []).length);
  }

  // The row goes inside a scroll wrapper so a many-year search can
  // scroll horizontally instead of compressing each bar to a hair-
  // line. The fill class makes bars fill available width when there
  // are few enough that no scroll is needed.
  const scroll = document.createElement('div');
  scroll.className = 'tl-scroll';
  const row = document.createElement('div');
  row.className = 'tl-row';
  // Reasonable threshold: at sidebar width ~300px content area and
  // a 14px min-width per bar, ~21 months fit comfortably.
  if (allMonths.length <= 21) row.classList.add('tl-row--fill');
  scroll.appendChild(row);
  list.appendChild(scroll);

  for (const ym of allMonths) {
    const n = (byMonth.get(ym) || []).length;
    const col = document.createElement('button');
    col.className = 'tl-col tl-month';
    col.dataset.ym = ym;
    col.disabled = n === 0;
    col.title = n === 0 ? `${ym}: no matches` : `${ym}: ${n} matches`;

    const bar = document.createElement('span');
    bar.className = 'tl-bar';
    const h = maxMonth ? Math.max(1, Math.round((n / maxMonth) * 100)) : 0;
    bar.style.height = `${h}%`;
    if (n === 0) bar.style.opacity = '0.25';
    col.appendChild(bar);

    const lbl = document.createElement('span');
    lbl.className = 'tl-label';
    // Compact label: just MMM, with year shown only on Jan or first
    // bar to avoid repetition.
    const [yy, mm] = ym.split('-');
    const [py] = (allMonths[allMonths.indexOf(ym) - 1] || '').split('-');
    const mIdx = +mm - 1;
    const monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][mIdx];
    lbl.textContent = (mIdx === 0 || py !== yy) ? `${monthShort}\n${yy}` : monthShort;
    col.appendChild(lbl);

    col.addEventListener('click', () => {
      if (n === 0) return;
      state.activeRadiusMonth = ym;
      renderRadiusTimeline(state.lastRadiusHits);
    });

    row.appendChild(col);
  }
}

function renderDaysView(allHits, ym) {
  const { byDay } = bucketHits(allHits);
  const list = els.resultsList;

  // Back button + caption row.
  const back = document.createElement('button');
  back.className = 'tl-back';
  back.textContent = '← all months';
  back.addEventListener('click', () => {
    state.activeRadiusMonth = null;
    renderRadiusTimeline(state.lastRadiusHits);
  });
  list.appendChild(back);

  const monthHits = (allHits || []).filter(h =>
    toYMD(new Date(h.start_ms)).slice(0, 7) === ym
  );
  const cap = document.createElement('div');
  cap.className = 'tl-caption';
  // Format the month nicely for the caption — "Jun 2024" rather
  // than the bare "2024-06" string.
  const [yy, mm] = ym.split('-');
  const monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+mm - 1];
  cap.textContent = `${monthShort} ${yy}: ${monthHits.length} matches. Click a day to view it on the map.`;
  list.appendChild(cap);

  const days = eachDayOfMonth(ym);
  let maxDay = 0;
  for (const ymd of days) {
    maxDay = Math.max(maxDay, (byDay.get(ymd) || []).length);
  }

  const scroll = document.createElement('div');
  scroll.className = 'tl-scroll';
  const row = document.createElement('div');
  row.className = 'tl-row tl-days';
  // Days always fit in a sidebar at 10px each (≤ 31 days × 10 =
  // 310px), so always use fill.
  row.classList.add('tl-row--fill');
  scroll.appendChild(row);
  list.appendChild(scroll);

  for (const ymd of days) {
    const n = (byDay.get(ymd) || []).length;
    const col = document.createElement('button');
    col.className = 'tl-col tl-day';
    col.dataset.ymd = ymd;
    col.disabled = n === 0;
    col.title = n === 0 ? `${ymd}: no matches` : `${ymd}: ${n} matches`;

    const bar = document.createElement('span');
    bar.className = 'tl-bar';
    const h = maxDay ? Math.max(1, Math.round((n / maxDay) * 100)) : 0;
    bar.style.height = `${h}%`;
    if (n === 0) bar.style.opacity = '0.2';
    col.appendChild(bar);

    const lbl = document.createElement('span');
    lbl.className = 'tl-label tl-day-label';
    // Sparse labels: 1, 5, 10, 15, 20, 25, 30. Keeps the row legible
    // at sidebar width. The full date is always in the title tooltip.
    const dayNum = +ymd.slice(-2);
    if (dayNum === 1 || dayNum % 5 === 0) {
      lbl.textContent = String(dayNum);
    } else {
      lbl.textContent = '';
    }
    col.appendChild(lbl);

    col.addEventListener('click', async () => {
      if (n === 0) return;
      // The user has narrowed from a search through a month to a
      // single day. The interesting question is now "what did I do
      // that day?", not "what did I do that day near my search."
      // So we set the date range to that day, load fresh segments,
      // and fit the map to those segments' bbox — which may be
      // anywhere on the planet, not necessarily near the search.
      //
      // Important: we bypass the debounced onDateRangeChange and
      // call loadSegments directly so we can await it. Otherwise
      // the fit would race the fetch and either land too early
      // (no data yet) or get clobbered by an earlier flyTo.
      els.dateStart.value = ymd;
      els.dateEnd.value = ymd;
      highlightQuickRange(null);
      coverage.setRange(ymd, ymd);

      const data = await loadSegments();
      if (els.layerSignals.checked) loadSignals();

      if (!map) return;
      const bbox = featureCollectionBBox(data);
      if (bbox && bbox[2] > bbox[0] && bbox[3] > bbox[1]) {
        map.fitBounds(
          [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
          { padding: 60, duration: 800, maxZoom: 17 },
        );
      } else if (bbox) {
        // Single point — bbox has zero area. Fly to the point at a
        // sensible zoom rather than letting fitBounds pick maxZoom.
        map.flyTo({ center: [bbox[0], bbox[1]], zoom: 15, duration: 800 });
      }
      // If bbox is null (no segments at all that day, which shouldn't
      // happen since the bar wouldn't have been clickable) we leave
      // the map alone — better than guessing where to go.
    });

    row.appendChild(col);
  }
}

// ------------- helpers: build a circle ring as lng/lat --------------

// Approximate a circle of radius `meters` around (lng, lat) as a
// polygon ring of N points. Good enough for visual feedback at our
// map scales.
function circleRingLngLat(lng, lat, meters, n = 64) {
  const pts = [];
  const R = 6371000; // earth radius
  const d = meters / R;
  const latRad = (lat * Math.PI) / 180;
  const lngRad = (lng * Math.PI) / 180;
  for (let i = 0; i <= n; i++) {
    const brng = (2 * Math.PI * i) / n;
    const lat2 = Math.asin(Math.sin(latRad) * Math.cos(d) + Math.cos(latRad) * Math.sin(d) * Math.cos(brng));
    const lng2 = lngRad + Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(latRad),
      Math.cos(d) - Math.sin(latRad) * Math.sin(lat2)
    );
    pts.push([(lng2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return pts;
}

// Compute the bounding box of a GeoJSON FeatureCollection. Walks
// every Point and every vertex of every LineString. Returns
// [minLng, minLat, maxLng, maxLat] or null if empty / degenerate.
//
// Used after a day-click on the radius timeline so we can fit the
// map to the day's actual activity rather than flying back to the
// search center (which was the bug: a day picked from a search
// over a far city would still zoom to home).
function featureCollectionBBox(fc) {
  if (!fc || !fc.features || fc.features.length === 0) return null;
  let minLng =  Infinity, minLat =  Infinity;
  let maxLng = -Infinity, maxLat = -Infinity;
  const acc = (lng, lat) => {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  };
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Point') {
      acc(g.coordinates[0], g.coordinates[1]);
    } else if (g.type === 'LineString') {
      for (const c of g.coordinates) acc(c[0], c[1]);
    }
  }
  if (!isFinite(minLng) || !isFinite(maxLng)) return null;
  return [minLng, minLat, maxLng, maxLat];
}
