package server

import (
	"context"
	"encoding/json"
	"time"

	"github.com/kopia/kopia/internal/clock"
	"github.com/kopia/kopia/internal/ignoreerr"
	"github.com/kopia/kopia/internal/serverapi"
)

// ignoredErrorRule is a rule as shown in the UI, with what it hides now.
type ignoredErrorRule struct {
	ignoreerr.Rule

	Expired bool `json:"expired"`
	// Hides is how many errors of the newest snapshot of each source the rule hides now.
	Hides int `json:"hides"`
}

type ignoredErrorsResponse struct {
	Rules []ignoredErrorRule `json:"rules"`
}

type ignoredErrorRequest struct {
	Source string `json:"source"`
	Path   string `json:"path"`
	Scope  string `json:"scope"`
	Kind   string `json:"kind"`
	// ExpiresDays is how long the rule lasts; 0 is for ever.
	ExpiresDays int `json:"expiresDays"`
}

const maxIgnoreDays = 3650

func ignoredStore(rc requestContext) (*ignoreerr.Store, *apiError) {
	if srv, ok := rc.srv.(*Server); ok && srv.ignored != nil {
		return srv.ignored, nil
	}

	return nil, requestError(serverapi.ErrorNotConnected, "ignored errors are not set up")
}

func handleIgnoredErrorsList(_ context.Context, rc requestContext) (any, *apiError) {
	store, apiErr := ignoredStore(rc)
	if apiErr != nil {
		return nil, apiErr
	}

	now := clock.Now()
	out := ignoredErrorsResponse{Rules: []ignoredErrorRule{}}

	var latest []ignoreerr.Failure

	var sources []string

	if h := rc.srv.getOptions().TaskHistory; h != nil {
		if errs, err := h.LatestSnapshotErrors(); err == nil {
			for _, e := range errs {
				latest = append(latest, ignoreerr.Failure{Path: e.Path, Error: e.Error})
				sources = append(sources, sourcePath(e.Source))
			}
		}
	}

	for _, r := range store.Rules() {
		row := ignoredErrorRule{Rule: r, Expired: r.Expired(now)}

		for i, f := range latest {
			if r.Matches(sources[i], f.Path, f.Error, now) {
				row.Hides++
			}
		}

		out.Rules = append(out.Rules, row)
	}

	return out, nil
}

func handleIgnoredErrorsAdd(_ context.Context, rc requestContext) (any, *apiError) {
	store, apiErr := ignoredStore(rc)
	if apiErr != nil {
		return nil, apiErr
	}

	var req ignoredErrorRequest
	if err := json.Unmarshal(rc.body, &req); err != nil {
		return nil, requestError(serverapi.ErrorMalformedRequest, "malformed request body")
	}

	if req.ExpiresDays < 0 || req.ExpiresDays > maxIgnoreDays {
		return nil, requestError(serverapi.ErrorMalformedRequest, "invalid expiry")
	}

	r := ignoreerr.Rule{Source: req.Source, Path: req.Path, Scope: req.Scope, Kind: req.Kind}

	if req.ExpiresDays > 0 {
		t := clock.Now().Add(time.Duration(req.ExpiresDays) * 24 * time.Hour)
		r.Expires = &t
	}

	added, err := store.Add(r)
	if err != nil {
		return nil, requestError(serverapi.ErrorMalformedRequest, err.Error())
	}

	return added, nil
}

func handleIgnoredErrorsRemove(_ context.Context, rc requestContext) (any, *apiError) {
	store, apiErr := ignoredStore(rc)
	if apiErr != nil {
		return nil, apiErr
	}

	ok, err := store.Remove(rc.muxVar("id"))
	if err != nil {
		return nil, internalServerError(err)
	}

	if !ok {
		return nil, notFoundError("rule not found")
	}

	return &serverapi.Empty{}, nil
}
