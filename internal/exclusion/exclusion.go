// Package exclusion keeps the rules for what is left out of backups, as two sets: global rules, which apply
// to every snapshot source, and source rules, which apply to one. The net rules of a source are both sets
// together. The rules are written into Kopia's policies (see the server's exclusions code); this package
// only holds them, in a JSON file next to the other settings, and says what a pattern matches.
package exclusion

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pkg/errors"

	"github.com/kopia/kopia/internal/atomicfile"
)

// Where a rule came from.
const (
	AddedManual  = "manual"  // typed on the Exclusions page
	AddedCompare = "compare" // from the snapshot compare page
	AddedFailed  = "failed"  // from the failed-files dialog
	AddedImport  = "import"  // read from the policies when the rules were first set up
)

// Rule is one pattern, in the gitignore syntax Kopia uses. Source is the folder of the snapshot source it
// belongs to; empty means every source. AddedAt is nil for rules whose date is not known (imported ones).
type Rule struct {
	ID      string     `json:"id"`
	Source  string     `json:"source"`
	Pattern string     `json:"pattern"`
	AddedAt *time.Time `json:"addedAt,omitempty"`
	AddedBy string     `json:"addedBy"`
	Note    string     `json:"note,omitempty"`
}

// RemovedRule is a rule that was taken away, kept so that the history can be seen.
type RemovedRule struct {
	Rule

	RemovedAt time.Time `json:"removedAt"`
}

// Global reports whether the rule applies to every source.
func (r Rule) Global() bool { return r.Source == "" }

type fileContent struct {
	Version    int           `json:"version"`
	ImportedAt *time.Time    `json:"importedAt,omitempty"`
	// ReconciledAt is when the rules were last written into the policies. Until then the policies are
	// expected to differ from the rules (nothing has been applied), which is not a problem to alert about.
	ReconciledAt *time.Time `json:"reconciledAt,omitempty"`
	Rules      []Rule        `json:"rules"`
	Removed    []RemovedRule `json:"removed,omitempty"`
}

// Store keeps the rules in a file.
type Store struct {
	file string
	now  func() time.Time

	mu       sync.RWMutex
	content  fileContent
	existing bool
}

// Open reads the rules in the file; a missing file means no rules and Imported reports false.
func Open(file string, now func() time.Time) (*Store, error) {
	s := &Store{file: file, now: now, content: fileContent{Version: 1}}

	b, err := os.ReadFile(file) //nolint:gosec
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}

	if err != nil {
		return nil, errors.Wrap(err, "unable to read the exclusion rules")
	}

	if err := json.Unmarshal(b, &s.content); err != nil {
		return nil, errors.Wrap(err, "unable to parse the exclusion rules")
	}

	s.existing = true

	return s, nil
}

func (s *Store) save() error {
	s.content.Version = 1

	b, err := json.MarshalIndent(s.content, "", "  ")
	if err != nil {
		return errors.Wrap(err, "unable to encode the exclusion rules")
	}

	s.existing = true

	return errors.Wrap(atomicfile.Write(s.file, bytes.NewReader(append(b, '\n'))), "unable to write the exclusion rules")
}

// Imported reports whether the rules have been set up from the existing policies.
func (s *Store) Imported() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return s.content.ImportedAt != nil
}

// Reconciled reports whether the rules have ever been written into the policies.
func (s *Store) Reconciled() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return s.content.ReconciledAt != nil
}

// MarkReconciled records that the rules were written into the policies now.
func (s *Store) MarkReconciled() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	old := s.content.ReconciledAt
	s.content.ReconciledAt = &now

	if err := s.save(); err != nil {
		s.content.ReconciledAt = old

		return err
	}

	return nil
}

// ValidatePattern checks a pattern and returns it trimmed.
func ValidatePattern(p string) (string, error) {
	p = strings.TrimSpace(p)

	switch {
	case p == "":
		return "", errors.New("the pattern is empty")
	case strings.ContainsAny(p, "\r\n"):
		return "", errors.New("a pattern is one line")
	case strings.HasPrefix(p, "#"):
		return "", errors.New("a pattern cannot start with # (that is a comment); write \\# to match a file that does")
	case strings.HasPrefix(p, "!"):
		return "", errors.New("a pattern cannot start with ! (negation is not supported)")
	}

	return p, nil
}

