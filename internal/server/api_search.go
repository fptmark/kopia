package server

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/kopia/kopia/internal/clock"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/snapshot"
)

const maxRetainedSearches = 10

// searchJob is a search running (or finished) in the background, independent of the request that
// started it, so a page can be left and reopened while it runs.
type searchJob struct {
	id       string
	started  time.Time
	searcher *snapshotSearcher
	cancel   context.CancelFunc

	mu       sync.Mutex
	running  bool
	canceled bool
	err      string
}

var (
	searchJobsMu    sync.Mutex
	searchJobs      = map[string]*searchJob{}
	searchJobsOrder []string
)

func (j *searchJob) status() *serverapi.SearchStatus {
	results, truncated := j.searcher.results()

	j.mu.Lock()
	defer j.mu.Unlock()

	return &serverapi.SearchStatus{
		ID:        j.id,
		Running:   j.running,
		Canceled:  j.canceled,
		Error:     j.err,
		Truncated: truncated,
		StartedAt: j.started,
		Progress:  j.searcher.progress(),
		Results:   results,
	}
}

func registerSearchJob(j *searchJob) {
	searchJobsMu.Lock()
	defer searchJobsMu.Unlock()

	searchJobs[j.id] = j
	searchJobsOrder = append(searchJobsOrder, j.id)

	for len(searchJobsOrder) > maxRetainedSearches {
		old := searchJobsOrder[0]
		searchJobsOrder = searchJobsOrder[1:]

		if oj := searchJobs[old]; oj != nil {
			oj.cancel()
		}

		delete(searchJobs, old)
	}
}

func getSearchJob(id string) *searchJob {
	searchJobsMu.Lock()
	defer searchJobsMu.Unlock()

	return searchJobs[id]
}

// handleSearchStart starts a search over snapshots in the background and returns its ID.
func handleSearchStart(ctx context.Context, rc requestContext) (any, *apiError) {
	var req serverapi.SearchRequest

	if err := json.Unmarshal(rc.body, &req); err != nil {
		return nil, requestError(serverapi.ErrorMalformedRequest, "malformed request")
	}

	manifestIDs, err := snapshot.ListSnapshotManifests(ctx, rc.rep, nil, nil)
	if err != nil {
		return nil, internalServerError(err)
	}

	manifests, err := snapshot.LoadSnapshots(ctx, rc.rep, manifestIDs)
	if err != nil {
		return nil, internalServerError(err)
	}

	jobCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))

	searcher, err := newSnapshotSearcher(rc.rep, req, cancel)
	if err != nil {
		cancel()

		return nil, requestError(serverapi.ErrorMalformedRequest, err.Error())
	}

	job := &searchJob{
		id:       uuid.NewString(),
		started:  clock.Now(),
		searcher: searcher,
		cancel:   cancel,
		running:  true,
	}

	registerSearchJob(job)

	selected := selectSnapshots(manifests, req)

	go func() {
		err := searcher.search(jobCtx, selected)

		job.mu.Lock()
		defer job.mu.Unlock()

		job.running = false

		// hitting the result limit cancels the walk on purpose and is reported as truncation, not an error
		if err != nil {
			if _, truncated := searcher.results(); !truncated {
				if jobCtx.Err() != nil {
					job.canceled = true
				} else {
					job.err = err.Error()
				}
			}
		}

		cancel()
	}()

	return &serverapi.SearchStartResponse{ID: job.id}, nil
}

// handleSearchStatus returns progress and the results found so far.
func handleSearchStatus(_ context.Context, rc requestContext) (any, *apiError) {
	job := getSearchJob(rc.muxVar("id"))
	if job == nil {
		return nil, notFoundError("search not found")
	}

	return job.status(), nil
}

// handleSearchCancel stops a running search. Results found so far remain available.
func handleSearchCancel(_ context.Context, rc requestContext) (any, *apiError) {
	job := getSearchJob(rc.muxVar("id"))
	if job == nil {
		return nil, notFoundError("search not found")
	}

	job.cancel()

	return serverapi.Empty{}, nil
}

// handleSearchRange reports the date range of existing snapshots, overall and per source.
func handleSearchRange(ctx context.Context, rc requestContext) (any, *apiError) {
	manifestIDs, err := snapshot.ListSnapshotManifests(ctx, rc.rep, nil, nil)
	if err != nil {
		return nil, internalServerError(err)
	}

	manifests, err := snapshot.LoadSnapshots(ctx, rc.rep, manifestIDs)
	if err != nil {
		return nil, internalServerError(err)
	}

	return snapshotRanges(manifests), nil
}
