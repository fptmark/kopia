// Package ignoreerr keeps the rules for errors that are not worth reporting: a file that can never be read
// is not a failed backup. A rule hides an error from failure counts and notifications only; the error stays
// in the snapshot record, and nothing about what gets backed up changes.
package ignoreerr

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/pkg/errors"

	"github.com/kopia/kopia/internal/atomicfile"
)

// What an ignore rule covers.
const (
	ScopeFile   = "file"   // exactly this path
	ScopeFolder = "folder" // this folder and everything under it
)

// Kinds of error, so that a rule can cover one cause only.
const (
	KindPermission = "permission" // operation not permitted, permission denied
	KindMissing    = "missing"    // the file went away while it was being read
	KindBusy       = "busy"       // resource busy, locked
	KindOther      = "other"
)

// Kinds lists the kinds a rule may name.
var Kinds = []string{KindPermission, KindMissing, KindBusy, KindOther} //nolint:gochecknoglobals

// KindOf classifies an error message.
func KindOf(msg string) string {
	m := strings.ToLower(msg)

	switch {
	case strings.Contains(m, "operation not permitted"), strings.Contains(m, "permission denied"):
		return KindPermission
	case strings.Contains(m, "no such file"), strings.Contains(m, "not found"):
		return KindMissing
	case strings.Contains(m, "resource busy"), strings.Contains(m, "text file busy"), strings.Contains(m, "locked"):
		return KindBusy
	default:
		return KindOther
	}
}

// Rule hides matching errors. Source is the folder of the snapshot source (empty matches any source) and
// Path is relative to it. An empty Kind matches every kind of error.
type Rule struct {
	ID      string     `json:"id"`
	Source  string     `json:"source"`
	Path    string     `json:"path"`
	Scope   string     `json:"scope"`
	Kind    string     `json:"kind,omitempty"`
	Created time.Time  `json:"created"`
	Expires *time.Time `json:"expires,omitempty"`
}

// Expired reports whether the rule has stopped applying.
func (r Rule) Expired(now time.Time) bool {
	return r.Expires != nil && !now.Before(*r.Expires)
}

// relative normalizes a path inside a source: no leading or trailing slash.
func relative(p string) string {
	p = strings.Trim(path.Clean("/"+strings.TrimSpace(p)), "/")

	return p
}

// Validate checks the rule and fills in its normal form.
func (r *Rule) Validate() error {
	r.Path = relative(r.Path)
	r.Source = strings.TrimRight(strings.TrimSpace(r.Source), "/")

	switch r.Scope {
	case ScopeFile:
		if r.Path == "" {
			return errors.New("a file rule needs a path")
		}
	case ScopeFolder:
		if r.Path == "" && r.Kind == "" {
			return errors.New("a rule for a whole source needs an error kind")
		}
	default:
		return errors.Errorf("unknown scope %q", r.Scope)
	}

	if r.Kind != "" {
		ok := false

		for _, k := range Kinds {
			ok = ok || k == r.Kind
		}

		if !ok {
			return errors.Errorf("unknown error kind %q", r.Kind)
		}
	}

	return nil
}

// Matches reports whether the rule hides an error of the given source folder, path and message.
func (r Rule) Matches(source, p, msg string, now time.Time) bool {
	if r.Expired(now) {
		return false
	}

	if r.Source != "" && strings.TrimRight(source, "/") != r.Source {
		return false
	}

	if r.Kind != "" && KindOf(msg) != r.Kind {
		return false
	}

	p, rp := relative(p), relative(r.Path)

	switch r.Scope {
	case ScopeFile:
		return p == rp
	case ScopeFolder:
		return rp == "" || p == rp || strings.HasPrefix(p, rp+"/")
	}

	return false
}

// Failure is one error of a snapshot.
type Failure struct {
	Path  string
	Error string
}

// Store keeps the rules in a file. A nil store has no rules.
type Store struct {
	file string
	now  func() time.Time

	mu    sync.RWMutex
	rules []Rule
}

type fileContent struct {
	Rules []Rule `json:"rules"`
}

// Open reads the rules in the file; a missing file means no rules.
func Open(file string, now func() time.Time) (*Store, error) {
	s := &Store{file: file, now: now}

	b, err := os.ReadFile(file) //nolint:gosec
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}

	if err != nil {
		return nil, errors.Wrap(err, "unable to read ignored errors")
	}

	var c fileContent
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, errors.Wrap(err, "unable to parse ignored errors")
	}

	s.rules = c.Rules

	return s, nil
}

func (s *Store) save() error {
	b, err := json.MarshalIndent(fileContent{Rules: s.rules}, "", "  ")
	if err != nil {
		return errors.Wrap(err, "unable to encode ignored errors")
	}

	return errors.Wrap(atomicfile.Write(s.file, bytes.NewReader(append(b, '\n'))), "unable to write ignored errors")
}

// Rules returns every rule, expired ones included, so they can be shown and removed.
func (s *Store) Rules() []Rule {
	if s == nil {
		return nil
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	return append([]Rule{}, s.rules...)
}

// Add stores a new rule. Adding the same rule twice keeps one.
func (s *Store) Add(r Rule) (Rule, error) {
	if err := r.Validate(); err != nil {
		return Rule{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for _, o := range s.rules {
		if o.Source == r.Source && o.Path == r.Path && o.Scope == r.Scope && o.Kind == r.Kind && !o.Expired(s.now()) {
			return o, nil
		}
	}

	id := make([]byte, 6)
	if _, err := rand.Read(id); err != nil {
		return Rule{}, errors.Wrap(err, "unable to create a rule id")
	}

	r.ID = hex.EncodeToString(id)
	r.Created = s.now()

	s.rules = append(s.rules, r)

	if err := s.save(); err != nil {
		s.rules = s.rules[:len(s.rules)-1]

		return Rule{}, err
	}

	return r, nil
}

// Remove deletes a rule and reports whether there was one.
func (s *Store) Remove(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i, r := range s.rules {
		if r.ID != id {
			continue
		}

		old := s.rules
		s.rules = append(append([]Rule{}, old[:i]...), old[i+1:]...)

		if err := s.save(); err != nil {
			s.rules = old

			return false, err
		}

		return true, nil
	}

	return false, nil
}

// Ignored reports whether an active rule hides the error.
func (s *Store) Ignored(source, p, msg string) bool {
	if s == nil {
		return false
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	now := s.now()

	for _, r := range s.rules {
		if r.Matches(source, p, msg, now) {
			return true
		}
	}

	return false
}

// Covered says, for each failure, whether a rule hides it, and how many are hidden. It is the one place that
// decides what counts as ignored, for every view and check that reports failed files.
func (s *Store) Covered(source string, fs []Failure) ([]bool, int) {
	out := make([]bool, len(fs))
	n := 0

	for i, f := range fs {
		if s.Ignored(source, f.Path, f.Error) {
			out[i] = true
			n++
		}
	}

	return out, n
}

// CountIgnored says how many of the failures are hidden.
func (s *Store) CountIgnored(source string, fs []Failure) int {
	_, n := s.Covered(source, fs)

	return n
}
