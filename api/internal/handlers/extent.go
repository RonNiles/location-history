package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/locationhistory/api/internal/httpx"
)

// Extent returns the global extent of the user's data — the time
// range and bounding box that contains all of it. The UI uses this
// to set sensible default zoom/extent on first load.
//
// The query unions raw_signals and segments because either source
// might be the longest one (raw is sparse but recent, segments may
// stretch back further).
func (a *API) Extent(w http.ResponseWriter, r *http.Request) {
	const sql = `
		WITH bounds AS (
			SELECT
				min(min_ts) AS min_ts,
				max(max_ts) AS max_ts,
				ST_AsGeoJSON(
					ST_Extent(geom)::geometry,
					6, 0
				) AS bbox_geojson
			FROM (
				SELECT min(ts) AS min_ts, max(ts) AS max_ts,
				       ST_Extent(location::geometry) AS geom
				FROM raw_signals
				UNION ALL
				SELECT min(start_ts), max(end_ts),
				       ST_Extent(COALESCE(center, path)::geometry)
				FROM segments
			) u
		)
		SELECT min_ts, max_ts, bbox_geojson FROM bounds`
	var (
		minTs, maxTs *time.Time
		bboxJSON     *string
	)
	if err := a.Pool.QueryRow(r.Context(), sql).Scan(&minTs, &maxTs, &bboxJSON); err != nil {
		httpx.ErrorFrom(w, r, a.Logger, err)
		return
	}

	resp := map[string]any{}
	if minTs != nil {
		resp["start"] = minTs.UTC().Format(time.RFC3339)
	}
	if maxTs != nil {
		resp["end"] = maxTs.UTC().Format(time.RFC3339)
	}
	// bbox_geojson is a Polygon. The UI only needs the four corners,
	// but emitting the full geom keeps things simple — clients can
	// derive the bbox from .geometry.coordinates[0] (the outer ring).
	if bboxJSON != nil {
		resp["bbox_geojson"] = json.RawMessage(*bboxJSON)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
