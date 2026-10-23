package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/natefinch/atomic"
	"github.com/pkg/errors"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"

	"github.com/kopia/kopia/fs"
	"github.com/kopia/kopia/fs/localfs"
	"github.com/kopia/kopia/internal/clock"
	"github.com/kopia/kopia/internal/notifyhub"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/internal/uitask"
	"github.com/kopia/kopia/internal/units"
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/repo/blob"
	"github.com/kopia/kopia/repo/logging"
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
	// a full check that is this late runs at any hour.
	verifyDeepOverdue = 36 * time.Hour

	verifySamplePercent   = 1.0
	verifySampleMaxErrors = 5

	verifyReadBackMaxSize = 50 << 20
	verifyReadBackTries   = 60

	// failed files: an absolute ceiling, and a jump compared with the previous snapshot of the same source.
	verifyMaxFailedFiles  = 25
	verifyFailedFilesJump = 10

	verifyRemindEvery = 12 * time.Hour
)

// verifyCheckOrder is the order checks are listed in; unknown names go last.
var verifyCheckOrder = []string{ //nolint:gochecknoglobals
	checkReadable, checkRecent, checkFailedFilesName, checkSample, checkRestore,
}

const (
	checkReadable        = "Snapshots can be read"
	checkRecent          = "Snapshots are recent"
	checkFailedFilesName = "Snapshots skip no unexpected files"
	checkSample          = "Sample of stored data verifies"
	checkRestore         = "A random file restores identically"
)

func checkRank(name string) int {
	for i, n := range verifyCheckOrder {
		if n == name {
			return i
		}
	}

	return len(verifyCheckOrder)
}

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
	const name = checkRecent

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
	const name = checkFailedFilesName

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

	runMu sync.Mutex // serializes check runs

	mu sync.Mutex
	// +checklocks:mu
	status serverapi.VerifyStatus
	// the latest result of every check, so the results of the daily full check stay visible between runs.
	// +checklocks:mu
	known map[string]verifyCheck
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

// persistedVerifier is what survives a restart: the latest result of every check and what was last reported,
// so the page is not empty after a start and an alert already sent is not sent again.
type persistedVerifier struct {
	Checks        []verifyCheck `json:"checks"`
	State         string        `json:"state"`
	Since         time.Time     `json:"since"`
	LastSignature string        `json:"lastSignature"`
	LastNotified  time.Time     `json:"lastNotified"`
}

func (v *verifier) stateFile() string {
	f := v.srv.options.UIPreferencesFile
	if f == "" {
		return ""
	}

	return filepath.Join(filepath.Dir(f), "verifier-state.json")
}

func (v *verifier) loadState(ctx context.Context) {
	f := v.stateFile()
	if f == "" {
		return
	}

	b, err := os.ReadFile(f) //nolint:gosec
	if err != nil {
		if !os.IsNotExist(err) {
			userLog(ctx).Errorf("unable to read the health check state: %v", err)
		}

		return
	}

	var p persistedVerifier
	if err := json.Unmarshal(b, &p); err != nil {
		userLog(ctx).Errorf("ignoring a damaged health check state file: %v", err)
		return
	}

	v.mu.Lock()
	defer v.mu.Unlock()

	for _, c := range p.Checks {
		v.known[c.Name] = c
	}

	v.status.Checks = sortedChecks(v.known)
	v.status.State = p.State
	v.status.Since = p.Since
	v.lastSignature = p.LastSignature
	v.lastNotified = p.LastNotified
}

func (v *verifier) saveState(ctx context.Context, p persistedVerifier) {
	f := v.stateFile()
	if f == "" {
		return
	}

	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return
	}

	if err := atomic.WriteFile(f, bytes.NewReader(b)); err != nil {
		userLog(ctx).Errorf("unable to save the health check state: %v", err)
	}
}

func sortedChecks(known map[string]verifyCheck) []verifyCheck {
	all := make([]verifyCheck, 0, len(known))
	for _, c := range known {
		all = append(all, c)
	}

	sort.Slice(all, func(i, j int) bool {
		if ri, rj := checkRank(all[i].Name), checkRank(all[j].Name); ri != rj {
			return ri < rj
		}

		return all[i].Name < all[j].Name
	})

	return all
}

func startVerifier(ctx context.Context, srv *Server, rep repo.Repository) *verifier {
	ctx, cancel := context.WithCancel(context.WithoutCancel(ctx))

	v := &verifier{srv: srv, rep: rep, cancel: cancel, known: map[string]verifyCheck{}}

	now := clock.Now()
	v.status = serverapi.VerifyStatus{Enabled: true, State: "unknown"}
	v.graceUntil = now.Add(verifyWakeGrace)
	v.lastTick = now

	v.loadState(ctx)

	// a restart (or a deploy) must not trigger another full check: continue from the last recorded one.
	if tasks, _, err := srv.taskmgr.QueryTasks(ctx, uitask.TaskQuery{Kind: "Verify", Limit: 20}); err == nil {
		if end, id, ok := latestDeepRun(tasks); ok {
			v.status.LastDeep = &end
			v.status.LastDeepTaskID = id
		}
	}

	v.wg.Add(1)

	go func() {
		defer v.wg.Done()

		v.loop(ctx)
	}()

	return v
}

