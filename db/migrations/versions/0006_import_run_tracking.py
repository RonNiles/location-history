"""Track import-run provenance per row

Revision ID: 0006_import_run_tracking
Revises: 0005_refresh_places_trips
Create Date: 2026-05-07

Adds per-row tracking of which import run first inserted a record
(`created_import_run`) and which run most recently saw it
(`last_seen_import_run`, with `last_seen_at` for the wall-clock).

Motivation: with `ON CONFLICT (dedup_key) DO NOTHING`, a re-run of
the same source data is silent — we can't tell whether a row was
seen this run or only on its original ingest. That makes it hard
to investigate questions like "this duplicate appeared between
runs A and B — which run produced each side?"

The conflict clause for the three affected tables (segments,
raw_signals, activity_records) becomes DO UPDATE with a narrow
SET that only touches the two `last_seen_*` columns. The user-
visible data (centroid, path, confidence, etc.) is never altered
on conflict — the upsert is still effectively idempotent for the
record's content.

All three new columns are nullable to make this backward-compatible
with rows inserted before the migration; NULL means "predates
tracking." Backfilling historical rows is intentionally not done
here — we don't have the information to do it accurately, and
forensic value starts from the next ingest forward.
"""
from alembic import op
import sqlalchemy as sa


revision = "0006_import_run_tracking"
down_revision = "0005_refresh_places_trips"
branch_labels = None
depends_on = None


# Tables that go through the dedup-key upsert path. Adding the same
# three columns to each keeps the model uniform and means the ingester
# code path can be the same for every table.
_TRACKED_TABLES = ("segments", "raw_signals", "activity_records")


def upgrade() -> None:
    for table in _TRACKED_TABLES:
        # `created_import_run` is set on INSERT and never touched again.
        # Indexed because the most common diagnostic query is
        # "show me rows created by run X" or "count rows per run."
        op.add_column(
            table,
            sa.Column(
                "created_import_run",
                sa.BigInteger,
                sa.ForeignKey("import_runs.id", ondelete="SET NULL"),
                nullable=True,
            ),
        )
        op.create_index(
            f"ix_{table}_created_import_run",
            table,
            ["created_import_run"],
            postgresql_where=sa.text("created_import_run IS NOT NULL"),
        )

        # `last_seen_import_run` is set on INSERT and refreshed on
        # every subsequent matching upsert (the previously-silent
        # no-op path). When it differs from created_import_run, the
        # row has been seen in at least two runs.
        op.add_column(
            table,
            sa.Column(
                "last_seen_import_run",
                sa.BigInteger,
                sa.ForeignKey("import_runs.id", ondelete="SET NULL"),
                nullable=True,
            ),
        )

        # Wall-clock pairing for last_seen_import_run. Useful for
        # quick "what's stale" queries without joining import_runs.
        op.add_column(
            table,
            sa.Column(
                "last_seen_at",
                sa.DateTime(timezone=True),
                nullable=True,
            ),
        )


def downgrade() -> None:
    for table in _TRACKED_TABLES:
        op.drop_index(f"ix_{table}_created_import_run", table_name=table)
        op.drop_column(table, "last_seen_at")
        op.drop_column(table, "last_seen_import_run")
        op.drop_column(table, "created_import_run")
