package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gorilla/mux"
	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/fs"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/internal/taskstore"
	"github.com/kopia/kopia/internal/uitask"
	"github.com/kopia/kopia/snapshot"
)

func newHistoryServer(t *testing.T) (*Server, *taskstore.Store, string) {
	t.Helper()

	dir := t.TempDir()

	h, err := taskstore.Open(filepath.Join(dir, "task-history.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = h.Close() })

	s := &Server{
		options: Options{
			TaskHistory:           h,
			TaskHistoryBackupFile: filepath.Join(dir, "task-history.backup.sqlite"),
		},
		taskmgr: uitask.NewManager(false),
	}

	require.NoError(t, s.taskmgr.SetHistory(h))

	return s, h, dir
}

func callAPI(t *testing.T, s *Server, handler func(context.Context, requestContext) (any, *apiError), query string) (any, *apiError) {
	t.Helper()

	u := "/api/v1/tasks"
	if query != "" {
		u += "?" + query
	}

	req := httptest.NewRequest(http.MethodGet, u, http.NoBody)

	return handler(context.Background(), requestContext{w: httptest.NewRecorder(), req: req, srv: s})
}

func runTask(t *testing.T, s *Server, kind, desc string, fail bool) string {
	t.Helper()

	var id string

	err := s.taskmgr.Run(context.Background(), kind, desc, func(_ context.Context, ctrl uitask.Controller) error {
		id = ctrl.CurrentTaskID()

		if fail {
			return errTest
		}

		return nil
	})

	if fail {
		require.Error(t, err)
	} else {
		require.NoError(t, err)
	}

	return id
}

var errTest = &testError{"permission denied on Library/Accounts"}

type testError struct{ s string }

func (e *testError) Error() string { return e.s }

func TestTaskListAPIFiltersAndPages(t *testing.T) {
	s, _, _ := newHistoryServer(t)

	for i := 0; i < 12; i++ {
		kind := "Snapshot"
		if i%4 == 3 {
			kind = "Maintenance"
		}

		runTask(t, s, kind, "task "+uitask.FormatTaskID(i+1), i%3 == 0)
	}

	res, aerr := callAPI(t, s, handleTaskList, "")
	require.Nil(t, aerr)

	all := res.(serverapi.TaskListResponse)
	require.True(t, all.History)
	require.Equal(t, 12, all.Total)
	require.Len(t, all.Tasks, 12)
	require.Equal(t, []string{"Maintenance", "Snapshot"}, all.Kinds)
	require.Equal(t, "c", all.Tasks[0].TaskID, "newest first")

	res, aerr = callAPI(t, s, handleTaskList, "status=FAILED")
	require.Nil(t, aerr)
	require.Equal(t, 4, res.(serverapi.TaskListResponse).Total)

	res, _ = callAPI(t, s, handleTaskList, "kind=Maintenance")
	require.Equal(t, 3, res.(serverapi.TaskListResponse).Total)

	res, _ = callAPI(t, s, handleTaskList, "q="+url.QueryEscape("LIBRARY/accounts"))
	require.Equal(t, 4, res.(serverapi.TaskListResponse).Total)

	// paging by the id of the last task seen
	res, _ = callAPI(t, s, handleTaskList, "limit=5")
	page1 := res.(serverapi.TaskListResponse)
	require.Len(t, page1.Tasks, 5)
	require.Equal(t, 12, page1.Total)

	res, _ = callAPI(t, s, handleTaskList, "limit=5&before="+page1.Tasks[4].TaskID)
	page2 := res.(serverapi.TaskListResponse)
	require.Len(t, page2.Tasks, 5)
	require.Equal(t, "7", page2.Tasks[0].TaskID)

	future := url.QueryEscape(time.Now().Add(time.Hour).Format(time.RFC3339))
	res, _ = callAPI(t, s, handleTaskList, "from="+future)
	require.Empty(t, res.(serverapi.TaskListResponse).Tasks)
	require.NotNil(t, res.(serverapi.TaskListResponse).Tasks, "an empty list is [], never null")

	for _, bad := range []string{"from=yesterday", "to=x", "before=zz", "limit=-3", "limit=many"} {
		_, aerr = callAPI(t, s, handleTaskList, bad)
		require.NotNil(t, aerr, bad)
		require.Equal(t, serverapi.ErrorMalformedRequest, aerr.apiErrorCode, bad)
	}
}

func TestTaskListAPIWithoutHistory(t *testing.T) {
	s := &Server{taskmgr: uitask.NewManager(false)}
	require.NoError(t, s.taskmgr.Run(context.Background(), "Snapshot", "only in memory", func(context.Context, uitask.Controller) error { return nil }))

	res, aerr := callAPI(t, s, handleTaskList, "")
	require.Nil(t, aerr)

	r := res.(serverapi.TaskListResponse)
	require.False(t, r.History)
	require.Len(t, r.Tasks, 1)

	res, aerr = callAPIWithVars(t, s, handleTaskErrors, "1")
	require.Nil(t, aerr)
	require.Empty(t, res.(serverapi.TaskErrorsResponse).Errors)

	res, aerr = callAPI(t, s, handleStorageUsageHistory, "")
	require.Nil(t, aerr)
	require.Empty(t, res)
}

func manifestWithErrors(n int) *snapshot.Manifest {
	var failed []*fs.EntryWithError

	for i := 0; i < n; i++ {
		failed = append(failed, &fs.EntryWithError{EntryPath: "Library/Accounts/f" + uitask.FormatTaskID(i), Error: "open /x: permission denied"})
	}

	return &snapshot.Manifest{
		ID: "snap1",
		RootEntry: &snapshot.DirEntry{DirSummary: &fs.DirectorySummary{
			TotalFileSize: 1000, TotalFileCount: 40, FatalErrorCount: n, FailedEntries: failed,
		}},
	}
}

func TestSnapshotResultIsRecordedWithItsErrors(t *testing.T) {
	s, h, _ := newHistoryServer(t)

	id := runTask(t, s, "Snapshot", "u@h:/data at 2026-10-01", false)
	src := snapshot.SourceInfo{Host: "h", UserName: "u", Path: "/data"}

	s.recordSnapshotResult(context.Background(), id, src, manifestWithErrors(3))

	errs, err := h.SnapshotErrors(id)
	require.NoError(t, err)
	require.Len(t, errs, 3)

	// the errors stay available for auditing after a restart
	require.NoError(t, h.Close())

	h2, err := taskstore.Open(h.Path())
	require.NoError(t, err)

	defer h2.Close() //nolint:errcheck

	errs, err = h2.SnapshotErrors(id)
	require.NoError(t, err)
	require.Len(t, errs, 3)

	s.options.TaskHistory = h2
	require.NoError(t, s.taskmgr.SetHistory(h2))

	res, aerr := callAPIWithVars(t, s, handleTaskErrors, id)
	require.Nil(t, aerr)

	api := res.(serverapi.TaskErrorsResponse)
	require.Len(t, api.Errors, 3)
	require.Equal(t, "Library/Accounts/f0", api.Errors[0].Path)
	require.Equal(t, "open /x: permission denied", api.Errors[0].Error)

	// snapshots that failed completely or have no summary record nothing and do not crash
	s.recordSnapshotResult(context.Background(), id, src, &snapshot.Manifest{})
	s.recordSnapshotResult(context.Background(), "", src, manifestWithErrors(1))

	again, err := h2.SnapshotErrors(id)
	require.NoError(t, err)
	require.Empty(t, again, "recording an empty result replaces the earlier one for that task")
}

func callAPIWithVars(t *testing.T, s *Server, handler func(context.Context, requestContext) (any, *apiError), taskID string) (any, *apiError) {
	t.Helper()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/tasks/"+taskID+"/errors", http.NoBody)
	req = mux.SetURLVars(req, map[string]string{"taskID": taskID})

	return handler(context.Background(), requestContext{w: httptest.NewRecorder(), req: req, srv: s})
}

func TestStorageUsageHistoryAPI(t *testing.T) {
	s, h, _ := newHistoryServer(t)

	require.NoError(t, h.RecordStorageUsage(taskstore.StorageUsage{ComputedAt: time.Now(), TotalBytes: 123, BlobCount: 4, ElapsedMS: 5}))

	res, aerr := callAPI(t, s, handleStorageUsageHistory, "")
	require.Nil(t, aerr)

	b, err := json.Marshal(res)
	require.NoError(t, err)
	require.Contains(t, string(b), `"totalBytes":123`)
}

func TestMaintenancePrunesAndBacksUp(t *testing.T) {
	s, h, dir := newHistoryServer(t)

	old := time.Now().Add(-400 * 24 * time.Hour)

	require.NoError(t, h.TaskStarted(uitask.Info{TaskID: "64", Kind: "Snapshot", Description: "ancient", Status: uitask.StatusRunning, StartTime: old}))
	end := old.Add(time.Minute)
	require.NoError(t, h.TaskFinished(uitask.Info{TaskID: "64", Kind: "Snapshot", Description: "ancient", Status: uitask.StatusSuccess, StartTime: old, EndTime: &end}, nil))

	id := runTask(t, s, "Snapshot", "recent", false)

	s.options.TaskHistoryRetention = 365 * 24 * time.Hour

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})

	go func() {
		defer close(done)

		s.maintainTaskHistory(ctx)
	}()

	// the backup appears when the first maintenance run is complete (opening it would create an empty one)
	require.Eventually(t, func() bool {
		_, err := os.Stat(filepath.Join(dir, "task-history.backup.sqlite"))
		return err == nil
	}, 10*time.Second, 20*time.Millisecond)

	cancel()
	<-done

	_, ok, err := h.GetTask(0x64)
	require.NoError(t, err)
	require.False(t, ok, "the task older than the retention period is removed")

	_, ok, err = h.GetTask(1)
	require.NoError(t, err)
	require.True(t, ok)

	cp, err := taskstore.Open(filepath.Join(dir, "task-history.backup.sqlite"))
	require.NoError(t, err)

	defer cp.Close() //nolint:errcheck

	got, ok, err := cp.GetTask(1)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, "recent", got.Description)
	require.Equal(t, "1", id)
}
