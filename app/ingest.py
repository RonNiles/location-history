"""
Ingest a Google Maps Timeline export (the on-device JSON format,
post-2024) into Postgres+PostGIS.

Usage:
    python -m app.ingest /path/to/Timeline.json
    python -m app.ingest /path/to/Timeline.json --dry-run
    python -m app.ingest /path/to/Timeline.json --probe   # inspect structure only

Notes
-----
The new on-device export does NOT have a single canonical schema in
public docs. The two top-level arrays we care about are:

    rawSignals[]        -- dense GPS-ish points
    semanticSegments[]  -- visit/activity spans

Field names within these have shifted across export versions. This
importer is defensive: it walks each record looking for the first
shape that matches, and dumps the entire raw record as JSONB so we
can re-derive fields later without re-parsing the export.

We use `ijson` to stream the file so we never hold the full JSON in
memory, and `psycopg`'s COPY support for bulk inserts (much faster
than row-by-row INSERTs).
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterator, Optional

import ijson
import psycopg
import typer
from dateutil import parser as dtparser
from psycopg.types.json import Jsonb
from rich.console import Console
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TextColumn,
    TimeElapsedColumn,
)


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

DEFAULT_DB_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://locuser:locpass@localhost:5432/location_history",
)
# Strip the SQLAlchemy driver prefix if present — psycopg wants a
# plain libpq URL.
if DEFAULT_DB_URL.startswith("postgresql+psycopg://"):
    DEFAULT_DB_URL = "postgresql://" + DEFAULT_DB_URL[len("postgresql+psycopg://"):]

# Round coords to 6 decimal places (~11cm) for dedup hashing.
# Two points that round to the same lat/lng at the same timestamp
# are treated as the same observation.
DEDUP_COORD_DECIMALS = 6

# COPY batch size — larger is faster but uses more RAM. 50k rows of
# location data is roughly 5-10MB of text.
BATCH_SIZE = 50_000


app = typer.Typer(add_completion=False)
console = Console()


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def parse_ts(s: Any) -> Optional[datetime]:
    """Parse a timestamp from any reasonable string form, return UTC."""
    if not s:
        return None
    if isinstance(s, datetime):
        return s.astimezone(timezone.utc)
    try:
        dt = dtparser.isoparse(str(s))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def as_float(x: Any) -> Optional[float]:
    """Coerce ijson Decimals (and strings, ints) to plain float. None on failure."""
    if x is None:
        return None
    if isinstance(x, bool):  # bool is a subclass of int — guard explicitly
        return None
    if isinstance(x, (int, float)):
        return float(x)
    if isinstance(x, Decimal):
        return float(x)
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def to_native(obj: Any) -> Any:
    """
    Recursively convert ijson's Decimal numbers to floats. Required
    because psycopg's Jsonb adapter emits Decimal as strings (per the
    JSON spec — JSON has no Decimal type), but downstream JS / GeoJSON
    consumers expect numbers. Doing this once on the raw blob keeps
    everything else simple.
    """
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, dict):
        return {k: to_native(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [to_native(v) for v in obj]
    return obj


def parse_geo_string(s: Any) -> Optional[tuple[float, float]]:
    """
    Google's exports often store coordinates as 'geo:LAT,LNG' or
    'LAT°, LNG°' or as a {latitudeE7, longitudeE7} dict. Try to
    coax any of these into (lat, lng).
    """
    if s is None:
        return None
    if isinstance(s, dict):
        # Newer format: {"latLng": "37.123,-122.456"} or
        # {"latitudeE7": 371230000, "longitudeE7": -1224560000} or
        # {"latitude": 37.123, "longitude": -122.456}
        if "latLng" in s:
            return parse_geo_string(s["latLng"])
        if "LatLng" in s:
            return parse_geo_string(s["LatLng"])
        if "latitudeE7" in s and "longitudeE7" in s:
            lat = as_float(s["latitudeE7"])
            lng = as_float(s["longitudeE7"])
            if lat is None or lng is None:
                return None
            return (lat / 1e7, lng / 1e7)
        if "latitude" in s and "longitude" in s:
            lat = as_float(s["latitude"])
            lng = as_float(s["longitude"])
            if lat is None or lng is None:
                return None
            return (lat, lng)
        return None
    if isinstance(s, str):
        # Strip optional 'geo:' prefix and degree signs, normalize whitespace.
        cleaned = s.strip().removeprefix("geo:").replace("°", "")
        parts = cleaned.split(",")
        if len(parts) != 2:
            return None
        lat = as_float(parts[0].strip())
        lng = as_float(parts[1].strip())
        if lat is None or lng is None:
            return None
        return (lat, lng)
    return None


def dedup_key(*parts: Any) -> bytes:
    """Stable hash for (timestamp, coords, ...) used as a unique key."""
    h = hashlib.sha256()
    for p in parts:
        h.update(repr(p).encode("utf-8"))
        h.update(b"\x1f")
    return h.digest()


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# --------------------------------------------------------------------------
# Record extraction
# --------------------------------------------------------------------------


@dataclass
class RawSignalRow:
    ts: datetime
    lat: float
    lng: float
    accuracy_m: Optional[float]
    altitude_m: Optional[float]
    speed_mps: Optional[float]
    source: Optional[str]
    raw: dict
    dedup_key: bytes


@dataclass
class ActivityRecordRow:
    ts: datetime
    top_type: Optional[str]
    top_confidence: Optional[float]
    probables: list[dict]  # [{"type": "STILL", "confidence": 1.0}, ...]
    raw: dict
    dedup_key: bytes


@dataclass
class SegmentRow:
    segment_type: str  # 'visit' | 'activity'
    start_ts: datetime
    end_ts: datetime
    center_lat: Optional[float] = None
    center_lng: Optional[float] = None
    path_points: list[tuple[float, float]] = field(default_factory=list)
    activity_type: Optional[str] = None
    activity_confidence: Optional[float] = None
    distance_m: Optional[float] = None
    place_id: Optional[str] = None
    raw: dict = field(default_factory=dict)
    dedup_key: bytes = b""


# Dispatch result for raw_signals[] records — tells the importer
# which counter to bump and which writer to call (if any).
@dataclass
class Dispatch:
    kind: str  # 'position' | 'activity' | 'wifi' | 'unknown'
    position: Optional[RawSignalRow] = None
    activity: Optional[ActivityRecordRow] = None
    unknown: Optional["UnknownRow"] = None


def classify_raw_signal(record: dict) -> Dispatch:
    """
    A rawSignals[] entry is typically one of three kinds, distinguished
    by which top-level key is present:
      * position       -> a GPS/WiFi-derived location fix
      * activityRecord -> sensor inference of motion type, no location
      * wifiScan       -> raw nearby APs, no usable location

    Anything else is 'unknown' and gets captured in `unknown_records`
    so we can investigate and add a handler later, rather than silently
    dropping data. This insurance has paid for itself before.
    """
    if "position" in record or "rawSignal" in record:
        rs = extract_position(record)
        if rs:
            return Dispatch(kind="position", position=rs)
        # Malformed position — capture as unknown.
        return Dispatch(
            kind="unknown",
            unknown=UnknownRow(
                source_array="rawSignals",
                shape_hint=_shape_hint(record),
                raw=to_native(record),
                dedup_key=dedup_key("unknown_raw_position", _shape_hint(record), repr(record)[:200]),
            ),
        )
    if "activityRecord" in record:
        ar = extract_activity_record(record)
        if ar:
            return Dispatch(kind="activity", activity=ar)
        return Dispatch(
            kind="unknown",
            unknown=UnknownRow(
                source_array="rawSignals",
                shape_hint=_shape_hint(record),
                raw=to_native(record),
                dedup_key=dedup_key("unknown_raw_activity", _shape_hint(record), repr(record)[:200]),
            ),
        )
    if "wifiScan" in record:
        return Dispatch(kind="wifi")
    return Dispatch(
        kind="unknown",
        unknown=UnknownRow(
            source_array="rawSignals",
            shape_hint=_shape_hint(record),
            raw=to_native(record),
            dedup_key=dedup_key("unknown_raw", _shape_hint(record), repr(record)[:200]),
        ),
    )


def extract_position(record: dict) -> Optional[RawSignalRow]:
    """
    Pull a RawSignalRow out of one rawSignals[] entry that carries
    a position. Returns None if the position is malformed.
    """
    pos = (
        record.get("position")
        or record.get("rawSignal", {}).get("position")
    )
    if not isinstance(pos, dict):
        return None

    coords = parse_geo_string(pos)
    if coords is None:
        return None
    lat, lng = coords
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None

    ts = (
        parse_ts(pos.get("timestamp"))
        or parse_ts(record.get("timestamp"))
        or parse_ts(pos.get("time"))
        or parse_ts(record.get("time"))
    )
    if ts is None:
        return None

    source = pos.get("source") or record.get("source")
    raw_native = to_native(record)

    def _first_present(*keys: str) -> Any:
        """Return first key whose value is not None (allows 0/0.0).
        `or`-chains don't work here because Decimal('0.0') is falsy."""
        for k in keys:
            v = pos.get(k)
            if v is not None:
                return v
        return None

    return RawSignalRow(
        ts=ts,
        lat=round(lat, 7),
        lng=round(lng, 7),
        accuracy_m=as_float(_first_present("accuracyMeters", "accuracy")),
        altitude_m=as_float(_first_present("altitudeMeters", "altitude")),
        speed_mps=as_float(_first_present("speedMetersPerSecond", "speed")),
        source=str(source) if source else None,
        raw=raw_native,
        dedup_key=dedup_key(
            ts.isoformat(),
            round(lat, DEDUP_COORD_DECIMALS),
            round(lng, DEDUP_COORD_DECIMALS),
        ),
    )


