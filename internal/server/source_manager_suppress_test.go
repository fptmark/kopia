package server

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/repotesting"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/policy"
)

// TestRecentlyCompletedWithinToleranceSuppressesAnAutomaticCollision reproduces the scenario behind two full
// snapshots of the same source running back to back a minute apart: an overdue catch-up and some other
// automatic trigger landing close together. A snapshot that just completed well inside the tolerance window
// (25% of a 1h interval = 15min) must suppress a second automatic trigger.
func TestRecentlyCompletedWithinToleranceSuppressesAnAutomaticCollision(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)
	si := snapshot.SourceInfo{Host: "host", UserName: "user", Path: "/tmp/src"}

	require.NoError(t, policy.SetPolicy(ctx, env.RepositoryWriter, policy.GlobalPolicySourceInfo, &policy.Policy{
		SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: 3600},
	}))

	t0 := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC)
	setClock(t, t0)
	saveTestSnapshot(t, env, si, t0)

	sm := &sourceManager{src: si, rep: env.RepositoryWriter, server: noopSMServer{}}
	sm.refreshStatus(ctx)

	// well inside the 15-minute tolerance.
	advanceClock(t, t0.Add(5*time.Minute))
	require.True(t, sm.recentlyCompletedWithinTolerance())

	// right at the edge: not yet 15 minutes, still suppressed.
	advanceClock(t, t0.Add(14*time.Minute+59*time.Second))
	require.True(t, sm.recentlyCompletedWithinTolerance())

	// past the 15-minute tolerance: no longer suppressed.
	advanceClock(t, t0.Add(16*time.Minute))
	require.False(t, sm.recentlyCompletedWithinTolerance())
}

// TestRecentlyCompletedWithinToleranceIgnoresTimeOfDayAndCronSchedules confirms the tolerance only applies
// to a plain interval schedule -- a time-of-day or cron slot is a specific intended moment, not a window
// this percentage-of-interval idea has any meaning against.
func TestRecentlyCompletedWithinToleranceIgnoresTimeOfDayAndCronSchedules(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)
	si := snapshot.SourceInfo{Host: "host", UserName: "user", Path: "/tmp/src"}

	t0 := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC)
	setClock(t, t0)
	saveTestSnapshot(t, env, si, t0)

	for name, sp := range map[string]policy.SchedulingPolicy{
		"time of day": {IntervalSeconds: 3600, TimesOfDay: []policy.TimeOfDay{{Hour: 9}}},
		"cron":        {IntervalSeconds: 3600, Cron: []string{"0 * * * *"}},
	} {
		t.Run(name, func(t *testing.T) {
			require.NoError(t, policy.SetPolicy(ctx, env.RepositoryWriter, policy.GlobalPolicySourceInfo, &policy.Policy{
				SchedulingPolicy: sp,
			}))

			sm := &sourceManager{src: si, rep: env.RepositoryWriter, server: noopSMServer{}}
			sm.refreshStatus(ctx)

			// one second after the snapshot completed -- would be suppressed for a plain interval policy,
			// must not be here.
			advanceClock(t, t0.Add(time.Second))
			require.False(t, sm.recentlyCompletedWithinTolerance())
		})
	}
}

// TestRecentlyCompletedWithinToleranceAllowsTheFirstEverSnapshot guards against a source with no completed
// snapshot yet ever being suppressed.
func TestRecentlyCompletedWithinToleranceAllowsTheFirstEverSnapshot(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)
	si := snapshot.SourceInfo{Host: "host", UserName: "user", Path: "/tmp/src"}

	require.NoError(t, policy.SetPolicy(ctx, env.RepositoryWriter, policy.GlobalPolicySourceInfo, &policy.Policy{
		SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: 3600},
	}))

	setClock(t, time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC))

	sm := &sourceManager{src: si, rep: env.RepositoryWriter, server: noopSMServer{}}
	sm.refreshStatus(ctx)

	require.False(t, sm.recentlyCompletedWithinTolerance())
}

// TestTriggerScheduledSnapshotDoesNotQueueWhileSuppressed confirms triggerScheduledSnapshot (the scheduler's
// own entry point) actually honors the suppression -- scheduleSnapshotNow's request channel stays untouched
// when a snapshot just completed well inside the tolerance.
func TestTriggerScheduledSnapshotDoesNotQueueWhileSuppressed(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)
	si := snapshot.SourceInfo{Host: "host", UserName: "user", Path: "/tmp/src"}

	require.NoError(t, policy.SetPolicy(ctx, env.RepositoryWriter, policy.GlobalPolicySourceInfo, &policy.Policy{
		SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: 3600},
	}))

	t0 := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC)
	setClock(t, t0)
	saveTestSnapshot(t, env, si, t0)

	sm := &sourceManager{src: si, rep: env.RepositoryWriter, server: noopSMServer{}, snapshotRequests: make(chan struct{}, 1)}
	sm.refreshStatus(ctx)

	advanceClock(t, t0.Add(5*time.Minute))
	sm.triggerScheduledSnapshot()

	select {
	case <-sm.snapshotRequests:
		t.Fatal("triggerScheduledSnapshot queued a run despite being well inside the suppression window")
	default:
	}

	// past the tolerance now: must queue for real.
	advanceClock(t, t0.Add(16*time.Minute))
	sm.triggerScheduledSnapshot()

	select {
	case <-sm.snapshotRequests:
	default:
		t.Fatal("triggerScheduledSnapshot did not queue a run once past the suppression window")
	}
}
