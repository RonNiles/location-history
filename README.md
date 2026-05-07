# Location History

Ingest a Google Maps Timeline JSON export (the on-device format,
post-2024) into Postgres + PostGIS, then query and visualize it via
a Go read-API.

Everything runs in containers — the only thing exposed on the host is
the API on `127.0.0.1:8000` (configurable via `.env`). Postgres has
no host port by default; the Python ingest tools and `psql` shell
run as one-shot containers on the same compose network.

## Prerequisites

- Ubuntu 24 (or anything with Docker + Compose v2)
- Docker Engine + Compose plugin
- ~2GB free disk for the Postgres volume

Install Docker on Ubuntu 24 if you don't already have it:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2 make curl
sudo usermod -aG docker "$USER"   # log out + back in for this to take effect
```

You do **not** need Python on the host — ingestion runs in a
container. Go is only needed if you want to run the API tests on the
host (`make api-test`); otherwise the API is built inside its own
container too.

## One-time setup

```bash
make up         # builds the api image, starts db + api
make migrate    # applies Alembic migrations (runs in ingest container)
```

That's it. The API is now reachable at `http://127.0.0.1:8000`.

```bash
curl http://127.0.0.1:8000/health
# {"status":"ok"}
```

## Network layout

```
host
├── 127.0.0.1:${API_PORT}  ───►  api container  ──►  db container
└── (no other ports exposed)                       (postgres, only on
                                                    the compose network)
```

`API_PORT` defaults to 8000. Postgres has no host port mapping. The
Go API talks to it over the compose network using the DNS name `db`.
The Python ingester and the `psql` shell run as one-shot containers
on the same network.

If you want to point a desktop tool (DBeaver, Postico) at the DB,
opt in temporarily:

```bash
make db-expose      # exposes Postgres on 127.0.0.1:5432
make db-private     # back to private (this is the default state)
```

## Configuration

Defaults work out of the box. To override, copy `.env.example` to
`.env` and edit:

```bash
cp .env.example .env
```

Currently configurable:

- `API_PORT` — host port for the API (default `8000`). Change this
  if 8000 conflicts with something else on your machine. Both
  `docker compose` and the `Makefile` read this variable, so
  `make up` and the health-check curl follow the override.

After editing `.env`, restart the API:

```bash
make api-rebuild
```

## Importing your export

First, **probe** the file — this prints what top-level keys are
present and how many items are in each. The schema of Google's
on-device export has shifted across versions, so this confirms the
two array names the importer expects (`rawSignals` and
`semanticSegments`):

```bash
make probe JSON=/path/to/Timeline.json
```

Expected output looks something like:

```
{'rawSignals': 412318, 'semanticSegments': 18402, ...}
```

If the keys are named differently in your file, pass them explicitly
through the container:

```bash
docker compose run --rm \
  -v "$(dirname /path/to/Timeline.json):/host-input:ro" \
  ingest \
  python -m app.ingest /host-input/Timeline.json \
    --raw-signals-key=rawSignals \
    --segments-key=semanticSegments
```

