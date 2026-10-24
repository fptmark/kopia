package server

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/pkg/errors"

	"github.com/kopia/kopia/fs"
	"github.com/kopia/kopia/internal/exclusion"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/snapshot"
)

const (
	maxExclusionRulesPerRequest = 500
	exclusionPreviewTimeout     = 90 * time.Second
	exclusionPreviewTop         = 10
)

func exclusionServer(rc requestContext) (*Server, *apiError) {
	if srv, ok := rc.srv.(*Server); ok && srv.exclusions != nil {
		return srv, nil
	}

	return nil, requestError(serverapi.ErrorNotConnected, "exclusion rules are not set up")
}

type exclusionSourceRow struct {
	Path     string `json:"path"`
	Host     string `json:"host"`
	UserName string `json:"userName"`
	Own      int    `json:"ownRules"`
	Net      int    `json:"netRules"`
	InSync   bool   `json:"inSync"`
}

type exclusionsResponse struct {
	Rules    []exclusion.Rule        `json:"rules"`
	Removed  []exclusion.RemovedRule `json:"removed"`
	Sources  []exclusionSourceRow    `json:"sources"`
	Drift    []exclusionDrift        `json:"drift"`
	Imported bool                    `json:"imported"`
}

func handleExclusionsList(ctx context.Context, rc requestContext) (any, *apiError) {
	srv, apiErr := exclusionServer(rc)
	if apiErr != nil {
		return nil, apiErr
	}

	if err := srv.ensureExclusionsImported(ctx, rc.rep); err != nil {
		return nil, internalServerError(err)
	}

	sources, err := srv.exclusionSources(ctx, rc.rep)
	if err != nil {
		return nil, internalServerError(err)
	}

	drift, err := srv.exclusionDriftReport(ctx, rc.rep)
	if err != nil {
		return nil, internalServerError(err)
	}

	bad := map[string]bool{}
	for _, d := range drift {
		bad[d.Target] = true
	}

	store := srv.exclusions

	out := &exclusionsResponse{
		Rules:    store.Rules(),
		Removed:  store.Removed(),
		Sources:  []exclusionSourceRow{},
		Drift:    drift,
		Imported: store.Imported(),
	}

	for _, si := range sources {
		out.Sources = append(out.Sources, exclusionSourceRow{
			Path:     si.Path,
			Host:     si.Host,
			UserName: si.UserName,
			Own:      len(store.SourcePatterns(si.Path)),
			Net:      len(store.NetPatterns(si.Path)),
			InSync:   !bad[si.Path],
		})
	}

	return out, nil
}

type exclusionRuleRequest struct {
	Source  string `json:"source"`
	Pattern string `json:"pattern"`
	Note    string `json:"note"`
}

type exclusionAddRequest struct {
	Rules   []exclusionRuleRequest `json:"rules"`
	AddedBy string                 `json:"addedBy"`
}

type exclusionAddResponse struct {
	Added     []exclusion.Rule  `json:"added"`
	Existing  []exclusion.Rule  `json:"existing"`
	Changes   []exclusionChange `json:"changes"`
	ApplyFail string            `json:"applyError,omitempty"`
}

// sourcesAffectedBy returns the sources a change to these rules touches, and whether the global policy is.
func (s *Server) sourcesAffectedBy(ctx context.Context, rep repo.Repository, rules []exclusion.Rule) (srcs []snapshot.SourceInfo, global bool, _ error) {
	all, err := s.exclusionSources(ctx, rep)
	if err != nil {
		return nil, false, err
	}

	paths := map[string]bool{}

	for _, r := range rules {
		if r.Global() {
			global = true
		} else {
			paths[r.Source] = true
		}
	}

	for _, si := range all {
		if global || paths[si.Path] {
			srcs = append(srcs, si)
		}
	}

	return srcs, global, nil
}

func handleExclusionsAdd(ctx context.Context, rc requestContext) (any, *apiError) {
	srv, apiErr := exclusionServer(rc)
	if apiErr != nil {
		return nil, apiErr
	}

	var req exclusionAddRequest
	if err := json.Unmarshal(rc.body, &req); err != nil {
		return nil, requestError(serverapi.ErrorMalformedRequest, "malformed request body")
	}

	if len(req.Rules) == 0 || len(req.Rules) > maxExclusionRulesPerRequest {
		return nil, requestError(serverapi.ErrorMalformedRequest, "send between 1 and 500 rules")
	}

	switch req.AddedBy {
	case "", exclusion.AddedManual, exclusion.AddedCompare, exclusion.AddedFailed:
	default:
		return nil, requestError(serverapi.ErrorMalformedRequest, "unknown addedBy")
	}

	// check every pattern before adding any
	for _, r := range req.Rules {
		if _, err := exclusion.NewMatcher(r.Pattern); err != nil {
			return nil, requestError(serverapi.ErrorMalformedRequest, r.Pattern+": "+err.Error())
		}
	}

	if err := srv.ensureExclusionsImported(ctx, rc.rep); err != nil {
		return nil, internalServerError(err)
	}

	out := &exclusionAddResponse{Added: []exclusion.Rule{}, Existing: []exclusion.Rule{}, Changes: []exclusionChange{}}

	var touched []exclusion.Rule

	for _, r := range req.Rules {
		rule, created, err := srv.exclusions.Add(exclusion.Rule{Source: r.Source, Pattern: r.Pattern, Note: r.Note, AddedBy: req.AddedBy})
		if err != nil {
			return nil, requestError(serverapi.ErrorMalformedRequest, err.Error())
		}

		if created {
			out.Added = append(out.Added, rule)
			touched = append(touched, rule)
		} else {
			out.Existing = append(out.Existing, rule)
		}
	}

	if len(touched) == 0 {
		return out, nil
	}

	srcs, global, err := srv.sourcesAffectedBy(ctx, rc.rep, touched)
	if err != nil {
		return nil, internalServerError(err)
	}

	changes, err := srv.applyExclusions(ctx, rc.rep, srcs, global)
	out.Changes = changes

	if err != nil {
		// the rules are saved; the drift check shows that Kopia does not follow them yet
		out.ApplyFail = err.Error()
	}

	return out, nil
}

