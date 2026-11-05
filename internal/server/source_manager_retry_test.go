package server

import (
	"context"
	"testing"
	"time"

	"github.com/pkg/errors"
	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/fs"
	"github.com/kopia/kopia/internal/clock"
	"github.com/kopia/kopia/internal/repotesting"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/internal/testlogging"
	"github.com/kopia/kopia/internal/uitask"
	"github.com/kopia/kopia/notification/notifydata"
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/policy"
)

// retryTestSMServer is a sourceManagerServerInterface for runScheduledSnapshot/runScheduledVerify tests:
// runSnapshotTask and runQueuedVerifyOnce each fail the first failCount calls then succeed, and every call
// is counted. sm is set by newRetrySourceManager after construction, so runSnapshotTask can set
// lastAttemptedSnapshotTime the way the real snapshotInternal does -- without it, the retry-tier due-time
// computation would advance from the zero time instead of from "now".
type retryTestSMServer struct {
	noopSMServer

	failCount int
	calls     int
	rt        retryTierSettings
	sm        *sourceManager
}

func (s *retryTestSMServer) runSnapshotTask(context.Context, snapshot.SourceInfo, func(context.Context, uitask.Controller, *notifydata.ManifestWithError) error) error {
	s.calls++

	s.sm.sourceMutex.Lock()
	s.sm.lastAttemptedSnapshotTime = fs.UTCTimestampFromTime(clock.Now())
	s.sm.sourceMutex.Unlock()

	if s.calls <= s.failCount {
		return errors.New("simulated failure")
	}

	return nil
}

func (s *retryTestSMServer) runQueuedVerifyOnce(context.Context, repo.Repository, *snapshot.Manifest, string, float64) error {
	s.calls++
	if s.calls <= s.failCount {
		return errors.New("simulated failure")
	}

	return nil
}

func (s *retryTestSMServer) retryTierSettings() retryTierSettings { return s.rt }

func testRetryTierSettings() retryTierSettings {
	return retryTierSettingsFromPreferences(serverapi.UIPreferences{
		RetryTierThresholdHours: 1,
		OftenRetryCount:         3, OftenRetryIntervalMinutes: 1,
		OccasionalRetryCount: 5, OccasionalRetryIntervalMinutes: 5,
	})
}

func newRetrySourceManager(t *testing.T, failCount int, intervalSeconds int64) (*sourceManager, *retryTestSMServer, *repotesting.Environment) {
	t.Helper()

	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)
	si := snapshot.SourceInfo{Host: "host", UserName: "user", Path: "/tmp/src"}

	require.NoError(t, policy.SetPolicy(ctx, env.RepositoryWriter, policy.GlobalPolicySourceInfo, &policy.Policy{
		SchedulingPolicy:       policy.SchedulingPolicy{IntervalSeconds: intervalSeconds},
		VerifySchedulingPolicy: policy.VerifySchedulingPolicy{SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: intervalSeconds}},
	}))

	setClock(t, time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC))

	srv := &retryTestSMServer{failCount: failCount, rt: testRetryTierSettings()}
	sm := &sourceManager{src: si, rep: env.RepositoryWriter, server: srv}
	srv.sm = sm
	sm.refreshStatus(ctx)

	return sm, srv, env
}

// requireRetryDueIn asserts the source's next snapshot/verify time is lastAttempted+delay, matching what
// the scheduler would compute and wait for before firing the next retry.
func requireRetryDueIn(t *testing.T, got time.Time, delay time.Duration) {
	t.Helper()
	require.True(t, clock.Now().Add(delay).Equal(got), "expected due in %v (at %v), got %v", delay, clock.Now().Add(delay), got)
}

func TestRunScheduledSnapshotOftenGivesUpAfterBurst(t *testing.T) {
	// 1h interval == exactly at the 1h threshold: often.
	sm, srv, _ := newRetrySourceManager(t, 99, 3600)
	ctx := testlogging.Context(t)

	sm.runScheduledSnapshot(ctx, true) // attempt 1: fails
	next, ok := sm.getNextSnapshotTime()
	require.True(t, ok)
	requireRetryDueIn(t, next, time.Minute)

	sm.runScheduledSnapshot(ctx, true) // attempt 2 (retry 1): fails
	next, ok = sm.getNextSnapshotTime()
	require.True(t, ok)
	requireRetryDueIn(t, next, time.Minute)

	sm.runScheduledSnapshot(ctx, true) // attempt 3 (retry 2): fails
	next, ok = sm.getNextSnapshotTime()
	require.True(t, ok)
	requireRetryDueIn(t, next, time.Minute)

	sm.runScheduledSnapshot(ctx, true) // attempt 4 (retry 3): fails, often budget (3 retries) now used up

	require.Equal(t, 4, srv.calls, "the first attempt plus 3 often retries, then give up")

	next, ok = sm.getNextSnapshotTime()
	require.True(t, ok)
	require.True(t, next.After(clock.Now().Add(time.Minute)), "budget exhausted: natural (1h) schedule applies, not another 1-minute retry")
}

