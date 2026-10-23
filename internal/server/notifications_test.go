package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/notifyhub"
	"github.com/kopia/kopia/internal/taskstore"
	"github.com/kopia/kopia/internal/uitask"
)

type eventLog struct {
	mu  sync.Mutex
	got []notifyhub.Event
}

func (l *eventLog) Emit(_ context.Context, e notifyhub.Event) {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.got = append(l.got, e)
}

func (l *eventLog) events() []notifyhub.Event {
	l.mu.Lock()
	defer l.mu.Unlock()

	return append([]notifyhub.Event(nil), l.got...)
}

func TestSnapshotOutcomeEvents(t *testing.T) {
	l := &eventLog{}
	s := &Server{notifier: l}
	ctx := context.Background()
	sec := 16 * time.Second

	s.emitSnapshotOutcome(ctx, "/Users/me", nil, 0, 100, sec)
	s.emitSnapshotOutcome(ctx, "/Users/me", nil, 6, 662141, sec)
	s.emitSnapshotOutcome(ctx, "/Applications", errors.New("snapshot task: dial tcp 192.168.0.214:22: no route to host"), 0, 0, sec)
	s.emitSnapshotOutcome(ctx, "/Applications", errors.New("operation canceled"), 0, 0, sec)

	require.Equal(t, []notifyhub.Event{
		{ID: notifyhub.EventDone, Source: "/Users/me", Files: 100, Elapsed: sec},
		{ID: notifyhub.EventSkipped, Source: "/Users/me", Skipped: 6, Files: 662141},
		{ID: notifyhub.EventDone, Source: "/Users/me", Skipped: 6, Files: 662141, Elapsed: sec},
		{ID: notifyhub.EventFailed, Source: "/Applications"},
	}, l.events())

	// a server that is shutting down is not a failed backup
	cctx, cancel := context.WithCancel(ctx)
	cancel()

	s.emitSnapshotOutcome(cctx, "/Users/me", errors.New("boom"), 0, 0, sec)
	require.Len(t, l.events(), 4)
}

func TestSourcePath(t *testing.T) {
	require.Equal(t, "/Users/me", sourcePath("me@laptop:/Users/me"))
	require.Equal(t, "/a:b", sourcePath("u@h:/a:b"))
	require.Equal(t, "/Applications", sourcePath("/Applications"))
}

func TestBuildSummaryFromTaskHistory(t *testing.T) {
	s := notificationServer(t)
	h := s.options.TaskHistory
	base := time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC)

	add := func(seq int, kind string, st uitask.Status, hours int, src string, files, failed int64) {
		end := base.Add(time.Duration(hours)*time.Hour + time.Minute)
		info := uitask.Info{TaskID: fmt.Sprintf("%x", seq), Kind: kind, Status: st, StartTime: base.Add(time.Duration(hours) * time.Hour), EndTime: &end}
		require.NoError(t, h.TaskStarted(info))
		require.NoError(t, h.TaskFinished(info, nil))

		if src != "" {
			require.NoError(t, h.RecordSnapshotResult(info.TaskID, taskstore.SnapshotResult{Source: src, TotalFiles: files, FailedFiles: failed}))
		}
	}

	add(1, "Snapshot", uitask.StatusSuccess, 1, "me@h:/Users/me", 100, 0)
	add(2, "Snapshot", uitask.StatusSuccess, 2, "me@h:/Users/me", 110, 6)
	add(3, "Snapshot", uitask.StatusFailed, 3, "me@h:/Users/me", 0, 0)
	add(4, "Snapshot", uitask.StatusSuccess, 2, "me@h:/Applications", 50, 0)
	add(5, "Snapshot", uitask.StatusSuccess, -30, "me@h:/Users/me", 1, 0) // before the period
	add(6, "Maintenance", uitask.StatusSuccess, 4, "", 0, 0)
	add(7, "Maintenance", uitask.StatusFailed, 5, "", 0, 0)

	require.NoError(t, h.RecordStorageUsage(taskstore.StorageUsage{ComputedAt: base.Add(-2 * time.Hour), TotalBytes: 100}))
	require.NoError(t, h.RecordStorageUsage(taskstore.StorageUsage{ComputedAt: base.Add(6 * time.Hour), TotalBytes: 160}))

	sum, err := s.buildSummary(context.Background(), base, base.Add(8*time.Hour), "daily")
	require.NoError(t, err)

	require.Equal(t, []notifyhub.SourceSummary{{Source: "/Users/me", Snapshots: 2, Files: 110}, {Source: "/Applications", Snapshots: 1, Files: 50}}, sum.Sources)
	require.Equal(t, 1, sum.Failed)
	require.Equal(t, 1, sum.WithSkipped)
	require.EqualValues(t, 6, sum.MostSkipped)
	require.Equal(t, 2, sum.MaintRuns)
	require.Equal(t, 1, sum.MaintFailed)
	require.True(t, sum.HaveRepo)
	require.EqualValues(t, 160, sum.RepoBytes)
	require.True(t, sum.HaveGrowth)
	require.EqualValues(t, 60, sum.RepoGrowth)
	require.Equal(t, "not run", sum.Health)

	// no activity at all still gives a summary
	empty, err := s.buildSummary(context.Background(), base.Add(100*time.Hour), base.Add(110*time.Hour), "daily")
	require.NoError(t, err)
	require.Empty(t, empty.Sources)
}