def extract_activity_record(record: dict) -> Optional[ActivityRecordRow]:
    """
    Pull an ActivityRecordRow from a rawSignals[] entry shaped like:
        {"activityRecord": {
            "probableActivities": [{"type": "STILL", "confidence": 1.0}, ...],
            "timestamp": "2025-01-04T10:03:55.000-08:00"
        }}
    """
    ar = record.get("activityRecord")
    if not isinstance(ar, dict):
        return None
    ts = parse_ts(ar.get("timestamp") or record.get("timestamp"))
    if ts is None:
        return None

    probables_raw = ar.get("probableActivities") or []
    if not isinstance(probables_raw, list):
        probables_raw = []
    probables: list[dict] = []
    for p in probables_raw:
        if not isinstance(p, dict):
            continue
        probables.append({
            "type": p.get("type"),
            "confidence": as_float(p.get("confidence")),
        })

    # The "top" probable is whichever has highest confidence.
    top_type: Optional[str] = None
    top_conf: Optional[float] = None
    for p in probables:
        c = p.get("confidence")
        if c is None:
            continue
        if top_conf is None or c > top_conf:
            top_conf = c
            top_type = p.get("type")

    return ActivityRecordRow(
        ts=ts,
        top_type=top_type,
        top_confidence=top_conf,
        probables=probables,
        raw=to_native(record),
        dedup_key=dedup_key("activity_record", ts.isoformat(), top_type or ""),
    )


