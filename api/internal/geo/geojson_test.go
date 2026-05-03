package geo

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestParseBBox_OK(t *testing.T) {
	cases := []struct {
		in   string
		want BBox
	}{
		{"-122.5,37.7,-122.3,37.9", BBox{-122.5, 37.7, -122.3, 37.9}},
		{" -180, -90, 180, 90 ", BBox{-180, -90, 180, 90}},
	}
	for _, c := range cases {
		got, err := ParseBBox(c.in)
		if err != nil {
			t.Fatalf("ParseBBox(%q): %v", c.in, err)
		}
		if got != c.want {
			t.Errorf("ParseBBox(%q) = %+v, want %+v", c.in, got, c.want)
		}
	}
}

func TestParseBBox_Errors(t *testing.T) {
	cases := []string{
		"",
		"a,b,c,d",
		"1,2,3",       // too few
		"1,2,3,4,5",   // too many
		"-200,0,0,1",  // out of range
		"0,0,-1,1",    // empty (max < min)
		"5,5,5,5",     // empty (equal)
		"170,0,-170,1", // antimeridian; we don't support this
	}
	for _, in := range cases {
		_, err := ParseBBox(in)
		if err == nil {
			t.Errorf("ParseBBox(%q) should fail", in)
		}
	}
}

func TestParseTimeWindow(t *testing.T) {
	tw, err := ParseTimeWindow("2024-01-01T00:00:00Z", "2024-12-31T23:59:59Z")
	if err != nil {
		t.Fatal(err)
	}
	if tw.Start.Year() != 2024 || tw.End.Year() != 2024 {
		t.Errorf("years wrong: %v %v", tw.Start, tw.End)
	}

	// Empty bounds default to the open interval.
	tw, err = ParseTimeWindow("", "")
	if err != nil {
		t.Fatal(err)
	}
	if !tw.Start.Before(time.Now()) || !tw.End.After(time.Now()) {
		t.Errorf("empty bounds should bracket now: %v / %v", tw.Start, tw.End)
	}

	// End before start should error.
	if _, err := ParseTimeWindow("2024-06-01T00:00:00Z", "2024-01-01T00:00:00Z"); err == nil {
		t.Error("end<start should fail")
	}
	// Equal start and end should error (half-open interval).
	if _, err := ParseTimeWindow("2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"); err == nil {
		t.Error("end==start should fail")
	}
	// Garbage timestamp.
	if _, err := ParseTimeWindow("not-a-date", ""); err == nil {
		t.Error("garbage start should fail")
	}
}

func TestPointGeomMarshal(t *testing.T) {
	g := PointGeom(-122.4, 37.78)
	b, err := json.Marshal(g)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"type":"Point","coordinates":[-122.4,37.78]}`
	if string(b) != want {
		t.Errorf("got %s want %s", b, want)
	}
}

func TestLineStringGeomMarshal(t *testing.T) {
	g := LineStringGeom([][2]float64{{-122.4, 37.78}, {-122.3, 37.79}})
	b, err := json.Marshal(g)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"type":"LineString"`) {
		t.Errorf("missing LineString type: %s", b)
	}
	if !strings.Contains(string(b), `[[-122.4,37.78],[-122.3,37.79]]`) {
		t.Errorf("coords wrong: %s", b)
	}
}