// NormalizeSource trims a source folder.
func NormalizeSource(src string) string {
	src = strings.TrimSpace(src)
	if len(src) > 1 {
		src = strings.TrimRight(src, "/")
	}

	return src
}

// Rules returns every rule, global ones first, then by source, then by pattern.
func (s *Store) Rules() []Rule {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := append([]Rule{}, s.content.Rules...)
	sortRules(out)

	return out
}

// Removed returns the rules that were taken away, newest first.
func (s *Store) Removed() []RemovedRule {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := append([]RemovedRule{}, s.content.Removed...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].RemovedAt.After(out[j].RemovedAt) })

	return out
}

func sortRules(rs []Rule) {
	sort.SliceStable(rs, func(i, j int) bool {
		if rs[i].Global() != rs[j].Global() {
			return rs[i].Global()
		}

		if rs[i].Source != rs[j].Source {
			return rs[i].Source < rs[j].Source
		}

		return rs[i].Pattern < rs[j].Pattern
	})
}

func newID() (string, error) {
	id := make([]byte, 6)
	if _, err := rand.Read(id); err != nil {
		return "", errors.Wrap(err, "unable to create a rule id")
	}

	return hex.EncodeToString(id), nil
}

// Add stores a rule. Adding a pattern a source or the global set already has returns the existing rule.
func (s *Store) Add(r Rule) (Rule, bool, error) {
	p, err := ValidatePattern(r.Pattern)
	if err != nil {
		return Rule{}, false, err
	}

	r.Pattern = p
	r.Source = NormalizeSource(r.Source)

	s.mu.Lock()
	defer s.mu.Unlock()

	for _, o := range s.content.Rules {
		if o.Source == r.Source && o.Pattern == r.Pattern {
			return o, false, nil
		}
	}

	if r.ID, err = newID(); err != nil {
		return Rule{}, false, err
	}

	if r.AddedBy == "" {
		r.AddedBy = AddedManual
	}

	if r.AddedBy != AddedImport {
		now := s.now()
		r.AddedAt = &now
	}

	s.content.Rules = append(s.content.Rules, r)

	if err := s.save(); err != nil {
		s.content.Rules = s.content.Rules[:len(s.content.Rules)-1]

		return Rule{}, false, err
	}

	return r, true, nil
}

// Remove takes a rule away, keeping a record of it, and returns it.
func (s *Store) Remove(id string) (Rule, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i, r := range s.content.Rules {
		if r.ID != id {
			continue
		}

		oldRules, oldRemoved := s.content.Rules, s.content.Removed

		s.content.Rules = append(append([]Rule{}, oldRules[:i]...), oldRules[i+1:]...)
		s.content.Removed = append(append([]RemovedRule{}, oldRemoved...), RemovedRule{Rule: r, RemovedAt: s.now()})

		if err := s.save(); err != nil {
			s.content.Rules, s.content.Removed = oldRules, oldRemoved

			return Rule{}, false, err
		}

		return r, true, nil
	}

	return Rule{}, false, nil
}

