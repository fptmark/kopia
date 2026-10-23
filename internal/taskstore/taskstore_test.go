package taskstore_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/taskstore"
	"github.com/kopia/kopia/internal/uitask"
)

func openStore(t *testing.T) (*taskstore.Store, string) {
	t.Helper()

	path := filepath.Join(t.TempDir(), "sub", "task-history.db")
	s, err := taskstore.Open(path)
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })

	return s, path
}

func info(seq int, kind, desc string, status uitask.Status, start time.Time) uitask.Info {
	i := uitask.Info{
		TaskID:      uitask.FormatTaskID(seq),
		Kind:        kind,
		Description: desc,
		Status:      status,
		StartTime:   start,
		Counters:    map[string]uitask.CounterValue{},
	}

	if status.IsFinished() {
		end := start.Add(90 * time.Second)
		i.EndTime = &end
	}

	return i
}

func record(t *testing.T, s *taskstore.Store, i uitask.Info, logs ...string) {
	t.Helper()

	running := i
	running.Status = uitask.StatusRunning
	running.EndTime = nil
	require.NoError(t, s.TaskStarted(running))

	var lines []json.RawMessage
	for _, l := range logs {
		lines = append(lines, json.RawMessage(l))
	}

	require.NoError(t, s.TaskFinished(i, lines))
}

var t0 = time.Date(2026, time.October, 1, 12, 0, 0, 0, time.UTC)

func TestOpenCreatesAndReopens(t *testing.T) {
	s, path := openStore(t)
	record(t, s, info(1, "Snapshot", "first", uitask.StatusSuccess, t0))
	require.NoError(t, s.Close())

	s2, err := taskstore.Open(path)
	require.NoError(t, err)

	defer s2.Close() //nolint:errcheck

	got, ok, err := s2.GetTask(1)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, "first", got.Description)

	last, err := s2.MaxTaskSeq()
	require.NoError(t, err)
	require.Equal(t, 1, last)
}

func TestEmptyStore(t *testing.T) {
	s, _ := openStore(t)

	last, err := s.MaxTaskSeq()
	require.NoError(t, err)
	require.Zero(t, last)

	list, total, err := s.ListTasks(uitask.TaskQuery{})
	require.NoError(t, err)
	require.Empty(t, list)
	require.Zero(t, total)

	_, ok, err := s.GetTask(42)
	require.NoError(t, err)
	require.False(t, ok)
}

func TestRoundTripKeepsEverything(t *testing.T) {
	s, _ := openStore(t)

	i := info(0x1f, "Snapshot", "markmalamut@marks-laptop:/Users/markmalamut at 2026-10-01", uitask.StatusFailed, t0)
	i.ErrorMessage = "snapshot task: upload error: boom"
	i.Counters = map[string]uitask.CounterValue{
		"Hashed Files": uitask.SimpleCounter(574000),
		"Hashed Bytes": uitask.BytesCounter(198_000_000_000),
		"Errors":       uitask.ErrorCounter(6),
	}

	record(t, s, i, `{"ts":1,"mod":"uploader","level":1,"msg":"hello"}`, `{"ts":2,"mod":"uploader","level":3,"msg":"bad"}`)

	got, ok, err := s.GetTask(0x1f)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, "1f", got.TaskID)
	require.Equal(t, uitask.StatusFailed, got.Status)
	require.Equal(t, i.ErrorMessage, got.ErrorMessage)
	require.Equal(t, i.Description, got.Description)
	require.True(t, got.StartTime.Equal(t0))
	require.NotNil(t, got.EndTime)
	require.True(t, got.EndTime.Equal(t0.Add(90*time.Second)))
	require.Equal(t, i.Counters, got.Counters)

	logs, err := s.TaskLogs(0x1f)
	require.NoError(t, err)
	require.Len(t, logs, 2)
	require.JSONEq(t, `{"ts":2,"mod":"uploader","level":3,"msg":"bad"}`, string(logs[1]))
}

func TestFinishWithoutRecordedStart(t *testing.T) {
	s, _ := openStore(t)

	require.NoError(t, s.TaskFinished(info(7, "Restore", "late", uitask.StatusSuccess, t0), nil))

	got, ok, err := s.GetTask(7)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, uitask.StatusSuccess, got.Status)
}

