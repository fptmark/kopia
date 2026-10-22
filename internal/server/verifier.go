package server

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"math/rand/v2"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pkg/errors"

	"github.com/kopia/kopia/fs"
	"github.com/kopia/kopia/fs/localfs"
	"github.com/kopia/kopia/internal/clock"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/internal/uitask"
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/repo/blob"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/snapshotfs"
)

const (
	verifyQuickInterval = 10 * time.Minute
	// the newest snapshot of a local source must be younger than this (snapshots run hourly).
	verifyMaxSnapshotAge = 3 * time.Hour
	// after the server starts or the machine wakes up, stale snapshots are not reported for this long
	// because the next scheduled snapshot has not had a chance to run yet.
	verifyWakeGrace = 90 * time.Minute
	// the machine is assumed to have slept when the quick check ran this much later than scheduled.
	verifySleepGap = 3 * verifyQuickInterval
	// the deep check runs once a day, in the first quick run in the hours after this local hour.
	verifyDeepHour  = 3
	verifyDeepEvery = 24 * time.Hour

	verifySamplePercent   = 1.0
	verifySampleMaxErrors = 5

	verifyReadBackMaxSize = 50 << 20
	verifyReadBackTries   = 60

	// failed files: an absolute ceiling, and a jump compared with the previous snapshot of the same source.
	verifyMaxFailedFiles  = 25
	verifyFailedFilesJump = 10

	verifyRemindEvery = 12 * time.Hour
)

// verifyCheck is the outcome of one check.
type verifyCheck = serverapi.VerifyCheck

func passed(name, detail string) verifyCheck {
	return verifyCheck{Name: name, OK: true, Detail: detail}
}
func failed(name, detail string) verifyCheck {
	return verifyCheck{Name: name, OK: false, Detail: detail}
}

// newestFirst groups manifests by source, newest snapshot first. Incomplete snapshots are ignored.
func newestFirst(ms []*snapshot.Manifest) map[snapshot.SourceInfo][]*snapshot.Manifest {
	by := map[snapshot.SourceInfo][]*snapshot.Manifest{}

	for _, m := range ms {
		if m.IncompleteReason != "" || m.RootEntry == nil {
			continue
		}

		by[m.Source] = append(by[m.Source], m)
	}

	for _, l := range by {
		sort.Slice(l, func(i, j int) bool { return l[i].StartTime.ToTime().After(l[j].StartTime.ToTime()) })
	}

	return by
}

func sortedSources[T any](by map[snapshot.SourceInfo]T) []snapshot.SourceInfo {
	srcs := make([]snapshot.SourceInfo, 0, len(by))
	for s := range by {
		srcs = append(srcs, s)
	}

	sort.Slice(srcs, func(i, j int) bool { return srcs[i].String() < srcs[j].String() })

	return srcs
}

// checkFreshness fails when the newest snapshot of a source is older than maxAge.
func checkFreshness(now time.Time, by map[snapshot.SourceInfo][]*snapshot.Manifest, maxAge time.Duration) verifyCheck {
	const name = "Snapshots are recent"

	if len(by) == 0 {
		return failed(name, "there are no snapshots")
	}

	var bad []string

	for _, src := range sortedSources(by) {
		age := now.Sub(by[src][0].StartTime.ToTime())
		if age > maxAge {
			bad = append(bad, fmt.Sprintf("%v: newest snapshot is %v old", src.Path, age.Round(time.Minute)))
		}
	}

	if len(bad) > 0 {
		return failed(name, strings.Join(bad, "; "))
	}

	return passed(name, fmt.Sprintf("newest snapshot of each of %d sources is under %v old", len(by), maxAge))
}

func failedFiles(m *snapshot.Manifest) int {
	if m.RootEntry == nil || m.RootEntry.DirSummary == nil {
		return 0
	}

	return int(m.RootEntry.DirSummary.FatalErrorCount)
}

