-- import_runs.sql
--
-- Diagnostic report on import history. Reads the import_runs audit
-- table plus the per-row provenance columns added in migration 0006
-- (created_import_run, last_seen_import_run, last_seen_at).
--
-- Useful for investigating:
--   * "How many rows came from each ingest?"
--   * "Which rows have been touched by multiple runs?" (created !=
--     last_seen → the same dedup_key was seen again in a later run)
--   * "When did I last import?"

\pset border 2
\pset linestyle unicode
\pset null '·'

\echo
\echo === recent import runs ===
SELECT
  id,
  started_at::timestamp(0) AS started,
  finished_at::timestamp(0) AS finished,
  source_path,
  raw_signals_inserted AS rs_ins,
  segments_inserted    AS sg_ins,
  COALESCE(notes, '·') AS notes
FROM import_runs
ORDER BY id DESC
LIMIT 20;

-- ---------- per-run row counts ----------
-- Joins the per-row provenance back to import_runs to show the actual
-- distribution of rows by which run created them. Rows with NULL
-- created_import_run predate migration 0006 (legacy data) and are
-- grouped into a single bucket at the top.

\echo
\echo === rows by created_import_run (segments) ===
SELECT
  COALESCE(s.created_import_run::text, '· (pre-migration)') AS run_id,
  count(*) AS n_rows,
  min(s.start_ts)::date AS earliest_event,
  max(s.start_ts)::date AS latest_event
FROM segments s
GROUP BY s.created_import_run
ORDER BY s.created_import_run DESC NULLS LAST;

\echo
\echo === rows by created_import_run (raw_signals) ===
SELECT
  COALESCE(r.created_import_run::text, '· (pre-migration)') AS run_id,
  count(*) AS n_rows
FROM raw_signals r
GROUP BY r.created_import_run
ORDER BY r.created_import_run DESC NULLS LAST;

-- ---------- drift detection ----------
-- These are the headline diagnostic: rows where created and last_seen
-- disagree, meaning the row's dedup_key was seen in at least two
-- different runs. With ON CONFLICT DO UPDATE only touching the
-- last_seen_* columns, the row's data hasn't been mutated — but the
-- fact that two runs both produced a matching dedup_key tells us
-- something about how stable Google's exports are.
--
-- A row that drifts isn't a bug; a re-ingest of the same source file
-- will look exactly like this. The interesting case is when this
-- count is unexpectedly small (suggesting recent runs produced new
-- dedup_keys for things that should have matched older ones — a
-- duplication risk) or unexpectedly large (suggesting many rows are
-- being re-seen across runs, which is the expected idempotency).

\echo
\echo === segments seen in multiple runs ===
SELECT
  count(*) FILTER (WHERE created_import_run = last_seen_import_run)  AS single_run,
  count(*) FILTER (WHERE created_import_run <> last_seen_import_run) AS multi_run,
  count(*) FILTER (WHERE created_import_run IS NULL)                 AS pre_migration
FROM segments;

-- ---------- candidate-duplicate detection ----------
-- Rows with the same (segment_type, start_ts, place_id) but different
-- dedup_key are the candidate-duplicates worth investigating. Note
-- that this query is segments-only; raw_signals duplicates would use
-- (ts, location) grouping.
--
-- LIMIT 30 keeps the output manageable; if you suspect a lot of
-- duplicates, run the underlying query directly without the LIMIT.

\echo
\echo === candidate duplicate visits (same start, place, type; different dedup_key) ===
SELECT
  s.segment_type,
  s.start_ts::timestamptz AS start_ts,
  s.place_id,
  count(DISTINCT s.dedup_key) AS n_dedup_keys,
  array_agg(DISTINCT s.created_import_run ORDER BY s.created_import_run) AS runs
FROM segments s
WHERE s.place_id IS NOT NULL
GROUP BY s.segment_type, s.start_ts, s.place_id
HAVING count(DISTINCT s.dedup_key) > 1
ORDER BY s.start_ts
LIMIT 30;