func TestTasksRunningAtShutdownAreMarkedInterrupted(t *testing.T) {
	s, path := openStore(t)

	require.NoError(t, s.TaskStarted(info(1, "Snapshot", "was running", uitask.StatusRunning, t0)))
	record(t, s, info(2, "Snapshot", "finished fine", uitask.StatusSuccess, t0))
	require.NoError(t, s.Close())

	s2, err := taskstore.Open(path)
	require.NoError(t, err)

	defer s2.Close() //nolint:errcheck

	got, _, err := s2.GetTask(1)
	require.NoError(t, err)
	require.Equal(t, uitask.StatusFailed, got.Status)
	require.Contains(t, got.ErrorMessage, "interrupted")
	require.NotNil(t, got.EndTime)

	ok, _, err := s2.GetTask(2)
	require.NoError(t, err)
	require.Equal(t, uitask.StatusSuccess, ok.Status)
	require.Empty(t, ok.ErrorMessage)
}

func seed(t *testing.T, s *taskstore.Store) {
	t.Helper()

	statusOf := []uitask.Status{uitask.StatusSuccess, uitask.StatusFailed, uitask.StatusSuccess}

	for n := 1; n <= 30; n++ {
		kind := "Snapshot"
		if n%5 == 0 {
			kind = "Maintenance"
		}

		i := info(n, kind, "task number "+uitask.FormatTaskID(n), statusOf[n%3], t0.Add(time.Duration(n)*24*time.Hour))
		if i.Status == uitask.StatusFailed {
			i.ErrorMessage = "permission denied on Library/Accounts"
		}

		record(t, s, i)
	}
}

func TestListFiltersAndPaging(t *testing.T) {
	s, _ := openStore(t)
	seed(t, s)

	all, total, err := s.ListTasks(uitask.TaskQuery{Limit: 1000})
	require.NoError(t, err)
	require.Equal(t, 30, total)
	require.Len(t, all, 30)
	require.Equal(t, "1e", all[0].TaskID, "newest first")
	require.Equal(t, "1", all[29].TaskID)

	// default limit
	page, total, err := s.ListTasks(uitask.TaskQuery{})
	require.NoError(t, err)
	require.Equal(t, 30, total)
	require.Len(t, page, 30)

	// paging walks back without gaps or repeats
	var seen []string

	before := 0

	for {
		p, tot, err := s.ListTasks(uitask.TaskQuery{Limit: 7, BeforeSeq: before})
		require.NoError(t, err)
		require.Equal(t, 30, tot, "total ignores the page position")

		if len(p) == 0 {
			break
		}

		for _, x := range p {
			seen = append(seen, x.TaskID)
		}

		seq, _ := uitask.ParseTaskID(p[len(p)-1].TaskID)
		before = seq
	}

	require.Len(t, seen, 30)
	require.Len(t, uniq(seen), 30)

	failed, total, err := s.ListTasks(uitask.TaskQuery{Status: "FAILED", Limit: 1000})
	require.NoError(t, err)
	require.Equal(t, 10, total)

	for _, f := range failed {
		require.Equal(t, uitask.StatusFailed, f.Status)
	}

	maint, total, err := s.ListTasks(uitask.TaskQuery{Kind: "Maintenance", Limit: 1000})
	require.NoError(t, err)
	require.Equal(t, 6, total)
	require.Len(t, maint, 6)

	byText, total, err := s.ListTasks(uitask.TaskQuery{Text: "LIBRARY/accounts", Limit: 1000})
	require.NoError(t, err)
	require.Equal(t, 10, total, "matches the error text, ignoring case")
	require.Len(t, byText, 10)

	byDesc, _, err := s.ListTasks(uitask.TaskQuery{Text: "number 1e", Limit: 1000})
	require.NoError(t, err)
	require.Len(t, byDesc, 1)

	// date range: tasks 10..12 started on days 10..12
	ranged, total, err := s.ListTasks(uitask.TaskQuery{
		From: t0.Add(10 * 24 * time.Hour), To: t0.Add(12*24*time.Hour + time.Hour), Limit: 1000,
	})
	require.NoError(t, err)
	require.Equal(t, 3, total)
	require.Len(t, ranged, 3)

	// combined
	both, _, err := s.ListTasks(uitask.TaskQuery{Status: "FAILED", Kind: "Maintenance", Limit: 1000})
	require.NoError(t, err)

	for _, b := range both {
		require.Equal(t, "Maintenance", b.Kind)
		require.Equal(t, uitask.StatusFailed, b.Status)
	}

	// text with SQL-ish characters is just text
	odd, total, err := s.ListTasks(uitask.TaskQuery{Text: "'; DROP TABLE tasks; --%_"})
	require.NoError(t, err)
	require.Zero(t, total)
	require.Empty(t, odd)

	_, stillThere, err := s.ListTasks(uitask.TaskQuery{})
	require.NoError(t, err)
	require.Equal(t, 30, stillThere)
}

