package handlers

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/locationhistory/api/internal/httpx"
	"github.com/locationhistory/api/internal/tiles"
)

// Tiles serves a single OSM raster tile, hitting the local cache
// first and falling back to upstream OSM. Z/X/Y are validated:
//   * z in [0, 19]
//   * x, y in [0, 2^z - 1]
// Anything outside is 404 — without this, a malicious or buggy
// client could flood OSM with requests for nonsensical coordinates
// and we'd dutifully forward them.
func (a *API) Tiles(w http.ResponseWriter, r *http.Request) {
	zS := chi.URLParam(r, "z")
	xS := chi.URLParam(r, "x")
	yS := chi.URLParam(r, "y")

	z, err1 := strconv.Atoi(zS)
	x, err2 := strconv.Atoi(xS)
	y, err3 := strconv.Atoi(yS)
	if err1 != nil || err2 != nil || err3 != nil {
		httpx.Error(w, http.StatusBadRequest, "z, x, y must be integers")
		return
	}
	if z < 0 || z > 19 {
		httpx.Error(w, http.StatusBadRequest, "z out of range [0, 19]")
		return
	}
	max := 1 << z
	if x < 0 || y < 0 || x >= max || y >= max {
		httpx.Error(w, http.StatusBadRequest, "x or y out of range for this zoom")
		return
	}

	if a.TileCache == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "tile cache not configured")
		return
	}

	res, err := a.TileCache.Get(r.Context(), z, x, y)
	if err != nil {
		if errors.Is(err, tiles.ErrNotFound) {
			http.NotFound(w, r)
			return
		}
		// Don't leak full upstream errors to the client; log and
		// 502.
		a.Logger.Warn("tile fetch failed", "z", z, "x", x, "y", y, "err", err)
		httpx.Error(w, http.StatusBadGateway, "tile unavailable")
		return
	}

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Cache", res.Source)
	if res.Age > 0 {
		w.Header().Set("X-Cache-Age", res.Age.Truncate(time.Second).String())
	}
	// Tell the browser to cache aggressively too — these are the
	// same bytes the upstream OSM server would serve.
	w.Header().Set("Cache-Control", "public, max-age=604800") // 7 days
	w.Header().Set("Content-Length", strconv.Itoa(len(res.Bytes)))
	_, _ = w.Write(res.Bytes)
}

// TileStats returns counters for the tile cache. Useful for the UI
// to show a "tiles cached / hit rate" line, and for `make tile-stats`.
func (a *API) TileStats(w http.ResponseWriter, r *http.Request) {
	if a.TileCache == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "tile cache not configured")
		return
	}
	s := a.TileCache.Stats()
	w.Header().Set("Content-Type", "application/json")
	disabled := "false"
	if s.Disabled {
		disabled = "true"
	}
	body := []byte(`{"hits":` + strconv.FormatUint(s.Hits, 10) +
		`,"misses":` + strconv.FormatUint(s.Misses, 10) +
		`,"errors":` + strconv.FormatUint(s.Errors, 10) +
		`,"put_failures":` + strconv.FormatUint(s.PutFailures, 10) +
		`,"disabled":` + disabled + `}` + "\n")
	w.Write(body)
}
