package server

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// TestDeferredSchedulerItemTreatsEveryTaskKindTheSame is the regression test for the bug behind a flood of
// snapshots every ~1 minute after waking from sleep: scheduling used to defer snapshot/verify one way (a
// near-future NextTime that the scheduler fired for real) and maintenance another way (excluded from the
// list entirely), and the snapshot/verify path had no actual guard against the scheduler firing real work
// the moment that near-future time arrived. deferredSchedulerItem is the one place that now decides this,
// the same way for any kind of background work, so this test drives it directly with three different
// "kinds" of trigger and requires identical treatment: real due time and a live trigger while stable, a
// near-future no-op while recently unstable -- Trigger() must never run the real work in that case.
func TestDeferredSchedulerItemTreatsEveryTaskKindTheSame(t *testing.T) {
	now := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC)
	setClock(t, now)

	realDueTime := now.Add(time.Hour)

	kinds := []string{"snapshot", "verify", "maintenance"}

	// stable: every kind gets its real due time, and Trigger() actually runs the real work.
	for _, kind := range kinds {
		srv := &Server{}

		ran := false
		item := srv.deferredSchedulerItem(kind, realDueTime, func() { ran = true })

		require.Equal(t, kind, item.Description)
		require.True(t, realDueTime.Equal(item.NextTime))

		item.Trigger()
		require.True(t, ran, "%s: the real trigger must run while the system is stable", kind)
	}

	// recently unstable: every kind defers the same way -- a near-future recheck, and Trigger() must not
	// run the real work.
	v := &verifier{instabilityUntil: now.Add(90 * time.Minute)}

	for _, kind := range kinds {
		srv := &Server{}
		srv.verify.Store(v)

		ran := false
		item := srv.deferredSchedulerItem(kind, realDueTime, func() { ran = true })

		require.NotEqual(t, realDueTime, item.NextTime, "%s: must not be left at the real (overdue) due time", kind)
		require.False(t, item.NextTime.After(now.Add(instabilityRecheckInterval)), "%s: recheck must be near-future", kind)
		require.False(t, item.NextTime.Before(now), "%s: recheck must not be in the past", kind)

		item.Trigger()
		require.False(t, ran, "%s: the real trigger must not run while the system is recently unstable", kind)
	}
}