// checkFailedFiles fails when the newest snapshot of a source skipped many files, or many more than the
// snapshot before it (this is what losing a permission looks like: the snapshot still "succeeds").
func checkFailedFiles(by map[snapshot.SourceInfo][]*snapshot.Manifest) verifyCheck {
	const name = "Snapshots skip no unexpected files"

	var bad []string

	for _, src := range sortedSources(by) {
		l := by[src]
		newest := failedFiles(l[0])

		prev := newest
		if len(l) > 1 {
			prev = failedFiles(l[1])
		}

		switch {
		case newest > verifyMaxFailedFiles:
			bad = append(bad, fmt.Sprintf("%v: %d files could not be backed up (limit %d)", src.Path, newest, verifyMaxFailedFiles))
		case newest > prev+verifyFailedFilesJump:
			bad = append(bad, fmt.Sprintf("%v: failed files went from %d to %d", src.Path, prev, newest))
		}
	}

	if len(bad) > 0 {
		return failed(name, strings.Join(bad, "; "))
	}

	return passed(name, "failed files are within limits")
}

// quickChecks are the checks that only read snapshot manifests.
func quickChecks(now time.Time, ms []*snapshot.Manifest, checkAge bool) []verifyCheck {
	by := newestFirst(ms)

	var checks []verifyCheck

	if checkAge {
		checks = append(checks, checkFreshness(now, by, verifyMaxSnapshotAge))
	}

	return append(checks, checkFailedFiles(by))
}

// entryAt follows the slash separated relative path below root.
func entryAt(ctx context.Context, root fs.Directory, rel string) (fs.Entry, error) {
	var cur fs.Entry = root

	for _, part := range strings.Split(rel, "/") {
		d, ok := cur.(fs.Directory)
		if !ok {
			return nil, errors.Errorf("%q is not a directory", part)
		}

		e, err := d.Child(ctx, part)
		if err != nil {
			return nil, errors.Wrapf(err, "unable to find %q", part)
		}

		cur = e
	}

	return cur, nil
}

// randomFile walks down from dir picking a random child at each level until it reaches a regular file.
// It returns a nil file when it ends in an empty directory or an entry that is neither file nor directory.
func randomFile(ctx context.Context, rnd *rand.Rand, dir fs.Directory) (rel string, f fs.File, err error) {
	var parts []string

	cur := dir

	for depth := 0; depth < 64; depth++ {
		entries, err := fs.GetAllEntries(ctx, cur)
		if err != nil {
			return "", nil, errors.Wrap(err, "unable to list directory")
		}

		if len(entries) == 0 {
			return "", nil, nil
		}

		e := entries[rnd.IntN(len(entries))]

		switch v := e.(type) {
		case fs.Directory:
			parts = append(parts, e.Name())
			cur = v
		case fs.File:
			return strings.Join(append(parts, e.Name()), "/"), v, nil
		default:
			return "", nil, nil
		}
	}

	return "", nil, nil
}

func hashFile(ctx context.Context, f fs.File) (sum [sha256.Size]byte, n int64, err error) {
	r, err := f.Open(ctx)
	if err != nil {
		return sum, 0, errors.Wrap(err, "unable to open")
	}

	defer r.Close() //nolint:errcheck

	h := sha256.New()

	n, err = io.Copy(h, r)
	if err != nil {
		return sum, n, errors.Wrap(err, "unable to read")
	}

	copy(sum[:], h.Sum(nil))

	return sum, n, nil
}

// readBack picks random files from the snapshot, reads them back from the repository and compares them
// with the file as it is now. A file that changed since the snapshot (different size or modification time) is
// not comparable and another is tried. It succeeds on the first file that is read back identically.
// When it fails after reading a file, the returned path says which one.
func readBack(ctx context.Context, rnd *rand.Rand, snap, live fs.Directory) (rel string, size int64, err error) {
	var lastErr error

	for try := 0; try < verifyReadBackTries; try++ {
		path, f, err := randomFile(ctx, rnd, snap)
		if err != nil {
			return "", 0, err
		}

		if f == nil || f.Size() > verifyReadBackMaxSize {
			continue
		}

		lf, err := entryAt(ctx, live, path)
		if err != nil {
			continue // deleted or moved since the snapshot
		}

		lfile, ok := lf.(fs.File)
		if !ok || lfile.Size() != f.Size() || !lfile.ModTime().Equal(f.ModTime()) {
			continue
		}

		want, _, err := hashFile(ctx, lfile)
		if err != nil {
			lastErr = errors.Wrapf(err, "reading the live file %v", path) // not a backup problem
			continue
		}

		got, n, err := hashFile(ctx, f)
		if err != nil {
			return path, f.Size(), errors.Wrapf(err, "restoring %v from the snapshot", path)
		}

		if got != want {
			return path, f.Size(), errors.Errorf("%v differs from the live file (restored %d bytes)", path, n)
		}

		return path, f.Size(), nil
	}

	if lastErr != nil {
		return "", 0, lastErr
	}

	return "", 0, errors.Errorf("no unchanged file found to compare after %d tries", verifyReadBackTries)
}