func uniq(in []string) map[string]bool {
	m := map[string]bool{}
	for _, s := range in {
		m[s] = true
	}

	return m
}

func TestSnapshotResultAndErrors(t *testing.T) {
	s, _ := openStore(t)
	record(t, s, info(5, "Snapshot", "snap", uitask.StatusSuccess, t0))
	record(t, s, info(6, "Snapshot", "snap 2", uitask.StatusSuccess, t0.Add(time.Hour)))

	errs := []taskstore.SnapshotError{
		{Path: "Library/Accounts/a", Error: "unable to open: permission denied"},
		{Path: "Library/Accounts/b", Error: "unable to open: permission denied"},
	}

	require.NoError(t, s.RecordSnapshotResult("5", taskstore.SnapshotResult{
		Source: "u@h:/Users/u", SnapshotID: "abc", TotalSize: 123, TotalFiles: 4, FailedFiles: 2, Errors: errs,
	}))

	got, err := s.SnapshotErrors("5")
	require.NoError(t, err)
	require.Equal(t, errs, got)

	none, err := s.SnapshotErrors("6")
	require.NoError(t, err)
	require.NotNil(t, none)
	require.Empty(t, none)

	// recording again replaces, it does not duplicate
	require.NoError(t, s.RecordSnapshotResult("5", taskstore.SnapshotResult{Source: "u@h:/Users/u", Errors: errs[:1]}))

	got, err = s.SnapshotErrors("5")
	require.NoError(t, err)
	require.Len(t, got, 1)

	require.Error(t, s.RecordSnapshotResult("zz", taskstore.SnapshotResult{}))
}

func TestFailedFileCountIsPartOfTheTask(t *testing.T) {
	s, _ := openStore(t)
	record(t, s, info(1, "Snapshot", "clean", uitask.StatusSuccess, t0))
	record(t, s, info(2, "Snapshot", "with failures", uitask.StatusSuccess, t0.Add(time.Hour)))
	require.NoError(t, s.RecordSnapshotResult("2", taskstore.SnapshotResult{FailedFiles: 143}))

	list, _, err := s.ListTasks(uitask.TaskQuery{})
	require.NoError(t, err)
	require.Len(t, list, 2)
	require.Equal(t, 143, list[0].FailedFiles)
	require.Zero(t, list[1].FailedFiles)

	one, ok, err := s.GetTask(2)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, 143, one.FailedFiles)
}

func TestPruneRemovesOldTasksAndTheirData(t *testing.T) {
	s, path := openStore(t)

	record(t, s, info(1, "Snapshot", "old", uitask.StatusSuccess, t0), `{"msg":"old log"}`)
	record(t, s, info(2, "Snapshot", "new", uitask.StatusSuccess, t0.Add(100*24*time.Hour)), `{"msg":"new log"}`)
	require.NoError(t, s.TaskStarted(info(3, "Snapshot", "still running, old", uitask.StatusRunning, t0)))
	require.NoError(t, s.RecordSnapshotResult("1", taskstore.SnapshotResult{Errors: []taskstore.SnapshotError{{Path: "p", Error: "e"}}}))

	n, err := s.Prune(t0.Add(50 * 24 * time.Hour))
	require.NoError(t, err)
	require.EqualValues(t, 1, n)

	_, ok, _ := s.GetTask(1)
	require.False(t, ok)
	_, ok, _ = s.GetTask(2)
	require.True(t, ok)
	_, ok, _ = s.GetTask(3)
	require.True(t, ok, "a running task is never pruned")

	logs, err := s.TaskLogs(1)
	require.NoError(t, err)
	require.Empty(t, logs, "logs go with the task")

	errs, err := s.SnapshotErrors("1")
	require.NoError(t, err)
	require.Empty(t, errs, "snapshot errors go with the task")

	// numbering still continues after the highest task, even after pruning everything older
	last, err := s.MaxTaskSeq()
	require.NoError(t, err)
	require.Equal(t, 3, last)

	require.NoError(t, s.Close())

	db, err := sql.Open("sqlite", "file:"+path)
	require.NoError(t, err)

	defer db.Close() //nolint:errcheck

	var orphans int
	require.NoError(t, db.QueryRow(`SELECT COUNT(*) FROM task_logs WHERE task_seq = 1`).Scan(&orphans))
	require.Zero(t, orphans)
}

