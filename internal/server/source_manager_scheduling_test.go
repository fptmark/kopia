package server

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/fs"
	"github.com/kopia/kopia/internal/clock"
	"github.com/kopia/kopia/internal/repotesting"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/internal/testlogging"
	"github.com/kopia/kopia/internal/uitask"
	"github.com/kopia/kopia/notification/notifydata"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/policy"
)

// noopSMServer is the minimal sourceManagerServerInterface a refreshStatus()-only test needs: no
// verification history, so the verify schedule is just "not due" throughout.
type noopSMServer struct{}

func (noopSMServer) runSnapshotTask(context.Context, snapshot.SourceInfo, func(context.Context, uitask.Controller, *notifydata.ManifestWithError) error) error {
	return nil
}

func (noopSMServer) refreshScheduler(string) {}

func (noopSMServer) lastVerificationTime(snapshot.SourceInfo, string) (time.Time, bool) {
	return time.Time{}, false
}

func (noopSMServer) systemRecentlyUnstable() bool { return false }

func (noopSMServer) retryTierSettings() retryTierSettings {
	return retryTierSettingsFromPreferences(serverapi.UIPreferences{})
}

// unstableSMServer is noopSMServer with systemRecentlyUnstable forced true, for tests of the deferral it
// drives in findClosestNextSnapshotTimeReadLocked/findClosestNextVerifyTimeReadLocked.
type unstableSMServer struct{ noopSMServer }

func (unstableSMServer) systemRecentlyUnstable() bool { return true }

// setClock pins clock.Now() to t and restores the real clock when the test ends. Requires the
// "testing" build tag (clock.Now is a plain func otherwise, not an overridable var).
func setClock(tb testing.TB, t time.Time) {
	tb.Helper()

	orig := clock.Now
	clock.Now = func() time.Time { return t }
	tb.Cleanup(func() { clock.Now = orig })
}

func advanceClock(tb testing.TB, t time.Time) {
	tb.Helper()

	clock.Now = func() time.Time { return t }
}

func saveTestSnapshot(t *testing.T, env *repotesting.Environment, si snapshot.SourceInfo, start time.Time) {
	t.Helper()

	man := &snapshot.Manifest{
		Source:    si,
		StartTime: fs.UTCTimestampFromTime(start),
		EndTime:   fs.UTCTimestampFromTime(start),
	}

	_, err := snapshot.SaveSnapshot(testlogging.Context(t), env.RepositoryWriter, man)
	require.NoError(t, err)
}

// TestRefreshStatusDoesNotRescheduleWhileAnUploadIsRunning simulates a periodic background refresh
// landing while this source's own snapshot is already running -- the scenario behind a snapshot
// that stalls for hours (the laptop asleep, a dropped connection): the stalled run's own manifest
// isn't written yet, so a refresh that didn't know to leave it alone would see the previous,
// now-stale completion, judge the source overdue, and arm another run before this one even
// finishes -- which is exactly how one slow snapshot turned into a burst of back-to-back ones the
// moment it, and the ones right after it, finally completed.
func TestRefreshStatusDoesNotRescheduleWhileAnUploadIsRunning(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)
	si := snapshot.SourceInfo{Host: "host", UserName: "user", Path: "/tmp/src"}

	require.NoError(t, policy.SetPolicy(ctx, env.RepositoryWriter, policy.GlobalPolicySourceInfo, &policy.Policy{
		SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: 3600},
	}))

	t0 := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC)
	setClock(t, t0)
	saveTestSnapshot(t, env, si, t0)

	sm := &sourceManager{src: si, rep: env.RepositoryWriter, server: noopSMServer{}}

	// a normal refresh right after that snapshot: next one a clean hour out, nothing overdue.
	sm.refreshStatus(ctx)
	baseline, ok := sm.getNextSnapshotTime()
	require.True(t, ok)
	require.True(t, t0.Add(time.Hour).Equal(baseline))

	// the next snapshot starts, taking a very long time (asleep, a dropped connection -- its own
	// manifest will not exist until it finishes).
	sm.setSnapshotInProgress(true)

	// well past an hour since t0: without the guard this reads as badly overdue.
	stillRunningAt := t0.Add(3 * time.Hour)
	advanceClock(t, stillRunningAt)

	// the periodic background refresh (every few hours, for every source) lands while this
	// source's own upload is still running.
	sm.refreshStatus(ctx)

	stillBaseline, ok := sm.getNextSnapshotTime()
	require.True(t, ok)
	require.Equal(t, baseline, stillBaseline, "a refresh mid-upload must not touch the schedule")

	// the upload finally finishes; its own manifest lands, and this is the refresh the upload
	// itself triggers on completion -- this one must recompute, not be skipped.
	saveTestSnapshot(t, env, si, stillRunningAt)
	sm.setSnapshotInProgress(false)
	sm.refreshStatus(ctx)

	next, ok := sm.getNextSnapshotTime()
	require.True(t, ok)
	require.False(t, next.Before(stillRunningAt.Add(time.Hour)),
		"the next snapshot must not start sooner than one full interval after this one started")
}

