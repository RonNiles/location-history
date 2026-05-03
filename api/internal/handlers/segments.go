package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/locationhistory/api/internal/geo"
	"github.com/locationhistory/api/internal/httpx"
)

// Segments returns visits and activities as a GeoJSON FeatureCollection.
//
// Query params:
//
//	bbox       -- optional; if present, only segments whose center
//	              (visit) or path (activity) intersects the bbox
//	start, end -- required; segments overlapping [start, end)
//	types      -- optional; comma list, "visit" / "activity" / both
//	limit      -- default 5_000, hard cap 50_000
//
// Unlike /signals, segment counts are typically small enough (a few
// thousand at most for a year-wide query) that we don't need to be
// quite as careful about streaming. We still stream for consistency
// and so context cancellation is meaningful.
//
// Geometries: for path columns we ask Postgres to emit GeoJSON
// directly via ST_AsGeoJSON. LineStrings have variable length, and
// shipping pre-formatted JSON is simpler than reading the WKT/WKB
// and reformatting in Go.
func (a *API) Segments(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	tw, err := geo.ParseTimeWindow(q.Get("start"), q.Get("end"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}

	var (
		hasBbox bool
		box     geo.BBox
	)
	if s := q.Get("bbox"); s != "" {
		box, err = geo.ParseBBox(s)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		hasBbox = true
	}

	wantVisit, wantActivity := true, true
	if t := q.Get("types"); t != "" {
		wantVisit, wantActivity = false, false
		// Cheap manual split — we only need to detect two tokens.
		for _, k := range splitComma(t) {
			switch k {
			case "visit":
				wantVisit = true
			case "activity":
				wantActivity = true
			default:
				httpx.Error(w, http.StatusBadRequest, "unknown type: "+k)
				return
			}
		}
	}
	if !wantVisit && !wantActivity {
		httpx.Error(w, http.StatusBadRequest, "no types selected")
		return
	}

	limit := 5_000
	if s := q.Get("limit"); s != "" {
		v, err := strconv.Atoi(s)
		if err != nil || v <= 0 {
			httpx.Error(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		if v > 50_000 {
			v = 50_000
		}
		limit = v
	}

	// Optional path simplification. The tolerance is in meters; the
	// SQL converts to degrees by dividing by 111_320 (rough meters
	// per degree at the equator). Topology-preserving so paths don't
	// become disjoint. Only applied to LineStrings, not points.
	//
	// Typical values: 5m for street-level, 50m for city, 500m+ for
	// global. The UI passes a tolerance based on map zoom.
	var simplifyM float64
	if s := q.Get("simplify_m"); s != "" {
		v, err := strconv.ParseFloat(s, 64)
		if err != nil || v < 0 {
			httpx.Error(w, http.StatusBadRequest, "simplify_m must be a non-negative number")
			return
		}
		// Cap simplification — beyond a few km the geometry starts
		// looking degenerate.
		if v > 5_000 {
			v = 5_000
		}
		simplifyM = v
	}

	// Build SQL. We use overlap semantics for the time window —
	// `tstzrange(start_ts, end_ts) && tstzrange($1, $2)` would also
	// work but plain comparisons are faster with our existing btree
	// indexes on start_ts / end_ts.
	//
	// Geometry column: visit -> center (Point); activity -> path
	// (LineString). We coalesce them into a single geojson string
	// emitted by Postgres. When simplify_m > 0, the path geometry is
	// simplified before being serialized; the visit center is left
	// alone (simplifying a single point is a no-op anyway).
	args := []any{tw.Start, tw.End}
	geomExpr := `COALESCE(center, path)::geometry`
	if simplifyM > 0 {
		// ST_SimplifyPreserveTopology takes geometry, not geography.
		// Tolerance in degrees. Lat/lng degree size varies, but at
		// our query latitudes ~111km/deg is close enough for visual
		// simplification — the user is picking visual fidelity, not
		// surveying.
		geomExpr = `ST_SimplifyPreserveTopology(
			COALESCE(center, path)::geometry,
			` + strconv.FormatFloat(simplifyM/111_320.0, 'f', 9, 64) + `
		)`
	}
	sqlStr := `
		SELECT
			id, segment_type,
			extract(epoch FROM start_ts) * 1000 AS start_ms,
			extract(epoch FROM end_ts)   * 1000 AS end_ms,
			activity_type, activity_confidence, distance_m, place_id,
			ST_AsGeoJSON(` + geomExpr + `, 6, 0) AS geom_json
		FROM segments
		WHERE start_ts < $2 AND end_ts >= $1`
	if !(wantVisit && wantActivity) {
		// Filter to one type
		if wantVisit {
			sqlStr += ` AND segment_type = 'visit'`
		} else {
			sqlStr += ` AND segment_type = 'activity'`
		}
	}
	if hasBbox {
		args = append(args, box.MinLng, box.MinLat, box.MaxLng, box.MaxLat)
		sqlStr += ` AND COALESCE(center, path)::geometry && ST_MakeEnvelope($3,$4,$5,$6,4326)`
	}
	sqlStr += ` ORDER BY start_ts LIMIT $` + strconv.Itoa(len(args)+1)
	args = append(args, limit)

	rows, err := a.Pool.Query(r.Context(), sqlStr, args...)
	if err != nil {
		httpx.ErrorFrom(w, r, a.Logger, err)
		return
	}
	defer rows.Close()

	w.Header().Set("Content-Type", "application/geo+json")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	if _, err := w.Write([]byte(`{"type":"FeatureCollection","features":[`)); err != nil {
		return
	}
	enc := json.NewEncoder(w)

	first := true
	count := 0
	for rows.Next() {
		if r.Context().Err() != nil {
			return
		}
		var (
			id                      int64
			segType                 string
			startMs, endMs          float64
			activityType, placeID   *string
			activityConf, distanceM *float64
			geomJSON                *string
		)
		if err := rows.Scan(&id, &segType, &startMs, &endMs,
			&activityType, &activityConf, &distanceM, &placeID, &geomJSON); err != nil {
			a.Logger.Warn("segments scan", "err", err)
			break
		}

		if !first {
			_, _ = w.Write([]byte(","))
		}
		first = false

		// geomJSON is already a JSON object string from ST_AsGeoJSON.
		// We splice it into the feature without re-parsing.
		var geom json.RawMessage
		if geomJSON != nil {
			geom = json.RawMessage(*geomJSON)
		} else {
			geom = json.RawMessage("null")
		}
		props := map[string]any{
			"id":       id,
			"type":     segType,
			"start_ms": int64(startMs),
			"end_ms":   int64(endMs),
			"act":      activityType,
			"conf":     activityConf,
			"dist_m":   distanceM,
			"place_id": placeID,
		}
		feature := map[string]any{
			"type":       "Feature",
			"geometry":   geom,
			"properties": props,
		}
		if err := enc.Encode(feature); err != nil {
			return
		}
		count++

		if flusher != nil && count%512 == 0 {
			flusher.Flush()
		}
	}
	if err := rows.Err(); err != nil && r.Context().Err() == nil {
		a.Logger.Warn("segments rows.Err", "err", err)
	}

	_, _ = w.Write([]byte(`],"count":` + strconv.Itoa(count) +
		`,"limit":` + strconv.Itoa(limit) + `}` + "\n"))
	if flusher != nil {
		flusher.Flush()
	}
}

func splitComma(s string) []string {
	var out []string
	cur := ""
	for _, r := range s {
		if r == ',' {
			if cur != "" {
				out = append(out, cur)
				cur = ""
			}
			continue
		}
		cur += string(r)
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}
