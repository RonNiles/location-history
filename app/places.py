"""
Manage user-supplied labels for places.

Subcommands:

    list [--unlabeled] [--limit N]
        Show top places by visit count. Without --unlabeled, shows
        labeled places. With --unlabeled, shows places that don't
        yet have a user label — useful for finding places worth
        naming.

    show ID
        Show full detail for one place.

    label ID NAME
        Set (or update) the user label for the place with the given
        Google place_id.

    unlabel ID
        Clear the user label for a place.

    search QUERY
        Substring-search labels (uses the trgm index).

The data layer lives in `places` (populated by refresh_places() at
end of each ingest run). user_label is preserved across ingests.
"""
from __future__ import annotations

import os
import sys

import psycopg
import typer
from rich.console import Console
from rich.table import Table


DEFAULT_DB_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://locuser:locpass@localhost:5432/location_history",
)
if DEFAULT_DB_URL.startswith("postgresql+psycopg://"):
    DEFAULT_DB_URL = "postgresql://" + DEFAULT_DB_URL[len("postgresql+psycopg://"):]

app = typer.Typer(add_completion=False, help=__doc__)
console = Console()


def _connect(db_url: str) -> psycopg.Connection:
    return psycopg.connect(db_url, autocommit=False)


def _human_seconds(s: int | None) -> str:
    if s is None or s <= 0:
        return "—"
    h, rem = divmod(int(s), 3600)
    m = rem // 60
    if h >= 24:
        d, hh = divmod(h, 24)
        return f"{d}d {hh}h"
    if h > 0:
        return f"{h}h {m}m"
    return f"{m}m"


def _format_label(label: str | None) -> str:
    return label if label else "[dim](unlabeled)[/]"


# ----------------------------- list -----------------------------


@app.command("list")
def list_cmd(
    unlabeled: bool = typer.Option(False, "--unlabeled",
        help="Show only places without a user_label."),
    labeled: bool = typer.Option(False, "--labeled",
        help="Show only places WITH a user_label."),
    limit: int = typer.Option(30, "--limit", "-n",
        help="Max rows to show."),
    db_url: str = typer.Option(DEFAULT_DB_URL, "--db-url", envvar="DATABASE_URL"),
):
    """Show top places by visit count."""
    where = ""
    if unlabeled and labeled:
        console.print("[red]--unlabeled and --labeled are mutually exclusive[/]")
        raise typer.Exit(2)
    if unlabeled:
        where = "WHERE user_label IS NULL"
    elif labeled:
        where = "WHERE user_label IS NOT NULL"

    conn = _connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(f"""
                SELECT id, user_label, visit_count, total_seconds,
                       first_seen::date, last_seen::date,
                       ST_X(centroid::geometry), ST_Y(centroid::geometry)
                FROM places
                {where}
                ORDER BY visit_count DESC
                LIMIT %s
            """, (limit,))
            rows = cur.fetchall()
    finally:
        conn.close()

    if not rows:
        console.print("[yellow]No matching places.[/]")
        return

    title = "Places — "
    if unlabeled:
        title += f"unlabeled (top {limit} by visit count)"
    elif labeled:
        title += f"labeled (top {limit} by visit count)"
    else:
        title += f"top {limit} by visit count"

    table = Table(title=title, show_header=True, header_style="bold")
    table.add_column("place_id", overflow="ellipsis", max_width=32)
    table.add_column("label")
    table.add_column("visits", justify="right")
    table.add_column("total time", justify="right")
    table.add_column("first → last")
    table.add_column("lat,lng")
    for pid, label, n, secs, fs, ls, lng, lat in rows:
        latlng = (
            f"{lat:.4f},{lng:.4f}" if (lat is not None and lng is not None) else "—"
        )
        spanned = f"{fs} → {ls}" if fs and ls else "—"
        table.add_row(pid, _format_label(label), str(n), _human_seconds(secs),
                      spanned, latlng)
    console.print(table)


# ----------------------------- show -----------------------------