// sampleVerify reads back a percentage of the files of each newest snapshot and checks that every
// object they refer to exists, including that its pack blob is present in storage.
func sampleVerify(ctx context.Context, rep repo.Repository, roots map[snapshot.SourceInfo]*snapshot.Manifest, percent float64) (files, bytes int64, err error) {
	opts := snapshotfs.VerifierOptions{
		VerifyFilesPercent: percent,
		FileQueueLength:    20000,
		Parallelism:        runtime.NumCPU(),
		MaxErrors:          verifySampleMaxErrors,
	}

	if dr, ok := rep.(repo.DirectRepository); ok {
		blobMap, err := blob.ReadBlobMap(ctx, dr.BlobReader())
		if err != nil {
			return 0, 0, errors.Wrap(err, "unable to list the blobs in storage")
		}

		opts.BlobMap = blobMap
	}

	v := snapshotfs.NewVerifier(ctx, rep, opts)

	res, err := v.InParallel(ctx, func(tw *snapshotfs.TreeWalker) error {
		for _, src := range sortedSources(roots) {
			root, err := snapshotfs.SnapshotRoot(rep, roots[src])
			if err != nil {
				return errors.Wrapf(err, "unable to open the snapshot of %v", src.Path)
			}

			//nolint:errcheck // errors are aggregated by the verifier
			tw.Process(ctx, root, src.Path)
		}

		return nil
	})

	return res.Stats.ReadFileCount, res.Stats.ReadBytes, errors.Wrap(err, "verification failed")
}

// verifier runs the health checks of one connected repository.
type verifier struct {
	srv *Server
	rep repo.Repository

	cancel context.CancelFunc
	wg     sync.WaitGroup
	notify verifyNotifier

	runMu sync.Mutex // serializes check runs

	mu sync.Mutex
	// +checklocks:mu
	status serverapi.VerifyStatus
	// +checklocks:mu
	lastSignature string
	// +checklocks:mu
	lastNotified time.Time
	// +checklocks:mu
	graceUntil time.Time
	// +checklocks:mu
	lastTick time.Time
	// +checklocks:mu
	deepRunning bool
}

func startVerifier(ctx context.Context, srv *Server, rep repo.Repository) *verifier {
	ctx, cancel := context.WithCancel(context.WithoutCancel(ctx))

	v := &verifier{srv: srv, rep: rep, cancel: cancel, notify: newVerifyNotifier(srv)}

	now := clock.Now()
	v.status = serverapi.VerifyStatus{Enabled: true, State: "unknown"}
	v.graceUntil = now.Add(verifyWakeGrace)
	v.lastTick = now

	v.wg.Add(1)

	go func() {
		defer v.wg.Done()

		v.loop(ctx)
	}()

	return v
}

func (v *verifier) stop() {
	v.cancel()
	v.wg.Wait()
}

func (v *verifier) loop(ctx context.Context) {
	// first look soon after start, so a broken state is reported without waiting a full interval.
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}

		v.tick(ctx)
		timer.Reset(verifyQuickInterval)
	}
}

