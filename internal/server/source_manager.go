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
	refreshTimeout = 30 * time.Second // max amount of time to refresh a single source
)

type sourceManagerServerInterface interface {
	runSnapshotTask(ctx context.Context, src snapshot.SourceInfo, inner func(ctx context.Context, ctrl uitask.Controller, result *notifydata.ManifestWithError) error) error
	runQueuedVerifyOnce(ctx context.Context, rep repo.Repository, m *snapshot.Manifest, mode string, percent float64) error
	refreshScheduler(reason string)
	// lastVerificationTime returns when src was last verified in mode's bucket ("new" is its own bucket,
	// sample and full share one), so a periodic verify schedule knows whether it's due.
	lastVerificationTime(src snapshot.SourceInfo, mode string) (time.Time, bool)
	// retryTierSettings resolves the current often/occasional retry-tier preferences. See docs/retry-tiers.md.
	retryTierSettings() retryTierSettings
}

// requestKind is which of a source's two scheduled background jobs a scheduledRequest is for.
type requestKind int

const (
	requestSnapshot requestKind = iota
	requestVerify
)

// scheduledRequest is the one shape every background attempt for a source goes through, whatever triggered
// it: the scheduler hitting a due time (automatic) or an explicit user action (manual, scheduled==false,
// never auto-retried). See runLocal and runAttempt -- there is exactly one place per source that actually
// executes one of these.
type scheduledRequest struct {
	kind      requestKind
	scheduled bool
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

	src    snapshot.SourceInfo
	rep    repo.Repository
	closed chan struct{}
	// requests carries every scheduled or manual Snapshot/Verify request for this source; runLocal is the
	// only reader, so at most one ever executes at a time.
	requests chan scheduledRequest
	wg       sync.WaitGroup

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
	// lastAttemptedVerifyTime is the Snapshot-side lastAttemptedSnapshotTime's counterpart for Verify: set
	// before every scheduled verify attempt (success or failure), so the schedule computation always
	// advances past "now" after an attempt instead of treating a stale last-success as still overdue
	// indefinitely. See docs/retry-tiers.md.
	lastAttemptedVerifyTime time.Time
	// +checklocks:sourceMutex
	// snapshotRetry and verifyRetry are each kind's retry-tier cycle, if one is in progress. See
	// docs/retry-tiers.md and advanceRetryState/retryDueTime (retry_tier.go).
	snapshotRetry retryState
	// +checklocks:sourceMutex
	verifyRetry retryState
	// +checklocks:sourceMutex
	isReadOnly bool
	// +checklocks:sourceMutex
	// snapshotInProgress and verifyInProgress are set for the duration of an actual attempt, so the next-due
	// computation -- which is never cached, just computed fresh on every ask -- reports "not due" instead of
	// judging this source overdue off state that predates the attempt in flight, and arming another one
	// before this one even finishes.
	snapshotInProgress bool
	// +checklocks:sourceMutex
	verifyInProgress bool

	progress *upload.CountingUploadProgress
}

func (s *sourceManager) Status() *serverapi.SourceStatus {
	s.sourceMutex.RLock()
	defer s.sourceMutex.RUnlock()

	st := &serverapi.SourceStatus{
		Source:           s.src,
		Status:           s.state,
		NextSnapshotTime: s.findClosestNextSnapshotTimeReadLocked(),
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

func (s *sourceManager) setVerifyInProgress(v bool) {
	s.sourceMutex.Lock()
	defer s.sourceMutex.Unlock()

	s.verifyInProgress = v
}

func (s *sourceManager) isPaused() bool {
	s.sourceMutex.RLock()
	defer s.sourceMutex.RUnlock()

	return s.paused
}

// getNextSnapshotTime computes this source's next snapshot due time fresh, from current policy and attempt
// state -- never cached, so there is nothing that can go stale between calls. ok is false when nothing is
// currently due to be scheduled (paused, an upload already in flight, or no real schedule).
func (s *sourceManager) getNextSnapshotTime() (time.Time, bool) {
	s.sourceMutex.RLock()
	defer s.sourceMutex.RUnlock()

	t := s.findClosestNextSnapshotTimeReadLocked()
	if t == nil {
		return time.Time{}, false
	}

	return *t, true
}

// getNextVerifyTime is getNextSnapshotTime's Verify counterpart.
func (s *sourceManager) getNextVerifyTime() (time.Time, bool) {
	s.sourceMutex.RLock()
	defer s.sourceMutex.RUnlock()

	t := s.findClosestNextVerifyTimeReadLocked()
	if t == nil {
		return time.Time{}, false
	}

	return *t, true
}

func (s *sourceManager) setCurrentTaskID(taskID string) {
	s.sourceMutex.Lock()
	defer s.sourceMutex.Unlock()

	s.currentTask = taskID
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

// runLocal is the one place a source's background work actually executes: one request at a time, off the
// requests channel, for as long as the source manager is running.
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

		case req := <-s.requests:
			if s.isPaused() {
				s.setStatus("PAUSED")
				continue
			}

			s.setStatus("PENDING")

			switch req.kind {
			case requestSnapshot:
				s.runScheduledSnapshot(ctx, req.scheduled)
			case requestVerify:
				s.runScheduledVerify(ctx, req.scheduled)
			}

			s.setStatus("IDLE")
		}
	}
}

