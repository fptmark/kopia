package server

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/errors"

	"github.com/kopia/kopia/fs"
	"github.com/kopia/kopia/fs/localfs"
	"github.com/kopia/kopia/internal/clock"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/internal/uitask"
	"github.com/kopia/kopia/notification/notifydata"
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/policy"
	"github.com/kopia/kopia/snapshot/upload"
)

const (
	failedSnapshotRetryInterval = 5 * time.Minute
	refreshTimeout              = 30 * time.Second // max amount of time to refresh a single source
)

type sourceManagerServerInterface interface {
	runSnapshotTask(ctx context.Context, src snapshot.SourceInfo, inner func(ctx context.Context, ctrl uitask.Controller, result *notifydata.ManifestWithError) error) error
	refreshScheduler(reason string)
	// lastVerificationTime returns when src was last verified in mode's bucket ("new" is its own bucket,
	// sample and full share one), so a periodic verify schedule knows whether it's due.
	lastVerificationTime(src snapshot.SourceInfo, mode string) (time.Time, bool)
	// systemRecentlyUnstable reports whether the machine appears to have just woken from sleep, so the
	// next snapshot/verify time can defer instead of judging this source overdue off a connection that
	// is likely still mid-reconnect-storm.
	systemRecentlyUnstable() bool
}

// sourceManager manages the state machine of each source
// Possible states:
//
// - INITIALIZING - fetching configuration from repository
// - READY - waiting for next snapshot
// - PAUSED - inactive
// - FAILED - inactive
// - UPLOADING - uploading a snapshot.
type sourceManager struct {
	upload.NullUploadProgress

	server sourceManagerServerInterface

	src              snapshot.SourceInfo
	rep              repo.Repository
	closed           chan struct{}
	snapshotRequests chan struct{}
	wg               sync.WaitGroup

	sourceMutex sync.RWMutex
	// +checklocks:sourceMutex
	uploader *upload.Uploader
	// +checklocks:sourceMutex
	pol policy.SchedulingPolicy
	// +checklocks:sourceMutex
	verifyPol policy.VerifySchedulingPolicy
	// +checklocks:sourceMutex
	state string
	// +checklocks:sourceMutex
	nextSnapshotTime *time.Time
	// +checklocks:sourceMutex
	nextVerifyTime *time.Time
	// +checklocks:sourceMutex
	lastSnapshot *snapshot.Manifest
	// +checklocks:sourceMutex
	lastCompleteSnapshot *snapshot.Manifest
	// +checklocks:sourceMutex
	manifestsSinceLastCompleteSnapshot []*snapshot.Manifest
	// +checklocks:sourceMutex
	paused bool
	// +checklocks:sourceMutex
	currentTask string
	// +checklocks:sourceMutex
	lastAttemptedSnapshotTime fs.UTCTimestamp
	// +checklocks:sourceMutex
	isReadOnly bool
	// +checklocks:sourceMutex
	// snapshotInProgress is set for the duration of an actual upload, so a refreshStatus() landing in
	// that window (the periodic one, not the one this very upload triggers when it finishes) leaves
	// the schedule alone instead of judging this source overdue off a manifest that predates the
	// upload in flight, and arming another run before this one even finishes.
	snapshotInProgress bool

	progress *upload.CountingUploadProgress
}

func (s *sourceManager) Status() *serverapi.SourceStatus {
	s.sourceMutex.RLock()
	defer s.sourceMutex.RUnlock()

	st := &serverapi.SourceStatus{
		Source:           s.src,
		Status:           s.state,
		NextSnapshotTime: s.nextSnapshotTime,
		SchedulingPolicy: s.pol,
		LastSnapshot:     s.lastSnapshot,
	}

	if st.Status == "UPLOADING" {
		c := s.progress.Snapshot()

		st.UploadCounters = &c

		st.CurrentTask = s.currentTask
	}

	return st
}

func (s *sourceManager) setStatus(stat string) {
	s.sourceMutex.Lock()
	defer s.sourceMutex.Unlock()

	s.state = stat
}

func (s *sourceManager) setSnapshotInProgress(v bool) {
	s.sourceMutex.Lock()
	defer s.sourceMutex.Unlock()

	s.snapshotInProgress = v
}

func (s *sourceManager) isPaused() bool {
	s.sourceMutex.RLock()
	defer s.sourceMutex.RUnlock()

	return s.paused
}

func (s *sourceManager) getNextSnapshotTime() (time.Time, bool) {
	s.sourceMutex.RLock()
	defer s.sourceMutex.RUnlock()

	if s.nextSnapshotTime == nil {
		return time.Time{}, false
	}

	return *s.nextSnapshotTime, true
}