func TestStorageUsageHistory(t *testing.T) {
	s, _ := openStore(t)

	h, err := s.StorageUsageHistory(10)
	require.NoError(t, err)
	require.NotNil(t, h)
	require.Empty(t, h)

	require.NoError(t, s.RecordStorageUsage(taskstore.StorageUsage{ComputedAt: t0, TotalBytes: 100, BlobCount: 5, ElapsedMS: 10}))
	require.NoError(t, s.RecordStorageUsage(taskstore.StorageUsage{ComputedAt: t0.Add(time.Hour), TotalBytes: 250, BlobCount: 9, ElapsedMS: 20}))

	h, err = s.StorageUsageHistory(10)
	require.NoError(t, err)
	require.Len(t, h, 2)
	require.EqualValues(t, 250, h[0].TotalBytes, "newest first")
	require.True(t, h[1].ComputedAt.Equal(t0))

	h, err = s.StorageUsageHistory(1)
	require.NoError(t, err)
	require.Len(t, h, 1)
}

func TestBackupIsAConsistentCopy(t *testing.T) {
	s, _ := openStore(t)
	seed(t, s)

	dest := filepath.Join(t.TempDir(), "task-history.backup.sqlite")
	require.NoError(t, s.BackupTo(context.Background(), dest))

	// back up again over the existing copy
	record(t, s, info(31, "Snapshot", "one more", uitask.StatusSuccess, t0.Add(40*24*time.Hour)))
	require.NoError(t, s.BackupTo(context.Background(), dest))

	cp, err := taskstore.Open(dest)
	require.NoError(t, err)

	defer cp.Close() //nolint:errcheck

	_, total, err := cp.ListTasks(uitask.TaskQuery{})
	require.NoError(t, err)
	require.Equal(t, 31, total)
}

func TestNewerSchemaIsRefused(t *testing.T) {
	_, path := openStore(t)

	db, err := sql.Open("sqlite", "file:"+path)
	require.NoError(t, err)
	_, err = db.Exec("PRAGMA user_version = 99")
	require.NoError(t, err)
	require.NoError(t, db.Close())

	_, err = taskstore.Open(path)
	require.ErrorContains(t, err, "newer version")
}

func TestReadableViewsForTheCommandLine(t *testing.T) {
	s, path := openStore(t)
	record(t, s, info(0xa, "Snapshot", "viewable", uitask.StatusFailed, t0))
	require.NoError(t, s.RecordSnapshotResult("a", taskstore.SnapshotResult{
		Source: "u@h:/x", Errors: []taskstore.SnapshotError{{Path: "p/q", Error: "denied"}},
	}))
	require.NoError(t, s.Close())

	db, err := sql.Open("sqlite", "file:"+path)
	require.NoError(t, err)

	defer db.Close() //nolint:errcheck

	var id, kind, started string

	require.NoError(t, db.QueryRow(`SELECT id, kind, started FROM task_history`).Scan(&id, &kind, &started))
	require.Equal(t, "a", id)
	require.Equal(t, "Snapshot", kind)
	require.NotEmpty(t, started)

	var task, p string

	require.NoError(t, db.QueryRow(`SELECT task, path FROM snapshot_error_history`).Scan(&task, &p))
	require.Equal(t, "a", task)
	require.Equal(t, "p/q", p)
}