@dataclass
class TimelineMemoryRow:
    start_ts: datetime
    end_ts: datetime
    title: Optional[str]
    kind: Optional[str]
    place_ids: list[str]   # ordered, may contain duplicates
    raw: dict
    dedup_key: bytes


@dataclass
class UnknownRow:
    """A record we couldn't classify. We store the whole thing for
    later forensics. `shape_hint` is a comma-joined list of the
    record's top-level keys, useful for grouping in queries like:
        SELECT shape_hint, count(*) FROM unknown_records GROUP BY 1;
    """
    source_array: str  # 'rawSignals' | 'semanticSegments' | 'other'
    shape_hint: Optional[str]
    raw: dict
    dedup_key: bytes


# Result of classifying a semanticSegments[] entry. Mirrors the
# Dispatch type used for rawSignals[].
@dataclass
class SegmentDispatch:
    kind: str  # 'segment' | 'memory' | 'unknown'
    segment: Optional["SegmentRow"] = None
    memory: Optional[TimelineMemoryRow] = None
    unknown: Optional[UnknownRow] = None


def _shape_hint(record: dict) -> str:
    """Best-effort fingerprint of a record's structure: comma-joined
    sorted top-level keys, capped at 200 chars."""
    if not isinstance(record, dict):
        return type(record).__name__
    keys = sorted(record.keys())
    s = ",".join(keys)
    return s[:200]


def extract_timeline_memory(record: dict) -> Optional[TimelineMemoryRow]:
    """
    Pull a TimelineMemoryRow out of a semanticSegments[] entry that
    carries a `timelineMemory` field. The structure across export
    versions varies; we try several common shapes.

    Typical shape (Google docs + observed exports):
        {
          "startTime": "...", "endTime": "...",
          "timelineMemory": {
            "trip": {
              "destinations": [
                {"identifier": {"placeId": "ChIJ..."}},
                ...
              ]
            }
          }
        }

    Older / variant shapes may use 'placeIds' as a flat list, or
    'places' as the wrapper. We accept any of these.
    """
    tm = record.get("timelineMemory")
    if not isinstance(tm, dict):
        return None
    start_ts = parse_ts(record.get("startTime"))
    end_ts = parse_ts(record.get("endTime"))
    if start_ts is None or end_ts is None:
        return None

    # Walk the memory structure looking for placeId values. We keep
    # ordering as encountered, since it likely reflects trip order.
    # We deduplicate consecutive duplicates to avoid double-counting
    # when a record has both a direct `placeId` and a nested
    # `identifier.placeId` referring to the same place.
    place_ids: list[str] = []

    def collect_place_ids(obj: Any) -> None:
        if isinstance(obj, dict):
            # If this node has a placeId AND/OR identifier.placeId,
            # they're describing the same place — pick the first
            # available and skip recursion through identifier.
            pid = obj.get("placeId")
            if not isinstance(pid, str):
                ident = obj.get("identifier")
                if isinstance(ident, dict):
                    pid = ident.get("placeId")
            if isinstance(pid, str):
                place_ids.append(pid)
                # Recurse into other keys but skip identifier (already consumed).
                for k, v in obj.items():
                    if k in ("placeId", "identifier"):
                        continue
                    collect_place_ids(v)
                return
            # No placeId at this node — recurse normally.
            for v in obj.values():
                collect_place_ids(v)
        elif isinstance(obj, list):
            for item in obj:
                collect_place_ids(item)

    collect_place_ids(tm)

    # Title: try a few common locations.
    title = None
    for path in (
        ("trip", "title"),
        ("title",),
        ("name",),
    ):
        cur: Any = tm
        for key in path:
            cur = cur.get(key) if isinstance(cur, dict) else None
            if cur is None:
                break
        if isinstance(cur, str) and cur:
            title = cur
            break

    # Kind: 'trip' if there's a trip key, otherwise the first dict key.
    kind = None
    if isinstance(tm.get("trip"), dict):
        kind = "trip"
    else:
        # Try whatever the first wrapper is.
        for k in tm.keys():
            if isinstance(tm[k], dict):
                kind = k
                break

    return TimelineMemoryRow(
        start_ts=start_ts,
        end_ts=end_ts,
        title=title,
        kind=kind,
        place_ids=place_ids,
        raw=to_native(record),
        dedup_key=dedup_key(
            "memory",
            start_ts.isoformat(),
            end_ts.isoformat(),
            ",".join(place_ids[:10]),  # first 10 places enough to disambiguate
        ),
    )


def classify_segment(record: dict) -> SegmentDispatch:
    """
    Classify a semanticSegments[] entry into one of:
      * 'segment' — visit / activity / bare timelinePath (the original cases)
      * 'memory'  — timelineMemory record
      * 'unknown' — anything else, captured in unknown_records

    A record with both timelineMemory AND visit/activity is rare but
    possible; we treat the timelineMemory as authoritative since it's
    a higher-level abstraction.
    """
    if "timelineMemory" in record:
        m = extract_timeline_memory(record)
        if m is not None:
            return SegmentDispatch(kind="memory", memory=m)
        # Fall through: malformed memory, capture as unknown.
        return SegmentDispatch(
            kind="unknown",
            unknown=UnknownRow(
                source_array="semanticSegments",
                shape_hint=_shape_hint(record),
                raw=to_native(record),
                dedup_key=dedup_key(
                    "unknown_segment",
                    record.get("startTime") or "",
                    record.get("endTime") or "",
                    _shape_hint(record),
                ),
            ),
        )
    s = extract_segment(record)
    if s is not None:
        return SegmentDispatch(kind="segment", segment=s)
    return SegmentDispatch(
        kind="unknown",
        unknown=UnknownRow(
            source_array="semanticSegments",
            shape_hint=_shape_hint(record),
            raw=to_native(record),
            dedup_key=dedup_key(
                "unknown_segment",
                record.get("startTime") or "",
                record.get("endTime") or "",
                _shape_hint(record),
            ),
        ),
    )


