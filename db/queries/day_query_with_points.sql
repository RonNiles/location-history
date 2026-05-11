-- day_query_with_points.sql
--
-- Companion to day_query.sql. Where day_query gives you the lean
-- "what was on this day," this one zooms in on geographic detail:
-- every raw signal with its lat/lng, every visit's centroid, every
-- activity's full path (plus a few sample mid-points so the eye can
-- get a sense of the shape without parsing a 100-vertex LINESTRING).
--
-- Records without geographic content (timeline_memories with no
-- linked place, unknown_records, activity_records which are pure
-- sensor inferences) are intentionally skipped — use day_query for
-- those.
--
-- Variables (set with -v before running):
--   day  -- the calendar day in YYYY-MM-DD form
--   tz   -- IANA timezone name, e.g. 'America/Los_Angeles' or 'UTC'
--
-- Output sizes can be substantial: a busy day with continuous GPS
-- can easily produce 1000+ raw_signal rows and activity paths with
-- many hundreds of vertices. That's the point — when you're asking
-- "where exactly was I," you want it all.

\pset border 2
\pset linestyle unicode
\pset null '·'
\pset format wrapped

-- Validate the timezone upfront so a typo produces one clean error
-- instead of cascading through every section. (See day_query.sql for
-- the full discussion of valid TZ formats.)
SELECT (TIMESTAMP '2000-01-01 00:00:00' AT TIME ZONE :'tz') AS tz_check
\gset

SELECT
  (:'day' || ' 00:00:00')::timestamp AT TIME ZONE :'tz' AS day_start_utc,
  (:'day' || ' 00:00:00')::timestamp AT TIME ZONE :'tz' + INTERVAL '1 day' AS day_end_utc
\gset

\echo
\echo === window ===
SELECT
  :'day' AS local_day,
  :'tz' AS tz,
  :'day_start_utc'::timestamptz AS window_start,
  :'day_end_utc'::timestamptz   AS window_end;

-- ---------- visits ----------
-- Every visit overlapping the day, with its centroid as decimal
-- degrees. We include accuracy_m if the underlying record had one
-- (it usually doesn't for visits — they're inferences, not raw fixes).

\echo
\echo === visits (with coordinates) ===
SELECT
  s.id,
  (s.start_ts AT TIME ZONE :'tz')::timestamp AS start_local,
  age(s.end_ts, s.start_ts) AS dur,
  ST_Y(s.center::geometry) AS lat,
  ST_X(s.center::geometry) AS lng,
  s.place_id,
  COALESCE(p.user_label, '·') AS label
FROM segments s
LEFT JOIN places p ON p.id = s.place_id
WHERE s.segment_type = 'visit'
  AND s.start_ts < :'day_end_utc'::timestamptz
  AND s.end_ts  >= :'day_start_utc'::timestamptz
ORDER BY s.start_ts;

-- ---------- activities (full path) ----------
-- Each activity gets two rows here: the headline (id, type, distance,
-- vertex count, start/end coords) and then the full WKT in a wide
-- column. The WKT is paste-able into tools like geojson.io if you
-- want to see the route on a map outside the UI.
--
-- The endpoints are extracted into named columns so the most common
-- "where did this start/end" question is answerable at a glance
-- without parsing the WKT.

\echo
\echo === activities (with full path) ===
SELECT
  s.id,
  (s.start_ts AT TIME ZONE :'tz')::timestamp AS start_local,
  (s.end_ts   AT TIME ZONE :'tz')::timestamp AS end_local,
  s.activity_type,
  s.distance_m AS dist_m,
  ST_NPoints(s.path::geometry) AS pts,
  ST_Y(ST_StartPoint(s.path::geometry)) AS start_lat,
  ST_X(ST_StartPoint(s.path::geometry)) AS start_lng,
  ST_Y(ST_EndPoint(s.path::geometry))   AS end_lat,
  ST_X(ST_EndPoint(s.path::geometry))   AS end_lng,
  ST_AsText(s.path::geometry, 5)        AS path_wkt
FROM segments s
WHERE s.segment_type = 'activity'
  AND s.start_ts < :'day_end_utc'::timestamptz
  AND s.end_ts  >= :'day_start_utc'::timestamptz
ORDER BY s.start_ts;

-- ---------- raw_signals (every one) ----------
-- No cap. A day with continuous logging can produce >1000 rows; that's
-- fine — when the question is "where exactly was I at 3:42pm," you
-- need the actual fix, not a representative sample.
--
-- We sort by ts so reading the rows top-to-bottom traces your day in
-- chronological order.

\echo
\echo === raw_signals (every one, in order) ===
SELECT
  rs.id,
  (rs.ts AT TIME ZONE :'tz')::timestamp AS ts_local,
  rs.source,
  ST_Y(rs.location::geometry) AS lat,
  ST_X(rs.location::geometry) AS lng,
  rs.accuracy_m AS acc_m,
  rs.altitude_m AS alt_m,
  rs.speed_mps  AS spd
FROM raw_signals rs
WHERE rs.ts >= :'day_start_utc'::timestamptz
  AND rs.ts <  :'day_end_utc'::timestamptz
ORDER BY rs.ts;
