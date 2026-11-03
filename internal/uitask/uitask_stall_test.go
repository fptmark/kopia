package uitask

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/taskprogress"
)

// withShortStallPolling shrinks stallCheckInterval for the duration of the test, so these tests run in
// milliseconds instead of waiting on real StallTimeout-sized ticks.
func withShortStallPolling(tb testing.TB) {
	tb.Helper()

	orig := stallCheckInterval
	stallCheckInterval = 5 * time.Millisecond
	tb.Cleanup(func() { stallCheckInterval = orig })
}

// TestRunCancelsATaskThatStalls reproduces the bug behind a task sitting silent for minutes (see
// taskprogress): a task that never ticks its Reporter -- because every call it makes is stuck, or because it
// simply never calls anything that would -- must be canceled on its own once StallTimeout() elapses, with a
// CancelReason distinguishing this from a user Stop, rather than being left to run indefinitely.
func TestRunCancelsATaskThatStalls(t *testing.T) {
	withShortStallPolling(t)

	m := NewManager(false)
	m.StallTimeout = func() time.Duration { return 20 * time.Millisecond }

	canceledCtx := make(chan struct{})

	err := m.Run(context.Background(), "Verify", "stalls forever", func(ctx context.Context, ctrl Controller) error {
		ctx, cancel := context.WithCancel(ctx)
		ctrl.OnCancel(cancel)

		<-ctx.Done()
		close(canceledCtx)

		return ctx.Err()
	})

	select {
	case <-canceledCtx:
	default:
		t.Fatal("the task's own context was never canceled")
	}

	require.Error(t, err)

	tasks := m.ListTasks()
	require.Len(t, tasks, 1)
	require.Equal(t, StatusCanceled, tasks[0].Status)
	require.Contains(t, tasks[0].CancelReason, "no response from storage")
}

// TestRunDoesNotCancelATaskThatKeepsTicking is the companion case: a task that calls taskprogress.Tick(ctx)
// -- as internal/retry now does on every storage operation attempt -- faster than it stalls must run to
// completion untouched, however long it takes in total.
func TestRunDoesNotCancelATaskThatKeepsTicking(t *testing.T) {
	withShortStallPolling(t)

	m := NewManager(false)
	m.StallTimeout = func() time.Duration { return 15 * time.Millisecond }

	const ticks = 8

	err := m.Run(context.Background(), "Verify", "keeps making progress", func(ctx context.Context, _ Controller) error {
		for range ticks {
			time.Sleep(5 * time.Millisecond)
			taskprogress.Tick(ctx)
		}

		return nil
	})

	require.NoError(t, err)

	tasks := m.ListTasks()
	require.Len(t, tasks, 1)
	require.Equal(t, StatusSuccess, tasks[0].Status)
	require.Empty(t, tasks[0].CancelReason)
}

// TestRunWithoutStallTimeoutUsesTheDefault documents that a nil StallTimeout (the zero value most callers,
// and every pre-existing test, actually have) does not mean "disabled" -- it falls back to
// defaultStallTimeout, not a 0s (immediately-stall-everything) or infinite timeout.
func TestRunWithoutStallTimeoutUsesTheDefault(t *testing.T) {
	m := NewManager(false)
	require.Equal(t, defaultStallTimeout, m.stallTimeout())
}

// TestWatchForStallStopsItsGoroutineWhenTheTaskFinishesNormally guards against a goroutine leak: a task that
// finishes well within StallTimeout must not leave its watchdog goroutine running.
func TestWatchForStallStopsItsGoroutineWhenTheTaskFinishesNormally(t *testing.T) {
	withShortStallPolling(t)

	m := NewManager(false)
	m.StallTimeout = func() time.Duration { return time.Hour } // would never fire within this test

	err := m.Run(context.Background(), "Snapshot", "finishes fast", func(context.Context, Controller) error {
		return errors.New("boom")
	})

	require.Error(t, err)

	tasks := m.ListTasks()
	require.Len(t, tasks, 1)
	require.Equal(t, StatusFailed, tasks[0].Status)
	require.Empty(t, tasks[0].CancelReason, "a normal failure is not a server-initiated cancel")
}