func (v *verifier) tick(ctx context.Context) {
	now := clock.Now()

	v.mu.Lock()
	if gap := now.Sub(v.lastTick); gap > verifySleepGap {
		userLog(ctx).Infof("verifier: last check was %v ago (machine asleep?); not reporting stale snapshots for %v", gap.Round(time.Second), verifyWakeGrace)

		v.graceUntil = now.Add(verifyWakeGrace)
	}

	v.lastTick = now
	deepDue := v.status.LastDeep == nil || (now.Sub(*v.status.LastDeep) >= verifyDeepEvery && now.Hour() >= verifyDeepHour && now.Hour() < verifyDeepHour+6)
	v.mu.Unlock()

	if deepDue {
		v.runDeep(ctx, "scheduled")
		return
	}

	v.runQuick(ctx)
}

func (v *verifier) loadManifests(ctx context.Context) ([]*snapshot.Manifest, error) {
	ids, err := snapshot.ListSnapshotManifests(ctx, v.rep, nil, nil)
	if err != nil {
		return nil, errors.Wrap(err, "unable to list snapshots")
	}

	ms, err := snapshot.LoadSnapshots(ctx, v.rep, ids)

	return ms, errors.Wrap(err, "unable to load snapshots")
}

// localOnly keeps the snapshots made by this machine.
func (v *verifier) localOnly(ms []*snapshot.Manifest) []*snapshot.Manifest {
	h := v.rep.ClientOptions().Hostname

	var out []*snapshot.Manifest

	for _, m := range ms {
		if m.Source.Host == h {
			out = append(out, m)
		}
	}

	return out
}

func (v *verifier) quick(ctx context.Context) ([]verifyCheck, []*snapshot.Manifest) {
	ms, err := v.loadManifests(ctx)
	if err != nil {
		return []verifyCheck{failed("Snapshots can be read", err.Error())}, nil
	}

	ms = v.localOnly(ms)

	v.mu.Lock()
	checkAge := !clock.Now().Before(v.graceUntil)
	v.mu.Unlock()

	return quickChecks(clock.Now(), ms, checkAge), ms
}

// runQuick runs the cheap checks. A task is only recorded when the outcome changes.
func (v *verifier) runQuick(ctx context.Context) {
	v.runMu.Lock()
	defer v.runMu.Unlock()

	checks, _ := v.quick(ctx)
	v.finish(ctx, checks, false)
}

// runDeep runs all checks as a recorded task.
func (v *verifier) runDeep(ctx context.Context, why string) {
	v.mu.Lock()
	if v.deepRunning {
		v.mu.Unlock()
		return
	}

	v.deepRunning = true
	v.mu.Unlock()

	defer func() {
		v.mu.Lock()
		v.deepRunning = false
		v.mu.Unlock()
	}()

	v.runMu.Lock()
	defer v.runMu.Unlock()

	var checks []verifyCheck

	taskID := ""

	//nolint:errcheck // a failed check is reported through the checks, the task error only marks the task FAILED
	_ = v.srv.taskmgr.Run(ctx, "Verify", "Backup health check ("+why+")", func(ctx context.Context, ctrl uitask.Controller) error {
		taskID = ctrl.CurrentTaskID()
		checks = v.deepChecks(ctx, ctrl)

		for _, c := range checks {
			if c.OK {
				userLog(ctx).Infof("PASS  %v: %v", c.Name, c.Detail)
			} else {
				userLog(ctx).Errorf("FAIL  %v: %v", c.Name, c.Detail)
			}
		}

		if bad := failedSummary(checks); bad != "" {
			return errors.New(bad)
		}

		return nil
	})

	now := clock.Now()

	v.mu.Lock()
	v.status.LastDeep = &now
	v.status.LastDeepTaskID = taskID
	v.mu.Unlock()

	v.finish(ctx, checks, true)
}

func (v *verifier) deepChecks(ctx context.Context, ctrl uitask.Controller) []verifyCheck {
	checks, ms := v.quick(ctx)
	if ms == nil {
		return checks
	}

	latest := map[snapshot.SourceInfo]*snapshot.Manifest{}

	for src, l := range newestFirst(ms) {
		latest[src] = l[0]
	}

	if len(latest) == 0 {
		return checks
	}

	ctrl.ReportProgressInfo("verifying a sample of files")

	files, bytes, err := sampleVerify(ctx, v.rep, latest, verifySamplePercent)
	if err != nil {
		checks = append(checks, failed("Sample of stored data verifies", err.Error()))
	} else {
		checks = append(checks, passed("Sample of stored data verifies", fmt.Sprintf("%v%% sample: read %d files, %d bytes, all objects present in storage", verifySamplePercent, files, bytes)))
	}

	ctrl.ReportProgressInfo("restoring a random file")

	return append(checks, v.readBackCheck(ctx, latest))
}

