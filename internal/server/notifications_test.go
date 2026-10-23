package server

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/notifyhub"
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

	s.emitSnapshotOutcome(ctx, "/Users/me", nil, 0, 100)
	require.Empty(t, l.events(), "a clean snapshot sends nothing")

	s.emitSnapshotOutcome(ctx, "/Users/me", nil, 6, 662141)
	s.emitSnapshotOutcome(ctx, "/Applications", errors.New("snapshot task: dial tcp 192.168.0.214:22: no route to host"), 0, 0)
	s.emitSnapshotOutcome(ctx, "/Applications", errors.New("operation canceled"), 0, 0)

	require.Equal(t, []notifyhub.Event{
		{ID: notifyhub.EventSkipped, Source: "/Users/me", Skipped: 6, Files: 662141},
		{ID: notifyhub.EventFailed, Source: "/Applications"},
	}, l.events())

	// a server that is shutting down is not a failed backup
	cctx, cancel := context.WithCancel(ctx)
	cancel()

	s.emitSnapshotOutcome(cctx, "/Users/me", errors.New("boom"), 0, 0)
	require.Len(t, l.events(), 2)
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

	// staying down is reported once, and recovery is reported
	end := s.watchRepositoryOpen(ctx)
	time.Sleep(120 * time.Millisecond)
	require.Len(t, l.events(), 1)
	require.Equal(t, notifyhub.ProblemRepoUnreachable, l.events()[0].Problem)
	require.False(t, l.events()[0].Since.IsZero())

	end(true)
	require.Len(t, l.events(), 2)
	require.True(t, l.events()[1].Recovered)
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

	// a start without preferences file sends nothing and does not fail
	s2 := &Server{}
	s2.setupNotifications(context.Background())
	s2.emit(context.Background(), notifyhub.Event{ID: notifyhub.EventFailed})
	require.Nil(t, s2.notifyHub)
}
