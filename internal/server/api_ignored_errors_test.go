package server

import (
	"context"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/ignoreerr"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/internal/uitask"
	"github.com/kopia/kopia/snapshot"
)

// ignoringServer is a server with task history for a snapshot of u@h:/data that failed on 3 files
// under Library/Accounts, and rules that can be added to.
func ignoringServer(t *testing.T) (*Server, string) {
	t.Helper()

	s, _, dir := newHistoryServer(t)
	s.options.UIPreferencesFile = filepath.Join(dir, "ui-preferences.json")
	s.setupIgnoredErrors(context.Background())
	require.NotNil(t, s.ignored)

	id := runTask(t, s, "Snapshot", "u@h:/data at 2026-10-01", false)
	s.recordSnapshotResult(context.Background(), id, snapshot.SourceInfo{Host: "h", UserName: "u", Path: "/data"}, manifestWithErrors(3))

	return s, id
}

func addRule(t *testing.T, s *Server, body string) *apiError {
	t.Helper()

	_, aerr := handleIgnoredErrorsAdd(context.Background(), rcFor(s, http.MethodPost, "/", body, nil))

	return aerr
}

func TestIgnoredErrorsAddListRemove(t *testing.T) {
	s, _ := ignoringServer(t)
	ctx := context.Background()

	require.Nil(t, addRule(t, s, `{"source":"/data","path":"Library/Accounts","scope":"folder","kind":"permission","expiresDays":30}`))
	require.Nil(t, addRule(t, s, `{"source":"/data","path":"nothing/here","scope":"file"}`))

	for _, bad := range []string{`{"scope":"file"}`, `{"scope":"folder"}`, `{"path":"a","scope":"x"}`, `{"path":"a","scope":"file","expiresDays":-1}`, `nope`} {
		require.NotNil(t, addRule(t, s, bad), bad)
	}

	out, aerr := handleIgnoredErrorsList(ctx, rcFor(s, http.MethodGet, "/", "", nil))
	require.Nil(t, aerr)

	rules := out.(ignoredErrorsResponse).Rules
	require.Len(t, rules, 2)
	require.Equal(t, 3, rules[0].Hides, "all 3 errors of the newest snapshot")
	require.Zero(t, rules[1].Hides)
	require.NotNil(t, rules[0].Expires)
	require.Nil(t, rules[1].Expires)

	_, aerr = handleIgnoredErrorsRemove(ctx, rcFor(s, http.MethodDelete, "/", "", map[string]string{"id": rules[0].ID}))
	require.Nil(t, aerr)

	_, aerr = handleIgnoredErrorsRemove(ctx, rcFor(s, http.MethodDelete, "/", "", map[string]string{"id": rules[0].ID}))
	require.NotNil(t, aerr)

	out, _ = handleIgnoredErrorsList(ctx, rcFor(s, http.MethodGet, "/", "", nil))
	require.Len(t, out.(ignoredErrorsResponse).Rules, 1)
}

func TestIgnoredErrorsNeedAPreferencesFile(t *testing.T) {
	s, _, _ := newHistoryServer(t)
	s.setupIgnoredErrors(context.Background())
	require.Nil(t, s.ignored)

	_, aerr := handleIgnoredErrorsList(context.Background(), rcFor(s, http.MethodGet, "/", "", nil))
	require.NotNil(t, aerr)
}

func TestIgnoredErrorsAreHiddenFromTasks(t *testing.T) {
	s, id := ignoringServer(t)

	errsOf := func() serverapi.TaskErrorsResponse {
		res, aerr := callAPIWithVars(t, s, handleTaskErrors, id)
		require.Nil(t, aerr)

		return res.(serverapi.TaskErrorsResponse)
	}

	listed := func() uitask.Info {
		res, aerr := callAPI(t, s, handleTaskList, "")
		require.Nil(t, aerr)

		return res.(serverapi.TaskListResponse).Tasks[0]
	}

	before := errsOf()
	require.Equal(t, "/data", before.Source)
	require.Equal(t, "u", before.UserName)
	require.Equal(t, "h", before.Host)
	require.Len(t, before.Errors, 3)
	require.Equal(t, ignoreerr.KindPermission, before.Errors[0].Kind)
	require.False(t, before.Errors[0].Ignored)
	require.Equal(t, 3, listed().FailedFiles)

	require.Nil(t, addRule(t, s, `{"source":"/data","path":"Library/Accounts/f1","scope":"file"}`))

	after := errsOf()
	require.Len(t, after.Errors, 3, "ignored errors are still recorded")

	ignored := 0
	for _, e := range after.Errors {
		if e.Ignored {
			ignored++
		}
	}

	require.Equal(t, 1, ignored)
	require.Equal(t, 2, listed().FailedFiles)
	require.Equal(t, 1, listed().IgnoredFiles)

	require.Nil(t, addRule(t, s, `{"path":"Library","scope":"folder"}`))
	require.Zero(t, listed().FailedFiles)
	require.Equal(t, 3, listed().IgnoredFiles)
}

func TestIgnoredErrorsDoNotCountForTheVerifier(t *testing.T) {
	s, _ := ignoringServer(t)
	src := snapshot.SourceInfo{Host: "h", UserName: "u", Path: "/data"}

	m := manifestWithErrors(30)
	m.Source = src

	require.Equal(t, 30, failedFiles(m, s.ignored))
	require.False(t, checkFailedFiles(map[snapshot.SourceInfo][]*snapshot.Manifest{src: {m}}, s.ignored).OK)

	require.Nil(t, addRule(t, s, `{"source":"/data","path":"Library/Accounts","scope":"folder","kind":"permission"}`))
	require.Zero(t, failedFiles(m, s.ignored))
	require.True(t, checkFailedFiles(map[snapshot.SourceInfo][]*snapshot.Manifest{src: {m}}, s.ignored).OK)
}
