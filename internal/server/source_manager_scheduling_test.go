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
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/policy"
)

// TestScheduleIsAtomicAgainstARapidSecondCall is the regression test for a real double-snapshot:
// schedule() used to let a second call through whenever something had already dequeued the first request
// but hadn't yet set the in-progress flag -- that used to happen inside runScheduledSnapshot, on a
// different goroutine, a moment later. A gap of microseconds in practice, but wide enough: the live
// scheduler hit it, firing "snapshot /Applications" for real a second time, 533 microseconds after the
// first. schedule() now sets the flag atomically, under sourceMutex, before sending, so a second call with
// nothing having dequeued the first must be rejected outright rather than relying on the channel buffer
// alone to de-duplicate.
func TestScheduleIsAtomicAgainstARapidSecondCall(t *testing.T) {
	sm := &sourceManager{
		src:      snapshot.SourceInfo{Host: "h", UserName: "u", Path: "/x"},
		server:   noopSMServer{},
		requests: make(chan scheduledRequest, 2),
	}

	sm.scheduleAutomaticSnapshot()
	sm.scheduleAutomaticSnapshot() // the "scheduler polls again before anything dequeues" scenario

	require.Len(t, sm.requests, 1, "only one request should ever have been queued")
	require.True(t, sm.snapshotInProgress)

	// draining the one real request and marking it done must restore normal scheduling.
	<-sm.requests
	sm.clearInProgress(requestSnapshot)
	require.False(t, sm.snapshotInProgress)

	sm.scheduleAutomaticSnapshot()
	require.Len(t, sm.requests, 1, "a legitimate new trigger after completion must queue normally")

	// verify is independently gated: a pending snapshot must not block it, and vice versa.
	sm.scheduleAutomaticVerify()
	require.Len(t, sm.requests, 2, "snapshot and verify each get their own slot, not one shared one")
	require.True(t, sm.verifyInProgress)
}

// noopSMServer is the minimal sourceManagerServerInterface a refreshStatus()-only test needs: no
// verification history, so the verify schedule is just "not due" throughout.
type noopSMServer struct{}

func (noopSMServer) runSnapshotTask(context.Context, snapshot.SourceInfo, func(context.Context, uitask.Controller, *notifydata.ManifestWithError) error) error {
	return nil
}

func (noopSMServer) runQueuedVerifyOnce(context.Context, repo.Repository, *snapshot.Manifest, string, float64) error {
	return nil
}

func (noopSMServer) refreshScheduler(string) {}

func (noopSMServer) lastVerificationTime(snapshot.SourceInfo, string) (time.Time, bool) {
	return time.Time{}, false
}

func (noopSMServer) retryTierSettings() retryTierSettings {
	return retryTierSettingsFromPreferences(serverapi.UIPreferences{})
}

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

// TestGetNextSnapshotTimeSuppressedWhileAnUploadIsRunning simulates a periodic background refresh landing
// while this source's own snapshot is already running -- the scenario behind a snapshot that stalls for
// hours (the laptop asleep, a dropped connection): the stalled run's own manifest isn't written yet, so a
// refresh that didn't know to leave it alone would see the previous, now-stale completion, judge the source
// overdue, and offer another run before this one even finishes -- which is exactly how one slow snapshot
// turned into a burst of back-to-back ones the moment it, and the ones right after it, finally completed.
// getNextSnapshotTime checks snapshotInProgress itself (not a cache refreshStatus chooses to skip updating),
// so it stays suppressed (ok=false) for as long as the flag is set, regardless of how many refreshes land.
func TestGetNextSnapshotTimeSuppressedWhileAnUploadIsRunning(t *testing.T) {
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

	_, ok = sm.getNextSnapshotTime()
	require.False(t, ok, "a refresh mid-upload must not offer another snapshot")

	// the upload finally finishes; its own manifest lands, and this is the refresh the upload
	// itself triggers on completion.
	saveTestSnapshot(t, env, si, stillRunningAt)
	sm.setSnapshotInProgress(false)
	sm.refreshStatus(ctx)

	next, ok := sm.getNextSnapshotTime()
	require.True(t, ok)
	require.False(t, next.Before(stillRunningAt.Add(time.Hour)),
		"the next snapshot must not start sooner than one full interval after this one started")
}

