// Package geo holds GeoJSON types and bbox / coordinate parsing.
//
// We keep these types minimal — a full GeoJSON library is overkill
// for our output shape (FeatureCollection of Points and LineStrings).
package geo

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// BBox is a longitude/latitude bounding box.
//
// GeoJSON convention: order is [minLng, minLat, maxLng, maxLat]. We
// store explicit fields so call sites can't get the order wrong.
type BBox struct {
	MinLng, MinLat, MaxLng, MaxLat float64
}

// ParseBBox parses a "minLng,minLat,maxLng,maxLat" string. Returns
// an error if the string is malformed or describes an empty / invalid
// box. Antimeridian-crossing boxes (where MinLng > MaxLng) are NOT
// supported here — Postgres ST_MakeEnvelope can handle them with care
// but we reject them to keep the API surface simple.
func ParseBBox(s string) (BBox, error) {
	parts := strings.Split(s, ",")
	if len(parts) != 4 {
		return BBox{}, fmt.Errorf("bbox must be 'minLng,minLat,maxLng,maxLat', got %q", s)
	}
	vals := make([]float64, 4)
	for i, p := range parts {
		v, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil {
			return BBox{}, fmt.Errorf("bbox component %d: %w", i, err)
		}
		vals[i] = v
	}
	b := BBox{MinLng: vals[0], MinLat: vals[1], MaxLng: vals[2], MaxLat: vals[3]}
	if err := b.Validate(); err != nil {
		return BBox{}, err
	}
	return b, nil
}

func (b BBox) Validate() error {
	if b.MinLng < -180 || b.MaxLng > 180 || b.MinLat < -90 || b.MaxLat > 90 {
		return errors.New("bbox out of range")
	}
	if b.MinLng >= b.MaxLng || b.MinLat >= b.MaxLat {
		return errors.New("bbox is empty (min must be < max; antimeridian-crossing not supported)")
	}
	return nil
}

// FeatureCollection / Feature / Geometry are the minimum subset of
// GeoJSON we emit. We don't unmarshal these on the server side — the
// API is read-only — so MarshalJSON is the only thing that matters.

type FeatureCollection struct {
	Type     string    `json:"type"` // always "FeatureCollection"
	Features []Feature `json:"features"`
}

type Feature struct {
	Type       string          `json:"type"` // always "Feature"
	Geometry   Geometry        `json:"geometry"`
	Properties json.RawMessage `json:"properties"`
}

// Geometry is either a Point ([lng, lat]) or a LineString
// ([[lng, lat], ...]). We use one struct with a discriminator so the
// streaming writer can emit either without allocating per-feature.
type Geometry struct {
	Type        string      `json:"type"`
	Coordinates interface{} `json:"coordinates"`
}

func PointGeom(lng, lat float64) Geometry {
	return Geometry{Type: "Point", Coordinates: [2]float64{lng, lat}}
}

func LineStringGeom(coords [][2]float64) Geometry {
	return Geometry{Type: "LineString", Coordinates: coords}
}
