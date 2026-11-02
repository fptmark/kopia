package server

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/testlogging"
	"github.com/kopia/kopia/internal/uitask"
)

func TestRecentlyUnstable(t *testing.T) {
	v := &verifier{}
	now := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC)

	require.False(t, v.recentlyUnstable(now), "nothing has ever flagged instability yet")

	v.instabilityUntil = now.Add(90 * time.Minute)
	require.True(t, v.recentlyUnstable(now))
	require.True(t, v.recentlyUnstable(now.Add(89*time.Minute)))
	require.False(t, v.recentlyUnstable(now.Add(91*time.Minute)), "the window has elapsed")
}

// TestCancelBackgroundTasksForInstabilityCancelsTheRightKinds reproduces the scenario behind a Verify stuck
// for hours: a real uitask.Manager with running tasks of several kinds, cancelBackgroundTasksForInstability
// must cancel the Snapshot/Verify/Maintenance ones (matching how a real task registers its own cancel func
// via ctrl.OnCancel, the same path cancelTask/the GUI's Stop button use) and leave anything else running.
func TestCancelBackgroundTasksForInstabilityCancelsTheRightKinds(t *testing.T) {
	tm := uitask.NewManager(false)
	srv := &Server{taskmgr: tm}

	started := make(chan struct{}, 4)

	var mu sync.Mutex
	canceled := map[string]bool{}

	runCancelable := func(kind string) {
		go tm.Run(testlogging.Context(t), kind, kind+" task", func(ctx context.Context, ctrl uitask.Controller) error { //nolint:errcheck
			ctx, cancel := context.WithCancel(ctx)
			ctrl.OnCancel(cancel)

			started <- struct{}{}
			<-ctx.Done()

			mu.Lock()
			canceled[kind] = true
			mu.Unlock()

			return ctx.Err()
		})
	}

	// a kind outside the three that should be touched: never registers a cancel func, and has its own
	// short timeout so the test doesn't leave it running past the test itself.
	go func() {
		ctx, cancel := context.WithTimeout(testlogging.Context(t), 2*time.Second)
		defer cancel()

		tm.Run(ctx, "Repository", "unrelated task", func(ctx context.Context, ctrl uitask.Controller) error { //nolint:errcheck
			started <- struct{}{}
			<-ctx.Done()
			return ctx.Err()
		})
	}()

	runCancelable("Snapshot")
	runCancelable("Verify")
	runCancelable("Maintenance")

	for range 4 {
		<-started
	}

	srv.cancelBackgroundTasksForInstability(testlogging.Context(t))

	require.Eventually(t, func() bool {
		mu.Lock()
		defer mu.Unlock()

		return canceled["Snapshot"] && canceled["Verify"] && canceled["Maintenance"]
	}, time.Second, 5*time.Millisecond, "Snapshot, Verify and Maintenance tasks must all be canceled")

	mu.Lock()
	defer mu.Unlock()
	require.False(t, canceled["Repository"], "a kind outside Snapshot/Verify/Maintenance must not be canceled")
}
