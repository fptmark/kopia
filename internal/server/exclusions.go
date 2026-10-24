package server

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pkg/errors"

	"github.com/kopia/kopia/internal/clock"
	"github.com/kopia/kopia/internal/exclusion"
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/policy"
)

// Kopia uses the ignore list of the most specific policy that has one and ignores the lists of the policies
// above it. The exclusion rules are two sets (global, and per source); this file writes them into Kopia's
// policies so that what Kopia does is what the sets say:
//
//   - the global policy's list is the global set;
//   - a source whose own set is empty has no list of its own, so it follows the global one;
//   - a source with its own rules gets a list of the global set plus its own;
//   - if a policy in between still hides the result, the source gets the full list.

func exclusionsFile(prefsFile string) string {
	if prefsFile == "" {
		return ""
	}

	return filepath.Join(filepath.Dir(prefsFile), "exclusion-rules.json")
}

// setupExclusions opens the exclusion rules. Without them the server runs as before: the rules pages report
// that they are not set up, and policies are not touched.
func (s *Server) setupExclusions(ctx context.Context) {
	file := exclusionsFile(s.options.UIPreferencesFile)
	if file == "" {
		return
	}

	store, err := exclusion.Open(file, clock.Now)
	if err != nil {
		userLog(ctx).Errorf("unable to read the exclusion rules, policies are left as they are: %v", err)

		return
	}

	s.exclusions = store
}

// exclusionTarget names a policy in the reports: "global" or the source folder.
func exclusionTarget(si snapshot.SourceInfo) string {
	if si == policy.GlobalPolicySourceInfo {
		return "global"
	}

	return si.Path
}

// localSources lists the snapshot sources of this host and user that are known to the server or have a policy.
func (s *Server) exclusionSources(ctx context.Context, rep repo.Repository) ([]snapshot.SourceInfo, error) {
	opts := rep.ClientOptions()
	seen := map[snapshot.SourceInfo]bool{}

	add := func(si snapshot.SourceInfo) {
		if si.Path != "" && si.Host == opts.Hostname && si.UserName == opts.Username {
			seen[si] = true
		}
	}

	for si := range s.snapshotAllSourceManagers() {
		add(si)
	}

	pols, err := policy.ListPolicies(ctx, rep)
	if err != nil {
		return nil, errors.Wrap(err, "unable to list policies")
	}

	for _, p := range pols {
		add(p.Target())
	}

	out := make([]snapshot.SourceInfo, 0, len(seen))
	for si := range seen {
		out = append(out, si)
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })

	return out, nil
}

// definedIgnore returns the ignore list set on one policy itself (nil when it has none or no policy).
func definedIgnore(ctx context.Context, rep repo.Repository, si snapshot.SourceInfo) ([]string, error) {
	p, err := policy.GetDefinedPolicy(ctx, rep, si)
	if errors.Is(err, policy.ErrPolicyNotFound) {
		return nil, nil
	}

	if err != nil {
		return nil, errors.Wrap(err, "unable to read policy")
	}

	return p.FilesPolicy.IgnoreRules, nil
}

// effectiveIgnore returns the ignore list Kopia uses for a source.
func effectiveIgnore(ctx context.Context, rep repo.Repository, si snapshot.SourceInfo) ([]string, error) {
	p, _, _, err := policy.GetEffectivePolicy(ctx, rep, si)
	if err != nil {
		return nil, errors.Wrap(err, "unable to read the effective policy")
	}

	return p.FilesPolicy.IgnoreRules, nil
}

// setDefinedIgnore sets the ignore list of one policy, leaving everything else in it as it is.
func setDefinedIgnore(ctx context.Context, rep repo.Repository, si snapshot.SourceInfo, patterns []string) error {
	return errors.Wrap(repo.WriteSession(ctx, rep, repo.WriteSessionOptions{Purpose: "ExclusionRules"}, func(ctx context.Context, w repo.RepositoryWriter) error {
		pol, err := policy.GetDefinedPolicy(ctx, w, si)

		switch {
		case errors.Is(err, policy.ErrPolicyNotFound):
			if len(patterns) == 0 {
				return nil
			}

			pol = &policy.Policy{}
		case err != nil:
			return errors.Wrap(err, "unable to read policy")
		}

		if len(patterns) == 0 {
			pol.FilesPolicy.IgnoreRules = nil
		} else {
			pol.FilesPolicy.IgnoreRules = exclusion.Unique(patterns)
		}

		return errors.Wrap(policy.SetPolicy(ctx, w, si, pol), "unable to save policy")
	}), "unable to change the policy of "+exclusionTarget(si))
}

// ensureExclusionsImported sets the rules up from the ignore lists the policies have now, once.
func (s *Server) ensureExclusionsImported(ctx context.Context, rep repo.Repository) error {
	store := s.exclusions
	if store == nil || store.Imported() {
		return nil
	}

	global, err := definedIgnore(ctx, rep, policy.GlobalPolicySourceInfo)
	if err != nil {
		return err
	}

	sources, err := s.exclusionSources(ctx, rep)
	if err != nil {
		return err
	}

	bySource := map[string][]string{}

	for _, si := range sources {
		ps, err := definedIgnore(ctx, rep, si)
		if err != nil {
			return err
		}

		if len(ps) > 0 {
			bySource[si.Path] = ps
		}
	}

	_, err = store.Import(global, bySource)

	return errors.Wrap(err, "unable to import the existing ignore rules")
}

