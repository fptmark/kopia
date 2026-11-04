package server

import (
	"context"
	"testing"
	"time"

	"github.com/pkg/errors"
	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/repotesting"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/internal/testlogging"
	"github.com/kopia/kopia/internal/uitask"
	"github.com/kopia/kopia/notification/notifydata"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/policy"
)

// retryTestSMServer is a sourceManagerServerInterface for attemptSnapshotWithRetries tests: runSnapshotTask
// fails the first failCount calls then succeeds, and every call is counted.
type retryTestSMServer struct {
	noopSMServer

	failCount int
	calls     int
	rt        retryTierSettings
}

func (s *retryTestSMServer) runSnapshotTask(context.Context, snapshot.SourceInfo, func(context.Context, uitask.Controller, *notifydata.ManifestWithError) error) error {
	s.calls++
	if s.calls <= s.failCount {
		return errors.New("simulated failure")
	}

	return nil
}

func (s *retryTestSMServer) retryTierSettings() retryTierSettings { return s.rt }

// recordingSleep replaces sleepInterruptibly for a test: records each requested delay and returns at once
// (true, as if it slept the whole duration) instead of actually waiting.
func recordingSleep(tb testing.TB) *[]time.Duration {
	tb.Helper()

	var got []time.Duration

	orig := sleepInterruptibly
	sleepInterruptibly = func(_ context.Context, d time.Duration) bool {
		got = append(got, d)
		return true
	}
	tb.Cleanup(func() { sleepInterruptibly = orig })

	return &got
}

func testRetryTierSettings() retryTierSettings {
	return retryTierSettingsFromPreferences(serverapi.UIPreferences{
		RetryTierThresholdHours: 1,
		OftenRetryCount:         3, OftenRetryIntervalMinutes: 1,
		OccasionalRetryCount: 5, OccasionalRetryIntervalMinutes: 5,
	})
}

func newRetrySourceManager(t *testing.T, failCount int, intervalSeconds int64) (*sourceManager, *retryTestSMServer, *[]time.Duration) {
	t.Helper()

	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)
	si := snapshot.SourceInfo{Host: "host", UserName: "user", Path: "/tmp/src"}

	require.NoError(t, policy.SetPolicy(ctx, env.RepositoryWriter, policy.GlobalPolicySourceInfo, &policy.Policy{
		SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: intervalSeconds},
	}))

	setClock(t, time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC))

	srv := &retryTestSMServer{failCount: failCount, rt: testRetryTierSettings()}
	sm := &sourceManager{src: si, rep: env.RepositoryWriter, server: srv, snapshotRequests: make(chan bool, 1)}
	sm.refreshStatus(ctx)

	sleeps := recordingSleep(t)

	return sm, srv, sleeps
}

func TestAttemptSnapshotWithRetriesOftenGivesUpAfterBurst(t *testing.T) {
	// 1h interval == exactly at the 1h threshold: often.
	sm, srv, sleeps := newRetrySourceManager(t, 99, 3600)

	sm.attemptSnapshotWithRetries(testlogging.Context(t), true)

	require.Equal(t, 4, srv.calls, "the first attempt plus 3 often retries, then give up")
	require.Equal(t, []time.Duration{time.Minute, time.Minute, time.Minute}, *sleeps)
}

func TestAttemptSnapshotWithRetriesOccasionalEscalates(t *testing.T) {
	// 4h interval, well beyond the 1h threshold: occasional.
	sm, srv, sleeps := newRetrySourceManager(t, 99, 4*3600)

	sm.attemptSnapshotWithRetries(testlogging.Context(t), true)

	require.Equal(t, 9, srv.calls, "the first attempt plus 3 often + 5 occasional retries, then give up")
	require.Equal(t, []time.Duration{
		time.Minute, time.Minute, time.Minute,
		5 * time.Minute, 5 * time.Minute, 5 * time.Minute, 5 * time.Minute, 5 * time.Minute,
	}, *sleeps)
}

func TestAttemptSnapshotWithRetriesSucceedsPartway(t *testing.T) {
	sm, srv, sleeps := newRetrySourceManager(t, 2, 3600)

	sm.attemptSnapshotWithRetries(testlogging.Context(t), true)

	require.Equal(t, 3, srv.calls, "2 failures then a success")
	require.Equal(t, []time.Duration{time.Minute, time.Minute}, *sleeps)
}

func TestAttemptSnapshotWithRetriesManualTriggerNeverRetries(t *testing.T) {
	sm, srv, sleeps := newRetrySourceManager(t, 99, 3600)

	sm.attemptSnapshotWithRetries(testlogging.Context(t), false)

	require.Equal(t, 1, srv.calls, "a manual trigger reports its own failure, no automatic retry")
	require.Empty(t, *sleeps)
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