Then dry-run (parses everything, doesn't write):

```bash
make dry-run JSON=/path/to/Timeline.json
```

If the dry-run looks healthy, import for real:

```bash
make ingest JSON=/path/to/Timeline.json
```

This is **idempotent** — running it twice doesn't create duplicates.

### Importing a directory of exports

Google's on-device Timeline format only includes ~30 days of
`rawSignals` per export, so to keep the raw-signal coverage dense
you'll want to do regular exports (every few weeks) and ingest them
all. The `ingest_dir` command handles a folder of exports:

```bash
make ingest-dir DIR=~/timeline-exports
```

It matches `location-history.json`, `Timeline.json`, and
`Timeline (N).json` (the three filename forms Android has used
across versions), sorts them by mtime so older exports go first,
and skips files whose SHA-256 was already imported. Just drop new
exports into the directory and re-run.

Output ends with a per-file summary table and a coverage report:

```
Coverage:  142 days w/ raw_signals  ·  3,847 days w/ segments  ·  3,847 days w/ either
Span: 2014-08-01  →  2026-04-28  (4,289 days total)
```

Going forward, my recommended workflow is:

1. Set a calendar reminder every ~3 weeks.
2. On Android: `Settings → Location → Location services → Timeline → Export`
3. Save the resulting `Timeline (N).json` into your exports directory.
4. Run `make ingest-dir DIR=~/timeline-exports` to pick it up.

### About `rawSignals` coverage

The on-device export only includes ~30 days of `rawSignals`, so
you'll see big gaps in the raw-signal data for any month between
exports. The `semanticSegments` data is long-term — it goes back as
far as you've used Timeline. Use `make coverage` to see what's
covered:

```bash
make coverage
```

## Inspecting the data

Quick stats:

```bash
make stats
```

Open a psql shell:

```bash
make psql
```

Some useful exploratory queries:

```sql
-- How dense is the data over time?
SELECT date_trunc('month', ts) AS month, count(*)
FROM raw_signals
GROUP BY 1 ORDER BY 1;

-- Activity type breakdown
SELECT activity_type, count(*)
FROM segments
WHERE segment_type = 'activity'
GROUP BY 1 ORDER BY 2 DESC;

-- Bounding box of all your data
SELECT ST_AsText(ST_Extent(location::geometry)) FROM raw_signals;

-- How many points are within 500m of a given location?
SELECT count(*) FROM raw_signals
WHERE ST_DWithin(
    location,
    ST_SetSRID(ST_MakePoint(-122.4194, 37.7749), 4326)::geography,
    500
);
```

## Schema overview

- `raw_signals` — one row per GPS fix.
  - `ts TIMESTAMPTZ`, `location geography(Point,4326)`, `accuracy_m`, etc.
  - `raw JSONB` keeps the original record so we can re-derive things later.
  - GiST index on `location`, btree on `ts`.
- `segments` — visit/activity spans from Google's interpretation.
  - `segment_type` is `'visit'` or `'activity'`.
  - Visits have a `center` point. Activities have a `path` linestring.
- `import_runs` — audit log of what got imported, when, from where.

## Troubleshooting

**"could not connect to server"** — `make up` finished but the DB
isn't ready yet. The Makefile waits for `pg_isready`, but if you ran
something else first, give it a few seconds.

**High "unparseable" count on dry-run** — the export's record shape
differs from what the importer expects. Run a few records through
the container's Python directly:

```bash
docker compose run --rm \
  -v "$(dirname /path/to/Timeline.json):/host-input:ro" \
  ingest python -c "
import ijson
with open('/host-input/Timeline.json', 'rb') as f:
    for i, item in enumerate(ijson.items(f, 'rawSignals.item')):
        if i >= 3: break
        print(item)
"
```

Then we adjust `extract_raw_signal` / `extract_segment` in
`app/ingest.py` to match the real shape.

**"out of memory" during import** — drop `BATCH_SIZE` in
`app/ingest.py` from 50,000 to e.g. 10,000.

## API server

A small Go server in `api/` exposes read endpoints over the data.
We use Go for the API instead of Python because pgx propagates
context cancellation cleanly into Postgres — when an HTTP client
disconnects, the still-running query is cancelled rather than
running to completion and discarding its result.

### Running

The API is part of `docker compose up -d` (which is what `make up`
calls). It runs in its own container, builds from a multi-stage
Dockerfile, and exposes only loopback port 8000.

```bash
make up               # builds + starts db + api
curl http://127.0.0.1:8000/health
make api-logs         # follow API logs
make api-rebuild      # rebuild the api image and restart that one container
make api-test         # run Go unit tests on the host (requires Go installed)
```

To run the API outside Docker for development (you'll need Go 1.22+
installed and the DB exposed on 5432 — see `make db-expose`):

```bash
make db-expose
cd api && go run ./cmd/server
make db-private       # remember to put it back when done
```

### Endpoints

All endpoints are read-only and return JSON. Coordinate order in
GeoJSON is `[lng, lat]` per the spec.

**`GET /health`** — pings the DB. 200 OK if reachable.

**`GET /coverage[?start=...&end=...]`** — daily coverage rows from
the `daily_coverage` view. Returns `{"days":[{day, raw_signal_count,
segment_seconds, has_raw, has_segments}, ...]}`. Use this in the UI to
show which date ranges have raw GPS data vs segment-only data.

**`GET /signals?bbox=...&start=...&end=...&limit=N`** — streaming
GeoJSON FeatureCollection of raw GPS points within the bbox and time
window. Required: `bbox`, `start`, `end`. Default limit 50,000; hard
cap 500,000.

```
bbox       minLng,minLat,maxLng,maxLat
start, end RFC3339 (e.g. 2024-06-01T00:00:00Z)
limit      max features (default 50_000, cap 500_000)
```

The response streams — clients can start rendering before the full
result is in hand. If you disconnect mid-response, the underlying
Postgres query is cancelled.

**`GET /segments?start=...&end=...[&bbox=...&types=visit,activity&limit=N]`** —
GeoJSON FeatureCollection of visits (Points) and activities (LineStrings)
that overlap the time window. `types` defaults to both.

**`GET /points-near?lat=...&lng=...&radius_m=...[&start=...&end=...&limit=N]`** —
"when was I within X meters of (lat, lng)?". Searches both
`raw_signals` and `segments`, returning two arrays:

```json
{
  "query": {"lat": 37.7749, "lng": -122.4194, "radius_m": 200, ...},
  "raw_hits":     [{"id", "ts_ms", "lng", "lat", "dist_m", "acc_m", "src"}, ...],
  "segment_hits": [{"id", "type", "start_ms", "end_ms", "min_dist_m", "act", ...}, ...],
  "limit": 1000
}
```

`raw_hits` is sparse (we only have raw GPS for ~30 days per export).
`segment_hits` covers the long-term timeline. The UI should show both
and label them differently.

### Design notes

The Go API is a thin shim — all the spatial heavy lifting happens in
PostGIS. Key implementation choices:

- **`pgx/v5`** instead of `database/sql`. Binary protocol, faster
  scans, real context propagation.
- **Streaming JSON** for `/signals` and `/segments`. We write the
  FeatureCollection envelope manually and emit each feature as we
  pull it from the cursor, so memory stays flat regardless of result
  size.
- **`ST_MakeEnvelope` + `&&`** for bbox queries. The `&&` operator
  uses the GiST index directly. We cast geography → geometry only
  for the bbox check; distance computations still use geography.
- **`ST_DWithin(geography, geography, meters)`** for radius search.
  This is the canonical "within X meters" pattern in PostGIS and
  uses the GiST index.
- **`extract(epoch FROM ts) * 1000`** in SQL to emit JS-friendly
  millisecond timestamps without round-trip through the Go time
  package.

## Web UI

The API serves a static single-page UI at `/`. The UI is bundled into
the Go binary via `//go:embed`, so there's nothing extra to deploy —
once the API container is running, open `http://127.0.0.1:8000` in a
browser.

### Features

- **Segments view**: visits as circles (sized by stay duration),
  activities as colored polylines (color by transport mode). Hover
  any feature for time / duration / details.
- **Date range picker**: defaults to the last 30 days of your data.
  Quick-range buttons for 30d / 90d / 1y / all. A coverage strip
  beneath the picker shows raw-signal density and segment-time
  density per day at a glance — click anywhere on it to jump.
- **Layer toggles**: visits, activities, raw signals (zoom 13+), and
  a heatmap layer.
- **Radius search**: click the button, then click anywhere on the
  map to find every visit/activity within N meters of that point
  across your entire history. Results group by month; clicking a
  result jumps the date range so you can see the segment in context.
- **Path simplification**: at low zoom levels the API simplifies
  activity paths server-side (via `ST_SimplifyPreserveTopology`) so
  cross-country trips don't ship thousands of points to the browser.

### Tiles

The UI doesn't fetch OSM tiles directly. Instead the API exposes a
`/tiles/{z}/{x}/{y}.png` endpoint that proxies upstream and caches
the bytes to disk:

```
browser  →  /tiles/14/2632/6334.png  →  api  →  hits disk cache?
                                              ↳ yes: serve immediately
                                              ↳ no:  fetch upstream,
                                                     write to disk,
                                                     serve
```

Why bother:

- **Respect for OSM**: each tile is fetched from upstream at most
  once (until eviction). OSM's tile usage policy explicitly asks
  for this kind of caching.
- **Speed**: warm-cache requests are a filesystem read — sub-millisecond.
- **Offline-ish**: any region you've browsed before keeps working
  even if upstream OSM is down or unreachable. The cache persists
  in a Docker named volume across `make api-rebuild`.

The cache lives at `/var/cache/tiles` inside the API container,
backed by a Docker named volume (`tilecache`).

```bash
make tile-stats     # in-memory hits/misses + on-disk file count + size
make tiles-clear    # nuke the cache
```

The `X-Cache` response header tells you what happened for each
request: `hit`, `miss`, `stale-revalidated`, or `stale-fallback`
(stale bytes served because upstream is down).

**Configuring upstream.** Default is `tile.openstreetmap.org`; edit
`.env` (see `.env.example`) to point at a different upstream like a
self-hosted tileserver-gl. **Set `TILE_USER_AGENT` to identify your
application** — OSM's tile usage policy requires it.

**Rate limiting.** A token bucket (default 5 req/s, burst 20) caps
how fast we hit upstream. Single-flight de-duplication ensures that
multiple simultaneous browser requests for the same tile coalesce
into one upstream fetch. Both are configurable via `.env`.

### Offline-friendly assets

MapLibre GL JS, the maplibre CSS, and EB Garamond + JetBrains Mono
fonts are all vendored under `api/cmd/server/ui/vendor/` and embedded
into the binary. With the tile cache warmed for a region, the UI
works fully offline for that region.

### Design

The aesthetic is intentionally low-flash and high-density: warm
paper background, EB Garamond for headings, JetBrains Mono for data,
a single cinnabar accent for selected/active states. The goal is a
calm, instrumental feel for long browsing sessions — the visual
opposite of a marketing dashboard.

### Preferences

A small Preferences panel at the bottom of the sidebar carries
per-browser settings, currently:

- **Units** (km / mi). Affects the radius picker, popup distances,
  and the map's scale control. Stored in `localStorage` under
  `lh.prefs.v1` so it persists across reloads (per browser).

The radius picker's +/- buttons step through a quasi-logarithmic
grid in the chosen unit:

```
km:    0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100
mi:    0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50
```

You can also type any value directly. If you type something
off-grid (say `1.37 km`) and then click the arrow, the value snaps
to the nearest grid value (`1`); the next click steps from there.
This matches the way users typically use such a control: type a
rough value, then nudge to taste.

### Great-circle rendering of long activities

Activities with widely-spaced waypoints (most commonly flights —
sometimes recorded as just a departure and arrival fix) are
densified at render time so the rendered path follows the great
circle rather than a straight Mercator chord. The threshold is
50km per segment; below that, the chord and great circle differ by
sub-pixel amounts at any zoom we care about. Above it, the
deviation grows quadratically — a SFO→JFK flight rendered as a
chord misses Chicago by ~900km on the map even though the actual
flight passes within 25km of it.

The stored geometry isn't mutated; we only densify the copy that
flows into MapLibre and the day-click bbox computation. The
heatmap also benefits — a flight contributes density along its
actual path instead of just at its endpoints.

A known limitation: paths crossing the antimeridian (e.g.
LAX→Tokyo) will currently render as a "long way round" chord at
the seam. This isn't fixed yet because most users don't encounter
it; if it bites you, file an issue.

## Places

Google's `placeId` strings are promoted to a first-class `places`
table at the end of every ingest run (the SQL function
`refresh_places()` aggregates over `segments` where
`segment_type='visit' AND place_id IS NOT NULL`). Each place row
carries a derived centroid, `visit_count`, `total_seconds`,
`first_seen` / `last_seen`, plus an optional `user_label` that you
set yourself.

The `user_label` column is **preserved across re-imports** — only
the derived fields are updated by `refresh_places()`.

### Labeling places from the CLI

```bash
make places                    # top places by visit count
make places-unlabeled          # find places worth naming
make place-show ID=ChIJ...     # full detail for one place
make place-label ID=ChIJ... NAME="Mom's house"
make place-unlabel ID=ChIJ...  # clear a label
make place-search Q=ramen      # substring-search labels (uses trigram index)
```

A typical workflow:

```bash
make places-unlabeled          # see the places you visit most that aren't named
make place-show ID=ChIJ...     # confirm it's the one you mean
make place-label ID=ChIJ... NAME="The Italian place on 5th"
```

### Places on the map

The web UI has a **Places** layer in the sidebar (toggle, default on).
Each place renders as a deep-plum-bordered circle, sized by the
square root of its visit count so a place visited 100× isn't 10×
larger than one visited 1×. Hover any place for a popup showing
the user label, total visits, total time, and date range. For
unlabeled places the popup also shows the raw `place_id` so you
can copy it for `make place-label ID=...`.

Places are deliberately **not filtered by date range** — they're
a historical aggregate, so they remain a stable spatial anchor as
you scroll through time with the date picker. The date range still
controls visits, activities, signals, and the heatmap.

### Radius search timeline

For a frequently-visited place, the radius search returns dozens
or hundreds of hits. Rather than a flat list, the results panel
draws a **two-row timeline**: the top row is one bar per month
(across the full span of matches), the bottom row appears when you
click a month and shows one bar per day within that month. Bar
heights scale with hit count.

Click a day → the date picker snaps to that day and the map flies
to the search center, so you see the full context of what you did
that day, not just the radius hits. Click the active month again
to collapse the days row.

## Trips and timeline memories

Google occasionally produces `timelineMemory` records — multi-day
"trip" abstractions referencing a list of places. These are stored
in the `timeline_memories` table, with the ordered list of places
in `timeline_memory_places`. They reference (but don't duplicate)
data already in `segments`.

You can query them directly via psql for now; a `make trips` target
will land in a future round once we know what views are useful.

## Unknown records (forensics)

Anything the importer can't classify is captured in
`unknown_records` with a shape hint, instead of being silently
dropped. This is insurance against future Google export changes
introducing new record kinds — we capture them so we can add proper
handling later without losing data.

```bash
make unknowns
```

shows the kinds and counts. If a particular kind warrants real
handling, the `raw` JSONB column has the full record for
inspection:

```sql
SELECT raw FROM unknown_records WHERE shape_hint = 'someNewKind' LIMIT 5;
```

## Inspecting API calls

For debugging the UI's interaction with the backend — especially
"why did this search return these specific results?" — set two
env vars on the api container:

```
LOG_FORMAT=json     # one JSON line per event, easy to pipe to jq
LOG_BODIES=1        # capture up to 64KB of each response body
```

Drop them into your `.env` and `make api-rebuild`. Every request
then logs as a single JSON object with `request_id`, `method`,
`path`, `query`, `status`, `bytes`, `dur`, and `body` (parsed JSON
when the response is JSON, raw string otherwise; `truncated: true`
group when over the 64KB cap).

Each response also carries an `X-Request-Id` header so you can
correlate a flaky moment in the UI with its log line:

```bash
docker compose logs api -f | jq 'select(.path == "/points-near")'
```

`/tiles/*` and the embedded UI assets (`/`, `/app.js`, `/style.css`,
`/vendor/*`) are always skipped — capturing tile PNGs would bloat
the log without helping debug anything. Skipping is unconditional
even when `LOG_BODIES=1`.

Leave `LOG_BODIES` off for normal operation; the body capture adds
allocation pressure in proportion to response sizes. Turn it on
when you're hunting a specific bug.

## Inspecting a single day

When the UI shows something surprising for a particular day — or
you just want to see what an ingest produced — `make day-query`
dumps everything relevant to one calendar day in your chosen
timezone:

```bash
make day-query DAY=2024-06-15
make day-query DAY=2024-06-15 TZ=America/Los_Angeles
```

`DAY` is required (`YYYY-MM-DD`). `TZ` defaults to UTC; pass an IANA
timezone to interpret the day in that zone — useful for matching
what the web UI sees, since the UI uses the browser's local time.

**Valid `TZ` values:**

- IANA names like `America/Los_Angeles`, `Europe/London`,
  `Asia/Tokyo` — preferred, DST-aware.
- POSIX zone names like `PST8PDT`, `EST5EDT` — also DST-aware.
- `UTC` (the default).

**Avoid numeric offsets** like `-07:00` or `-07`: Postgres applies
inverted sign to these (a quirk of the POSIX time-zone tradition),
so `-07:00` actually means UTC**+**7. Bare digit forms like `-700`
are not parsed at all and produce an error. Stick to IANA names.

The output starts with the exact UTC window queried, then summary
counts, then visit and activity segments, timeline memories,
raw signals (capped at 200), activity records (capped at 200), and
any unknown records ingested that day. Times are shown in the
requested zone; the window header tells you the absolute moments.

### What's next

Possible Phase 4 directions, in roughly increasing order of effort:

- **More popup detail**: include reverse-geocoded address for visits
  (would require either a local geocoder or a third-party API).
- **Place clustering**: group repeat visits to the same `place_id`
  into a "you've been here N times" view.
- **Self-hosted tiles**: tileserver-gl + a regional MBTiles extract
  for fully offline browsing.
- **Vector tiles for huge datasets**: switch from full-document
  GeoJSON responses to MVT tiles served by the API. Worth it once
  you're past a few hundred thousand visible features.
