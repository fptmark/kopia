package server

import (
	"context"
	"sort"
	"strconv"
	"time"

	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/snapshot/policy"
)

const defaultUpcomingTasksLimit = 10

// handleTasksUpcoming reports the next scheduled snapshots and verifies across every source, soonest first.
func handleTasksUpcoming(ctx context.Context, rc requestContext) (any, *apiError) {
	limit := defaultUpcomingTasksLimit

	if s := rc.queryParam("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n <= 0 {
			return nil, requestError(serverapi.ErrorMalformedRequest, "invalid limit")
		}

		limit = n
	}

	out := []serverapi.UpcomingTask{}

	for src, sm := range rc.srv.snapshotAllSourceManagers() {
		policies, err := policy.GetPolicyHierarchy(ctx, rc.rep, src, nil)
		if err != nil {
			continue
		}

		eff, _ := policy.MergePolicies(policies, src)

		// appendTask appends one entry for src/kind and returns the time to project the next one from -- the
		// one piece of bookkeeping both the live first entry and the projected later ones share.
		appendTask := func(kind string, t time.Time) time.Time {
			out = append(out, serverapi.UpcomingTask{Time: t, Kind: kind, Source: src})
			return t.Add(time.Second)
		}

		// The first entry is the one thing actually about to happen: it comes from the source manager's own
		// real, live target, which already reflects its actual last completion, any sleep/wake deferral,
		// and the suppression a too-soon automatic trigger gets -- not a recompute from a blind "now",
		// which can't know a slot is overdue-but-deferred and so silently projects straight past it. Only
		// this one entry can be made honest this way: the source manager tracks just the one next target,
		// not a run of future ones, so everything after it necessarily falls back to projecting the policy
		// forward in time, same as before.
		if st, ok := sm.getNextSnapshotTime(); ok {
			now := appendTask("Snapshot", st)

			for range limit - 1 {
				st, ok := eff.SchedulingPolicy.NextSnapshotTime(now, now)
				if !ok {
					break
				}

				now = appendTask("Snapshot", st)
			}
		}

		if vt, ok := sm.getNextVerifyTime(); ok {
			now := appendTask("Verify", vt)

			for range limit - 1 {
				vt, ok := eff.VerifySchedulingPolicy.NextVerifyTime(now, now)
				if !ok {
					break
				}

				now = appendTask("Verify", vt)
			}
		}
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Time.Before(out[j].Time) })

	if len(out) > limit {
		out = out[:limit]
	}

	return serverapi.UpcomingTasksResponse{Tasks: out}, nil
}