// runAttempt is the one place a retry-tier cycle advances, for both Snapshot and Verify: run attempt(), then
// update retry's cycle accordingly (see advanceRetryState), refresh this source's cached policy/snapshot
// state, and nudge the scheduler so whatever the next due time now is takes effect immediately.
func (s *sourceManager) runAttempt(ctx context.Context, kind string, scheduled bool, retry *retryState, periodEstimateReadLocked func(time.Time) (time.Duration, bool), attempt func(ctx context.Context) error) {
	err := attempt(ctx)
	if err != nil {
		userLog(ctx).Errorf("%s error: %v", kind, err)
	}

	s.sourceMutex.Lock()
	*retry = advanceRetryState(*retry, s.server.retryTierSettings(), err != nil, scheduled, func() (time.Duration, bool) {
		return periodEstimateReadLocked(clock.Now())
	})
	s.sourceMutex.Unlock()

	s.refreshStatus(ctx)
	s.server.refreshScheduler(kind + " finished")
}

func (s *sourceManager) runScheduledSnapshot(ctx context.Context, scheduled bool) {
	s.setSnapshotInProgress(true)
	defer s.setSnapshotInProgress(false)

	s.runAttempt(ctx, "snapshot", scheduled, &s.snapshotRetry, s.snapshotPeriodEstimateReadLocked, func(ctx context.Context) error {
		return s.server.runSnapshotTask(ctx, s.src, s.snapshotInternal)
	})
}

