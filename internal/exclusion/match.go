package exclusion

import (
	"strings"

	"github.com/pkg/errors"

	"github.com/kopia/kopia/internal/wcmatch"
)

// Matcher says whether a path of a snapshot source is left out by a pattern, the way Kopia decides it
// while taking a snapshot (a pattern is relative to the source folder; matching is case sensitive).
type Matcher struct {
	m wcmatch.WildcardMatcher
}

// NewMatcher compiles a pattern.
func NewMatcher(pattern string) (*Matcher, error) {
	p, err := ValidatePattern(pattern)
	if err != nil {
		return nil, err
	}

	m, err := wcmatch.NewWildcardMatcher(p, wcmatch.IgnoreCase(false), wcmatch.BaseDir(""))
	if err != nil {
		return nil, errors.Wrap(err, "the pattern is not valid")
	}

	return &Matcher{m: *m}, nil
}

// Match reports whether the path, relative to the source folder, is excluded. Kopia hands its matchers
// paths that start with a slash ("/Projects/a/build"), so that is what is matched here too.
func (m *Matcher) Match(path string, isDir bool) bool {
	return m.m.Match("/"+strings.TrimPrefix(path, "/"), isDir)
}
