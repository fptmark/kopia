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
	"github.com/kopia/kopia/internal/testlogging"
	"github.com/kopia/kopia/internal/uitask"
	"github.com/kopia/kopia/notification/notifydata"
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/policy"
)

// This file is the layer none of the other tests in this package exercise: multiple real *sourceManagers,
// driven across many rounds the way the live scheduler actually runs for hours, with each round choosing the
// globally-earliest due time exactly as internal/scheduler.Scheduler.run does (just without its real-time
// wait). A single getSchedulerItems() call, or a single sourceManager method call in isolation, cannot catch
// a bug that only shows up in the interaction between a decision made in one round and state read back in a
// later one -- which is exactly where both real scheduling bugs this architecture replaced actually lived.

// schedSimServer is a scriptable sourceManagerServerInterface for one simulated source: runSnapshotTask and
// runQueuedVerifyOnce call back into test-supplied functions, so a scenario can script exactly which
// attempts fail, and each also records a realistic lastAttemptedSnapshotTime/lastAttemptedVerifyTime the way
// the real implementations do (snapshotInternal, sourceManager.markVerifyAttempted) -- without this the
// retry-tier due-time computation would advance from the zero time instead of from "now".
type schedSimServer struct {
	noopSMServer
	rt  retryTierSettings
	sm  *sourceManager
	t   *testing.T
	env *repotesting.Environment

	snapshotAttempt func(call int) error
	verifyAttempt   func(call int) error

	snapshotCalls int
	verifyCalls   int
}

// runSnapshotTask simulates one attempt: always marks "attempted now" (as the real snapshotInternal does),
// and -- on success -- actually saves a snapshot manifest, the way a real upload would, so
// lastCompleteSnapshot genuinely becomes non-nil and a scenario can drive Verify (which is gated on it)
// truthfully instead of it staying permanently unschedulable.
func (s *schedSimServer) runSnapshotTask(context.Context, snapshot.SourceInfo, func(context.Context, uitask.Controller, *notifydata.ManifestWithError) error) error {
	s.snapshotCalls++

	s.sm.sourceMutex.Lock()
	s.sm.lastAttemptedSnapshotTime = fs.UTCTimestampFromTime(clock.Now())
	s.sm.sourceMutex.Unlock()

	var err error
	if s.snapshotAttempt != nil {
		err = s.snapshotAttempt(s.snapshotCalls)
	}

	if err == nil {
		saveTestSnapshot(s.t, s.env, s.sm.src, clock.Now())
	}

	return err
}

func (s *schedSimServer) runQueuedVerifyOnce(context.Context, repo.Repository, *snapshot.Manifest, string, float64) error {
	s.verifyCalls++

	if s.verifyAttempt == nil {
		return nil
	}

	return s.verifyAttempt(s.verifyCalls)
}

func (s *schedSimServer) retryTierSettings() retryTierSettings { return s.rt }

// newSchedSimSource builds one simulated source with its own per-source policy (so different sources in the
// same scenario can have different intervals), wired to a schedSimServer the caller can script.
func newSchedSimSource(t *testing.T, ctx context.Context, env *repotesting.Environment, name string, snapshotIntervalSeconds, verifyIntervalSeconds int64) *schedSimServer {
	t.Helper()

	si := snapshot.SourceInfo{Host: "host", UserName: "user", Path: "/" + name}

	vsp := policy.VerifySchedulingPolicy{SchedulingPolicy: policy.SchedulingPolicy{Manual: verifyIntervalSeconds == 0}}
	if verifyIntervalSeconds > 0 {
		vsp.SchedulingPolicy = policy.SchedulingPolicy{IntervalSeconds: verifyIntervalSeconds}
	}

	require.NoError(t, policy.SetPolicy(ctx, env.RepositoryWriter, si, &policy.Policy{
		SchedulingPolicy:       policy.SchedulingPolicy{IntervalSeconds: snapshotIntervalSeconds},
		VerifySchedulingPolicy: vsp,
	}))

	srv := &schedSimServer{rt: testRetryTierSettings(), t: t, env: env}
	sm := &sourceManager{src: si, rep: env.RepositoryWriter, server: srv}
	srv.sm = sm

	sm.refreshStatus(ctx)

	return srv
}

// driveRounds repeatedly finds the globally earliest due time across every source's snapshot and verify,
// jumps the clock straight to it (no real waiting -- a deliberate stand-in for the real scheduler's
// sleepable.Timer, which internal/scheduler's own tests already cover on its own), and runs that one
// attempt, exactly the decision internal/scheduler.Scheduler.run makes every time around its loop.
func driveRounds(t *testing.T, ctx context.Context, sources []*schedSimServer, rounds int) {
	t.Helper()

	for round := range rounds {
		var (
			earliestAt   time.Time
			earliestSrv  *schedSimServer
			earliestKind requestKind
			found        bool
		)

		consider := func(srv *schedSimServer, kind requestKind, t0 time.Time, ok bool) {
			if !ok {
				return
			}

			if !found || t0.Before(earliestAt) {
				earliestAt, earliestSrv, earliestKind, found = t0, srv, kind, true
			}
		}

		for _, srv := range sources {
			t0, ok := srv.sm.getNextSnapshotTime()
			consider(srv, requestSnapshot, t0, ok)

			t0, ok = srv.sm.getNextVerifyTime()
			consider(srv, requestVerify, t0, ok)
		}

		require.True(t, found, "round %d: nothing due at all", round)

		advanceClock(t, earliestAt)

		switch earliestKind {
		case requestSnapshot:
			earliestSrv.sm.runScheduledSnapshot(ctx, true)
		case requestVerify:
			earliestSrv.sm.runScheduledVerify(ctx, true)
		}
	}
}

