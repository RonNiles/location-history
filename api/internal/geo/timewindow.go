package geo

import (
	"fmt"
	"time"
)

// TimeWindow is a half-open interval [Start, End).
type TimeWindow struct {
	Start time.Time
	End   time.Time
}

// ParseTimeWindow parses two RFC3339 strings. Either may be empty —
// missing bounds default to the past or future "infinity" (a
// thousand-year window centered on the epoch is plenty for our data).
func ParseTimeWindow(start, end string) (TimeWindow, error) {
	tw := TimeWindow{
		Start: time.Date(1970, 1, 1, 0, 0, 0, 0, time.UTC),
		End:   time.Date(3000, 1, 1, 0, 0, 0, 0, time.UTC),
	}
	if start != "" {
		t, err := time.Parse(time.RFC3339, start)
		if err != nil {
			return tw, fmt.Errorf("start: %w", err)
		}
		tw.Start = t.UTC()
	}
	if end != "" {
		t, err := time.Parse(time.RFC3339, end)
		if err != nil {
			return tw, fmt.Errorf("end: %w", err)
		}
		tw.End = t.UTC()
	}
	if !tw.End.After(tw.Start) {
		return tw, fmt.Errorf("end must be after start")
	}
	return tw, nil
}