def extract_segment(record: dict) -> Optional[SegmentRow]:
    """Pull a SegmentRow from one semanticSegments[] entry."""
    start_ts = parse_ts(record.get("startTime"))
    end_ts = parse_ts(record.get("endTime"))
    if start_ts is None or end_ts is None:
        return None

    visit = record.get("visit")
    activity = record.get("activity")
    timeline_path = record.get("timelinePath")  # list of {point, durationMinutesOffsetFromStartTime}
    raw_native = to_native(record)

    if visit:
        # A visit: stay at one place
        top = visit.get("topCandidate") or {}
        center = parse_geo_string(top.get("placeLocation") or visit.get("placeLocation"))
        place_id = top.get("placeId") or visit.get("placeId")
        return SegmentRow(
            segment_type="visit",
            start_ts=start_ts,
            end_ts=end_ts,
            center_lat=center[0] if center else None,
            center_lng=center[1] if center else None,
            place_id=place_id,
            activity_confidence=as_float(visit.get("probability") or top.get("probability")),
            raw=raw_native,
            dedup_key=dedup_key("visit", start_ts.isoformat(), end_ts.isoformat(), place_id or ""),
        )

    if activity:
        top = activity.get("topCandidate") or {}
        start_pt = parse_geo_string(activity.get("start"))
        end_pt = parse_geo_string(activity.get("end"))
        path: list[tuple[float, float]] = []
        if start_pt:
            path.append(start_pt)
        # If the segment carries a timelinePath, prefer that for the linestring.
        if isinstance(timeline_path, list):
            for tp in timeline_path:
                pt = parse_geo_string(tp.get("point") if isinstance(tp, dict) else None)
                if pt:
                    path.append(pt)
        if end_pt:
            path.append(end_pt)

        return SegmentRow(
            segment_type="activity",
            start_ts=start_ts,
            end_ts=end_ts,
            path_points=path,
            activity_type=top.get("type") or activity.get("type"),
            activity_confidence=as_float(top.get("probability") or activity.get("probability")),
            distance_m=as_float(activity.get("distanceMeters")),
            raw=raw_native,
            dedup_key=dedup_key(
                "activity",
                start_ts.isoformat(),
                end_ts.isoformat(),
                top.get("type") or "",
            ),
        )

    # Some exports put a bare timelinePath at the top level — treat
    # as an activity with unknown type.
    if isinstance(timeline_path, list) and timeline_path:
        path = []
        for tp in timeline_path:
            pt = parse_geo_string(tp.get("point") if isinstance(tp, dict) else None)
            if pt:
                path.append(pt)
        if path:
            return SegmentRow(
                segment_type="activity",
                start_ts=start_ts,
                end_ts=end_ts,
                path_points=path,
                activity_type="unknown",
                raw=raw_native,
                dedup_key=dedup_key("path", start_ts.isoformat(), end_ts.isoformat()),
            )

    return None


# --------------------------------------------------------------------------
# Streaming readers
# --------------------------------------------------------------------------


def iter_array_items(path: Path, prefix: str) -> Iterator[dict]:
    """
    Yield items from a top-level JSON array using ijson. We try a
    couple of common ijson backends; the C backend (yajl2_c) is
    much faster but optional.
    """
    # Prefer the fastest available backend. ijson selects automatically
    # if you import from `ijson` directly.
    with path.open("rb") as f:
        for item in ijson.items(f, f"{prefix}.item"):
            if isinstance(item, dict):
                yield item


def probe(path: Path) -> dict[str, int]:
    """
    Walk the file once with a tiny streaming parser to discover top-level
    keys and array sizes. Useful when the export's exact shape is unknown.
    """
    counts: dict[str, int] = {}
    current_key: Optional[str] = None
    depth = 0
    with path.open("rb") as f:
        parser = ijson.parse(f)
        for prefix, event, value in parser:
            # Top-level object keys appear at depth 1 with event 'map_key'
            if prefix == "" and event == "map_key":
                current_key = value
                counts.setdefault(current_key, 0)
            # Direct items under a top-level array
            if current_key and prefix == f"{current_key}.item" and event in ("start_map", "start_array"):
                # Only count once per item (start_map for object items)
                if event == "start_map":
                    counts[current_key] += 1
            # Top-level type (array vs object) — handled below
            if prefix == "" and event == "start_array":
                # The whole document is an array, not an object.
                counts["__root_array__"] = 1
                break
    return counts


# --------------------------------------------------------------------------
# DB writer
# --------------------------------------------------------------------------


