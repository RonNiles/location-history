package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/locationhistory/api/internal/geo"
	"github.com/locationhistory/api/internal/httpx"
)

// Places returns places as a GeoJSON FeatureCollection.
//
// Selection rules:
//   * Every place that has a user_label, regardless of visit_count.
//   * Plus unlabeled places with visit_count >= min_visits (default 3),
//     so heavily-visited but unnamed places still show up.
//
// Query params:
//   bbox        bounding box filter (centroid intersects)
//   min_visits  threshold for unlabeled places (default 3)
//   limit       hard cap (default 5000, max 20000)
//
// We don't filter by date range — places are a historical aggregate
// of all visits, not a snapshot of a time window. The map's date
// picker controls segments + signals + heatmap, and intentionally
// leaves places alone so they remain a stable spatial anchor as the
// user scrolls through time.
//
// Properties on each feature:
//   id, label (user_label or null), visits, total_seconds,
//   first_seen, last_seen
func (a *API) Places(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	minVisits := 3
	if s := q.Get("min_visits"); s != "" {
		v, err := strconv.Atoi(s)
		if err != nil || v < 0 {
			httpx.Error(w, http.StatusBadRequest, "min_visits must be non-negative")
			return
		}
		minVisits = v
	}

	limit := 5000
	if s := q.Get("limit"); s != "" {
		v, err := strconv.Atoi(s)
		if err != nil || v <= 0 {
			httpx.Error(w, http.StatusBadRequest, "limit must be positive")
			return
		}
		if v > 20000 {
			v = 20000
		}
		limit = v
	}

	args := []any{minVisits, limit}
	bboxClause := ""
	if s := q.Get("bbox"); s != "" {
		box, err := geo.ParseBBox(s)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		args = []any{minVisits, box.MinLng, box.MinLat, box.MaxLng, box.MaxLat, limit}
		bboxClause = "AND centroid::geometry && ST_MakeEnvelope($2,$3,$4,$5,4326)"
	}

	// We require centroid IS NOT NULL because a labeled trip-only
	// place (no actual visit) has NULL centroid and can't be drawn.
	// Future improvement: derive a centroid from the segment(s) of
	// any timeline_memory that contains it.
	limitParam := "$2"
	if bboxClause != "" {
		limitParam = "$6"
	}
	sqlStr := `
		SELECT
			id,
			user_label,
			visit_count,
			total_seconds,
			first_seen,
			last_seen,
			ST_X(centroid::geometry) AS lng,
			ST_Y(centroid::geometry) AS lat
		FROM places
		WHERE centroid IS NOT NULL
		  AND (user_label IS NOT NULL OR visit_count >= $1)
		  ` + bboxClause + `
		ORDER BY visit_count DESC
		LIMIT ` + limitParam

	rows, err := a.Pool.Query(r.Context(), sqlStr, args...)
	if err != nil {
		httpx.ErrorFrom(w, r, a.Logger, err)
		return
	}
	defer rows.Close()

	w.Header().Set("Content-Type", "application/json")
	// Stream the FeatureCollection. We could buffer it (these
	// responses are bounded by `limit`) but streaming is the
	// pattern used by /signals and /segments — keep things uniform.
	w.Write([]byte(`{"type":"FeatureCollection","features":[`))

	first := true
	count := 0
	for rows.Next() {
		var (
			id, label            *string
			visits, totalSeconds *int64
			firstSeen, lastSeen  *time.Time
			lng, lat             *float64
		)
		if err := rows.Scan(&id, &label, &visits, &totalSeconds,
			&firstSeen, &lastSeen, &lng, &lat); err != nil {
			a.Logger.Warn("places scan", "err", err)
			continue
		}
		if !first {
			w.Write([]byte(","))
		}
		first = false

		feat := map[string]any{
			"type": "Feature",
			"geometry": map[string]any{
				"type":        "Point",
				"coordinates": []any{*lng, *lat},
			},
			"properties": map[string]any{
				"id":            *id,
				"label":         derefString(label),
				"visits":        derefInt64(visits),
				"total_seconds": derefInt64(totalSeconds),
				"first_seen":    derefTime(firstSeen),
				"last_seen":     derefTime(lastSeen),
			},
		}
		buf, err := json.Marshal(feat)
		if err != nil {
			return
		}
		w.Write(buf)
		count++
	}
	if err := rows.Err(); err != nil {
		a.Logger.Warn("places iteration", "err", err)
	}
	w.Write([]byte(`],"count":` + strconv.Itoa(count) + `}`))
}

func derefString(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func derefInt64(p *int64) any {
	if p == nil {
		return int64(0)
	}
	return *p
}

func derefTime(p *time.Time) any {
	if p == nil {
		return nil
	}
	return p.UTC().Format(time.RFC3339)
}