func TestRunScheduledSnapshotOccasionalEscalates(t *testing.T) {
	// 4h interval, well beyond the 1h threshold: occasional.
	sm, srv, _ := newRetrySourceManager(t, 99, 4*3600)
	ctx := testlogging.Context(t)

	wantDelays := []time.Duration{
		time.Minute, time.Minute, time.Minute,
		5 * time.Minute, 5 * time.Minute, 5 * time.Minute, 5 * time.Minute, 5 * time.Minute,
	}

	for i, want := range wantDelays {
		sm.runScheduledSnapshot(ctx, true)
		require.Equal(t, i+1, srv.calls)

		next, ok := sm.getNextSnapshotTime()
		require.True(t, ok, "attempt %d", i+1)
		requireRetryDueIn(t, next, want)
	}

	// one more failure: the 3 often + 5 occasional budget is now fully used up.
	sm.runScheduledSnapshot(ctx, true)
	require.Equal(t, 9, srv.calls, "the first attempt plus 3 often + 5 occasional retries, then give up")

	next, ok := sm.getNextSnapshotTime()
	require.True(t, ok)
	require.True(t, next.After(clock.Now().Add(5*time.Minute)), "budget exhausted: natural (4h, floored) schedule applies")
}

func TestRunScheduledSnapshotSucceedsPartway(t *testing.T) {
	sm, srv, _ := newRetrySourceManager(t, 2, 3600)
	ctx := testlogging.Context(t)

	sm.runScheduledSnapshot(ctx, true) // fails
	sm.runScheduledSnapshot(ctx, true) // fails
	sm.runScheduledSnapshot(ctx, true) // succeeds

	require.Equal(t, 3, srv.calls, "2 failures then a success")

	next, ok := sm.getNextSnapshotTime()
	require.True(t, ok)
	require.True(t, next.After(clock.Now().Add(time.Minute)), "a success clears the retry cycle: natural schedule applies, not another 1-minute retry")
}

func TestRunScheduledSnapshotManualTriggerNeverRetries(t *testing.T) {
	sm, srv, _ := newRetrySourceManager(t, 99, 3600)
	ctx := testlogging.Context(t)

	sm.runScheduledSnapshot(ctx, false)

	require.Equal(t, 1, srv.calls, "a manual trigger reports its own failure, no automatic retry")

	next, ok := sm.getNextSnapshotTime()
	require.True(t, ok)
	require.True(t, next.After(clock.Now().Add(time.Minute)), "a manual failure never starts a retry cycle")
}

func TestRunScheduledVerifyOftenGivesUpAfterBurst(t *testing.T) {
	sm, srv, env := newRetrySourceManager(t, 99, 3600)
	ctx := testlogging.Context(t)

	saveTestSnapshot(t, env, sm.src, clock.Now())
	sm.refreshStatus(ctx)

	for range 3 {
		sm.runScheduledVerify(ctx, true)
	}

	sm.runScheduledVerify(ctx, true)
	require.Equal(t, 4, srv.calls, "the first attempt plus 3 often retries, then give up")
}

func TestRunScheduledVerifyManualNeverRetries(t *testing.T) {
	// There is no manual "verify now" entry point on sourceManager -- a manual verify of a specific snapshot
	// goes through startSnapshotVerify directly (api_snapshot_verify.go), never through here. This documents
	// that a manual (scheduled=false) call to runScheduledVerify, same as Snapshot's, never retries.
	sm, srv, env := newRetrySourceManager(t, 99, 3600)
	ctx := testlogging.Context(t)

	saveTestSnapshot(t, env, sm.src, clock.Now())
	sm.refreshStatus(ctx)

	sm.runScheduledVerify(ctx, false)
	require.Equal(t, 1, srv.calls)

	next, ok := sm.getNextVerifyTime()
	require.True(t, ok)
	require.True(t, next.After(clock.Now().Add(time.Minute)), "a manual failure never starts a retry cycle")
}

// TestFindClosestNextSnapshotTimeAppliesOccasionalFloor confirms the end-to-end wiring: an occasional
// source whose natural next time has fallen back to close to "now" gets floored to lastCompletion+threshold
// instead of being offered again almost immediately -- the scenario behind two full snapshots of the same
// (long-interval) source landing close together, e.g. when a periodic refresh lands shortly after the slot
// Truncate picked has already passed.
func TestFindClosestNextSnapshotTimeAppliesOccasionalFloor(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)
	si := snapshot.SourceInfo{Host: "host", UserName: "user", Path: "/tmp/src"}

	const fourHours = 4 * 3600 // occasional, given the 1h threshold in testRetryTierSettings

	require.NoError(t, policy.SetPolicy(ctx, env.RepositoryWriter, policy.GlobalPolicySourceInfo, &policy.Policy{
		SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: fourHours},
	}))

	// A completion sitting just before an exact 4h grid boundary: Truncate(lastCompletion+4h, 4h) rounds
	// down to that boundary, just over a minute after lastCompletion -- constructed this way (rather than
	// picking an elapsed duration by hand) so the result doesn't depend on wall-clock phase at test-run
	// time; see schedulePeriodEstimate's doc comment for why Truncate's grid is phase-dependent.
	boundary := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC).Truncate(4 * time.Hour)
	lastCompletion := boundary.Add(-time.Minute)
	saveTestSnapshot(t, env, si, lastCompletion)

	srv := &retryTestSMServer{rt: testRetryTierSettings()}
	sm := &sourceManager{src: si, rep: env.RepositoryWriter, server: srv}

	// "now" is 1 minute past that boundary -- without the floor this would be offered again almost
	// immediately, 2 minutes after it last completed, on a nominally 4-hour schedule.
	setClock(t, lastCompletion.Add(2*time.Minute))
	sm.refreshStatus(ctx)

	next, ok := sm.getNextSnapshotTime()
	require.True(t, ok)
	require.True(t, lastCompletion.Add(time.Hour).Equal(next), "floored to lastCompletion+threshold, not re-offered 2 minutes later: got %v", next)
}
