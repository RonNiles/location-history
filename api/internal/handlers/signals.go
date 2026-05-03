package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/locationhistory/api/internal/geo"
	"github.com/locationhistory/api/internal/httpx"
)

// Signals streams a GeoJSON FeatureCollection of raw_signals points
// inside a bbox and time window.
//
// Query params:
//
//	bbox       -- "minLng,minLat,maxLng,maxLat"  (required)
//	start, end -- RFC3339 timestamps              (required)
//	limit      -- max features                    (default 50_000, hard cap 500_000)
//
// We stream the JSON directly to the response so memory usage stays
// flat regardless of result size, and so a client disconnect (which
// fires r.Context().Done()) can cancel the still-running query in
// Postgres via pgx's context propagation.
func (a *API) Signals(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	bboxStr := q.Get("bbox")
	if bboxStr == "" {
		httpx.Error(w, http.StatusBadRequest, "bbox is required")
		return
	}
	box, err := geo.ParseBBox(bboxStr)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}

	tw, err := geo.ParseTimeWindow(q.Get("start"), q.Get("end"))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}

	limit := 50_000
	if s := q.Get("limit"); s != "" {
		v, err := strconv.Atoi(s)
		if err != nil || v <= 0 {
			httpx.Error(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		if v > 500_000 {
			v = 500_000
		}
		limit = v
	}

	// Note: ST_MakeEnvelope wants (minLng, minLat, maxLng, maxLat, srid).
	// We cast both sides to geometry for ST_Intersects — geography uses
	// great-circle math which is overkill (and slower) for a small bbox.
	// The GiST index on location works the same either way.
	const sql = `
		SELECT
			id,
			extract(epoch FROM ts) * 1000 AS ts_ms,
			ST_X(location::geometry) AS lng,
			ST_Y(location::geometry) AS lat,
			accuracy_m, altitude_m, speed_mps, source
		FROM raw_signals
		WHERE ts >= $1 AND ts < $2
		  AND location::geometry && ST_MakeEnvelope($3, $4, $5, $6, 4326)
		ORDER BY ts
		LIMIT $7`
	rows, err := a.Pool.Query(r.Context(), sql,
		tw.Start, tw.End,
		box.MinLng, box.MinLat, box.MaxLng, box.MaxLat,
		limit,
	)
	if err != nil {
		httpx.ErrorFrom(w, r, a.Logger, err)
		return
	}
	defer rows.Close()

	// Stream the response. We write the FeatureCollection envelope
	// manually so we never have to hold all features in memory.
	w.Header().Set("Content-Type", "application/geo+json")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	enc := json.NewEncoder(w)
	if _, err := w.Write([]byte(`{"type":"FeatureCollection","features":[`)); err != nil {
		return
	}

	first := true
	count := 0
	for rows.Next() {
		// Bail early if the client went away. pgx will also see this
		// via the original context, but checking here lets us stop
		// the per-row work.
		if r.Context().Err() != nil {
			return
		}
		var (
			id              int64
			tsMs            float64
			lng, lat        float64
			acc, alt, speed *float64
			source          *string
		)
		if err := rows.Scan(&id, &tsMs, &lng, &lat, &acc, &alt, &speed, &source); err != nil {
			a.Logger.Warn("signals scan", "err", err)
			break
		}

		if !first {
			_, _ = w.Write([]byte(","))
		}
		first = false

		// Build properties as a small map. JSON encoder handles the
		// nullable pointers correctly (writes null when nil).
		props := map[string]any{
			"id":    id,
			"ts_ms": int64(tsMs),
			"acc_m": acc,
			"alt_m": alt,
			"spd":   speed,
			"src":   source,
		}
		feature := map[string]any{
			"type":       "Feature",
			"geometry":   map[string]any{"type": "Point", "coordinates": [2]float64{lng, lat}},
			"properties": props,
		}
		if err := enc.Encode(feature); err != nil {
			return
		}
		count++

		// Periodically flush so the client can see progress and so a
		// disconnect surfaces quickly.
		if flusher != nil && count%2048 == 0 {
			flusher.Flush()
		}
	}
	if err := rows.Err(); err != nil && r.Context().Err() == nil {
		a.Logger.Warn("signals rows.Err", "err", err)
	}

	// Trailer with a count, so clients can tell whether they hit the limit.
	// json.Encoder.Encode writes a trailing newline, which is fine.
	_, _ = w.Write([]byte(`],"count":` + strconv.Itoa(count) +
		`,"limit":` + strconv.Itoa(limit) + `}` + "\n"))
	if flusher != nil {
		flusher.Flush()
	}
}