type exclusionRemoveResponse struct {
	Removed   exclusion.Rule    `json:"removed"`
	Changes   []exclusionChange `json:"changes"`
	ApplyFail string            `json:"applyError,omitempty"`
}

func handleExclusionsRemove(ctx context.Context, rc requestContext) (any, *apiError) {
	srv, apiErr := exclusionServer(rc)
	if apiErr != nil {
		return nil, apiErr
	}

	rule, ok, err := srv.exclusions.Remove(rc.muxVar("id"))
	if err != nil {
		return nil, internalServerError(err)
	}

	if !ok {
		return nil, notFoundError("rule not found")
	}

	out := &exclusionRemoveResponse{Removed: rule, Changes: []exclusionChange{}}

	srcs, global, err := srv.sourcesAffectedBy(ctx, rc.rep, []exclusion.Rule{rule})
	if err != nil {
		return nil, internalServerError(err)
	}

	changes, err := srv.applyExclusions(ctx, rc.rep, srcs, global)
	out.Changes = changes

	if err != nil {
		out.ApplyFail = err.Error()
	}

	return out, nil
}

type exclusionNetResponse struct {
	Source    string              `json:"source"`
	Rules     []exclusion.NetRule `json:"rules"`
	Effective []string            `json:"effective"`
	Missing   []string            `json:"missing"`
	Extra     []string            `json:"extra"`
	InSync    bool                `json:"inSync"`
}

func handleExclusionsNet(ctx context.Context, rc requestContext) (any, *apiError) {
	srv, apiErr := exclusionServer(rc)
	if apiErr != nil {
		return nil, apiErr
	}

	src := exclusion.NormalizeSource(rc.queryParam("source"))
	if src == "" {
		return nil, requestError(serverapi.ErrorMalformedRequest, "source is required")
	}

	opts := rc.rep.ClientOptions()
	si := snapshot.SourceInfo{Host: opts.Hostname, UserName: opts.Username, Path: src}

	eff, err := effectiveIgnore(ctx, rc.rep, si)
	if err != nil {
		return nil, internalServerError(err)
	}

	net := srv.exclusions.NetPatterns(src)

	return &exclusionNetResponse{
		Source:    src,
		Rules:     srv.exclusions.Net(src),
		Effective: exclusion.Unique(eff),
		Missing:   exclusion.Difference(net, eff),
		Extra:     exclusion.Difference(eff, net),
		InSync:    exclusion.SameSet(net, eff),
	}, nil
}

type exclusionReconcileRequest struct {
	// Sources limits the sources; empty means all, and the global policy.
	Sources []string `json:"sources"`
}

func handleExclusionsReconcile(ctx context.Context, rc requestContext) (any, *apiError) {
	srv, apiErr := exclusionServer(rc)
	if apiErr != nil {
		return nil, apiErr
	}

	var req exclusionReconcileRequest
	if len(rc.body) > 0 {
		if err := json.Unmarshal(rc.body, &req); err != nil {
			return nil, requestError(serverapi.ErrorMalformedRequest, "malformed request body")
		}
	}

	all, err := srv.exclusionSources(ctx, rc.rep)
	if err != nil {
		return nil, internalServerError(err)
	}

	srcs := all

	if len(req.Sources) > 0 {
		want := map[string]bool{}
		for _, p := range req.Sources {
			want[exclusion.NormalizeSource(p)] = true
		}

		srcs = nil

		for _, si := range all {
			if want[si.Path] {
				srcs = append(srcs, si)
			}
		}
	}

	changes, err := srv.applyExclusions(ctx, rc.rep, srcs, len(req.Sources) == 0)
	if err != nil {
		return nil, internalServerError(err)
	}

	return map[string]any{"changes": changes}, nil
}

type exclusionPreviewRequest struct {
	Source   string   `json:"source"`
	Patterns []string `json:"patterns"`
}

type exclusionMatch struct {
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
	Files int64  `json:"files"`
}