func failTimes(n int) func(call int) error {
	return func(call int) error {
		if call <= n {
			return errors.New("simulated failure")
		}

		return nil
	}
}

func TestSchedulerSimulationIndependentSourcesDoNotCrossContaminate(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)
	setClock(t, time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC))

	// both hourly (often tier), verify left manual so this scenario is purely about snapshot retries.
	flaky := newSchedSimSource(t, ctx, env, "flaky", 3600, 0)
	flaky.snapshotAttempt = failTimes(2)

	clean := newSchedSimSource(t, ctx, env, "clean", 3600, 0)
	clean.snapshotAttempt = failTimes(0)

	driveRounds(t, testlogging.Context(t), []*schedSimServer{flaky, clean}, 4)

	require.Equal(t, 3, flaky.snapshotCalls, "2 failures then a success, driven across its own retry rounds")
	require.Equal(t, 1, clean.snapshotCalls, "a clean, unrelated source must not be re-triggered by another source's retries")
}

// TestSchedulerSimulationVerifyWaitsForTheFirstSnapshot covers the gate added specifically to avoid a
// busy-loop: a source with no complete snapshot yet must not offer a verify item at all (round after round)
// until a snapshot actually succeeds -- driven through the real multi-round loop, not just a single
// findClosestNextVerifyTimeReadLocked() call, to prove the gate actually stops the scheduler from spinning.
func TestSchedulerSimulationVerifyWaitsForTheFirstSnapshot(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)
	setClock(t, time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC))

	src := newSchedSimSource(t, ctx, env, "src", 3600, 1800) // hourly snapshot, half-hourly verify

	_, ok := src.sm.getNextVerifyTime()
	require.False(t, ok, "nothing to verify before the first snapshot ever completes")

	// first round: only the snapshot is due (verify offers nothing), so it must be the one driven.
	driveRounds(t, testlogging.Context(t), []*schedSimServer{src}, 1)
	require.Equal(t, 1, src.snapshotCalls)
	require.Equal(t, 0, src.verifyCalls, "verify still must not have fired ahead of there being anything to verify")

	_, ok = src.sm.getNextVerifyTime()
	require.True(t, ok, "now that a snapshot has completed, verify is schedulable")

	driveRounds(t, testlogging.Context(t), []*schedSimServer{src}, 1)
	require.Equal(t, 1, src.verifyCalls, "the next due item is now the verify")
}

// TestSchedulerSimulationSnapshotAndVerifyRetryIndependently drives one source whose snapshot and verify
// each fail their own number of times, confirming the two kinds' retry cycles (separate retryState fields,
// separate "last attempted" times) never interfere with each other.
func TestSchedulerSimulationSnapshotAndVerifyRetryIndependently(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)
	setClock(t, time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC))

	src := newSchedSimSource(t, ctx, env, "src", 3600, 1800)
	src.snapshotAttempt = failTimes(1) // 1 failure then succeeds
	src.verifyAttempt = failTimes(2)   // 2 failures then succeeds

	// snapshot: 1 failure + 1 success = 2 calls. Then verify becomes due and runs its own cycle: 2
	// failures + 1 success = 3 calls. 5 rounds covers both cycles in full.
	driveRounds(t, testlogging.Context(t), []*schedSimServer{src}, 5)

	require.Equal(t, 2, src.snapshotCalls)
	require.Equal(t, 3, src.verifyCalls)

	// both cycles are over: next due times are the natural (hourly/half-hourly) schedule, not a retry delay.
	nextSnapshot, ok := src.sm.getNextSnapshotTime()
	require.True(t, ok)
	require.True(t, nextSnapshot.After(clock.Now().Add(time.Minute)))

	nextVerify, ok := src.sm.getNextVerifyTime()
	require.True(t, ok)
	require.True(t, nextVerify.After(clock.Now().Add(time.Minute)))
}

// TestSchedulerSimulationCatchesUpOnceAcrossASimulatedSleep simulates the machine being asleep through
// several scheduled times for one of two sources, mid-scenario, and confirms the driven, multi-source loop
// still produces exactly one catch-up attempt for the affected source -- not a burst, and without disturbing
// the other, unaffected source's own independent schedule.
func TestSchedulerSimulationCatchesUpOnceAcrossASimulatedSleep(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)
	t0 := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC)
	setClock(t, t0)

	a := newSchedSimSource(t, ctx, env, "a", 3600, 0)
	b := newSchedSimSource(t, ctx, env, "b", 3600, 0)

	// both sources get their first, on-schedule snapshot.
	driveRounds(t, testlogging.Context(t), []*schedSimServer{a, b}, 2)
	require.Equal(t, 1, a.snapshotCalls)
	require.Equal(t, 1, b.snapshotCalls)

	// the machine sleeps for 7 hours: nothing runs or advances the clock in between (unlike driveRounds,
	// which always jumps to the next real due time -- this jump is bigger than any pending due time, the
	// same gap a real missed wall-clock period produces).
	advanceClock(t, clock.Now().Add(7*time.Hour))

	// badly overdue for both sources now; each must catch up with exactly one immediate snapshot apiece,
	// not one per missed hourly slot.
	driveRounds(t, testlogging.Context(t), []*schedSimServer{a, b}, 2)
	require.Equal(t, 2, a.snapshotCalls, "exactly one catch-up run, not one per slept-through hour")
	require.Equal(t, 2, b.snapshotCalls, "the other source catches up independently, the same way")
}
