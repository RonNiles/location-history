"""refresh_places includes trip-only places

Revision ID: 0005_refresh_places_trips
Revises: 0004_places_and_memories
Create Date: 2026-05-03

The original refresh_places() only inserted into `places` for IDs
that appeared in `segments` (i.e. places we actually visited). But
timeline_memories often reference destination places we passed
through during a trip without producing a discrete visit record.

This migration redefines refresh_places() to UNION in those
trip-only place IDs as well, so they're labelable too. Trip-only
places get NULL centroid / 0 visits / no time bounds — the row
exists primarily to anchor a user_label.
"""
from alembic import op


revision = "0005_refresh_places_trips"
down_revision = "0004_places_and_memories"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE OR REPLACE FUNCTION refresh_places() RETURNS void AS $$
        BEGIN
            INSERT INTO places
                (id, centroid, visit_count, total_seconds,
                 first_seen, last_seen, updated_at)
            -- All place IDs that appear anywhere in our data.
            -- Visit-derived rows have centroid + counts; trip-only
            -- rows have NULLs for those derived fields.
            WITH visits AS (
                SELECT
                    place_id AS id,
                    ST_Centroid(ST_Collect(center::geometry))::geography AS centroid,
                    count(*) AS visit_count,
                    COALESCE(SUM(EXTRACT(EPOCH FROM (end_ts - start_ts)))::bigint, 0)
                        AS total_seconds,
                    min(start_ts) AS first_seen,
                    max(end_ts)   AS last_seen
                FROM segments
                WHERE segment_type = 'visit'
                  AND place_id IS NOT NULL
                  AND center IS NOT NULL
                GROUP BY place_id
            ),
            trip_only AS (
                SELECT DISTINCT mp.place_id AS id
                FROM timeline_memory_places mp
                LEFT JOIN visits v ON v.id = mp.place_id
                WHERE v.id IS NULL
            )
            SELECT id, centroid, visit_count, total_seconds,
                   first_seen, last_seen, now() AS updated_at
            FROM visits
            UNION ALL
            SELECT id, NULL::geography, 0::bigint, 0::bigint,
                   NULL::timestamptz, NULL::timestamptz, now() AS updated_at
            FROM trip_only
            ON CONFLICT (id) DO UPDATE SET
                -- Only overwrite the derived fields. user_label, raw,
                -- and updated_at... wait — we always update updated_at.
                centroid       = EXCLUDED.centroid,
                visit_count    = EXCLUDED.visit_count,
                total_seconds  = EXCLUDED.total_seconds,
                first_seen     = EXCLUDED.first_seen,
                last_seen      = EXCLUDED.last_seen,
                updated_at     = EXCLUDED.updated_at
                -- DELIBERATELY do NOT update user_label or raw.
                ;
        END;
        $$ LANGUAGE plpgsql;
    """)


def downgrade() -> None:
    # Restore the visits-only version from migration 0004.
    op.execute("""
        CREATE OR REPLACE FUNCTION refresh_places() RETURNS void AS $$
        BEGIN
            INSERT INTO places
                (id, centroid, visit_count, total_seconds,
                 first_seen, last_seen, updated_at)
            SELECT
                place_id AS id,
                ST_Centroid(ST_Collect(center::geometry))::geography AS centroid,
                count(*) AS visit_count,
                COALESCE(SUM(EXTRACT(EPOCH FROM (end_ts - start_ts)))::bigint, 0)
                    AS total_seconds,
                min(start_ts) AS first_seen,
                max(end_ts)   AS last_seen,
                now() AS updated_at
            FROM segments
            WHERE segment_type = 'visit'
              AND place_id IS NOT NULL
              AND center IS NOT NULL
            GROUP BY place_id
            ON CONFLICT (id) DO UPDATE SET
                centroid       = EXCLUDED.centroid,
                visit_count    = EXCLUDED.visit_count,
                total_seconds  = EXCLUDED.total_seconds,
                first_seen     = EXCLUDED.first_seen,
                last_seen      = EXCLUDED.last_seen,
                updated_at     = EXCLUDED.updated_at;
        END;
        $$ LANGUAGE plpgsql;
    """)
