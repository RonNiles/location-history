"""activity_records and richer import audit

Revision ID: 0002_activity_records
Revises: 0001_initial
Create Date: 2026-05-01

Adds:
  * activity_records table for rawSignals[] entries that carry
    activityRecord (sensor inference of motion type) but no position.
  * import_runs columns to track activity records and wifi scans
    seen/dropped, so the per-import audit row gives a complete
    accounting of every record in the file.
"""
from alembic import op
import sqlalchemy as sa


revision = "0002_activity_records"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ---------- activity_records ----------
    # Sensor inference: at this timestamp, the device's accelerometer
    # said you were probably {STILL, IN_VEHICLE, ON_FOOT, ...}.
    # No location attached — these come from a different sensor pass.
    # Useful later for filtering segments / annotating raw_signals
    # by motion state.
    op.create_table(
        "activity_records",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        # The "winning" probable activity (highest confidence).
        sa.Column("top_type", sa.Text, nullable=True),
        sa.Column("top_confidence", sa.Float, nullable=True),
        # Full set of {type, confidence} pairs preserved as JSONB so
        # we don't lose runner-up classifications.
        sa.Column("probables", sa.dialects.postgresql.JSONB, nullable=False),
        sa.Column("raw", sa.dialects.postgresql.JSONB, nullable=False),
        sa.Column("dedup_key", sa.LargeBinary, nullable=False),
    )
    op.create_index("ix_activity_records_ts", "activity_records", ["ts"])
    op.create_index("ix_activity_records_type", "activity_records", ["top_type"])
    op.create_index(
        "ux_activity_records_dedup",
        "activity_records",
        ["dedup_key"],
        unique=True,
    )

    # ---------- import_runs new columns ----------
    op.add_column(
        "import_runs",
        sa.Column("activity_records_inserted", sa.BigInteger, nullable=False, server_default="0"),
    )
    op.add_column(
        "import_runs",
        sa.Column("activity_records_skipped", sa.BigInteger, nullable=False, server_default="0"),
    )
    op.add_column(
        "import_runs",
        sa.Column("wifi_scans_dropped", sa.BigInteger, nullable=False, server_default="0"),
    )
    op.add_column(
        "import_runs",
        sa.Column("unknown_records_dropped", sa.BigInteger, nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("import_runs", "unknown_records_dropped")
    op.drop_column("import_runs", "wifi_scans_dropped")
    op.drop_column("import_runs", "activity_records_skipped")
    op.drop_column("import_runs", "activity_records_inserted")
    op.drop_table("activity_records")