func TestNotificationLogKeepsNewestFirst(t *testing.T) {
	s, _ := openStore(t)

	for i, status := range []string{"sent", "failed"} {
		require.NoError(t, s.RecordNotification(taskstore.NotificationEntry{
			SentAt: t0.Add(time.Duration(i) * time.Hour), Destination: "iphone", Event: "failed", Mode: "now", Status: status, Attempts: i + 1, Error: "e",
		}))
	}

	got, err := s.Notifications(10)
	require.NoError(t, err)
	require.Len(t, got, 2)
	require.Equal(t, "failed", got[0].Status)
	require.Equal(t, 2, got[0].Attempts)
	require.True(t, got[0].SentAt.Equal(t0.Add(time.Hour)))

	got, err = s.Notifications(1)
	require.NoError(t, err)
	require.Len(t, got, 1)
}

func TestRollupStateIsRememberedPerDestination(t *testing.T) {
	s, path := openStore(t)

	_, ok, err := s.LastRollup("iphone")
	require.NoError(t, err)
	require.False(t, ok)

	require.NoError(t, s.SetLastRollup("iphone", t0))
	require.NoError(t, s.SetLastRollup("iphone", t0.Add(time.Hour)))
	require.NoError(t, s.SetLastRollup("mac", t0))
	require.NoError(t, s.Close())

	s, err = taskstore.Open(path)
	require.NoError(t, err)

	defer s.Close() //nolint:errcheck

	got, ok, err := s.LastRollup("iphone")
	require.NoError(t, err)
	require.True(t, ok)
	require.True(t, got.Equal(t0.Add(time.Hour)), "survives a restart")
}

func TestDatabaseFromVersionOneGainsEveryLaterTable(t *testing.T) {
	s, path := openStore(t)
	require.NoError(t, s.Close())

	db, err := sql.Open("sqlite", "file:"+path)
	require.NoError(t, err)
	_, err = db.Exec("DROP TABLE notification_log")
	require.NoError(t, err)
	_, err = db.Exec("DROP TABLE notification_state")
	require.NoError(t, err)
	_, err = db.Exec("PRAGMA user_version = 1")
	require.NoError(t, err)
	require.NoError(t, db.Close())

	s, err = taskstore.Open(path)
	require.NoError(t, err)

	defer s.Close() //nolint:errcheck

	require.NoError(t, s.SetLastRollup("d", t0))
	require.NoError(t, s.RecordNotification(taskstore.NotificationEntry{SentAt: t0, Destination: "d", Event: "x", Mode: "now", Status: "sent", Attempts: 1}))
}

func TestActivityCountsByPeriodAndKeepsFailuresApart(t *testing.T) {
	s, _ := openStore(t)

	add := func(seq int, kind string, st uitask.Status, hours int, src string, files, failed int64) {
		i := info(seq, kind, "x", st, t0.Add(time.Duration(hours)*time.Hour))
		record(t, s, i)

		if src != "" {
			require.NoError(t, s.RecordSnapshotResult(i.TaskID, taskstore.SnapshotResult{Source: src, TotalFiles: files, FailedFiles: failed}))
		}
	}

	add(1, "Snapshot", uitask.StatusSuccess, 1, "u@h:/a", 10, 0)
	add(2, "Snapshot", uitask.StatusSuccess, 2, "u@h:/a", 12, 3)
	add(3, "Snapshot", uitask.StatusFailed, 3, "u@h:/a", 0, 0)
	add(4, "Snapshot", uitask.StatusSuccess, 30, "u@h:/a", 99, 0) // later than the period
	add(5, "Maintenance", uitask.StatusFailed, 4, "", 0, 0)
	add(6, "Maintenance", uitask.StatusSuccess, 5, "", 0, 0)

	acts, err := s.SnapshotActivity(t0, t0.Add(24*time.Hour))
	require.NoError(t, err)
	require.Equal(t, []taskstore.SourceActivity{{Source: "u@h:/a", Snapshots: 2, Files: 12, Failed: 1, WithSkipped: 1, MostSkipped: 3}}, acts)

	runs, failed, err := s.MaintenanceActivity(t0, t0.Add(24*time.Hour))
	require.NoError(t, err)
	require.Equal(t, 2, runs)
	require.Equal(t, 1, failed)

	acts, err = s.SnapshotActivity(t0.Add(100*time.Hour), t0.Add(200*time.Hour))
	require.NoError(t, err)
	require.Empty(t, acts)
}