// latestDeepRun finds the end of the newest finished full check among Verify tasks (newest first).
// Tasks recorded for a problem found by a quick check are not full checks.
func latestDeepRun(tasks []uitask.Info) (end time.Time, taskID string, ok bool) {
	for _, t := range tasks {
		if t.EndTime == nil || strings.Contains(t.Description, "problem found") {
			continue
		}

		if !ok || t.EndTime.After(end) {
			end, taskID, ok = *t.EndTime, t.TaskID, true
		}
	}

	return end, taskID, ok
}

// quietVerifierLogs stops the verifier from logging a line for every object it checks, which would fill the
// task log and push out the errors.
func quietVerifierLogs(ctx context.Context) context.Context {
	quiet := logging.Module("verifier")(ctx).Desugar().WithOptions(zap.IncreaseLevel(zapcore.InfoLevel)).Sugar()

	return logging.WithLogger(ctx, func(module string) logging.Logger {
		if module == "verifier" {
			return quiet
		}

		return logging.Module(module)(ctx)
	})
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
	due := deepDue(now, v.status.LastDeep)
	v.mu.Unlock()

	if due {
		v.runDeep(ctx, "scheduled")
		return
	}

	v.runQuick(ctx)
}

// deepDue reports whether the full check should run now: never run yet, a day has passed and it is the
// early morning (when the machine is mostly idle), or it is long overdue because the Mac was off or
// asleep during every early morning.
func deepDue(now time.Time, last *time.Time) bool {
	if last == nil {
		return true
	}

	since := now.Sub(*last)

	return since >= verifyDeepOverdue || (since >= verifyDeepEvery && now.Hour() >= verifyDeepHour && now.Hour() < verifyDeepHour+6)
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
		return []verifyCheck{failed(checkReadable, err.Error())}, nil
	}

	ms = v.localOnly(ms)

	v.mu.Lock()
	graceUntil := v.graceUntil
	v.mu.Unlock()

	now := clock.Now()
	checkAge := !now.Before(graceUntil)

	checks := []verifyCheck{passed(checkReadable, fmt.Sprintf("%d snapshots from %d sources", len(ms), len(newestFirst(ms))))}

	if !checkAge {
		checks = append(checks, passed(checkRecent, "not checked yet: waits until "+graceUntil.Local().Format("3:04 PM")+" for the first hourly snapshot after a start or wake"))
	}

	return append(checks, quickChecks(now, ms, checkAge)...), ms
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

	files, bytes, err := sampleVerify(quietVerifierLogs(ctx), v.rep, latest, verifySamplePercent)
	if err != nil {
		checks = append(checks, failed(checkSample, err.Error()))
	} else {
		checks = append(checks, passed(checkSample, fmt.Sprintf("%v%% sample: read %d files (%v), all objects present in storage", verifySamplePercent, files, units.BytesString(bytes))))
	}

	ctrl.ReportProgressInfo("restoring a random file")

	return append(checks, v.readBackCheck(ctx, latest))
}

func (v *verifier) readBackCheck(ctx context.Context, latest map[snapshot.SourceInfo]*snapshot.Manifest) verifyCheck {
	const name = checkRestore

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

		return passed(name, fmt.Sprintf("%v/%v (%v) read back from the repository matches the file on disk", src.Path, rel, units.BytesString(size)))
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

	v.mu.Lock()

	if v.known == nil {
		v.known = map[string]verifyCheck{}
	}

	for _, c := range checks {
		c.CheckedAt = now
		v.known[c.Name] = c
	}

	checks = sortedChecks(v.known)
	bad := failedSummary(checks)

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

	since := v.status.Since
	saved := persistedVerifier{Checks: checks, State: v.status.State, Since: v.status.Since, LastSignature: v.lastSignature, LastNotified: v.lastNotified}

	v.mu.Unlock()

	v.saveState(ctx, saved)

	ev := notifyhub.Event{ID: notifyhub.EventHealth, Since: since, Recovered: bad == ""}

	for _, c := range checks {
		if !c.OK {
			ev.Checks = append(ev.Checks, healthCheckCode(c.Name))
		}
	}

	if bad == "" {
		if notifyNow {
			userLog(ctx).Infof("verifier: healthy again")
			v.srv.emit(ctx, ev)
		}

		return
	}

	// a failure found by a quick check, outside a recorded task, gets its own task so the details stay in
	// the task history.
	if notifyNow {
		if !deep {
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

		userLog(ctx).Warnf("verifier: %v", bad)
	}

	// reported on every run while it lasts: the notification hub sends it once per repeat period to each
	// destination, and at once when the set of failing checks changes.
	v.srv.emit(ctx, ev)
}

// healthCheckCode maps a check to the code notifications use, so no detail text can reach a message.
func healthCheckCode(name string) notifyhub.HealthCheck {
	switch name {
	case checkReadable:
		return notifyhub.CheckReadable
	case checkRecent:
		return notifyhub.CheckRecent
	case checkFailedFilesName:
		return notifyhub.CheckSkips
	case checkSample:
		return notifyhub.CheckSample
	case checkRestore:
		return notifyhub.CheckRestore
	}

	return notifyhub.CheckReadable
}

func (v *verifier) getStatus() serverapi.VerifyStatus {
	v.mu.Lock()
	defer v.mu.Unlock()

	st := v.status
	st.Checks = append([]verifyCheck(nil), st.Checks...)

	return st
}
