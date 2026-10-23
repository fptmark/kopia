package server

import (
	"context"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/pkg/errors"

	"github.com/kopia/kopia/internal/clock"
	"github.com/kopia/kopia/internal/notifyhub"
	"github.com/kopia/kopia/internal/taskstore"
)

// repoUnreachableAfter is how long the repository may fail to open before it is reported: a failed first
// attempt after a deploy is expected and retried.
var repoUnreachableAfter = 2 * time.Minute //nolint:gochecknoglobals

// repoUnreachableReport is how often an unreachable repository is reported while it lasts.
var repoUnreachableReport = 10 * time.Minute //nolint:gochecknoglobals

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

	if err := notifyhub.Upgrade(file); err != nil {
		userLog(ctx).Errorf("unable to upgrade notification destinations: %v", err)
	}

	h := &notifyhub.Hub{
		Path:      file,
		Providers: notifyhub.SystemProviders(),
		Logf:      func(format string, args ...any) { userLog(ctx).Warnf(format, args...) },
		Digest:    s.buildSummary,
	}

	if history := s.options.TaskHistory; history != nil {
		h.State = history
		h.Repeat = history
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

// emitSnapshotOutcome tells destinations how a snapshot went: a failure, skipped files, or completion.
func (s *Server) emitSnapshotOutcome(ctx context.Context, path string, err error, failedFiles, totalFiles int64, elapsed time.Duration) {
	switch {
	case err != nil:
		if !strings.Contains(err.Error(), "canceled") && ctx.Err() == nil {
			s.emit(ctx, notifyhub.Event{ID: notifyhub.EventFailed, Source: path})
		}
	default:
		if failedFiles > 0 {
			s.emit(ctx, notifyhub.Event{ID: notifyhub.EventSkipped, Source: path, Skipped: failedFiles, Files: totalFiles})
		}

		s.emit(ctx, notifyhub.Event{ID: notifyhub.EventDone, Source: path, Files: totalFiles, Skipped: failedFiles, Elapsed: elapsed})
	}
}

// sourcePath is the folder of a source written as user@host:/path.
func sourcePath(src string) string {
	if i := strings.Index(src, ":"); i >= 0 && strings.Contains(src[:i], "@") {
		return src[i+1:]
	}

	return src
}

// buildSummary collects what happened between from and to for a periodic summary, from the task history.
func (s *Server) buildSummary(_ context.Context, from, to time.Time, _ string) (notifyhub.Summary, error) {
	var sum notifyhub.Summary

	h := s.options.TaskHistory
	if h == nil {
		return sum, errors.New("no task history")
	}

	acts, err := h.SnapshotActivity(from, to)
	if err != nil {
		return sum, errors.Wrap(err, "snapshot activity")
	}

	for _, a := range acts {
		if a.Snapshots > 0 {
			sum.Sources = append(sum.Sources, notifyhub.SourceSummary{Source: sourcePath(a.Source), Snapshots: a.Snapshots, Files: a.Files})
		}

		sum.Failed += a.Failed
		sum.WithSkipped += a.WithSkipped
		sum.MostSkipped = max(sum.MostSkipped, a.MostSkipped)
	}

	if sum.MaintRuns, sum.MaintFailed, err = h.MaintenanceActivity(from, to); err != nil {
		return sum, errors.Wrap(err, "maintenance activity")
	}

	if usage, uerr := h.StorageUsageHistory(500); uerr == nil && len(usage) > 0 {
		sum.HaveRepo, sum.RepoBytes = true, usage[0].TotalBytes

		for _, u := range usage { // newest first: the first one at or before the start of the period
			if !u.ComputedAt.After(from) {
				sum.HaveGrowth, sum.RepoGrowth = true, usage[0].TotalBytes-u.TotalBytes
				break
			}
		}
	}

	sum.Health = "not run"

	if v := s.currentVerifier(); v != nil {
		if st := v.getStatus(); st.State == "failing" {
			sum.Health = "failing"
		} else if st.LastDeep != nil {
			sum.Health = "passed"
		}
	}

	return sum, nil
}

// watchRepositoryOpen reports a repository that stays unreachable for longer than repoUnreachableAfter, and
// its recovery. The returned function ends the watch and reports whether the open succeeded.
func (s *Server) watchRepositoryOpen(ctx context.Context) func(ok bool) {
	start := clock.Now()

	var reported atomic.Bool

	down := notifyhub.Event{ID: notifyhub.EventMaint, Problem: notifyhub.ProblemRepoUnreachable, Since: start}

	// the failure is reported again while it lasts; each destination hears of it once per repeat period
	var tick *time.Ticker

	stop := make(chan struct{})

	t := time.AfterFunc(repoUnreachableAfter, func() {
		reported.Store(true)
		s.emit(ctx, down)

		tick = time.NewTicker(repoUnreachableReport)
		defer tick.Stop()

		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				s.emit(ctx, down)
			}
		}
	})

	return func(ok bool) {
		t.Stop()
		close(stop)

		if ok && reported.Load() {
			s.emit(ctx, notifyhub.Event{ID: notifyhub.EventMaint, Problem: notifyhub.ProblemRepoUnreachable, Recovered: true})
		}
	}
}