// Import sets up the rules from patterns that already exist in policies: global patterns, and per source.
// It only does anything once; the date of these rules is unknown.
func (s *Store) Import(global []string, bySource map[string][]string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.content.ImportedAt != nil {
		return 0, nil
	}

	have := map[string]bool{}
	for _, r := range s.content.Rules {
		have[r.Source+"\x00"+r.Pattern] = true
	}

	oldRules := s.content.Rules
	added := 0

	add := func(source, pattern string) error {
		p, err := ValidatePattern(pattern)
		if err != nil || have[source+"\x00"+p] {
			return nil //nolint:nilerr // a pattern that cannot be a rule is left in the policy, where it is
		}

		id, err := newID()
		if err != nil {
			return err
		}

		have[source+"\x00"+p] = true
		added++
		s.content.Rules = append(s.content.Rules, Rule{ID: id, Source: source, Pattern: p, AddedBy: AddedImport})

		return nil
	}

	for _, p := range global {
		if err := add("", p); err != nil {
			s.content.Rules = oldRules
			return 0, err
		}
	}

	globalSet := toSet(global)

	for src, ps := range bySource {
		for _, p := range ps {
			// a source pattern the global set already has is the same rule
			if globalSet[p] {
				continue
			}

			if err := add(NormalizeSource(src), p); err != nil {
				s.content.Rules = oldRules
				return 0, err
			}
		}
	}

	now := s.now()
	s.content.ImportedAt = &now

	if err := s.save(); err != nil {
		s.content.Rules, s.content.ImportedAt = oldRules, nil

		return 0, err
	}

	return added, nil
}

func toSet(ps []string) map[string]bool {
	m := make(map[string]bool, len(ps))
	for _, p := range ps {
		m[p] = true
	}

	return m
}

// GlobalPatterns returns the global patterns, sorted.
func (s *Store) GlobalPatterns() []string {
	return s.patterns(func(r Rule) bool { return r.Global() })
}

// SourcePatterns returns the patterns that belong to one source only, sorted.
func (s *Store) SourcePatterns(source string) []string {
	source = NormalizeSource(source)

	return s.patterns(func(r Rule) bool { return !r.Global() && r.Source == source })
}

func (s *Store) patterns(keep func(Rule) bool) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var out []string

	for _, r := range s.content.Rules {
		if keep(r) {
			out = append(out, r.Pattern)
		}
	}

	return Unique(out)
}

// NetRule is a pattern that applies to a source, and where it comes from.
type NetRule struct {
	Pattern string `json:"pattern"`
	// From is "global", "source", or "both" when the same pattern is in both sets.
	From    string     `json:"from"`
	RuleIDs []string   `json:"ruleIds"`
	AddedAt *time.Time `json:"addedAt,omitempty"`
	AddedBy string     `json:"addedBy"`
}

// Net returns the rules that apply to a source: the global rules and the source's own, one row per pattern.
func (s *Store) Net(source string) []NetRule {
	source = NormalizeSource(source)

	s.mu.RLock()
	defer s.mu.RUnlock()

	byPattern := map[string]*NetRule{}

	for _, r := range s.content.Rules {
		if !r.Global() && r.Source != source {
			continue
		}

		from := "source"
		if r.Global() {
			from = "global"
		}

		n := byPattern[r.Pattern]
		if n == nil {
			n = &NetRule{Pattern: r.Pattern, From: from, AddedAt: r.AddedAt, AddedBy: r.AddedBy}
			byPattern[r.Pattern] = n
		} else if n.From != from {
			n.From = "both"
		}

		n.RuleIDs = append(n.RuleIDs, r.ID)
	}

	out := make([]NetRule, 0, len(byPattern))
	for _, n := range byPattern {
		out = append(out, *n)
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Pattern < out[j].Pattern })

	return out
}

// NetPatterns returns the patterns that apply to a source, sorted.
func (s *Store) NetPatterns(source string) []string {
	var out []string
	for _, n := range s.Net(source) {
		out = append(out, n.Pattern)
	}

	return out
}

// Unique returns the patterns once each, sorted.
func Unique(ps []string) []string {
	seen := map[string]bool{}
	out := []string{}

	for _, p := range ps {
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}

	sort.Strings(out)

	return out
}

// SameSet reports whether two lists hold the same patterns, ignoring order and repeats.
func SameSet(a, b []string) bool {
	x, y := Unique(a), Unique(b)
	if len(x) != len(y) {
		return false
	}

	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}

	return true
}

// Difference returns what is in a and not in b, sorted.
func Difference(a, b []string) []string {
	in := toSet(b)
	out := []string{}

	for _, p := range Unique(a) {
		if !in[p] {
			out = append(out, p)
		}
	}

	return out
}