// exclusionChange is what was written to one policy.
type exclusionChange struct {
	Target string   `json:"target"`
	Before []string `json:"before"`
	After  []string `json:"after"`
}

// applyExclusions writes the rules into the policies of the given sources, and into the global policy when
// includeGlobal is set. A policy is only written when its list differs.
func (s *Server) applyExclusions(ctx context.Context, rep repo.Repository, sources []snapshot.SourceInfo, includeGlobal bool) ([]exclusionChange, error) {
	store := s.exclusions
	changes := []exclusionChange{}

	write := func(si snapshot.SourceInfo, want []string) error {
		have, err := definedIgnore(ctx, rep, si)
		if err != nil {
			return err
		}

		if exclusion.SameSet(have, want) {
			return nil
		}

		if err := setDefinedIgnore(ctx, rep, si, want); err != nil {
			return err
		}

		changes = append(changes, exclusionChange{Target: exclusionTarget(si), Before: exclusion.Unique(have), After: exclusion.Unique(want)})

		return nil
	}

	if includeGlobal {
		if err := write(policy.GlobalPolicySourceInfo, store.GlobalPatterns()); err != nil {
			return changes, err
		}
	}

	for _, si := range sources {
		net := store.NetPatterns(si.Path)

		var want []string
		if len(store.SourcePatterns(si.Path)) > 0 {
			want = net
		}

		if err := write(si, want); err != nil {
			return changes, err
		}

		// a policy between this one and the global one can still hide the list: then the source says it all
		if want == nil {
			eff, err := effectiveIgnore(ctx, rep, si)
			if err != nil {
				return changes, err
			}

			if !exclusion.SameSet(eff, net) {
				if err := write(si, net); err != nil {
					return changes, err
				}
			}
		}
	}

	// from now on a policy that differs from the rules is a problem worth an alert
	if err := store.MarkReconciled(); err != nil {
		return changes, errors.Wrap(err, "unable to record that the rules were applied")
	}

	return changes, nil
}

// exclusionDrift says where what Kopia will do differs from the rules.
type exclusionDrift struct {
	Target   string   `json:"target"`
	Expected []string `json:"expected"`
	Actual   []string `json:"actual"`
	Missing  []string `json:"missing"`
	Extra    []string `json:"extra"`
}

// exclusionDriftReport compares, for the global policy and every source, the list Kopia uses with the rules.
func (s *Server) exclusionDriftReport(ctx context.Context, rep repo.Repository) ([]exclusionDrift, error) {
	store := s.exclusions
	out := []exclusionDrift{}

	check := func(si snapshot.SourceInfo, expected, actual []string) {
		if exclusion.SameSet(expected, actual) {
			return
		}

		out = append(out, exclusionDrift{
			Target:   exclusionTarget(si),
			Expected: exclusion.Unique(expected),
			Actual:   exclusion.Unique(actual),
			Missing:  exclusion.Difference(expected, actual),
			Extra:    exclusion.Difference(actual, expected),
		})
	}

	global, err := definedIgnore(ctx, rep, policy.GlobalPolicySourceInfo)
	if err != nil {
		return nil, err
	}

	check(policy.GlobalPolicySourceInfo, store.GlobalPatterns(), global)

	sources, err := s.exclusionSources(ctx, rep)
	if err != nil {
		return nil, err
	}

	for _, si := range sources {
		eff, err := effectiveIgnore(ctx, rep, si)
		if err != nil {
			return nil, err
		}

		check(si, store.NetPatterns(si.Path), eff)
	}

	return out, nil
}

// exclusionDriftSummary describes drift in a sentence for the health check.
func exclusionDriftSummary(d []exclusionDrift) string {
	parts := make([]string, 0, len(d))

	for _, x := range d {
		parts = append(parts, fmt.Sprintf("%s: %d missing, %d extra", x.Target, len(x.Missing), len(x.Extra)))
	}

	return strings.Join(parts, "; ")
}

// exclusionCheck is the health check that Kopia's policies still say what the rules say. It reports nothing
// (ok is false) when the rules are not set up or not imported yet, since there is nothing to compare with, and
// it only fails once the rules have been applied: before that the policies are expected to differ.
func (s *Server) exclusionCheck(ctx context.Context, rep repo.Repository) (verifyCheck, bool) {
	if s.exclusions == nil || !s.exclusions.Imported() {
		return verifyCheck{}, false
	}

	drift, err := s.exclusionDriftReport(ctx, rep)
	if err != nil {
		return failed(checkExclusions, "unable to compare: "+err.Error()), true
	}

	if len(drift) == 0 {
		return passed(checkExclusions, fmt.Sprintf("%d rules, all in force", len(s.exclusions.Rules()))), true
	}

	// the rules have never been applied: the difference is expected and is shown on the Exclusions page
	if !s.exclusions.Reconciled() {
		return passed(checkExclusions, "not applied to the policies yet: "+exclusionDriftSummary(drift)+" (Exclusions page, Fix)"), true
	}

	return failed(checkExclusions, exclusionDriftSummary(drift)+" (Exclusions page, Fix)"), true
}
