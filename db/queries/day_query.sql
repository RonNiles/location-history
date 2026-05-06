-- day_query.sql
--
-- Dump everything in the database that's relevant to a single day,
-- in the timezone of the caller's choosing. Designed for terminal
-- use via `make day-query DAY=YYYY-MM-DD [TZ=...]`.
--
-- Variables (set with -v before running):
--   day  -- the calendar day in YYYY-MM-DD form
--   tz   -- IANA timezone name, e.g. 'America/Los_Angeles' or 'UTC'
--
-- The day is interpreted as local-midnight-to-local-midnight in `tz`.
-- All output timestamps are shown both in `tz` and in UTC so it's
-- obvious whether a row is borderline (e.g. a 23:00 PT visit is also
-- 06:00 UTC the next day).

\pset border 2
\pset linestyle unicode
\pset null '·'

-- Validate the timezone upfront. If `tz` is unparseable, we want a
-- clear single error rather than a cascade of syntax failures from
-- the AT TIME ZONE expressions below. We do this by attempting a
-- trivial AT TIME ZONE evaluation; on failure psql with
-- ON_ERROR_STOP=on aborts here before doing real work.
--
-- Avoid numeric offsets like '-07:00' (Postgres applies inverted
-- sign — see Postgres docs on POSIX vs ISO time zones). Use IANA
-- names ('America/Los_Angeles') or POSIX zone names ('PST8PDT').
SELECT (TIMESTAMP '2000-01-01 00:00:00' AT TIME ZONE :'tz') AS tz_check
\gset

-- Compute the local-midnight bounds once into psql variables and
-- echo them so the user can see exactly what window we're querying.
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

-- ---------- summary counts ----------

\echo
\echo === summary ===
WITH win AS (SELECT :'day_start_utc'::timestamptz AS s,
                    :'day_end_utc'::timestamptz   AS e)
SELECT 'raw_signals'      AS kind, (SELECT count(*) FROM raw_signals,      win WHERE ts        >= win.s AND ts        < win.e) AS n
UNION ALL
SELECT 'activity_records',         (SELECT count(*) FROM activity_records, win WHERE ts        >= win.s AND ts        < win.e)
UNION ALL
SELECT 'segments (overlap)',       (SELECT count(*) FROM segments,         win WHERE start_ts  <  win.e AND end_ts    >= win.s)
UNION ALL
SELECT '  visits',                 (SELECT count(*) FROM segments,         win WHERE start_ts  <  win.e AND end_ts    >= win.s AND segment_type = 'visit')
UNION ALL
SELECT '  activities',             (SELECT count(*) FROM segments,         win WHERE start_ts  <  win.e AND end_ts    >= win.s AND segment_type = 'activity')
UNION ALL
SELECT 'timeline_memories (overlap)',
                                   (SELECT count(*) FROM timeline_memories,win WHERE start_ts  <  win.e AND end_ts    >= win.s)
UNION ALL
SELECT 'unknown_records (seen_at)',
                                   (SELECT count(*) FROM unknown_records,  win WHERE seen_at   >= win.s AND seen_at   < win.e);

-- ---------- segments ----------

\echo
\echo === visits ===
SELECT
  s.id,
  (s.start_ts AT TIME ZONE :'tz')::timestamp AS start_local,
  (s.end_ts   AT TIME ZONE :'tz')::timestamp AS end_local,
  age(s.end_ts, s.start_ts) AS dur,
  s.activity_confidence    AS conf,
  s.place_id,
  COALESCE(p.user_label, '·') AS label,
  ST_AsText(s.center::geometry) AS center
FROM segments s
LEFT JOIN places p ON p.id = s.place_id
WHERE s.segment_type = 'visit'
  AND s.start_ts < :'day_end_utc'::timestamptz
  AND s.end_ts  >= :'day_start_utc'::timestamptz
ORDER BY s.start_ts;

\echo
\echo === activities ===
SELECT
  s.id,
  (s.start_ts AT TIME ZONE :'tz')::timestamp AS start_local,
  (s.end_ts   AT TIME ZONE :'tz')::timestamp AS end_local,
  age(s.end_ts, s.start_ts) AS dur,
  s.activity_type,
  s.activity_confidence    AS conf,
  s.distance_m             AS dist_m,
  ST_NPoints(s.path::geometry) AS path_pts
FROM segments s
WHERE s.segment_type = 'activity'
  AND s.start_ts < :'day_end_utc'::timestamptz
  AND s.end_ts  >= :'day_start_utc'::timestamptz
ORDER BY s.start_ts;

-- ---------- timeline memories ----------

\echo
\echo === timeline memories (trips) ===
SELECT
  m.id,
  (m.start_ts AT TIME ZONE :'tz')::date AS start_date,
  (m.end_ts   AT TIME ZONE :'tz')::date AS end_date,
  m.kind,
  COALESCE(m.title, '·') AS title,
  (SELECT count(*) FROM timeline_memory_places mp WHERE mp.memory_id = m.id) AS n_places
FROM timeline_memories m
WHERE m.start_ts < :'day_end_utc'::timestamptz
  AND m.end_ts  >= :'day_start_utc'::timestamptz
ORDER BY m.start_ts;

-- ---------- raw signals ----------
-- Capped at 200 rows: one position per minute is plausible, and 200
-- minutes of dense capture is enough to spot patterns. The summary
-- count above tells you the true total.

\echo
\echo === raw_signals (first 200) ===
SELECT
  rs.id,
  (rs.ts AT TIME ZONE :'tz')::timestamp AS ts_local,
  rs.source,
  rs.accuracy_m,
  rs.altitude_m,
  rs.speed_mps   AS speed,
  ST_AsText(rs.location::geometry) AS location
FROM raw_signals rs
WHERE rs.ts >= :'day_start_utc'::timestamptz
  AND rs.ts <  :'day_end_utc'::timestamptz
ORDER BY rs.ts
LIMIT 200;

-- ---------- activity records ----------

\echo
\echo === activity_records (first 200) ===
SELECT
  ar.id,
  (ar.ts AT TIME ZONE :'tz')::timestamp AS ts_local,
  ar.top_type            AS top,
  ar.top_confidence      AS conf,
  jsonb_pretty(ar.probables) AS probables
FROM activity_records ar
WHERE ar.ts >= :'day_start_utc'::timestamptz
  AND ar.ts <  :'day_end_utc'::timestamptz
ORDER BY ar.ts
LIMIT 200;

-- ---------- unknown records ----------
-- These are captured at ingest time, so seen_at is when we saw the
-- record, not when the underlying event happened. Useful to confirm
-- that an ingest run on this day picked up unrecognized data.

\echo
\echo === unknown_records (seen on this day, first 50) ===
SELECT
  u.id,
  (u.seen_at AT TIME ZONE :'tz')::timestamp AS seen_local,
  u.source_array,
  u.shape_hint
FROM unknown_records u
WHERE u.seen_at >= :'day_start_utc'::timestamptz
  AND u.seen_at <  :'day_end_utc'::timestamptz
ORDER BY u.seen_at
LIMIT 50;