// TestGetNextSnapshotTimeCatchesUpOnceAfterBeingAsleepThroughTheScheduledTime simulates the machine being
// asleep (or otherwise unable to run) straight through one or more scheduled times: when it finally gets a
// chance to check, it must catch up with exactly one immediate snapshot, due right away -- not stay silent,
// and not try to replay every slot it slept through.
func TestGetNextSnapshotTimeCatchesUpOnceAfterBeingAsleepThroughTheScheduledTime(t *testing.T) {
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
	// refresh must still leave it suppressed rather than offering another one on top of it.
	advanceClock(t, wokeAt.Add(20*time.Minute))
	sm.refreshStatus(ctx)

	_, ok = sm.getNextSnapshotTime()
	require.False(t, ok, "still just the one catch-up run in progress, not another offered on top of it")

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

// TestFindClosestNextTimeIsNeverCached is the regression test for a real double-snapshot: the next-due
// computation used to be cached into nextSnapshotTime/nextVerifyTime fields by refreshStatus(), read back
// later by the scheduler. A value computed under one set of conditions (e.g. a transient "recheck shortly"
// placeholder the old instability layer briefly produced) and read back minutes later, after conditions had
// already changed, is exactly the shape of bug that produced an unscheduled extra snapshot and verify in the
// field. There is no cache any more: getNextSnapshotTime/getNextVerifyTime recompute from current policy and
// attempt state on every call, so calling them repeatedly with nothing else changing, or with refreshStatus
// not re-run in between, must always agree with each other and with a direct call under the same state.
func TestFindClosestNextTimeIsNeverCached(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)
	si := snapshot.SourceInfo{Host: "host", UserName: "user", Path: "/tmp/src"}

	require.NoError(t, policy.SetPolicy(ctx, env.RepositoryWriter, policy.GlobalPolicySourceInfo, &policy.Policy{
		SchedulingPolicy:       policy.SchedulingPolicy{IntervalSeconds: 3600},
		VerifySchedulingPolicy: policy.VerifySchedulingPolicy{SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: 3600}},
	}))

	t0 := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC)
	setClock(t, t0)
	saveTestSnapshot(t, env, si, t0)

	sm := &sourceManager{src: si, rep: env.RepositoryWriter, server: lastVerifiedAtSMServer{lastVerify: t0}}
	sm.refreshStatus(ctx)

	nextSnapshot, ok := sm.getNextSnapshotTime()
	require.True(t, ok)
	require.True(t, t0.Add(time.Hour).Equal(nextSnapshot))

	nextVerify, ok := sm.getNextVerifyTime()
	require.True(t, ok)
	require.True(t, t0.Add(time.Hour).Equal(nextVerify))

	// time passes with no refreshStatus() in between -- a cached value would be unaffected, but the real
	// due time hasn't changed either (still a clean hour out), so a fresh call must agree.
	advanceClock(t, t0.Add(10*time.Minute))

	nextSnapshotAgain, ok := sm.getNextSnapshotTime()
	require.True(t, ok)
	require.True(t, nextSnapshot.Equal(nextSnapshotAgain), "recomputing with nothing relevant changed must agree with the first answer")
}

// TestFindClosestNextTimeRespectsPauseAndInProgress covers the two conditions that must suppress scheduling
// entirely (ok=false), now checked directly inside the next-due computation itself rather than emerging from
// refreshStatus() choosing when to skip recomputing a cache.
func TestFindClosestNextTimeRespectsPauseAndInProgress(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)
	si := snapshot.SourceInfo{Host: "host", UserName: "user", Path: "/tmp/src"}

	require.NoError(t, policy.SetPolicy(ctx, env.RepositoryWriter, policy.GlobalPolicySourceInfo, &policy.Policy{
		SchedulingPolicy:       policy.SchedulingPolicy{IntervalSeconds: 3600},
		VerifySchedulingPolicy: policy.VerifySchedulingPolicy{SchedulingPolicy: policy.SchedulingPolicy{IntervalSeconds: 3600}},
	}))

	t0 := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC)
	setClock(t, t0)
	saveTestSnapshot(t, env, si, t0)

	sm := &sourceManager{src: si, rep: env.RepositoryWriter, server: lastVerifiedAtSMServer{lastVerify: t0}}
	sm.refreshStatus(ctx)

	_, ok := sm.getNextSnapshotTime()
	require.True(t, ok, "baseline: due an hour out, nothing suppressing it")

	sm.sourceMutex.Lock()
	sm.paused = true
	sm.sourceMutex.Unlock()

	_, ok = sm.getNextSnapshotTime()
	require.False(t, ok, "paused suppresses snapshot scheduling")

	_, ok = sm.getNextVerifyTime()
	require.False(t, ok, "paused suppresses verify scheduling too")

	sm.sourceMutex.Lock()
	sm.paused = false
	sm.sourceMutex.Unlock()

	sm.setSnapshotInProgress(true)
	_, ok = sm.getNextSnapshotTime()
	require.False(t, ok, "an upload already running suppresses another snapshot")

	sm.setSnapshotInProgress(false)
	sm.setVerifyInProgress(true)
	_, ok = sm.getNextVerifyTime()
	require.False(t, ok, "a verify already running suppresses another verify")
}

// lastVerifiedAtSMServer is noopSMServer reporting a specific last-verification time, for tests that need
// findClosestNextVerifyTimeReadLocked to have a real baseline to advance from.
type lastVerifiedAtSMServer struct {
	noopSMServer
	lastVerify time.Time
}

func (s lastVerifiedAtSMServer) lastVerificationTime(snapshot.SourceInfo, string) (time.Time, bool) {
	return s.lastVerify, true
}
