package handlers

import (
	"reflect"
	"testing"
)

func TestSplitComma(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"a", []string{"a"}},
		{"a,b,c", []string{"a", "b", "c"}},
		{"a,,b", []string{"a", "b"}},          // empty tokens skipped
		{",a,b,", []string{"a", "b"}},         // leading/trailing commas
		{"visit,activity", []string{"visit", "activity"}},
	}
	for _, c := range cases {
		got := splitComma(c.in)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("splitComma(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestJoinAnd(t *testing.T) {
	cases := []struct {
		in   []string
		want string
	}{
		{nil, ""},
		{[]string{}, ""},
		{[]string{"a > 1"}, "a > 1"},
		{[]string{"a > 1", "b < 2"}, "a > 1 AND b < 2"},
		{[]string{"x", "y", "z"}, "x AND y AND z"},
	}
	for _, c := range cases {
		got := joinAnd(c.in)
		if got != c.want {
			t.Errorf("joinAnd(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}
