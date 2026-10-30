package server

import (
	"context"
	"sort"
	"strconv"
	"time"

	"github.com/kopia/kopia/internal/clock"
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

	for src := range rc.srv.snapshotAllSourceManagers() {
		policies, err := policy.GetPolicyHierarchy(ctx, rc.rep, src, nil)
		if err != nil {
			continue
		}

		eff, _ := policy.MergePolicies(policies, src)

		now := clock.Now().Local()
		for range limit {
			st, ok := eff.SchedulingPolicy.NextSnapshotTime(now, now)
			if !ok {
				break
			}

			out = append(out, serverapi.UpcomingTask{Time: st, Kind: "Snapshot", Source: src})
			now = st.Add(time.Second)
		}

		now = clock.Now().Local()
		for range limit {
			vt, ok := eff.VerifySchedulingPolicy.NextVerifyTime(now, now)
			if !ok {
				break
			}

			out = append(out, serverapi.UpcomingTask{Time: vt, Kind: "Verify", Source: src})
			now = vt.Add(time.Second)
		}
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Time.Before(out[j].Time) })

	if len(out) > limit {
		out = out[:limit]
	}

	return serverapi.UpcomingTasksResponse{Tasks: out}, nil
}