func (v *verifier) readBackCheck(ctx context.Context, latest map[snapshot.SourceInfo]*snapshot.Manifest) verifyCheck {
	const name = "A random file restores identically"

	rnd := rand.New(rand.NewPCG(uint64(clock.Now().UnixNano()), 1)) //nolint:gosec

	var lastErr error

	srcs := sortedSources(latest)
	rnd.Shuffle(len(srcs), func(i, j int) { srcs[i], srcs[j] = srcs[j], srcs[i] })

	for _, src := range srcs {
		root, err := snapshotfs.SnapshotRoot(v.rep, latest[src])
		if err != nil {
			return failed(name, errors.Wrapf(err, "unable to open the snapshot of %v", src.Path).Error())
		}

		dir, ok := root.(fs.Directory)
		if !ok {
			continue
		}

		liveEntry, err := localfs.NewEntry(src.Path)
		if err != nil {
			lastErr = err
			continue
		}

		liveDir, ok := liveEntry.(fs.Directory)
		if !ok {
			continue
		}

		rel, size, err := readBack(ctx, rnd, dir, liveDir)
		if err != nil {
			if rel != "" {
				return failed(name, err.Error()) // a real mismatch or restore failure
			}

			lastErr = err

			continue
		}

		return passed(name, fmt.Sprintf("%v/%v (%d bytes) read back from the repository matches the file on disk", src.Path, rel, size))
	}

	if lastErr != nil {
		return failed(name, lastErr.Error())
	}

	return failed(name, "no file could be compared")
}

func failedSummary(checks []verifyCheck) string {
	var bad []string

	for _, c := range checks {
		if !c.OK {
			bad = append(bad, c.Name+": "+c.Detail)
		}
	}

	return strings.Join(bad, "; ")
}

// finish stores the outcome and sends notifications when it changed (or as a reminder while it persists).
func (v *verifier) finish(ctx context.Context, checks []verifyCheck, deep bool) {
	now := clock.Now()
	bad := failedSummary(checks)

	v.mu.Lock()

	prevState := v.status.State
	prevSig := v.lastSignature

	v.status.Checks = checks
	v.status.LastRun = &now
	v.status.Enabled = true

	if bad == "" {
		v.status.State = "ok"
		v.status.Since = now
		v.lastSignature = ""
	} else {
		v.status.State = "failing"

		if prevState != "failing" {
			v.status.Since = now
		}

		v.lastSignature = bad
	}

	remind := bad != "" && prevSig == bad && now.Sub(v.lastNotified) >= verifyRemindEvery
	changed := bad != prevSig
	notifyNow := (bad != "" && (changed || remind)) || (bad == "" && prevState == "failing")

	if notifyNow {
		v.lastNotified = now
	}

	v.mu.Unlock()

	if !notifyNow {
		return
	}

	title, body := "Backup problem", bad
	if bad == "" {
		title, body = "Backup is healthy again", "All backup health checks pass."
	}

	// a failure found by a quick check, outside a recorded task, gets its own task so the details stay in
	// the task history.
	if !deep && bad != "" {
		//nolint:errcheck
		_ = v.srv.taskmgr.Run(ctx, "Verify", "Backup health check (problem found)", func(ctx context.Context, _ uitask.Controller) error {
			for _, c := range checks {
				if !c.OK {
					userLog(ctx).Errorf("FAIL  %v: %v", c.Name, c.Detail)
				}
			}

			return errors.New(bad)
		})
	}

	userLog(ctx).Warnf("verifier: %v: %v", title, body)
	v.notify.Notify(ctx, title, body)
}

func (v *verifier) getStatus() serverapi.VerifyStatus {
	v.mu.Lock()
	defer v.mu.Unlock()

	st := v.status
	st.Checks = append([]verifyCheck(nil), st.Checks...)

	return st
}
