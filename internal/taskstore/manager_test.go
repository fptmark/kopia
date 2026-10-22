package taskstore_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/taskstore"
	"github.com/kopia/kopia/internal/uitask"
	"github.com/kopia/kopia/repo/logging"
)

func loggerFor(ctx context.Context) logging.Logger {
	return logging.Module("taskstore-test")(ctx)
}

func newManager(t *testing.T, path string) (*uitask.Manager, *taskstore.Store) {
	t.Helper()

	s, err := taskstore.Open(path)
	require.NoError(t, err)

	m := uitask.NewManager(false)
	require.NoError(t, m.SetHistory(s))

	return m, s
}

func TestHistorySurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "task-history.db")
	ctx := context.Background()

	m, s := newManager(t, path)

	require.NoError(t, m.Run(ctx, "Snapshot", "first", func(ctx context.Context, ctrl uitask.Controller) error {
		ctrl.ReportCounters(map[string]uitask.CounterValue{"Files": uitask.SimpleCounter(12)})
		return nil
	}))
	require.Error(t, m.Run(ctx, "Snapshot", "second fails", func(context.Context, uitask.Controller) error {
		return errors.New("kaboom")
	}))
	require.NoError(t, s.Close())

	// a new server process: nothing in memory, same database
	m2, s2 := newManager(t, path)

	defer s2.Close() //nolint:errcheck

	require.Empty(t, m2.ListTasks(), "nothing is held in memory after a restart")

	got, total, err := m2.QueryTasks(ctx, uitask.TaskQuery{})
	require.NoError(t, err)
	require.Equal(t, 2, total)
	require.Len(t, got, 2)
	require.Equal(t, "second fails", got[0].Description)
	require.Equal(t, uitask.StatusFailed, got[0].Status)
	require.Equal(t, "kaboom", got[0].ErrorMessage)
	require.Equal(t, uitask.StatusSuccess, got[1].Status)
	require.EqualValues(t, 12, got[1].Counters["Files"].Value)

	// the task pages still work for old task IDs
	one, ok := m2.GetTask(got[1].TaskID)
	require.True(t, ok)
	require.Equal(t, "first", one.Description)

	// new tasks continue the numbering instead of reusing IDs
	var newID string

	require.NoError(t, m2.Run(ctx, "Snapshot", "third", func(_ context.Context, ctrl uitask.Controller) error {
		newID = ctrl.CurrentTaskID()
		return nil
	}))
	require.Equal(t, "3", newID)

	all, total, err := m2.QueryTasks(ctx, uitask.TaskQuery{})
	require.NoError(t, err)
	require.Equal(t, 3, total)
	require.Equal(t, "third", all[0].Description)
}

func TestHistoryKeepsMoreThanTheInMemoryLimit(t *testing.T) {
	ctx := context.Background()
	m, s := newManager(t, filepath.Join(t.TempDir(), "task-history.db"))

	defer s.Close() //nolint:errcheck

	const n = 120 // the in-memory list keeps only 50 finished tasks

	for i := 0; i < n; i++ {
		require.NoError(t, m.Run(ctx, "Snapshot", "task", func(context.Context, uitask.Controller) error { return nil }))
	}

	require.Len(t, m.ListTasks(), 50)

	got, total, err := m.QueryTasks(ctx, uitask.TaskQuery{Limit: 1000})
	require.NoError(t, err)
	require.Equal(t, n, total)
	require.Len(t, got, n)

	// a task that already dropped out of memory is still found, with its log
	old, ok := m.GetTask("1")
	require.True(t, ok)
	require.Equal(t, "task", old.Description)
}

func TestLogsOfOldTasksAreAvailable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "task-history.db")
	ctx := context.Background()

	m, s := newManager(t, path)
	require.NoError(t, m.Run(ctx, "Maintenance", "with log", func(ctx context.Context, _ uitask.Controller) error {
		logger := loggerFor(ctx)
		logger.Infof("hello from the task")

		return nil
	}))
	require.NoError(t, s.Close())

	m2, s2 := newManager(t, path)

	defer s2.Close() //nolint:errcheck

	lines := m2.TaskLog("1")
	require.NotEmpty(t, lines)
	require.Contains(t, string(lines[0]), "hello from the task")
}

func TestRunningTaskIsListedOnceAndFirst(t *testing.T) {
	ctx := context.Background()
	m, s := newManager(t, filepath.Join(t.TempDir(), "task-history.db"))

	defer s.Close() //nolint:errcheck

	require.NoError(t, m.Run(ctx, "Snapshot", "done", func(context.Context, uitask.Controller) error { return nil }))

	started := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})

	go func() {
		defer close(done)

		_ = m.Run(ctx, "Snapshot", "in progress", func(context.Context, uitask.Controller) error {
			close(started)
			<-release

			return nil
		})
	}()

	<-started

	got, total, err := m.QueryTasks(ctx, uitask.TaskQuery{})
	require.NoError(t, err)
	require.Equal(t, 2, total)
	require.Len(t, got, 2)
	require.Equal(t, uitask.StatusRunning, got[0].Status)
	require.Equal(t, "in progress", got[0].Description)

	running, total, err := m.QueryTasks(ctx, uitask.TaskQuery{Status: "RUNNING"})
	require.NoError(t, err)
	require.Equal(t, 1, total)
	require.Len(t, running, 1)

	close(release)
	<-done

	got, total, err = m.QueryTasks(ctx, uitask.TaskQuery{})
	require.NoError(t, err)
	require.Equal(t, 2, total)
	require.Equal(t, uitask.StatusSuccess, got[0].Status)
}

func TestQueryWithoutHistoryUsesMemory(t *testing.T) {
	ctx := context.Background()
	m := uitask.NewManager(false)

	require.NoError(t, m.Run(ctx, "Snapshot", "a", func(context.Context, uitask.Controller) error { return nil }))
	require.Error(t, m.Run(ctx, "Restore", "b", func(context.Context, uitask.Controller) error { return errors.New("x") }))

	got, total, err := m.QueryTasks(ctx, uitask.TaskQuery{Status: "FAILED"})
	require.NoError(t, err)
	require.Equal(t, 1, total)
	require.Equal(t, "b", got[0].Description)

	got, _, err = m.QueryTasks(ctx, uitask.TaskQuery{Text: "A"})
	require.NoError(t, err)
	require.Len(t, got, 1)

	got, _, err = m.QueryTasks(ctx, uitask.TaskQuery{From: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	require.Empty(t, got)
}
