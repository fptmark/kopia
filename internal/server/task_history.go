package server

import (
	"context"
	"time"

	"github.com/kopia/kopia/internal/clock"
	"github.com/kopia/kopia/internal/taskstore"
	"github.com/kopia/kopia/snapshot"
)

const (
	taskHistoryMaintenanceInterval = 6 * time.Hour
	taskHistoryBackupTimeout       = 5 * time.Minute
)

// recordSnapshotResult keeps what a snapshot produced, including each file that failed, with its task so
// the errors can still be examined after the snapshot itself has been removed by retention.
func (s *Server) recordSnapshotResult(ctx context.Context, taskID string, src snapshot.SourceInfo, m *snapshot.Manifest) {
	h := s.options.TaskHistory
	if h == nil || taskID == "" {
		return
	}

	res := taskstore.SnapshotResult{Source: src.String(), SnapshotID: string(m.ID)}

	if m.RootEntry != nil && m.RootEntry.DirSummary != nil {
		sum := m.RootEntry.DirSummary
		res.TotalSize = sum.TotalFileSize
		res.TotalFiles = sum.TotalFileCount
		res.FailedFiles = int64(sum.FatalErrorCount)

		for _, e := range sum.FailedEntries {
			res.Errors = append(res.Errors, taskstore.SnapshotError{Path: e.EntryPath, Error: e.Error})
		}
	}

	if err := h.RecordSnapshotResult(taskID, res); err != nil {
		userLog(ctx).Errorf("unable to record the result of snapshot task %v: %v", taskID, err)
	}
}

// maintainTaskHistory removes tasks older than the retention period and keeps a consistent copy of the
// database next to it (a live database file can be torn when it is copied by a file backup).
func (s *Server) maintainTaskHistory(ctx context.Context) {
	run := func() {
		h := s.options.TaskHistory

		if s.options.TaskHistoryRetention > 0 {
			cutoff := clock.Now().Add(-s.options.TaskHistoryRetention)

			if n, err := h.Prune(cutoff); err != nil {
				userLog(ctx).Errorf("unable to prune task history: %v", err)
			} else if n > 0 {
				userLog(ctx).Infof("removed %v tasks older than %v from the task history", n, cutoff.Format(time.DateOnly))
			}
		}

		if f := s.options.TaskHistoryBackupFile; f != "" {
			bctx, cancel := context.WithTimeout(ctx, taskHistoryBackupTimeout)
			defer cancel()

			if err := h.BackupTo(bctx, f); err != nil {
				userLog(ctx).Errorf("unable to back up task history: %v", err)
			}
		}
	}

	run()

	t := time.NewTicker(taskHistoryMaintenanceInterval)
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			run()
		}
	}
}