// TestRefreshStatusCatchesUpOnceAfterBeingAsleepThroughTheScheduledTime simulates the machine being
// asleep (or otherwise unable to run) straight through one or more scheduled times: when it finally
// gets a chance to check, it must catch up with exactly one immediate snapshot, due right away --
// not stay silent, and not try to replay every slot it slept through.
func TestRefreshStatusCatchesUpOnceAfterBeingAsleepThroughTheScheduledTime(t *testing.T) {
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

	// asleep for 7 hours straight through several scheduled snapshot times; nothing in this
	// process runs or calls refreshStatus again until it wakes.
	wokeAt := t0.Add(7 * time.Hour)
	advanceClock(t, wokeAt)

	sm.refreshStatus(ctx)

	next, ok := sm.getNextSnapshotTime()
	require.True(t, ok)
	require.True(t, wokeAt.Equal(next), "due immediately on waking, not one of the missed hourly slots")

	// that catch-up snapshot starts running.
	sm.setSnapshotInProgress(true)

	// a second interruption while the catch-up snapshot itself is still running -- a periodic
	// refresh must still leave the schedule alone rather than queuing yet another one behind it.
	advanceClock(t, wokeAt.Add(20*time.Minute))
	sm.refreshStatus(ctx)

	midRun, ok := sm.getNextSnapshotTime()
	require.True(t, ok)
	require.True(t, wokeAt.Equal(midRun), "still just the one catch-up run queued, not another on top of it")

	// it finishes quickly; the one after it must wait a full interval, not fire again right away
	// just because the schedule was behind a moment ago.
	finishedAt := wokeAt.Add(30 * time.Minute)
	advanceClock(t, finishedAt)
	saveTestSnapshot(t, env, si, wokeAt)
	sm.setSnapshotInProgress(false)
	sm.refreshStatus(ctx)

	after, ok := sm.getNextSnapshotTime()
	require.True(t, ok)
	require.False(t, after.Before(wokeAt.Add(time.Hour)),
		"resumes the normal hourly cadence instead of firing again immediately")
}

// TestSchedulingDefersWhileRecentlyUnstable covers the "don't start a job while the machine looks like it's
// still sleep-cycling" rule: even a badly overdue source must not get an immediate catch-up time while
// systemRecentlyUnstable is true -- it gets a near-future recheck instead, so the scheduler keeps polling
// without actually starting a snapshot or verify into what is likely still a flaky connection.
func TestSchedulingDefersWhileRecentlyUnstable(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)
	si := snapshot.SourceInfo{Host: "host", UserName: "user", Path: "/tmp/src"}

	require.NoError(t, policy.SetPolicy(ctx, env.RepositoryWriter, policy.GlobalPolicySourceInfo, &policy.Policy{
		SchedulingPolicy:       policy.SchedulingPolicy{IntervalSeconds: 3600},
		VerifySchedulingPolicy: policy.VerifySchedulingPolicy{SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: 3600}},
	}))

	t0 := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC)
	setClock(t, t0)
	saveTestSnapshot(t, env, si, t0)

	// badly overdue: a real wake right now would trigger an immediate catch-up.
	wayLater := t0.Add(5 * time.Hour)
	advanceClock(t, wayLater)

	sm := &sourceManager{src: si, rep: env.RepositoryWriter, server: unstableSMServer{}}
	sm.refreshStatus(ctx)

	nextSnapshot, ok := sm.getNextSnapshotTime()
	require.True(t, ok)
	require.False(t, nextSnapshot.After(wayLater.Add(instabilityRecheckInterval)),
		"a near-future recheck, not left stuck at the real (badly overdue) catch-up time")
	require.True(t, nextSnapshot.After(wayLater), "not in the past either -- genuinely deferred, not due now")

	nextVerify, ok := sm.getNextVerifyTime()
	require.True(t, ok)
	require.False(t, nextVerify.After(wayLater.Add(instabilityRecheckInterval)))

	// stability returns: a normal refresh now computes the real (immediate, one-time catch-up) time again.
	sm.server = noopSMServer{}
	sm.refreshStatus(ctx)

	caughtUp, ok := sm.getNextSnapshotTime()
	require.True(t, ok)
	require.True(t, wayLater.Equal(caughtUp), "due right away once stable, the normal catch-up-once behavior")
}