func (s *sourceManager) getNextVerifyTime() (time.Time, bool) {
	s.sourceMutex.RLock()
	defer s.sourceMutex.RUnlock()

	if s.nextVerifyTime == nil {
		return time.Time{}, false
	}

	return *s.nextVerifyTime, true
}

// verifyTriggerArgs is what a scheduled verify of this source needs to run: its latest complete snapshot and
// the mode/percent its policy asks for. ok is false when there is no complete snapshot to verify yet. It also
// clears nextVerifyTime, the same way scheduleSnapshotNow clears nextSnapshotTime: the actual verify runs in
// its own goroutine and only writes its result (and so only moves the source's last-verify time) once it
// finishes, so without this the scheduler would see the same due time on its next pass and fire again
// immediately, in a tight loop, for as long as the verify takes to complete. refreshStatus() recomputes a
// real next time once it runs again.
func (s *sourceManager) verifyTriggerArgs() (m *snapshot.Manifest, mode string, percent float64, ok bool) {
	s.sourceMutex.Lock()
	defer s.sourceMutex.Unlock()

	s.nextVerifyTime = nil

	if s.lastCompleteSnapshot == nil {
		return nil, "", 0, false
	}

	return s.lastCompleteSnapshot, s.verifyPol.EffectiveMode(), s.verifyPol.EffectivePercent(), true
}

func (s *sourceManager) setCurrentTaskID(taskID string) {
	s.sourceMutex.Lock()
	defer s.sourceMutex.Unlock()

	s.currentTask = taskID
}

func (s *sourceManager) setNextSnapshotTime(t time.Time) {
	s.sourceMutex.Lock()
	defer s.sourceMutex.Unlock()

	s.nextSnapshotTime = &t
}

func (s *sourceManager) currentUploader() *upload.Uploader {
	s.sourceMutex.RLock()
	defer s.sourceMutex.RUnlock()

	return s.uploader
}

func (s *sourceManager) setUploader(u *upload.Uploader) {
	s.sourceMutex.Lock()
	defer s.sourceMutex.Unlock()

	s.uploader = u
}

func (s *sourceManager) start(ctx context.Context, isLocal bool) {
	s.refreshStatus(ctx)

	go s.run(ctx, isLocal)
}

func (s *sourceManager) run(ctx context.Context, isLocal bool) {
	// make sure we run in a detached context, which ignores outside cancellation and deadline.
	ctx = context.WithoutCancel(ctx)

	s.setStatus("INITIALIZING")
	defer s.setStatus("STOPPED")

	s.wg.Add(1)
	defer s.wg.Done()

	if isLocal {
		s.runLocal(ctx)
	} else {
		s.runReadOnly()
	}
}

func (s *sourceManager) runLocal(ctx context.Context) {
	if s.isPaused() {
		s.setStatus("PAUSED")
	} else {
		s.setStatus("IDLE")
	}

	for {
		select {
		case <-s.closed:
			return

		case <-s.snapshotRequests:
			if s.isPaused() {
				s.setStatus("PAUSED")

				continue
			}

			s.setStatus("PENDING")

			userLog(ctx).Debugw("snapshotting", "source", s.src)

			s.setSnapshotInProgress(true)
			err := s.server.runSnapshotTask(ctx, s.src, s.snapshotInternal)
			s.setSnapshotInProgress(false)

			if err != nil {
				userLog(ctx).Errorf("snapshot error: %v", err)

				s.backoffBeforeNextSnapshot()
			} else {
				s.refreshStatus(ctx)
			}

			s.server.refreshScheduler("snapshot finished")

			s.setStatus("IDLE")
		}
	}
}

func (s *sourceManager) backoffBeforeNextSnapshot() {
	if _, ok := s.getNextSnapshotTime(); !ok {
		return
	}

	s.setNextSnapshotTime(clock.Now().Add(failedSnapshotRetryInterval))
}

func (s *sourceManager) isRunningReadOnly() bool {
	s.sourceMutex.RLock()
	defer s.sourceMutex.RUnlock()

	return s.isReadOnly
}

func (s *sourceManager) runReadOnly() {
	s.sourceMutex.Lock()
	s.isReadOnly = true
	s.sourceMutex.Unlock()
	s.setStatus("REMOTE")

	// wait until closed
	<-s.closed
}

