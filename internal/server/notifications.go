package server

import (
	"context"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/kopia/kopia/internal/clock"
	"github.com/kopia/kopia/internal/notifyhub"
	"github.com/kopia/kopia/internal/taskstore"
)

// repoUnreachableAfter is how long the repository may fail to open before it is reported: a failed first
// attempt after a deploy is expected and retried.
var repoUnreachableAfter = 2 * time.Minute //nolint:gochecknoglobals

// eventSink receives what happened; the notification hub decides who hears about it.
type eventSink interface {
	Emit(ctx context.Context, e notifyhub.Event)
}

func notificationDestinationsFile(prefsFile string) string {
	if prefsFile == "" {
		return ""
	}

	return filepath.Join(filepath.Dir(prefsFile), "notification-destinations.json")
}

// setupNotifications creates the hub that delivers events. Without a preferences file there is nowhere to
// keep destinations, so nothing is sent.
func (s *Server) setupNotifications(ctx context.Context) {
	file := notificationDestinationsFile(s.options.UIPreferencesFile)
	if file == "" {
		return
	}

	// the first start with destinations carries over what the health check did before: a macOS
	// notification, and an iMessage when a recipient was set.
	if prefs, err := getUIPreferencesOrEmpty(s); err == nil {
		if err := notifyhub.EnsureDefaults(file, prefs.VerifierIMessageTo); err != nil {
			userLog(ctx).Errorf("unable to create notification destinations: %v", err)
		}
	}

	h := &notifyhub.Hub{
		Path:      file,
		Providers: notifyhub.SystemProviders(),
		Logf:      func(format string, args ...any) { userLog(ctx).Warnf(format, args...) },
	}

	if history := s.options.TaskHistory; history != nil {
		h.Record = func(e notifyhub.Entry) {
			err := history.RecordNotification(taskstore.NotificationEntry{
				SentAt: e.At, Destination: e.Destination, Event: e.Event, Mode: e.Mode, Status: e.Status, Attempts: e.Attempts, Error: e.Error,
			})
			if err != nil {
				userLog(ctx).Errorf("unable to record notification: %v", err)
			}
		}
	}

	s.notifyHub = h
	s.notifier = h
}

// emit reports an event. It never blocks and never fails the caller.
func (s *Server) emit(ctx context.Context, e notifyhub.Event) {
	if s.notifier != nil {
		s.notifier.Emit(ctx, e)
	}
}

// emitSnapshotOutcome tells destinations about a snapshot that failed or skipped files.
func (s *Server) emitSnapshotOutcome(ctx context.Context, path string, err error, failedFiles, totalFiles int64) {
	switch {
	case err != nil && !strings.Contains(err.Error(), "canceled") && ctx.Err() == nil:
		s.emit(ctx, notifyhub.Event{ID: notifyhub.EventFailed, Source: path})
	case err == nil && failedFiles > 0:
		s.emit(ctx, notifyhub.Event{ID: notifyhub.EventSkipped, Source: path, Skipped: failedFiles, Files: totalFiles})
	}
}

// watchRepositoryOpen reports a repository that stays unreachable for longer than repoUnreachableAfter, and
// its recovery. The returned function ends the watch and reports whether the open succeeded.
func (s *Server) watchRepositoryOpen(ctx context.Context) func(ok bool) {
	start := clock.Now()

	var reported atomic.Bool

	t := time.AfterFunc(repoUnreachableAfter, func() {
		reported.Store(true)
		s.emit(ctx, notifyhub.Event{ID: notifyhub.EventMaint, Problem: notifyhub.ProblemRepoUnreachable, Since: start})
	})

	return func(ok bool) {
		t.Stop()

		if ok && reported.Load() {
			s.emit(ctx, notifyhub.Event{ID: notifyhub.EventMaint, Recovered: true})
		}
	}
}