func (s *sourceManager) runScheduledVerify(ctx context.Context, scheduled bool) {
	s.sourceMutex.RLock()
	m, mode, percent := s.lastCompleteSnapshot, s.verifyPol.EffectiveMode(), s.verifyPol.EffectivePercent()
	s.sourceMutex.RUnlock()

	if m == nil {
		return
	}

	s.setVerifyInProgress(true)
	defer s.setVerifyInProgress(false)

	s.runAttempt(ctx, "verify", scheduled, &s.verifyRetry, s.verifyPeriodEstimateReadLocked, func(ctx context.Context) error {
		s.markVerifyAttempted()
		return s.server.runQueuedVerifyOnce(ctx, s.rep, m, mode, percent)
	})
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

// schedule queues a request for this source -- scheduled (eligible for the retry-tier burst on failure) or
// manual (never retried). The channel is buffered 1 and the send is non-blocking: a request already queued
// for this kind makes a duplicate a no-op, since runLocal processes one at a time anyway.
func (s *sourceManager) schedule(kind requestKind, scheduled bool) {
	select {
	case s.requests <- scheduledRequest{kind: kind, scheduled: scheduled}:
	default:
	}
}

// scheduleSnapshotNow queues an explicit, manual snapshot request -- never auto-retried on failure.
func (s *sourceManager) scheduleSnapshotNow() {
	s.schedule(requestSnapshot, false)
}

// scheduleAutomaticSnapshot is the scheduler's own trigger for this source: a snapshot request eligible
// for the retry-tier burst on failure (docs/retry-tiers.md).
func (s *sourceManager) scheduleAutomaticSnapshot() {
	s.schedule(requestSnapshot, true)
}

// scheduleAutomaticVerify is the scheduler's own trigger for this source's periodic verify, against its
// latest complete snapshot, eligible for the retry-tier burst on failure (docs/retry-tiers.md). A manual
// verify of a specific snapshot goes through startSnapshotVerify directly instead -- a different request
// (an arbitrary, user-picked snapshot, not necessarily this source's latest), not a duplicate of this one.
func (s *sourceManager) scheduleAutomaticVerify() {
	s.schedule(requestVerify, true)
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

// snapshotPeriodEstimateReadLocked is schedulePeriodEstimate for this source's snapshot policy, used only
// to classify a retry-tier (docs/retry-tiers.md), never as an actual next-run time.
// +checklocksread:s.sourceMutex
func (s *sourceManager) snapshotPeriodEstimateReadLocked(from time.Time) (time.Duration, bool) {
	hasTimesOfDayOrCron := len(s.pol.TimesOfDay) > 0 || len(s.pol.Cron) > 0
	return schedulePeriodEstimate(s.pol.IntervalSeconds, hasTimesOfDayOrCron, s.pol.NextSnapshotTime, from)
}

// findClosestNextSnapshotTimeReadLocked computes this source's next snapshot due time fresh every time it's
// asked -- see getNextSnapshotTime and docs/retry-tiers.md. Returns nil when nothing should be scheduled
// right now: paused, an upload already running, or no real schedule.
// +checklocksread:s.sourceMutex
func (s *sourceManager) findClosestNextSnapshotTimeReadLocked() *time.Time {
	if s.paused || s.snapshotInProgress {
		return nil
	}

	rt := s.server.retryTierSettings()

	if t, ok := retryDueTime(s.snapshotRetry, rt, s.lastAttemptedSnapshotTime.ToTime()); ok {
		return &t
	}

	now := clock.Now()

	var previousSnapshotTime fs.UTCTimestamp
	if lcs := s.lastCompleteSnapshot; lcs != nil {
		previousSnapshotTime = lcs.StartTime
	}

	// consider attempted snapshots even if they did not end up writing snapshot manifests.
	if s.lastAttemptedSnapshotTime.After(previousSnapshotTime) {
		previousSnapshotTime = s.lastAttemptedSnapshotTime
	}

	t, ok := s.pol.NextSnapshotTime(previousSnapshotTime.ToTime(), now)
	if !ok {
		return nil
	}

	var lastCompletion time.Time

	hasCompletion := s.lastCompleteSnapshot != nil
	if hasCompletion {
		lastCompletion = s.lastCompleteSnapshot.StartTime.ToTime()
	}

	period, periodOK := s.snapshotPeriodEstimateReadLocked(now)
	often := !periodOK || rt.isOften(period) // no schedule to estimate from: be conservative, no floor

	t = rt.floor(t, lastCompletion, hasCompletion, often)

	return &t
}

// verifyPeriodEstimateReadLocked is snapshotPeriodEstimateReadLocked's Verify counterpart.
// +checklocksread:s.sourceMutex
func (s *sourceManager) verifyPeriodEstimateReadLocked(from time.Time) (time.Duration, bool) {
	sp := s.verifyPol.SchedulingPolicy
	hasTimesOfDayOrCron := len(sp.TimesOfDay) > 0 || len(sp.Cron) > 0

	return schedulePeriodEstimate(sp.IntervalSeconds, hasTimesOfDayOrCron, s.verifyPol.NextVerifyTime, from)
}

// findClosestNextVerifyTimeReadLocked is findClosestNextSnapshotTimeReadLocked's Verify counterpart.
// +checklocksread:s.sourceMutex
func (s *sourceManager) findClosestNextVerifyTimeReadLocked() *time.Time {
	if s.verifyPol.SchedulingPolicy.Manual {
		return nil
	}

	if s.paused || s.verifyInProgress {
		return nil
	}

	if s.lastCompleteSnapshot == nil {
		// nothing to verify yet: without this, a source with no complete snapshot would report itself
		// "due" forever (nothing ever advances lastAttemptedVerifyTime to move the natural computation
		// forward), and the scheduler would busy-loop re-triggering runScheduledVerify, which just no-ops
		// right back out, instead of simply not scheduling a verify item at all until there's something to
		// verify.
		return nil
	}

	rt := s.server.retryTierSettings()

	if t, ok := retryDueTime(s.verifyRetry, rt, s.lastAttemptedVerifyTime); ok {
		return &t
	}

	now := clock.Now()

	lastCompletion, hasCompletion := s.server.lastVerificationTime(s.src, s.verifyPol.EffectiveMode())

	previousVerifyTime := lastCompletion
	if s.lastAttemptedVerifyTime.After(previousVerifyTime) {
		previousVerifyTime = s.lastAttemptedVerifyTime
	}

	t, ok := s.verifyPol.NextVerifyTime(previousVerifyTime, now)
	if !ok {
		return nil
	}

	period, periodOK := s.verifyPeriodEstimateReadLocked(now)
	often := !periodOK || rt.isOften(period)

	t = rt.floor(t, lastCompletion, hasCompletion, often)

	return &t
}

// markVerifyAttempted records that a scheduled verify attempt is starting now, the Verify counterpart of
// snapshotInternal setting lastAttemptedSnapshotTime -- so the schedule computation always advances past
// "now" after an attempt instead of treating a stale last-success as still overdue indefinitely.
func (s *sourceManager) markVerifyAttempted() {
	s.sourceMutex.Lock()
	defer s.sourceMutex.Unlock()

	s.lastAttemptedVerifyTime = clock.Now()
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
		src:      src,
		rep:      rep,
		server:   server,
		state:    "UNKNOWN",
		closed:   make(chan struct{}),
		requests: make(chan scheduledRequest, 1),
		progress: &upload.CountingUploadProgress{},
	}

	return m
}
