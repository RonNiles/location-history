package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/locationhistory/api/internal/httpx"
)

// API holds shared dependencies passed to every handler.
type API struct {
	Pool   *pgxpool.Pool
	Logger *slog.Logger
}

// Health checks that the DB pool is responsive. We deliberately ping
// the DB rather than just returning 200 — the API is useless without it.
func (a *API) Health(w http.ResponseWriter, r *http.Request) {
	if err := a.Pool.Ping(r.Context()); err != nil {
		httpx.ErrorFrom(w, r, a.Logger, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// Coverage returns daily coverage rows from the daily_coverage view.
//
// Query params:
//
//	start, end -- RFC3339 (optional)
//
// The result is small (one row per day, ~4000 rows for 10 years), so
// we buffer the whole response.
func (a *API) Coverage(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	var startDate, endDate time.Time
	var hasStart, hasEnd bool
	if s := q.Get("start"); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "start: "+err.Error())
			return
		}
		startDate, hasStart = t.UTC(), true
	}
	if e := q.Get("end"); e != "" {
		t, err := time.Parse(time.RFC3339, e)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "end: "+err.Error())
			return
		}
		endDate, hasEnd = t.UTC(), true
	}

	// Build the WHERE clause dynamically. pgx supports $N parameters;
	// we add only the ones we need.
	var (
		query = `SELECT day, raw_signal_count, segment_seconds, has_raw, has_segments
		         FROM daily_coverage`
		where []string
		args  []any
	)
	if hasStart {
		args = append(args, startDate)
		where = append(where, "day >= $"+strconv.Itoa(len(args)))
	}
	if hasEnd {
		args = append(args, endDate)
		where = append(where, "day < $"+strconv.Itoa(len(args)))
	}
	if len(where) > 0 {
		query += " WHERE " + joinAnd(where)
	}
	query += " ORDER BY day"

	rows, err := a.Pool.Query(r.Context(), query, args...)
	if err != nil {
		httpx.ErrorFrom(w, r, a.Logger, err)
		return
	}
	defer rows.Close()

	type row struct {
		Day            string `json:"day"`
		RawSignalCount int64  `json:"raw_signal_count"`
		SegmentSeconds int64  `json:"segment_seconds"`
		HasRaw         bool   `json:"has_raw"`
		HasSegments    bool   `json:"has_segments"`
	}
	out := []row{}
	for rows.Next() {
		var (
			day               time.Time
			cnt, secs         int64
			hasRawSig, hasSeg bool
		)
		if err := rows.Scan(&day, &cnt, &secs, &hasRawSig, &hasSeg); err != nil {
			httpx.ErrorFrom(w, r, a.Logger, err)
			return
		}
		out = append(out, row{
			Day:            day.Format("2006-01-02"),
			RawSignalCount: cnt,
			SegmentSeconds: secs,
			HasRaw:         hasRawSig,
			HasSegments:    hasSeg,
		})
	}
	if err := rows.Err(); err != nil {
		httpx.ErrorFrom(w, r, a.Logger, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"days": out})
}

// joinAnd is a tiny helper so we don't pull in strings just for one " AND " join.
func joinAnd(parts []string) string {
	switch len(parts) {
	case 0:
		return ""
	case 1:
		return parts[0]
	}
	out := parts[0]
	for _, p := range parts[1:] {
		out += " AND " + p
	}
	return out
}
