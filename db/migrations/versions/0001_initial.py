"""initial schema

Revision ID: 0001_initial
Revises:
Create Date: 2026-05-01

"""
from alembic import op
import sqlalchemy as sa
from geoalchemy2 import Geography


revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Extensions. PostGIS is provided by the postgis Docker image,
    # but the extension still has to be CREATEd in each database.
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")  # text search later

    # ---------- raw_signals ----------
    # Dense GPS-ish points. One row per fix from the export's rawSignals[].
    op.create_table(
        "raw_signals",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("location", Geography(geometry_type="POINT", srid=4326), nullable=False),
        sa.Column("accuracy_m", sa.Float, nullable=True),
        sa.Column("altitude_m", sa.Float, nullable=True),
        sa.Column("speed_mps", sa.Float, nullable=True),
        sa.Column("source", sa.Text, nullable=True),  # gps / wifi / cell / unknown
        sa.Column("raw", sa.dialects.postgresql.JSONB, nullable=False),
        # Hash of (ts, lat, lng rounded) used to make re-imports idempotent.
        sa.Column("dedup_key", sa.LargeBinary, nullable=False),
    )
    op.create_index("ix_raw_signals_ts", "raw_signals", ["ts"])
    op.create_index(
        "ix_raw_signals_location",
        "raw_signals",
        ["location"],
        postgresql_using="gist",
    )
    op.create_index(
        "ux_raw_signals_dedup",
        "raw_signals",
        ["dedup_key"],
        unique=True,
    )

    # ---------- segments ----------
    # Google's interpretation: a span of time classified as either
    # a visit (you stayed somewhere) or an activity (you moved).
    op.create_table(
        "segments",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column("segment_type", sa.Text, nullable=False),  # 'visit' | 'activity'
        sa.Column("start_ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("end_ts", sa.DateTime(timezone=True), nullable=False),
        # For visits: the place centroid. For activities: nullable.
        sa.Column("center", Geography(geometry_type="POINT", srid=4326), nullable=True),
        # For activities: the path as a linestring (ordered points).
        # Geography vs geometry matters here: geography is correct for
        # length-in-meters queries but doesn't support all functions.
        # We store as geography; cast to geometry when needed.
        sa.Column("path", Geography(geometry_type="LINESTRING", srid=4326), nullable=True),
        sa.Column("activity_type", sa.Text, nullable=True),  # walking, driving, ...
        sa.Column("activity_confidence", sa.Float, nullable=True),
        sa.Column("distance_m", sa.Float, nullable=True),
        sa.Column("place_id", sa.Text, nullable=True),  # Google Place ID if present
        sa.Column("raw", sa.dialects.postgresql.JSONB, nullable=False),
        sa.Column("dedup_key", sa.LargeBinary, nullable=False),
    )
    op.create_index("ix_segments_start_ts", "segments", ["start_ts"])
    op.create_index("ix_segments_end_ts", "segments", ["end_ts"])
    op.create_index("ix_segments_type", "segments", ["segment_type"])
    op.create_index(
        "ix_segments_center",
        "segments",
        ["center"],
        postgresql_using="gist",
        postgresql_where=sa.text("center IS NOT NULL"),
    )
    op.create_index(
        "ix_segments_path",
        "segments",
        ["path"],
        postgresql_using="gist",
        postgresql_where=sa.text("path IS NOT NULL"),
    )
    op.create_index("ux_segments_dedup", "segments", ["dedup_key"], unique=True)

    # ---------- import_runs ----------
    # Audit table — what we imported, when, from which file.
    op.create_table(
        "import_runs",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source_path", sa.Text, nullable=False),
        sa.Column("source_sha256", sa.Text, nullable=False),
        sa.Column("source_bytes", sa.BigInteger, nullable=False),
        sa.Column("raw_signals_inserted", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("raw_signals_skipped", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("segments_inserted", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("segments_skipped", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("notes", sa.Text, nullable=True),
    )


def downgrade() -> None:
    op.drop_table("import_runs")
    op.drop_table("segments")
    op.drop_table("raw_signals")
    op.execute("DROP EXTENSION IF EXISTS pg_trgm")
    op.execute("DROP EXTENSION IF EXISTS postgis")