func TestRepositoryOpenIsReportedOnlyWhenItStaysDown(t *testing.T) {
	old := repoUnreachableAfter
	repoUnreachableAfter = 50 * time.Millisecond

	defer func() { repoUnreachableAfter = old }()

	l := &eventLog{}
	s := &Server{notifier: l}
	ctx := context.Background()

	// a quick recovery (the first attempt after a deploy) is silent
	s.watchRepositoryOpen(ctx)(true)
	time.Sleep(120 * time.Millisecond)
	require.Empty(t, l.events())

	// a failure that is given up on is silent too: the retries are what is being watched
	s.watchRepositoryOpen(ctx)(false)
	time.Sleep(120 * time.Millisecond)
	require.Empty(t, l.events())

	// staying down is reported, and again every report interval (the hub sends it once per repeat period)
	oldReport := repoUnreachableReport
	repoUnreachableReport = 40 * time.Millisecond

	defer func() { repoUnreachableReport = oldReport }()

	end := s.watchRepositoryOpen(ctx)
	time.Sleep(200 * time.Millisecond)

	got := l.events()
	require.GreaterOrEqual(t, len(got), 3)
	require.Equal(t, notifyhub.ProblemRepoUnreachable, got[0].Problem)
	require.False(t, got[0].Since.IsZero())

	end(true)

	last := l.events()[len(l.events())-1]
	require.True(t, last.Recovered)
	require.Equal(t, notifyhub.ProblemRepoUnreachable, last.Problem)

	n := len(l.events())
	time.Sleep(120 * time.Millisecond)
	require.Len(t, l.events(), n, "nothing more once it ends")
}

func TestSetupNotificationsCarriesOverTheIMessageRecipient(t *testing.T) {
	dir := t.TempDir()
	prefs := filepath.Join(dir, "ui-preferences.json")
	require.NoError(t, os.WriteFile(prefs, []byte(`{"verifierIMessageTo":"+1 555 0100"}`), 0o600))

	s := &Server{options: Options{UIPreferencesFile: prefs}}
	s.setupNotifications(context.Background())
	require.NotNil(t, s.notifyHub)

	ds, err := notifyhub.Load(filepath.Join(dir, "notification-destinations.json"))
	require.NoError(t, err)
	require.Len(t, ds, 2)
	require.Equal(t, "+1 555 0100", ds[1].Target)
	require.Equal(t, notifyhub.FailureEvents, ds[1].Failures)

	// a start without preferences file sends nothing and does not fail
	s2 := &Server{}
	s2.setupNotifications(context.Background())
	s2.emit(context.Background(), notifyhub.Event{ID: notifyhub.EventFailed})
	require.Nil(t, s2.notifyHub)
}

func TestSetupNotificationsUpgradesAFileFromTheFirstVersion(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "notification-destinations.json")
	require.NoError(t, os.WriteFile(file, []byte(`{"destinations":[{"id":"mac","type":"mac","name":"This Mac","events":{"failed":"now"}}]}`), 0o600))

	s := &Server{options: Options{UIPreferencesFile: filepath.Join(dir, "ui-preferences.json")}}
	s.setupNotifications(context.Background())

	b, err := os.ReadFile(file)
	require.NoError(t, err)
	require.Contains(t, string(b), `"failures"`)
	require.NotContains(t, string(b), `"events"`)
}