func (s *sourceManager) scheduleSnapshotNow() {
	s.sourceMutex.Lock()
	defer s.sourceMutex.Unlock()

	// next snapshot time will be recalculated by refreshStatus()
	s.nextSnapshotTime = nil

	select {
	case s.snapshotRequests <- struct{}{}: // scheduled snapshot
	default: // already scheduled
	}
}

func (s *sourceManager) upload(ctx context.Context) serverapi.SourceActionResponse {
	userLog(ctx).Infof("upload triggered via API: %v", s.src)
	s.scheduleSnapshotNow()

	return serverapi.SourceActionResponse{Success: true}
}

func (s *sourceManager) cancel(ctx context.Context) serverapi.SourceActionResponse {
	userLog(ctx).Debugw("cancel triggered via API", "source", s.src)

	if u := s.currentUploader(); u != nil {
		userLog(ctx).Info("canceling current upload")
		u.Cancel()
	}

	return serverapi.SourceActionResponse{Success: true}
}

func (s *sourceManager) pause(ctx context.Context) serverapi.SourceActionResponse {
	userLog(ctx).Debugw("pause triggered via API", "source", s.src)

	s.sourceMutex.Lock()
	s.paused = true
	s.sourceMutex.Unlock()

	if u := s.currentUploader(); u != nil {
		userLog(ctx).Info("canceling current upload")
		u.Cancel()
	}

	s.server.refreshScheduler("source paused")

	return serverapi.SourceActionResponse{Success: true}
}

func (s *sourceManager) resume(ctx context.Context) serverapi.SourceActionResponse {
	userLog(ctx).Debugw("resume triggered via API", "source", s.src)

	s.sourceMutex.Lock()
	s.paused = false
	s.sourceMutex.Unlock()

	s.server.refreshScheduler("source unpaused")

	return serverapi.SourceActionResponse{Success: true}
}

func (s *sourceManager) stop(ctx context.Context) {
	if u := s.currentUploader(); u != nil {
		userLog(ctx).Infow("canceling current upload", "src", s.src)
		u.Cancel()
	}

	close(s.closed)
}

func (s *sourceManager) waitUntilStopped() {
	s.wg.Wait()
}

func (s *sourceManager) snapshotInternal(ctx context.Context, ctrl uitask.Controller, result *notifydata.ManifestWithError) error {
	s.setStatus("UPLOADING")

	s.setCurrentTaskID(ctrl.CurrentTaskID())
	defer s.setCurrentTaskID("")

	// check if we got closed while waiting on semaphore
	select {
	case <-s.closed:
		userLog(ctx).Infof("not snapshotting %v because source manager is shutting down", s.src)
		return nil

	default:
	}

	localEntry, err := localfs.NewEntry(s.src.Path)
	if err != nil {
		return errors.Wrap(err, "unable to create local filesystem")
	}

	onUpload := func(int64) {}

	s.sourceMutex.Lock()
	manifestsSinceLastCompleteSnapshot := append([]*snapshot.Manifest(nil), s.manifestsSinceLastCompleteSnapshot...)
	s.lastAttemptedSnapshotTime = fs.UTCTimestampFromTime(clock.Now())
	s.sourceMutex.Unlock()

	if len(manifestsSinceLastCompleteSnapshot) > 0 {
		result.Previous = manifestsSinceLastCompleteSnapshot[0]
	}

	//nolint:wrapcheck
	return repo.WriteSession(ctx, s.rep, repo.WriteSessionOptions{
		Purpose: "Source Manager Uploader",
		OnUpload: func(numBytes int64) {
			// extra indirection to allow changing onUpload function later
			// once we have the uploader
			onUpload(numBytes)
		},
	}, func(ctx context.Context, w repo.RepositoryWriter) error {
		userLog(ctx).Debugf("uploading %v", s.src)

		u := upload.NewUploader(w)

		ctrl.OnCancel(u.Cancel)

		policyTree, err := policy.TreeForSource(ctx, w, s.src)
		if err != nil {
			return errors.Wrap(err, "unable to create policy getter")
		}

		// set up progress that will keep counters and report to the uitask.
		prog := &uitaskProgress{
			p:    s.progress,
			ctrl: ctrl,
		}
		u.Progress = prog
		onUpload = func(numBytes int64) {
			u.Progress.UploadedBytes(numBytes)
		}

		userLog(ctx).Debugf("starting upload of %v", s.src)
		s.setUploader(u)

		manifest, err := u.Upload(ctx, localEntry, policyTree, s.src, manifestsSinceLastCompleteSnapshot...)

		prog.report(true)
		s.setUploader(nil)

		if err != nil {
			return errors.Wrap(err, "upload error")
		}

		result.Manifest = *manifest

		ignoreIdenticalSnapshot := policyTree.EffectivePolicy().RetentionPolicy.IgnoreIdenticalSnapshots.OrDefault(false)
		if ignoreIdenticalSnapshot && len(manifestsSinceLastCompleteSnapshot) > 0 {
			if manifestsSinceLastCompleteSnapshot[0].RootObjectID() == manifest.RootObjectID() {
				userLog(ctx).Debug("Not saving snapshot because no files have been changed since previous snapshot")
				return nil
			}
		}

		snapshotID, err := snapshot.SaveSnapshot(ctx, w, manifest)
		if err != nil {
			return errors.Wrap(err, "unable to save snapshot")
		}

		if _, err := policy.ApplyRetentionPolicy(ctx, w, s.src, true); err != nil {
			return errors.Wrap(err, "unable to apply retention policy")
		}

		// result.Manifest was copied before the save assigned the ID
		result.Manifest.ID = snapshotID
		result.Saved = true

		userLog(ctx).Debugf("created snapshot %v", snapshotID)

		return nil
	})
}