@app.command("show")
def show_cmd(
    place_id: str = typer.Argument(..., help="The Google place_id."),
    db_url: str = typer.Option(DEFAULT_DB_URL, "--db-url", envvar="DATABASE_URL"),
):
    """Show full detail for one place."""
    conn = _connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, user_label, visit_count, total_seconds,
                       first_seen, last_seen,
                       ST_X(centroid::geometry), ST_Y(centroid::geometry),
                       updated_at
                FROM places WHERE id = %s
            """, (place_id,))
            row = cur.fetchone()
            if row is None:
                console.print(f"[red]place_id not found: {place_id}[/]")
                raise typer.Exit(1)
            (pid, label, n, secs, fs, ls, lng, lat, updated) = row

            # Recent visits
            cur.execute("""
                SELECT start_ts, end_ts, activity_confidence
                FROM segments
                WHERE place_id = %s AND segment_type = 'visit'
                ORDER BY start_ts DESC LIMIT 10
            """, (place_id,))
            visits = cur.fetchall()

            # Memberships in trips
            cur.execute("""
                SELECT m.id, m.title, m.start_ts::date, m.end_ts::date
                FROM timeline_memory_places mp
                JOIN timeline_memories m ON m.id = mp.memory_id
                WHERE mp.place_id = %s
                ORDER BY m.start_ts DESC
                LIMIT 10
            """, (place_id,))
            trips = cur.fetchall()
    finally:
        conn.close()

    console.rule(f"[bold]{pid}[/]")
    console.print(f"label:        [bold]{_format_label(label)}[/]")
    console.print(f"visits:       {n:,}")
    console.print(f"total time:   {_human_seconds(secs)}")
    console.print(f"first seen:   {fs}")
    console.print(f"last seen:    {ls}")
    if lat is not None and lng is not None:
        console.print(f"centroid:     {lat:.6f}, {lng:.6f}")
    console.print(f"updated:      [dim]{updated}[/]")

    if visits:
        console.print()
        t = Table(title="Recent visits", show_header=True, header_style="bold")
        t.add_column("start"); t.add_column("end"); t.add_column("conf", justify="right")
        for s, e, c in visits:
            t.add_row(str(s), str(e), f"{c:.2f}" if c is not None else "—")
        console.print(t)
    if trips:
        console.print()
        t = Table(title="Trips through this place", show_header=True, header_style="bold")
        t.add_column("trip"); t.add_column("title"); t.add_column("dates")
        for tid, title, ts, te in trips:
            t.add_row(str(tid), title or "[dim](untitled)[/]", f"{ts} → {te}")
        console.print(t)


# ----------------------------- label -----------------------------


@app.command("label")
def label_cmd(
    place_id: str = typer.Argument(..., help="The Google place_id."),
    name: str = typer.Argument(..., help="Your label for this place."),
    db_url: str = typer.Option(DEFAULT_DB_URL, "--db-url", envvar="DATABASE_URL"),
):
    """Set (or update) the user label for a place."""
    if len(name) > 200:
        console.print("[red]Name too long (max 200 chars).[/]")
        raise typer.Exit(2)
    conn = _connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE places SET user_label = %s, updated_at = now()
                   WHERE id = %s
                   RETURNING user_label""",
                (name, place_id),
            )
            row = cur.fetchone()
            if row is None:
                console.print(f"[red]place_id not found: {place_id}[/]")
                console.print(
                    "[dim]Hint: run 'list --unlabeled' to find places worth labeling.[/]"
                )
                raise typer.Exit(1)
            conn.commit()
            console.print(f"[green]Labeled[/] {place_id} → [bold]{name}[/]")
    finally:
        conn.close()


# ----------------------------- unlabel -----------------------------


@app.command("unlabel")
def unlabel_cmd(
    place_id: str = typer.Argument(...),
    db_url: str = typer.Option(DEFAULT_DB_URL, "--db-url", envvar="DATABASE_URL"),
):
    """Clear the user label for a place (sets it to NULL)."""
    conn = _connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE places SET user_label = NULL, updated_at = now()
                   WHERE id = %s
                   RETURNING id""",
                (place_id,),
            )
            row = cur.fetchone()
            if row is None:
                console.print(f"[red]place_id not found: {place_id}[/]")
                raise typer.Exit(1)
            conn.commit()
            console.print(f"[green]Cleared label for[/] {place_id}")
    finally:
        conn.close()


# ----------------------------- search -----------------------------


@app.command("search")
def search_cmd(
    query: str = typer.Argument(..., help="Substring to search labels for."),
    limit: int = typer.Option(30, "--limit", "-n"),
    db_url: str = typer.Option(DEFAULT_DB_URL, "--db-url", envvar="DATABASE_URL"),
):
    """Substring-search labels (uses the trigram index)."""
    conn = _connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, user_label, visit_count, total_seconds,
                       last_seen::date
                FROM places
                WHERE user_label IS NOT NULL AND user_label ILIKE %s
                ORDER BY visit_count DESC
                LIMIT %s
            """, (f"%{query}%", limit))
            rows = cur.fetchall()
    finally:
        conn.close()
    if not rows:
        console.print(f"[yellow]No labels match '{query}'.[/]")
        return
    table = Table(title=f"Labels matching '{query}'", show_header=True, header_style="bold")
    table.add_column("place_id", overflow="ellipsis", max_width=32)
    table.add_column("label")
    table.add_column("visits", justify="right")
    table.add_column("total", justify="right")
    table.add_column("last seen")
    for pid, label, n, secs, ls in rows:
        table.add_row(pid, label, str(n), _human_seconds(secs), str(ls) if ls else "—")
    console.print(table)


if __name__ == "__main__":
    app()
