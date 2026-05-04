// Main application. Orchestrates the map, the date picker, layer
// toggles, hover popups, and the radius-search workflow.

import { API, dayStartUTC, dayEndUTC, toYMD, fmtTime, fmtDuration, fmtMeters } from './api.js';
import { CoverageStrip } from './coverage.js';

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
// rather than silently leaving the page on "Loading…".
let map;
try {
  map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: [-122.42, 37.77], // sane default; replaced once /extent loads
    zoom: 11,
    attributionControl: false,
  });
} catch (e) {
  showFatalError('webgl');
  throw e;
}

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
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

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
  layerVisits:   document.getElementById('layer-visits'),
  layerActivities: document.getElementById('layer-activities'),
  layerSignals:  document.getElementById('layer-signals'),
  layerHeatmap:  document.getElementById('layer-heatmap'),
  countVisits:   document.getElementById('count-visits'),
  countActivities: document.getElementById('count-activities'),
  countSignals:  document.getElementById('count-signals'),
  btnRadius:     document.getElementById('btn-radius'),
  radiusHint:    document.getElementById('radius-hint'),
  radiusControls: document.getElementById('radius-controls'),
  radiusM:       document.getElementById('radius-m'),
  btnRadiusCancel: document.getElementById('btn-radius-cancel'),
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
  lastRadiusCenter: null,  // [lng, lat] of last radius search
  lastRadiusMeters: null,
  // We re-fetch segments whenever the date range changes; stash a
  // generation counter to ignore stale responses.
  segmentsGen: 0,
  signalsGen: 0,
};

const coverage = new CoverageStrip(els.coverageSvg, els.coverageAxis,
  (ymd) => {
    // Picking on the strip jumps the start date if it's before the
    // current start, otherwise the end date. Either way we keep the
    // same span length.
    const cur = new Date(els.dateStart.value).getTime();
    const span = new Date(els.dateEnd.value).getTime() - cur;
    const picked = new Date(ymd + 'T00:00:00Z').getTime();
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

map.on('load', async () => {
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

  // Hover popups for visits and activities.
  attachHover('visits-circle', renderVisitPopup);
  attachHover('activities-line', renderActivityPopup);

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

  // Fit map to data extent if we have it.
  if (extent.bbox_geojson) {
    try {
      const g = typeof extent.bbox_geojson === 'string'
        ? JSON.parse(extent.bbox_geojson) : extent.bbox_geojson;
      const ring = g.coordinates[0];
      const lngs = ring.map(p => p[0]);
      const lats = ring.map(p => p[1]);
      map.fitBounds([
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ], { padding: 40, duration: 0, maxZoom: 13 });
    } catch (_) { /* ignore parse errors */ }
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
  setStatus(`${state.extent.start?.slice(0,10) ?? '?'} → ${state.extent.end?.slice(0,10) ?? '?'}`);
}

// ----------------------- segment loading -----------------------

async function loadSegments() {
  const start = dayStartUTC(els.dateStart.value);
  const end   = dayEndUTC(els.dateEnd.value);
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
    return;
  }
  if (gen !== state.segmentsGen) return; // stale

  // Annotate features with duration_min for the visits radius
  // expression.
  for (const f of data.features) {
    const p = f.properties;
    if (p && p.start_ms != null && p.end_ms != null) {
      p.duration_min = Math.max(0, (p.end_ms - p.start_ms) / 60000);
    }
  }

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
      start: dayStartUTC(els.dateStart.value),
      end: dayEndUTC(els.dateEnd.value),
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

function applyQuickRange(name) {
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
  onDateRangeChange();
}

const onDateRangeChange = debounce(() => {
  coverage.setRange(els.dateStart.value, els.dateEnd.value);
  loadSegments();
  if (els.layerSignals.checked) loadSignals();
}, 250);

els.dateStart.addEventListener('change', () => {
  highlightQuickRange(null); onDateRangeChange();
});
els.dateEnd.addEventListener('change', () => {
  highlightQuickRange(null); onDateRangeChange();
});
els.quickRanges.addEventListener('click', (e) => {
  const r = e.target.dataset.range;
  if (r) applyQuickRange(r);
});

// ----------------------- layer toggles --------------------------

function setLayerVisible(layerId, visible) {
  if (!map.getLayer(layerId)) return;
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
els.layerHeatmap.addEventListener('change', () => {
  setLayerVisible('heatmap', els.layerHeatmap.checked);
});

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
  const lat = e.lngLat.lat;
  const lng = e.lngLat.lng;
  const radiusM = Math.max(10, Math.min(100000, +els.radiusM.value || 200));

  // Stash the search center for click-to-jump in the results panel.
  state.lastRadiusCenter = [lng, lat];
  state.lastRadiusMeters = radiusM;

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
  // Group by year-month for readability.
  const grouped = new Map();
  for (const h of seg) {
    const ym = new Date(h.start_ms).toISOString().slice(0,7);
    if (!grouped.has(ym)) grouped.set(ym, []);
    grouped.get(ym).push(h);
  }
  // Sort groups newest first.
  const months = [...grouped.keys()].sort().reverse();
  for (const ym of months) {
    const h2 = document.createElement('h3');
    h2.textContent = ym;
    h2.style.fontFamily = 'var(--f-serif)';
    h2.style.fontSize = '13px';
    h2.style.fontWeight = '600';
    h2.style.color = 'var(--c-ink-dim)';
    h2.style.margin = '14px 0 4px';
    h2.style.borderBottom = '1px solid var(--c-rule)';
    list.appendChild(h2);
    for (const hit of grouped.get(ym)) {
      list.appendChild(renderHitRow(hit));
    }
  }
  setStatus(`${seg.length + raw.length} matches`);
}

function renderHitRow(hit) {
  const div = document.createElement('div');
  div.className = 'result';
  const dur = hit.end_ms - hit.start_ms;
  const date = new Date(hit.start_ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = new Date(hit.start_ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `
    <span class="when">${date}<br/>${time}</span>
    <span class="what">${hit.type === 'visit' ? 'visit' : (hit.act || 'activity').toLowerCase().replace(/_/g,' ')}
      <br/><span style="font-style:normal;font-family:var(--f-mono);font-size:10px;color:var(--c-ink-dim);">${fmtDuration(dur)}</span>
    </span>
    <span class="dist">${fmtMeters(hit.min_dist_m)}</span>
  `;
  div.addEventListener('click', () => {
    // Jump to the search center; this also adjusts the date range
    // to bracket the hit so the segment becomes visible.
    if (state.lastRadiusCenter) {
      map.flyTo({ center: state.lastRadiusCenter, zoom: 15 });
    }
    // Set the date range tightly around this hit so loadSegments
    // pulls it in.
    const day = new Date(hit.start_ms).toISOString().slice(0, 10);
    const dayBefore = new Date(hit.start_ms - 86400000).toISOString().slice(0, 10);
    const dayAfter = new Date(hit.end_ms + 86400000).toISOString().slice(0, 10);
    els.dateStart.value = dayBefore;
    els.dateEnd.value = dayAfter;
    highlightQuickRange(null);
    onDateRangeChange();
  });
  return div;
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