type exclusionPreviewResult struct {
	Pattern string           `json:"pattern"`
	Error   string           `json:"error,omitempty"`
	Matches int              `json:"matches"`
	Files   int64            `json:"files"`
	Bytes   int64            `json:"bytes"`
	Top     []exclusionMatch `json:"top"`
}

type exclusionPreviewResponse struct {
	Snapshot *serverapi.Snapshot      `json:"snapshot"`
	Results  []exclusionPreviewResult `json:"results"`
	// Partial is set when the walk was stopped by the time limit; the counts are then lower bounds.
	Partial bool `json:"partial"`
}

// handleExclusionsPreview says what patterns would leave out of the newest snapshot of a source.
func handleExclusionsPreview(ctx context.Context, rc requestContext) (any, *apiError) {
	var req exclusionPreviewRequest
	if err := json.Unmarshal(rc.body, &req); err != nil {
		return nil, requestError(serverapi.ErrorMalformedRequest, "malformed request body")
	}

	src := exclusion.NormalizeSource(req.Source)
	if src == "" || len(req.Patterns) == 0 || len(req.Patterns) > maxExclusionRulesPerRequest {
		return nil, requestError(serverapi.ErrorMalformedRequest, "a source and between 1 and 500 patterns are required")
	}

	opts := rc.rep.ClientOptions()
	si := snapshot.SourceInfo{Host: opts.Hostname, UserName: opts.Username, Path: src}

	ids, err := snapshot.ListSnapshotManifests(ctx, rc.rep, &si, nil)
	if err != nil {
		return nil, internalServerError(err)
	}

	manifests, err := snapshot.LoadSnapshots(ctx, rc.rep, ids)
	if err != nil {
		return nil, internalServerError(err)
	}

	manifests = snapshot.SortByTime(manifests, true)

	var newest *snapshot.Manifest

	for _, m := range manifests {
		if m.IncompleteReason == "" && m.RootEntry != nil {
			newest = m

			break
		}
	}

	if newest == nil {
		return nil, requestError(serverapi.ErrorNotFound, "this source has no snapshot to look at")
	}

	root, err := snapshotRootDir(rc.rep, newest)
	if err != nil {
		return nil, internalServerError(err)
	}

	results := make([]exclusionPreviewResult, len(req.Patterns))
	matchers := make([]*exclusion.Matcher, len(req.Patterns))

	for i, p := range req.Patterns {
		results[i] = exclusionPreviewResult{Pattern: p, Top: []exclusionMatch{}}

		m, err := exclusion.NewMatcher(p)
		if err != nil {
			results[i].Error = err.Error()

			continue
		}

		matchers[i] = m
	}

	walkCtx, cancel := context.WithTimeout(ctx, exclusionPreviewTimeout)
	defer cancel()

	w := &previewWalker{matchers: matchers, results: results}
	walkErr := w.walk(walkCtx, root, "")

	for i := range results {
		sort.SliceStable(results[i].Top, func(a, b int) bool { return results[i].Top[a].Size > results[i].Top[b].Size })

		if len(results[i].Top) > exclusionPreviewTop {
			results[i].Top = results[i].Top[:exclusionPreviewTop]
		}
	}

	partial := false

	if walkErr != nil {
		if !errors.Is(walkErr, context.DeadlineExceeded) {
			return nil, internalServerError(walkErr)
		}

		partial = true
	}

	return &exclusionPreviewResponse{Snapshot: convertSnapshotManifest(newest), Results: results, Partial: partial}, nil
}

type previewWalker struct {
	matchers []*exclusion.Matcher
	results  []exclusionPreviewResult
}

// walk visits a directory the way a snapshot would: an entry that any pattern leaves out is counted and not
// entered.
func (w *previewWalker) walk(ctx context.Context, dir fs.Directory, rel string) error {
	if err := ctx.Err(); err != nil {
		return errors.Wrap(err, "stopped")
	}

	entries, err := fs.GetAllEntries(ctx, dir)
	if err != nil {
		return errors.Wrapf(err, "unable to read %q", rel)
	}

	for _, e := range entries {
		p := e.Name()
		if rel != "" {
			p = rel + "/" + e.Name()
		}

		matched := false

		for i, m := range w.matchers {
			if m == nil || !m.Match(p, e.IsDir()) {
				continue
			}

			matched = true
			size, files := totals(ctx, e)
			r := &w.results[i]
			r.Matches++
			r.Files += files
			r.Bytes += size
			r.Top = append(r.Top, exclusionMatch{Path: p, IsDir: e.IsDir(), Size: size, Files: dirFiles(e, files)})

			// keep the list short while walking: only the biggest ones are ever shown
			if len(r.Top) > 4*exclusionPreviewTop {
				sort.SliceStable(r.Top, func(a, b int) bool { return r.Top[a].Size > r.Top[b].Size })
				r.Top = r.Top[:exclusionPreviewTop]
			}
		}

		if matched {
			continue
		}

		if d, ok := e.(fs.Directory); ok {
			if err := w.walk(ctx, d, p); err != nil {
				return err
			}
		}
	}

	return nil
}