// instabilityRecheckInterval is how soon scheduling looks again while systemRecentlyUnstable is true: short
// enough that a real wake is picked up promptly, long enough not to busy-loop the scheduler.
const instabilityRecheckInterval = time.Minute

// +checklocksread:s.sourceMutex
func (s *sourceManager) findClosestNextSnapshotTimeReadLocked() *time.Time {
	if s.server.systemRecentlyUnstable() {
		t := clock.Now().Add(instabilityRecheckInterval)
		return &t
	}

	var previousSnapshotTime fs.UTCTimestamp
	if lcs := s.lastCompleteSnapshot; lcs != nil {
		previousSnapshotTime = lcs.StartTime
	}

	// consider attempted snapshots even if they did not end up writing snapshot manifests.
	if s.lastAttemptedSnapshotTime.After(previousSnapshotTime) {
		previousSnapshotTime = s.lastAttemptedSnapshotTime
	}

	t, ok := s.pol.NextSnapshotTime(previousSnapshotTime.ToTime(), clock.Now())
	if !ok {
		return nil
	}

	return &t
}

// +checklocksread:s.sourceMutex
func (s *sourceManager) findClosestNextVerifyTimeReadLocked() *time.Time {
	if s.verifyPol.SchedulingPolicy.Manual {
		return nil
	}

	if s.server.systemRecentlyUnstable() {
		t := clock.Now().Add(instabilityRecheckInterval)
		return &t
	}

	previousVerifyTime, _ := s.server.lastVerificationTime(s.src, s.verifyPol.EffectiveMode())

	t, ok := s.verifyPol.NextVerifyTime(previousVerifyTime, clock.Now())
	if !ok {
		return nil
	}

	return &t
}

func (s *sourceManager) refreshStatus(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, refreshTimeout)
	defer cancel()

	pol, _, _, err := policy.GetEffectivePolicy(ctx, s.rep, s.src)
	if err != nil {
		s.setStatus("FAILED")
		return
	}

	snapshots, err := snapshot.ListSnapshots(ctx, s.rep, s.src)
	if err != nil {
		s.setStatus("FAILED")
		return
	}

	s.sourceMutex.Lock()
	defer s.sourceMutex.Unlock()

	s.pol = pol.SchedulingPolicy
	s.verifyPol = pol.VerifySchedulingPolicy
	s.manifestsSinceLastCompleteSnapshot = nil
	s.lastCompleteSnapshot = nil

	snaps := snapshot.SortByTime(snapshots, true)
	if len(snaps) > 0 {
		s.lastSnapshot = snaps[0]
		for _, sn := range snaps {
			s.manifestsSinceLastCompleteSnapshot = append(s.manifestsSinceLastCompleteSnapshot, sn)

			// complete snapshot, end here
			if sn.IncompleteReason == "" {
				s.lastCompleteSnapshot = sn
				break
			}
		}
	} else {
		s.lastSnapshot = nil
	}

	switch {
	case s.paused:
		s.nextSnapshotTime = nil
		s.nextVerifyTime = nil
	case s.snapshotInProgress:
		// leave the schedule as it is (nil: scheduleSnapshotNow already cleared it for this run).
		// Recomputing here would judge this source overdue off lastCompleteSnapshot, which still
		// predates the upload that is actually running right now, and arm another one before this
		// one even finishes. The refreshStatus() this very upload calls when it completes is not
		// skipped: snapshotInProgress is cleared before that call.
	default:
		s.nextSnapshotTime = s.findClosestNextSnapshotTimeReadLocked()
		s.nextVerifyTime = s.findClosestNextVerifyTimeReadLocked()
	}
}

