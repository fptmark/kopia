package server

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/pkg/errors"

	"github.com/kopia/kopia/internal/clock"
	"github.com/kopia/kopia/internal/taskstore"
	"github.com/kopia/kopia/internal/uitask"
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/repo/blob"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/snapshotfs"
)

// runningVerify is a verification that is queued or reading data now.
type runningVerify struct {
	SnapshotID string    `json:"snapshotId"`
	Source     string    `json:"source"`
	Mode       string    `json:"mode"`
	Percent    float64   `json:"percent"`
	State      string    `json:"state"` // queued or running
	StartedAt  time.Time `json:"startedAt"`
	Files      int64     `json:"files"`
	Bytes      int64     `json:"bytes"`
	ReadBytes  int64     `json:"readBytes"`
	Errors     int64     `json:"errors"`
}

func (r *runningVerify) key() string {
	if r.Mode == taskstore.VerifyModeNew {
		return r.SnapshotID + "/new"
	}

	return r.SnapshotID + "/full"
}

// snapVerifyRegistry knows the verifications in flight. They run one at a time: they all read from the same
// storage, and two at once would only slow each other down.
type snapVerifyRegistry struct {
	mu      sync.Mutex
	running map[string]*runningVerify

	gateOnce sync.Once
	gate     chan struct{}
}

func (g *snapVerifyRegistry) turn() chan struct{} {
	g.gateOnce.Do(func() { g.gate = make(chan struct{}, 1) })

	return g.gate
}

// add registers a verification, or reports false when the same one is already queued or running.
func (g *snapVerifyRegistry) add(r *runningVerify) bool {
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.running == nil {
		g.running = map[string]*runningVerify{}
	}

	if _, ok := g.running[r.key()]; ok {
		return false
	}

	g.running[r.key()] = r

	return true
}

func (g *snapVerifyRegistry) remove(r *runningVerify) {
	g.mu.Lock()
	defer g.mu.Unlock()

	delete(g.running, r.key())
}

func (g *snapVerifyRegistry) update(r *runningVerify, f func(*runningVerify)) {
	g.mu.Lock()
	defer g.mu.Unlock()

	f(r)
}

// list returns a copy of those running, for the given snapshots (all when ids is empty).
func (g *snapVerifyRegistry) list(ids []string) []runningVerify {
	g.mu.Lock()
	defer g.mu.Unlock()

	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}

	out := []runningVerify{}

	for _, r := range g.running {
		if len(ids) == 0 || want[r.SnapshotID] {
			out = append(out, *r)
		}
	}

	return out
}

// startSnapshotVerify queues the verification of one snapshot as a Verify task and returns at once. It reports
// false when that verification is already queued or running.
func (s *Server) startSnapshotVerify(ctx context.Context, rep repo.Repository, m *snapshot.Manifest, mode string, percent float64) bool {
	rv := &runningVerify{
		SnapshotID: string(m.ID), Source: m.Source.String(), Mode: mode, Percent: percent, State: "queued", StartedAt: clock.Now(),
	}

	if !s.snapVerifs.add(rv) {
		return false
	}

	ctx = context.WithoutCancel(ctx)

	go func() {
		defer s.snapVerifs.remove(rv)

		gate := s.snapVerifs.turn()
		gate <- struct{}{}

		defer func() { <-gate }()

		s.snapVerifs.update(rv, func(r *runningVerify) { r.State = "running"; r.StartedAt = clock.Now() })

		desc := fmt.Sprintf("Verify snapshot of %v from %v (%v)", m.Source.Path, m.StartTime.ToTime().Local().Format("2006-01-02 15:04"), describeVerifyMode(mode, percent))

		_ = s.taskmgr.Run(ctx, "Verify", desc, func(ctx context.Context, ctrl uitask.Controller) error {
			return s.runSnapshotVerify(ctx, ctrl, rep, m, rv)
		})
	}()

	return true
}

func describeVerifyMode(mode string, percent float64) string {
	switch mode {
	case taskstore.VerifyModeNew:
		return "data it added"
	case taskstore.VerifyModeSample:
		return fmt.Sprintf("%g%% of files", percent)
	default:
		return "every file"
	}
}

func (s *Server) runSnapshotVerify(ctx context.Context, ctrl uitask.Controller, rep repo.Repository, m *snapshot.Manifest, rv *runningVerify) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	ctrl.OnCancel(cancel)

	started := clock.Now()

	progress := func(st snapVerifyStats) {
		s.snapVerifs.update(rv, func(r *runningVerify) {
			r.Files, r.Bytes, r.ReadBytes, r.Errors = st.Files, st.Bytes, st.ReadBytes, st.Errors
		})
		ctrl.ReportCounters(map[string]uitask.CounterValue{
			"Files checked": uitask.SimpleCounter(st.Files),
			"Data read":     uitask.BytesCounter(st.ReadBytes),
			"Failures":      uitask.ErrorCounter(st.Errors),
		})
	}

	var res snapVerifyResult

	if rv.Mode == taskstore.VerifyModeNew {
		dr, ok := rep.(repo.DirectRepository)
		if !ok {
			return errors.New("this repository connection cannot read stored data directly")
		}

		ctrl.ReportProgressInfo("reading the data this snapshot added")

		var err error

		res, err = verifyNewContents(ctx, dr, m.StartTime.ToTime(), m.EndTime.ToTime(), progress)
		if err != nil {
			return err
		}
	} else {
		opts := snapVerifyOptions{Percent: rv.Percent, Progress: progress}

		if dr, ok := rep.(repo.DirectRepository); ok {
			ctrl.ReportProgressInfo("listing the pack blobs in storage")

			blobs, err := blob.ReadBlobMap(ctx, dr.BlobReader())
			if err != nil {
				return errors.Wrap(err, "unable to list the blobs in storage")
			}

			opts.BlobMap = blobs
		}

		root, err := snapshotfs.SnapshotRoot(rep, m)
		if err != nil {
			return errors.Wrap(err, "unable to open the snapshot")
		}

		ctrl.ReportProgressInfo("reading the snapshot back")

		res = verifyTrees(ctx, rep, []treeRoot{{Path: m.Source.Path, Entry: root}}, opts)
	}

	if ctx.Err() != nil {
		return errors.New("canceled before the whole snapshot was read; nothing was recorded")
	}

	v := taskstore.Verification{
		SnapshotID: string(m.ID), Source: m.Source.String(), Mode: rv.Mode, Percent: rv.Percent,
		StartedAt: started, FinishedAt: clock.Now(), OK: res.Errors == 0,
		Files: res.Files, Bytes: res.Bytes, ReadFiles: res.ReadFiles, ReadBytes: res.ReadBytes, ErrorCount: res.Errors,
	}

	if seq, ok := uitask.ParseTaskID(ctrl.CurrentTaskID()); ok {
		v.TaskSeq = seq
	}

	if h := s.options.TaskHistory; h != nil {
		if _, err := h.RecordVerification(v, res.Failures); err != nil {
			userLog(ctx).Errorf("unable to record the verification result: %v", err)
		}
	}

	if res.Errors > 0 {
		return errors.Errorf("%d of %d failed to read back", res.Errors, res.Files)
	}

	return nil
}
