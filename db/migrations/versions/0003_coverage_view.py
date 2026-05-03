"""daily coverage view

Revision ID: 0003_coverage_view
Revises: 0002_activity_records
Create Date: 2026-05-02

A view that summarizes, per UTC day:
  * raw_signal_count    -- number of raw GPS fixes that day
  * segment_seconds     -- total seconds covered by segments that day
                           (clamped to the day's bounds for segments
                            that span across midnight)
  * has_raw / has_segments / has_any -- boolean coverage flags

This makes it cheap for the UI to draw a "data density" strip and to
weight the heatmap honestly (raw_signals coverage is sparse and
episodic; segments are the long-term truth).
"""
from alembic import op


revision = "0003_coverage_view"
down_revision = "0002_activity_records"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE OR REPLACE VIEW daily_coverage AS
        WITH raw_per_day AS (
            SELECT (ts AT TIME ZONE 'UTC')::date AS day,
                   count(*)::bigint AS raw_signal_count
            FROM raw_signals
            GROUP BY 1
        ),
        -- Expand each segment over every UTC day it touches and
        -- compute how many seconds of that day it actually covers.
        seg_days AS (
            SELECT
                d::date AS day,
                EXTRACT(EPOCH FROM
                    LEAST(end_ts, (d::date + 1)::timestamptz)
                  - GREATEST(start_ts, d::date::timestamptz)
                )::bigint AS seconds
            FROM segments,
            LATERAL generate_series(
                date_trunc('day', start_ts AT TIME ZONE 'UTC'),
                date_trunc('day', end_ts   AT TIME ZONE 'UTC'),
                interval '1 day'
            ) AS d
        ),
        seg_per_day AS (
            SELECT day, SUM(seconds)::bigint AS segment_seconds
            FROM seg_days
            WHERE seconds > 0
            GROUP BY day
        )
        SELECT
            COALESCE(r.day, s.day) AS day,
            COALESCE(r.raw_signal_count, 0) AS raw_signal_count,
            COALESCE(s.segment_seconds, 0)  AS segment_seconds,
            (r.raw_signal_count IS NOT NULL)         AS has_raw,
            (s.segment_seconds IS NOT NULL)          AS has_segments,
            (r.raw_signal_count IS NOT NULL
             OR s.segment_seconds IS NOT NULL)       AS has_any
        FROM raw_per_day r
        FULL OUTER JOIN seg_per_day s USING (day)
        ORDER BY day;
    """)


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS daily_coverage")