type uitaskProgress struct {
	nextReportTimeNanos atomic.Int64
	p                   *upload.CountingUploadProgress
	ctrl                uitask.Controller
}

// report reports the current progress to UITask.
func (t *uitaskProgress) report(final bool) {
	t.ctrl.ReportCounters(t.p.UITaskCounters(final))
}

// maybeReport occasionally reports current progress to UI task.
func (t *uitaskProgress) maybeReport() {
	n := clock.Now().UnixNano()

	nrt := t.nextReportTimeNanos.Load()
	if n > nrt && t.nextReportTimeNanos.CompareAndSwap(nrt, n+time.Second.Nanoseconds()) {
		t.report(false)
	}
}

// Enabled implements UploadProgress, always returns true.
func (t *uitaskProgress) Enabled() bool {
	return true
}

// UploadStarted is emitted once at the start of an upload.
func (t *uitaskProgress) UploadStarted() {
	t.p.UploadStarted()
	t.maybeReport()
}

// UploadFinished is emitted once at the end of an upload.
func (t *uitaskProgress) UploadFinished() {
	t.p.UploadFinished()
	t.maybeReport()
}

// CachedFile is emitted whenever uploader reuses previously uploaded entry without hashing the file.
func (t *uitaskProgress) CachedFile(path string, size int64) {
	t.p.CachedFile(path, size)
	t.maybeReport()
}

// HashingFile is emitted at the beginning of hashing of a given file.
func (t *uitaskProgress) HashingFile(fname string) {
	t.p.HashingFile(fname)
	t.maybeReport()
}

// FinishedHashingFile is emitted at the end of hashing of a given file.
func (t *uitaskProgress) FinishedHashingFile(fname string, numBytes int64) {
	t.p.FinishedHashingFile(fname, numBytes)
	t.maybeReport()
}

// FinishedFile is emitted when the system is done examining a file.
func (t *uitaskProgress) FinishedFile(fname string, err error) {
	t.p.FinishedFile(fname, err)
	t.maybeReport()
}

// HashedBytes is emitted while hashing any blocks of bytes.
func (t *uitaskProgress) HashedBytes(numBytes int64) {
	t.p.HashedBytes(numBytes)
	t.maybeReport()
}

// Error is emitted when an error is encountered.
func (t *uitaskProgress) Error(path string, err error, isIgnored bool) {
	t.p.Error(path, err, isIgnored)
	t.maybeReport()
}

// UploadedBytes is emitted whenever bytes are written to the blob storage.
func (t *uitaskProgress) UploadedBytes(numBytes int64) {
	t.p.UploadedBytes(numBytes)
	t.maybeReport()
}

// StartedDirectory is emitted whenever a directory starts being uploaded.
func (t *uitaskProgress) StartedDirectory(dirname string) {
	t.p.StartedDirectory(dirname)
	t.maybeReport()

	t.ctrl.ReportProgressInfo(dirname)
}

// FinishedDirectory is emitted whenever a directory is finished uploading.
func (t *uitaskProgress) FinishedDirectory(dirname string) {
	t.p.FinishedDirectory(dirname)
	t.maybeReport()
}

// ExcludedFile is emitted whenever a file is excluded.
func (t *uitaskProgress) ExcludedFile(fname string, numBytes int64) {
	t.p.ExcludedFile(fname, numBytes)
	t.maybeReport()
}

// ExcludedDir is emitted whenever a directory is excluded.
func (t *uitaskProgress) ExcludedDir(dirname string) {
	t.p.ExcludedDir(dirname)
	t.maybeReport()
}

// EstimatedDataSize is emitted whenever the size of upload is estimated.
func (t *uitaskProgress) EstimatedDataSize(fileCount, totalBytes int64) {
	t.p.EstimatedDataSize(fileCount, totalBytes)
	t.maybeReport()
}

// EstimationParameters returns parameters to be used for estimation.
func (t *uitaskProgress) EstimationParameters() upload.EstimationParameters {
	return t.p.EstimationParameters()
}

func newSourceManager(src snapshot.SourceInfo, server *Server, rep repo.Repository) *sourceManager {
	m := &sourceManager{
		src:              src,
		rep:              rep,
		server:           server,
		state:            "UNKNOWN",
		closed:           make(chan struct{}),
		snapshotRequests: make(chan struct{}, 1),
		progress:         &upload.CountingUploadProgress{},
	}

	return m
}
