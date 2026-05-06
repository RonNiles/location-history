package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/locationhistory/api/internal/geo"
	"github.com/locationhistory/api/internal/httpx"
)

// PointsNear answers "when was I near this point?". It queries BOTH
// raw_signals and segments because, as we established in Phase 1,
// raw_signals coverage is sparse (only ~30 days per export) and
// segments are the long-term truth.
//
// The endpoint returns a single JSON object with two arrays:
//
//	raw_hits      -- individual GPS fixes within the radius
//	segment_hits  -- visits whose center is within the radius, OR
//	                 activities whose path comes within the radius
//
// Each segment_hit also carries the type ('visit' / 'activity') so
// the UI can show them differently.
//
// Query params:
//
//	lat, lng    -- required; the query point
//	radius_m    -- required; meters
//	start, end  -- optional; default = all time
//	limit       -- per-array cap; default 1000, hard cap 10_000
func (a *API) PointsNear(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	lat, err := parseFloat(q.Get("lat"), "lat")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	lng, err := parseFloat(q.Get("lng"), "lng")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	if lat < -90 || lat > 90 || lng < -180 || lng > 180 {
		httpx.Error(w, http.StatusBadRequest, "lat/lng out of range")
		return
	}
	radius, err := parseFloat(q.Get("radius_m"), "radius_m")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	if radius <= 0 || radius > 1_000_000 {
		httpx.Error(w, http.StatusBadRequest, "radius_m must be in (0, 1_000_000]")
		return
	}

	tw, err := geo.ParseTimeWindow(q.Get("start"), q.Get("end"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}

	limit := 1000
	if s := q.Get("limit"); s != "" {
		v, err := strconv.Atoi(s)
		if err != nil || v <= 0 {
			httpx.Error(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		if v > 10_000 {
			v = 10_000
		}
		limit = v
	}

	// Build the query point as a geography so ST_DWithin is in meters.
	// ST_DWithin(geography, geography, distance_m) is the canonical
	// "within X meters" pattern in PostGIS and uses the GiST index.
	//
	// We run two queries (raw + segments) sequentially, sharing the
	// request context. They could be run in parallel goroutines for
	// a marginal speedup, but the simpler sequential code is easier
	// to reason about and the queries are independent in the planner.

	type rawHit struct {
		ID        int64    `json:"id"`
		TsMs      int64    `json:"ts_ms"`
		Lng       float64  `json:"lng"`
		Lat       float64  `json:"lat"`
		DistanceM float64  `json:"dist_m"`
		AccuracyM *float64 `json:"acc_m,omitempty"`
		Source    *string  `json:"src,omitempty"`
	}
	const rawSQL = `
		WITH q AS (
			SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS pt
		)
		SELECT id,
		       extract(epoch FROM ts) * 1000 AS ts_ms,
		       ST_X(location::geometry) AS lng,
		       ST_Y(location::geometry) AS lat,
		       ST_Distance(location, (SELECT pt FROM q)) AS dist_m,
		       accuracy_m, source
		FROM raw_signals
		WHERE ts >= $4 AND ts < $5
		  AND ST_DWithin(location, (SELECT pt FROM q), $3)
		ORDER BY ts
		LIMIT $6`
	rawRows, err := a.Pool.Query(r.Context(), rawSQL,
		lng, lat, radius, tw.Start, tw.End, limit)
	if err != nil {
		httpx.ErrorFrom(w, r, a.Logger, err)
		return
	}
	rawHits := make([]rawHit, 0, 64)
	for rawRows.Next() {
		if r.Context().Err() != nil {
			rawRows.Close()
			return
		}
		var h rawHit
		if err := rawRows.Scan(&h.ID, &h.TsMs, &h.Lng, &h.Lat, &h.DistanceM,
			&h.AccuracyM, &h.Source); err != nil {
			rawRows.Close()
			httpx.ErrorFrom(w, r, a.Logger, err)
			return
		}
		// Round ts_ms to int64 cleanly
		rawHits = append(rawHits, h)
	}
	if err := rawRows.Err(); err != nil && r.Context().Err() == nil {
		rawRows.Close()
		httpx.ErrorFrom(w, r, a.Logger, err)
		return
	}
	rawRows.Close()

	type segHit struct {
		ID           int64    `json:"id"`
		Type         string   `json:"type"` // visit | activity
		StartMs      int64    `json:"start_ms"`
		EndMs        int64    `json:"end_ms"`
		MinDistanceM float64  `json:"min_dist_m"`
		ActivityType *string  `json:"act,omitempty"`
		Confidence   *float64 `json:"conf,omitempty"`
		PlaceID      *string  `json:"place_id,omitempty"`
	}
	// For visits we use ST_Distance(center, q). For activities we use
	// ST_Distance(path, q) — PostGIS gives us minimum distance from
	// the linestring to the point, which is exactly what "did my path
	// pass through this radius" means.
	const segSQL = `
		WITH q AS (
			SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS pt
		)
		SELECT id, segment_type,
		       extract(epoch FROM start_ts) * 1000 AS start_ms,
		       extract(epoch FROM end_ts)   * 1000 AS end_ms,
		       ST_Distance(COALESCE(center, path), (SELECT pt FROM q)) AS dist_m,
		       activity_type, activity_confidence, place_id
		FROM segments
		WHERE start_ts < $5 AND end_ts >= $4
		  AND ST_DWithin(COALESCE(center, path), (SELECT pt FROM q), $3)
		ORDER BY start_ts
		LIMIT $6`
	segRows, err := a.Pool.Query(r.Context(), segSQL,
		lng, lat, radius, tw.Start, tw.End, limit)
	if err != nil {
		httpx.ErrorFrom(w, r, a.Logger, err)
		return
	}
	defer segRows.Close()
	segHits := make([]segHit, 0, 64)
	for segRows.Next() {
		if r.Context().Err() != nil {
			return
		}
		var h segHit
		if err := segRows.Scan(&h.ID, &h.Type, &h.StartMs, &h.EndMs,
			&h.MinDistanceM, &h.ActivityType, &h.Confidence, &h.PlaceID); err != nil {
			httpx.ErrorFrom(w, r, a.Logger, err)
			return
		}
		segHits = append(segHits, h)
	}
	if err := segRows.Err(); err != nil && r.Context().Err() == nil {
		httpx.ErrorFrom(w, r, a.Logger, err)
		return
	}

	// Compute a bounding box of all matched geometries plus the
	// search circle. Used by the UI to fit the map to the results.
	//
	// Why include the search circle? It's the user's intent.
	// A search center should never disappear off the edge of the
	// view — even if all the matches happen to be on one side of
	// it, panning to crop out the circle would feel disorienting.
	//
	// The circle is approximated with ST_Buffer on a geography (so
	// the radius is honored in meters), then cast back to geometry
	// for ST_Extent. We use 16 segments per quadrant which is
	// plenty for a viewport bbox (the circle is just there to
	// influence corners, not to be drawn).
	//
	// If no matches AND we still want the bbox to bracket the
	// circle, the buffered point alone is enough — ST_Extent of a
	// single polygon is just its envelope.
	const bboxSQL = `
		WITH q AS (
			SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS pt
		),
		matched_segs AS (
			SELECT COALESCE(center, path)::geometry AS g
			FROM segments
			WHERE start_ts < $5 AND end_ts >= $4
			  AND ST_DWithin(COALESCE(center, path), (SELECT pt FROM q), $3)
		),
		matched_raw AS (
			SELECT location::geometry AS g
			FROM raw_signals
			WHERE ts >= $4 AND ts < $5
			  AND ST_DWithin(location, (SELECT pt FROM q), $3)
		),
		circle AS (
			SELECT ST_Buffer((SELECT pt FROM q), $3, 16)::geometry AS g
		),
		all_geoms AS (
			SELECT g FROM matched_segs
			UNION ALL SELECT g FROM matched_raw
			UNION ALL SELECT g FROM circle
		)
		SELECT
			ST_XMin(ST_Extent(g)),
			ST_YMin(ST_Extent(g)),
			ST_XMax(ST_Extent(g)),
			ST_YMax(ST_Extent(g))
		FROM all_geoms`
	var bboxMinLng, bboxMinLat, bboxMaxLng, bboxMaxLat *float64
	bboxRow := a.Pool.QueryRow(r.Context(), bboxSQL,
		lng, lat, radius, tw.Start, tw.End)
	if err := bboxRow.Scan(&bboxMinLng, &bboxMinLat, &bboxMaxLng, &bboxMaxLat); err != nil {
		// Don't fail the whole response — bbox is a convenience.
		// Log and continue with a nil bbox.
		a.Logger.Warn("points-near bbox", "err", err)
	}
	var bboxOut []float64
	if bboxMinLng != nil && bboxMinLat != nil && bboxMaxLng != nil && bboxMaxLat != nil {
		bboxOut = []float64{*bboxMinLng, *bboxMinLat, *bboxMaxLng, *bboxMaxLat}
	}

	resp := map[string]any{
		"query": map[string]any{
			"lat":      lat,
			"lng":      lng,
			"radius_m": radius,
			"start":    tw.Start.Format(time.RFC3339),
			"end":      tw.End.Format(time.RFC3339),
		},
		"raw_hits":     rawHits,
		"segment_hits": segHits,
		"bbox":         bboxOut, // [minLng, minLat, maxLng, maxLat]
		"limit":        limit,
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func parseFloat(s, name string) (float64, error) {
	if s == "" {
		return 0, &requiredFieldError{name}
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, &fieldError{name, err}
	}
	return v, nil
}

type requiredFieldError struct{ name string }

func (e *requiredFieldError) Error() string { return e.name + " is required" }

type fieldError struct {
	name string
	err  error
}

func (e *fieldError) Error() string { return e.name + ": " + e.err.Error() }
