"""
Walk a directory of Google Maps Timeline exports and ingest each one
in chronological order (oldest first by file mtime).

Usage:
    python -m app.ingest_dir /path/to/exports/
    python -m app.ingest_dir /path/to/exports/ --pattern '*.json'
    python -m app.ingest_dir /path/to/exports/ --dry-run

Filename handling
-----------------
Across export-tool versions, Google has used at least three names:
    location-history.json  (older Android)
    Timeline.json          (current Android default)
    Timeline (N).json      (when the file manager auto-disambiguates
                            duplicates: 'Timeline (1).json',
                            'Timeline (2).json', ...)

We match all of these case-insensitively. Order is by mtime so each
export's audit row reflects what it added on top of the previous ones,
not the lexical ordering of '(10)' before '(2)'.

Skip-by-hash
------------
Each `import_runs` row stores the SHA-256 of the file that produced
it. Before doing any work on a candidate file, we hash it and skip if
that hash is already present. This keeps re-runs fast — the streaming
ingest is fast, but hashing 100MB takes a fraction of a second while
re-streaming all the JSON takes longer.
"""
from __future__ import annotations

import hashlib
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional

import psycopg
import typer
from rich.console import Console
from rich.table import Table

from app.ingest import DEFAULT_DB_URL, file_sha256


app = typer.Typer(add_completion=False)
console = Console()


# Default pattern matches the three filename forms we know about.
# Case-insensitive (Path.glob isn't, so we compile a regex too).
DEFAULT_FILENAME_RE = re.compile(
    r"^(location-history|timeline(?:\s*\(\d+\))?)\.json$",
    re.IGNORECASE,
)


def discover(root: Path, pattern: Optional[str]) -> list[Path]:
    """
    Find candidate JSON exports under `root`. If `pattern` is given,
    use it as a glob. Otherwise match any of the known Timeline names.
    Returns paths sorted by mtime ascending (oldest first).
    """
    if pattern:
        candidates = [p for p in root.rglob(pattern) if p.is_file()]
    else:
        candidates = [
            p for p in root.rglob("*.json")
            if p.is_file() and DEFAULT_FILENAME_RE.match(p.name)
        ]
    candidates.sort(key=lambda p: p.stat().st_mtime)
    return candidates


def already_imported(conn: psycopg.Connection, sha: str) -> Optional[int]:
    """Return import_runs.id of a previous run for this hash, else None."""
    with conn.cursor() as cur:
        cur.execute(
            """SELECT id FROM import_runs
               WHERE source_sha256 = %s AND finished_at IS NOT NULL
               ORDER BY id DESC LIMIT 1""",
            (sha,),
        )
        row = cur.fetchone()
        return row[0] if row else None


@app.command()
def main(
    root: Path = typer.Argument(..., exists=True, file_okay=False, dir_okay=True),
    db_url: str = typer.Option(DEFAULT_DB_URL, "--db-url", envvar="DATABASE_URL"),
    pattern: Optional[str] = typer.Option(
        None, "--pattern",
        help="Glob to match (default: location-history.json / Timeline*.json)",
    ),
    dry_run: bool = typer.Option(False, "--dry-run", help="Don't write to the DB"),
    force: bool = typer.Option(False, "--force", help="Re-ingest files already imported"),
):
    """Ingest every Timeline export in a directory tree."""
    root = root.resolve()
    files = discover(root, pattern)
    if not files:
        console.print(f"[yellow]No matching files under {root}[/]")
        raise typer.Exit(1)

    console.rule(f"[bold]Found {len(files)} file(s) under {root}[/]")
    for p in files:
        console.print(f"  {p.relative_to(root)}  ({p.stat().st_size/1e6:.1f} MB)")

    # Connect once just to check which files are already imported.
    conn = psycopg.connect(db_url, autocommit=True)
    try:
        skipped: list[Path] = []
        to_import: list[Path] = []
        for p in files:
            sha = file_sha256(p)
            existing = already_imported(conn, sha) if not dry_run else None
            if existing and not force:
                skipped.append(p)
            else:
                to_import.append(p)
    finally:
        conn.close()

    if skipped:
        console.print(f"\n[dim]Skipping {len(skipped)} already-imported file(s) "
                      f"(use --force to re-ingest)[/]")
        for p in skipped:
            console.print(f"  [dim]✓ {p.name}[/]")

    if not to_import:
        console.print("\n[green]Nothing to do.[/]")
        raise typer.Exit(0)

    console.print(f"\n[bold]Will ingest {len(to_import)} file(s):[/]")

    # Run the existing single-file ingester as a subprocess for each
    # file. This gives us natural process isolation — a crash on one
    # bad file doesn't poison the others — at the cost of re-importing
    # the Python interpreter each time. For a handful of 100MB files
    # the overhead is negligible.
    results: list[tuple[Path, int]] = []
    for p in to_import:
        console.rule(f"[bold cyan]{p.name}[/]")
        cmd = [sys.executable, "-m", "app.ingest", str(p), "--db-url", db_url]
        if dry_run:
            cmd.append("--dry-run")
        rc = subprocess.call(cmd)
        results.append((p, rc))

    # Final summary, pulled from the import_runs table itself so it
    # reflects what actually landed.
    console.rule("[bold green]Summary[/]")
    if dry_run:
        for p, rc in results:
            status = "OK" if rc == 0 else f"FAILED (rc={rc})"
            console.print(f"  {p.name}: {status}")
        raise typer.Exit(0)

    conn = psycopg.connect(db_url, autocommit=True)
    try:
        with conn.cursor() as cur:
            placeholders = ",".join(["%s"] * len(to_import))
            cur.execute(
                f"""SELECT source_path, raw_signals_inserted, segments_inserted,
                           activity_records_inserted, wifi_scans_dropped, finished_at
                    FROM import_runs
                    WHERE source_path IN ({placeholders})
                    ORDER BY id""",
                tuple(str(p) for p in to_import),
            )
            rows = cur.fetchall()

        table = Table(show_header=True, header_style="bold")
        table.add_column("file")
        table.add_column("positions", justify="right")
        table.add_column("segments", justify="right")
        table.add_column("activity", justify="right")
        table.add_column("wifi dropped", justify="right")
        table.add_column("finished")
        for sp, rs, sg, ar, wf, fin in rows:
            table.add_row(
                Path(sp).name,
                f"{rs:,}", f"{sg:,}", f"{ar:,}", f"{wf:,}",
                str(fin) if fin else "[red]incomplete[/]",
            )
        console.print(table)

        # Also dump a coverage snapshot at the end — useful for
        # verifying that newly-imported exports closed gaps.
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    count(*) FILTER (WHERE has_raw)        AS days_with_raw,
                    count(*) FILTER (WHERE has_segments)   AS days_with_segments,
                    count(*) FILTER (WHERE has_any)        AS days_with_any,
                    min(day), max(day)
                FROM daily_coverage
            """)
            dr, ds, da, lo, hi = cur.fetchone()
        console.print(
            f"\nCoverage:  {dr:,} days w/ raw_signals  ·  "
            f"{ds:,} days w/ segments  ·  {da:,} days w/ either"
        )
        if lo and hi:
            console.print(f"Span: {lo}  →  {hi}  ({(hi - lo).days + 1:,} days total)")
    finally:
        conn.close()


if __name__ == "__main__":
    app()