class Writer:
    """
    Writes batches of rows to Postgres. Uses a staging table + INSERT ...
    ON CONFLICT to make the import idempotent without paying the cost
    of per-row upserts.

    The flow per batch:
      1. COPY rows into a TEMP staging table (very fast).
      2. INSERT INTO target SELECT FROM staging ON CONFLICT (dedup_key) DO NOTHING.
      3. TRUNCATE staging.

    This handles re-runs cleanly: if the same export is imported twice,
    no duplicates are created.
    """

    def __init__(self, conn: psycopg.Connection, dry_run: bool = False,
                 run_id: Optional[int] = None):
        self.conn = conn
        self.dry_run = dry_run
        # `run_id` is the id of the audit row in `import_runs` for the
        # current run. Stamped onto every inserted row (created_import_run,
        # last_seen_import_run) and refreshed on every matching upsert
        # (last_seen_import_run only). May be None in some callers — when
        # so, the tracking columns are left NULL, which is the same shape
        # as rows that predate the 0006 migration.
        self.run_id = run_id

    def setup_staging(self) -> None:
        if self.dry_run:
            return
        with self.conn.cursor() as cur:
            cur.execute("""
                CREATE TEMP TABLE stage_raw_signals (
                    ts TIMESTAMPTZ NOT NULL,
                    lat DOUBLE PRECISION NOT NULL,
                    lng DOUBLE PRECISION NOT NULL,
                    accuracy_m DOUBLE PRECISION,
                    altitude_m DOUBLE PRECISION,
                    speed_mps DOUBLE PRECISION,
                    source TEXT,
                    raw JSONB NOT NULL,
                    dedup_key BYTEA NOT NULL
                ) ON COMMIT PRESERVE ROWS;
            """)
            cur.execute("""
                CREATE TEMP TABLE stage_segments (
                    segment_type TEXT NOT NULL,
                    start_ts TIMESTAMPTZ NOT NULL,
                    end_ts TIMESTAMPTZ NOT NULL,
                    center_lat DOUBLE PRECISION,
                    center_lng DOUBLE PRECISION,
                    path_wkt TEXT,
                    activity_type TEXT,
                    activity_confidence DOUBLE PRECISION,
                    distance_m DOUBLE PRECISION,
                    place_id TEXT,
                    raw JSONB NOT NULL,
                    dedup_key BYTEA NOT NULL
                ) ON COMMIT PRESERVE ROWS;
            """)
            cur.execute("""
                CREATE TEMP TABLE stage_activity_records (
                    ts TIMESTAMPTZ NOT NULL,
                    top_type TEXT,
                    top_confidence DOUBLE PRECISION,
                    probables JSONB NOT NULL,
                    raw JSONB NOT NULL,
                    dedup_key BYTEA NOT NULL
                ) ON COMMIT PRESERVE ROWS;
            """)
            cur.execute("""
                CREATE TEMP TABLE stage_timeline_memories (
                    start_ts TIMESTAMPTZ NOT NULL,
                    end_ts TIMESTAMPTZ NOT NULL,
                    title TEXT,
                    kind TEXT,
                    raw JSONB NOT NULL,
                    dedup_key BYTEA NOT NULL,
                    place_ids TEXT[] NOT NULL
                ) ON COMMIT PRESERVE ROWS;
            """)
            cur.execute("""
                CREATE TEMP TABLE stage_unknown_records (
                    source_array TEXT NOT NULL,
                    shape_hint TEXT,
                    raw JSONB NOT NULL,
                    dedup_key BYTEA NOT NULL
                ) ON COMMIT PRESERVE ROWS;
            """)

    def write_raw_signals(self, batch: list[RawSignalRow]) -> tuple[int, int]:
        """Returns (inserted, skipped_duplicates)."""
        if not batch:
            return (0, 0)
        if self.dry_run:
            return (len(batch), 0)

        with self.conn.cursor() as cur:
            with cur.copy(
                "COPY stage_raw_signals "
                "(ts, lat, lng, accuracy_m, altitude_m, speed_mps, source, raw, dedup_key) "
                "FROM STDIN"
            ) as cp:
                for r in batch:
                    cp.write_row((
                        r.ts,
                        r.lat,
                        r.lng,
                        r.accuracy_m,
                        r.altitude_m,
                        r.speed_mps,
                        r.source,
                        Jsonb(r.raw),
                        r.dedup_key,
                    ))
            # Insert via the staging table, stamping run-tracking
            # columns on every row. ON CONFLICT DO UPDATE updates
            # ONLY the last-seen columns — actual data is never
            # mutated, preserving idempotency for the user's data.
            #
            # We use RETURNING (xmax = 0) AS inserted to distinguish
            # fresh inserts from updates of existing rows:
            #   xmax = 0  → this statement inserted the row (new)
            #   xmax != 0 → this statement updated an existing row
            # That gives us a clean inserted/touched split without
            # a second query.
            cur.execute("""
                INSERT INTO raw_signals
                    (ts, location, accuracy_m, altitude_m, speed_mps, source, raw, dedup_key,
                     created_import_run, last_seen_import_run, last_seen_at)
                SELECT
                    ts,
                    ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
                    accuracy_m, altitude_m, speed_mps, source, raw, dedup_key,
                    %(run_id)s, %(run_id)s, now()
                FROM stage_raw_signals
                ON CONFLICT (dedup_key) DO UPDATE SET
                    last_seen_import_run = EXCLUDED.last_seen_import_run,
                    last_seen_at = EXCLUDED.last_seen_at
                RETURNING (xmax = 0) AS inserted
            """, {"run_id": self.run_id})
            results = cur.fetchall()
            inserted = sum(1 for (is_new,) in results if is_new)
            cur.execute("TRUNCATE stage_raw_signals")
        return (inserted, len(batch) - inserted)

    def write_segments(self, batch: list[SegmentRow]) -> tuple[int, int]:
        if not batch:
            return (0, 0)
        if self.dry_run:
            return (len(batch), 0)

        with self.conn.cursor() as cur:
            with cur.copy(
                "COPY stage_segments "
                "(segment_type, start_ts, end_ts, center_lat, center_lng, path_wkt, "
                "activity_type, activity_confidence, distance_m, place_id, raw, dedup_key) "
                "FROM STDIN"
            ) as cp:
                for s in batch:
                    if len(s.path_points) >= 2:
                        # WKT LINESTRING is "LINESTRING(lng1 lat1, lng2 lat2, ...)"
                        wkt = "LINESTRING(" + ",".join(
                            f"{lng} {lat}" for (lat, lng) in s.path_points
                        ) + ")"
                    else:
                        wkt = None
                    cp.write_row((
                        s.segment_type,
                        s.start_ts,
                        s.end_ts,
                        s.center_lat,
                        s.center_lng,
                        wkt,
                        s.activity_type,
                        s.activity_confidence,
                        s.distance_m,
                        s.place_id,
                        Jsonb(s.raw),
                        s.dedup_key,
                    ))
            cur.execute("""
                INSERT INTO segments
                    (segment_type, start_ts, end_ts, center, path,
                     activity_type, activity_confidence, distance_m,
                     place_id, raw, dedup_key,
                     created_import_run, last_seen_import_run, last_seen_at)
                SELECT
                    segment_type, start_ts, end_ts,
                    CASE WHEN center_lat IS NOT NULL AND center_lng IS NOT NULL
                         THEN ST_SetSRID(ST_MakePoint(center_lng, center_lat), 4326)::geography
                         ELSE NULL END,
                    CASE WHEN path_wkt IS NOT NULL
                         THEN ST_SetSRID(ST_GeomFromText(path_wkt), 4326)::geography
                         ELSE NULL END,
                    activity_type, activity_confidence, distance_m,
                    place_id, raw, dedup_key,
                    %(run_id)s, %(run_id)s, now()
                FROM stage_segments
                ON CONFLICT (dedup_key) DO UPDATE SET
                    last_seen_import_run = EXCLUDED.last_seen_import_run,
                    last_seen_at = EXCLUDED.last_seen_at
                RETURNING (xmax = 0) AS inserted
            """, {"run_id": self.run_id})
            results = cur.fetchall()
            inserted = sum(1 for (is_new,) in results if is_new)
            cur.execute("TRUNCATE stage_segments")
        return (inserted, len(batch) - inserted)

    def write_activity_records(self, batch: list[ActivityRecordRow]) -> tuple[int, int]:
        if not batch:
            return (0, 0)
        if self.dry_run:
            return (len(batch), 0)

        with self.conn.cursor() as cur:
            with cur.copy(
                "COPY stage_activity_records "
                "(ts, top_type, top_confidence, probables, raw, dedup_key) "
                "FROM STDIN"
            ) as cp:
                for r in batch:
                    cp.write_row((
                        r.ts,
                        r.top_type,
                        r.top_confidence,
                        Jsonb(r.probables),
                        Jsonb(r.raw),
                        r.dedup_key,
                    ))
            cur.execute("""
                INSERT INTO activity_records
                    (ts, top_type, top_confidence, probables, raw, dedup_key,
                     created_import_run, last_seen_import_run, last_seen_at)
                SELECT
                    ts, top_type, top_confidence, probables, raw, dedup_key,
                    %(run_id)s, %(run_id)s, now()
                FROM stage_activity_records
                ON CONFLICT (dedup_key) DO UPDATE SET
                    last_seen_import_run = EXCLUDED.last_seen_import_run,
                    last_seen_at = EXCLUDED.last_seen_at
                RETURNING (xmax = 0) AS inserted
            """, {"run_id": self.run_id})
            results = cur.fetchall()
            inserted = sum(1 for (is_new,) in results if is_new)
            cur.execute("TRUNCATE stage_activity_records")
        return (inserted, len(batch) - inserted)

    def write_timeline_memories(self, batch: list[TimelineMemoryRow]) -> tuple[int, int]:
        """
        Inserts timeline_memories AND populates timeline_memory_places.

        We do this in two steps because the place-list is keyed on
        the new memory's id, which we only learn after the INSERT.
        Postgres' RETURNING with a CTE makes this a single round-trip.
        """
        if not batch:
            return (0, 0)
        if self.dry_run:
            return (len(batch), 0)

        with self.conn.cursor() as cur:
            with cur.copy(
                "COPY stage_timeline_memories "
                "(start_ts, end_ts, title, kind, raw, dedup_key, place_ids) "
                "FROM STDIN"
            ) as cp:
                for m in batch:
                    cp.write_row((
                        m.start_ts,
                        m.end_ts,
                        m.title,
                        m.kind,
                        Jsonb(m.raw),
                        m.dedup_key,
                        m.place_ids,  # psycopg adapts list -> ARRAY automatically
                    ))
            # Single CTE: insert memories returning their new ids,
            # then explode the place_ids of newly-inserted rows into
            # the join table. Importantly we only join with `inserted`
            # (rows that were actually NEW), so re-imports don't
            # duplicate join-table rows.
            cur.execute("""
                WITH inserted AS (
                    INSERT INTO timeline_memories
                        (start_ts, end_ts, title, kind, raw, dedup_key)
                    SELECT start_ts, end_ts, title, kind, raw, dedup_key
                    FROM stage_timeline_memories
                    ON CONFLICT (dedup_key) DO NOTHING
                    RETURNING id, dedup_key
                ),
                joined AS (
                    SELECT i.id AS memory_id, p.place_id, p.ord
                    FROM inserted i
                    JOIN stage_timeline_memories s USING (dedup_key)
                    CROSS JOIN LATERAL unnest(s.place_ids) WITH ORDINALITY
                        AS p(place_id, ord)
                ),
                place_inserts AS (
                    INSERT INTO timeline_memory_places (memory_id, place_id, ord)
                    SELECT memory_id, place_id, ord::int FROM joined
                    ON CONFLICT DO NOTHING
                    RETURNING memory_id
                )
                SELECT count(*) FROM inserted
            """)
            inserted = cur.fetchone()[0]
            cur.execute("TRUNCATE stage_timeline_memories")
        return (inserted, len(batch) - inserted)

    def write_unknown_records(self, batch: list[UnknownRow]) -> tuple[int, int]:
        if not batch:
            return (0, 0)
        if self.dry_run:
            return (len(batch), 0)

        with self.conn.cursor() as cur:
            with cur.copy(
                "COPY stage_unknown_records "
                "(source_array, shape_hint, raw, dedup_key) "
                "FROM STDIN"
            ) as cp:
                for u in batch:
                    cp.write_row((
                        u.source_array,
                        u.shape_hint,
                        Jsonb(u.raw),
                        u.dedup_key,
                    ))
            cur.execute("""
                INSERT INTO unknown_records
                    (source_array, shape_hint, raw, dedup_key)
                SELECT source_array, shape_hint, raw, dedup_key
                FROM stage_unknown_records
                ON CONFLICT (dedup_key) DO NOTHING
            """)
            inserted = cur.rowcount
            cur.execute("TRUNCATE stage_unknown_records")
        return (inserted, len(batch) - inserted)

    def refresh_places(self) -> int:
        """Recompute every place's centroid + visit_count + first/last_seen
        from current segments. Preserves user_label. Returns row count
        affected."""
        if self.dry_run:
            return 0
        with self.conn.cursor() as cur:
            cur.execute("SELECT refresh_places()")
            cur.execute("SELECT count(*) FROM places")
            return cur.fetchone()[0]


# --------------------------------------------------------------------------
# Top-level run
# --------------------------------------------------------------------------


@app.command()
def main(
    json_path: Path = typer.Argument(..., exists=True, readable=True, dir_okay=False),
    db_url: str = typer.Option(DEFAULT_DB_URL, "--db-url", envvar="DATABASE_URL"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Parse and validate without writing"),
    probe_only: bool = typer.Option(False, "--probe", help="Show top-level structure only"),
    raw_signals_key: str = typer.Option("rawSignals", help="Top-level array name for raw signals"),
    segments_key: str = typer.Option("semanticSegments", help="Top-level array name for segments"),
):
    """Ingest a Google Maps Timeline JSON export into Postgres+PostGIS."""
    json_path = json_path.resolve()
    size = json_path.stat().st_size
    console.rule(f"[bold]Ingesting {json_path.name}[/]  ({size/1e6:.1f} MB)")

    if probe_only:
        console.print("Probing top-level structure (this reads the whole file once)...")
        counts = probe(json_path)
        console.print(counts)
        raise typer.Exit(0)

    sha = file_sha256(json_path)
    console.print(f"sha256: [dim]{sha}[/]")

    if dry_run:
        console.print("[yellow]DRY RUN — no DB writes[/]")

    # Connection: autocommit off, we manage transactions per phase.
    conn = psycopg.connect(db_url, autocommit=False)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT PostGIS_Full_Version()")
            console.print(f"PostGIS: [dim]{cur.fetchone()[0][:80]}...[/]")

        # Audit row up front so we have an id even if we crash.
        run_id: Optional[int] = None
        if not dry_run:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO import_runs (source_path, source_sha256, source_bytes)
                       VALUES (%s, %s, %s) RETURNING id""",
                    (str(json_path), sha, size),
                )
                run_id = cur.fetchone()[0]
                conn.commit()

        writer = Writer(conn, dry_run=dry_run, run_id=run_id)
        writer.setup_staging()

        # ---- Phase A: rawSignals ----
        # Each entry is one of: position / activityRecord / wifiScan /
        # something we don't recognize. The first three go to their
        # respective tables; unknowns are captured in unknown_records
        # for later inspection rather than silently dropped.
        rs_inserted = rs_skipped = 0
        ar_inserted = ar_skipped = 0
        unk_raw_inserted = 0
        wifi_dropped = 0
        with Progress(
            SpinnerColumn(),
            TextColumn("[bold]rawSignals[/]"),
            BarColumn(),
            TextColumn("{task.completed:,} processed"),
            TimeElapsedColumn(),
            console=console,
        ) as progress:
            task = progress.add_task("rs", total=None)
            pos_batch: list[RawSignalRow] = []
            act_batch: list[ActivityRecordRow] = []
            unk_raw_batch: list[UnknownRow] = []

            def flush_pos():
                nonlocal rs_inserted, rs_skipped
                if pos_batch:
                    ins, skp = writer.write_raw_signals(pos_batch)
                    rs_inserted += ins
                    rs_skipped += skp
                    pos_batch.clear()

            def flush_act():
                nonlocal ar_inserted, ar_skipped
                if act_batch:
                    ins, skp = writer.write_activity_records(act_batch)
                    ar_inserted += ins
                    ar_skipped += skp
                    act_batch.clear()

            def flush_unk_raw():
                nonlocal unk_raw_inserted
                if unk_raw_batch:
                    ins, _ = writer.write_unknown_records(unk_raw_batch)
                    unk_raw_inserted += ins
                    unk_raw_batch.clear()

            for record in iter_array_items(json_path, raw_signals_key):
                d = classify_raw_signal(record)
                if d.kind == "position" and d.position is not None:
                    pos_batch.append(d.position)
                    if len(pos_batch) >= BATCH_SIZE:
                        flush_pos()
                elif d.kind == "activity" and d.activity is not None:
                    act_batch.append(d.activity)
                    if len(act_batch) >= BATCH_SIZE:
                        flush_act()
                elif d.kind == "wifi":
                    wifi_dropped += 1
                elif d.kind == "unknown" and d.unknown is not None:
                    unk_raw_batch.append(d.unknown)
                    if len(unk_raw_batch) >= 1000:
                        flush_unk_raw()
                progress.update(task, advance=1)

            flush_pos()
            flush_act()
            flush_unk_raw()

        if not dry_run:
            conn.commit()
        console.print(
            f"  positions:        inserted [green]{rs_inserted:,}[/]  "
            f"dup [yellow]{rs_skipped:,}[/]"
        )
        console.print(
            f"  activity_records: inserted [green]{ar_inserted:,}[/]  "
            f"dup [yellow]{ar_skipped:,}[/]"
        )
        console.print(
            f"  wifiScan dropped: [dim]{wifi_dropped:,}[/]   "
            f"unknown captured: [red]{unk_raw_inserted:,}[/]"
        )

        # ---- Phase B: semanticSegments ----
        # Each entry classifies as a segment (visit/activity), a
        # timeline_memory (trip), or unknown (captured for forensics).
        seg_inserted = seg_skipped = 0
        mem_inserted = mem_skipped = 0
        unk_seg_captured = 0
        with Progress(
            SpinnerColumn(),
            TextColumn("[bold]semanticSegments[/]"),
            BarColumn(),
            TextColumn("{task.completed:,} processed"),
            TimeElapsedColumn(),
            console=console,
        ) as progress:
            task = progress.add_task("sg", total=None)
            seg_batch: list[SegmentRow] = []
            mem_batch: list[TimelineMemoryRow] = []
            unk_batch: list[UnknownRow] = []

            def flush_seg():
                nonlocal seg_inserted, seg_skipped
                if seg_batch:
                    ins, skp = writer.write_segments(seg_batch)
                    seg_inserted += ins
                    seg_skipped += skp
                    seg_batch.clear()

            def flush_mem():
                nonlocal mem_inserted, mem_skipped
                if mem_batch:
                    ins, skp = writer.write_timeline_memories(mem_batch)
                    mem_inserted += ins
                    mem_skipped += skp
                    mem_batch.clear()

            def flush_unk():
                nonlocal unk_seg_captured
                if unk_batch:
                    ins, _ = writer.write_unknown_records(unk_batch)
                    unk_seg_captured += ins
                    unk_batch.clear()

            for record in iter_array_items(json_path, segments_key):
                d = classify_segment(record)
                if d.kind == "segment" and d.segment is not None:
                    seg_batch.append(d.segment)
                    if len(seg_batch) >= BATCH_SIZE:
                        flush_seg()
                elif d.kind == "memory" and d.memory is not None:
                    mem_batch.append(d.memory)
                    # Memories are far less numerous than segments;
                    # smaller batch is fine.
                    if len(mem_batch) >= 1000:
                        flush_mem()
                elif d.kind == "unknown" and d.unknown is not None:
                    unk_batch.append(d.unknown)
                    if len(unk_batch) >= 1000:
                        flush_unk()
                progress.update(task, advance=1)

            flush_seg()
            flush_mem()
            flush_unk()

        if not dry_run:
            conn.commit()
        console.print(
            f"  segments:           inserted [green]{seg_inserted:,}[/]  "
            f"dup [yellow]{seg_skipped:,}[/]"
        )
        console.print(
            f"  timeline_memories:  inserted [green]{mem_inserted:,}[/]  "
            f"dup [yellow]{mem_skipped:,}[/]"
        )
        console.print(
            f"  unknown captured:   [red]{unk_seg_captured:,}[/]  "
            f"(see unknown_records table)"
        )

        # ---- refresh_places ----
        # Now that all segments are loaded, recompute the places
        # aggregation. Cheap; one SQL function call.
        if not dry_run:
            n_places = writer.refresh_places()
            conn.commit()
            console.print(f"  places refreshed:   [green]{n_places:,}[/]")

        # Finalize audit row
        if run_id is not None and not dry_run:
            with conn.cursor() as cur:
                cur.execute(
                    """UPDATE import_runs SET
                           finished_at                 = now(),
                           raw_signals_inserted        = %s,
                           raw_signals_skipped         = %s,
                           segments_inserted           = %s,
                           segments_skipped            = %s,
                           activity_records_inserted   = %s,
                           activity_records_skipped    = %s,
                           wifi_scans_dropped          = %s,
                           timeline_memories_inserted  = %s,
                           timeline_memories_skipped   = %s,
                           unknown_records_captured    = %s,
                           unknown_records_dropped     = 0
                       WHERE id = %s""",
                    (
                        rs_inserted, rs_skipped,
                        seg_inserted, seg_skipped,
                        ar_inserted, ar_skipped,
                        wifi_dropped,
                        mem_inserted, mem_skipped,
                        unk_raw_inserted + unk_seg_captured,
                        run_id,
                    ),
                )
                conn.commit()

        # Summary
        console.rule("[bold green]Done")
        if not dry_run:
            with conn.cursor() as cur:
                cur.execute("SELECT count(*), min(ts), max(ts) FROM raw_signals")
                n, mn, mx = cur.fetchone()
                console.print(f"raw_signals      total: {n:,}  span: {mn}  →  {mx}")
                cur.execute("SELECT count(*), min(ts), max(ts) FROM activity_records")
                n, mn, mx = cur.fetchone()
                console.print(f"activity_records total: {n:,}  span: {mn}  →  {mx}")
                cur.execute("SELECT count(*), min(start_ts), max(end_ts) FROM segments")
                n, mn, mx = cur.fetchone()
                console.print(f"segments         total: {n:,}  span: {mn}  →  {mx}")

    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    app()
