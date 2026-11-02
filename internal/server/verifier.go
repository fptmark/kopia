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
	"github.com/kopia/kopia/internal/ignoreerr"
	"github.com/kopia/kopia/internal/notifyhub"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/internal/taskstore"
	"github.com/kopia/kopia/internal/uitask"
	"github.com/kopia/kopia/internal/units"
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/repo/blob"
	"github.com/kopia/kopia/repo/logging"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/policy"
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

	verifySamplePercent = 1.0
	// the check lists this many failing files; all of them are kept in the task history.
	verifyCheckFailuresListed = 200

	verifyReadBackMaxSize = 50 << 20
	verifyReadBackTries   = 60

	// failed files: an absolute ceiling, and a jump compared with the previous snapshot of the same source.
	verifyMaxFailedFiles  = 25
	verifyFailedFilesJump = 10

	verifyRemindEvery = 12 * time.Hour

	// a read-back of the data a snapshot added that failed keeps the health check failing for this long.
	verifyNewDataWindow = 24 * time.Hour
)

// verifyCheckOrder is the order checks are listed in; unknown names go last.
var verifyCheckOrder = []string{ //nolint:gochecknoglobals
	checkReadable, checkRecent, checkFailedFilesName, checkExclusions, checkNewData, checkSample, checkRestore,
}

const (
	checkReadable        = "Snapshots can be read"
	checkRecent          = "Snapshots are recent"
	checkFailedFilesName = "Snapshots skip no unexpected files"
	checkExclusions      = "Exclusion rules match the policies"
	checkNewData         = "Data added by recent snapshots reads back"
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

// freshnessLimit is how old the newest snapshot of a source may be before it is reported, from its schedule:
// twice the interval plus half an hour (never less than the default), a day and two hours for fixed times of
// day or cron schedules, and a week and a day for manual snapshots.
func freshnessLimit(p policy.SchedulingPolicy) time.Duration {
	switch {
	case p.IntervalSeconds > 0:
		return max(verifyMaxSnapshotAge, 2*time.Duration(p.IntervalSeconds)*time.Second+30*time.Minute)
	case len(p.TimesOfDay) > 0 || len(p.Cron) > 0:
		return 26 * time.Hour
	case p.Manual:
		return 8 * 24 * time.Hour
	}

	return verifyMaxSnapshotAge
}

// limitFor returns the freshness limit of a source, following its current schedule.
func (v *verifier) limitFor(src snapshot.SourceInfo) time.Duration {
	if sm, ok := v.srv.snapshotAllSourceManagers()[src]; ok {
		return freshnessLimit(sm.Status().SchedulingPolicy)
	}

	return verifyMaxSnapshotAge
}

// checkFreshness fails when the newest snapshot of a source is older than the limit for that source.
func checkFreshness(now time.Time, by map[snapshot.SourceInfo][]*snapshot.Manifest, limit func(snapshot.SourceInfo) time.Duration) verifyCheck {
	const name = checkRecent

	if len(by) == 0 {
		return failed(name, "there are no snapshots")
	}

	var bad []string

	for _, src := range sortedSources(by) {
		age := now.Sub(by[src][0].StartTime.ToTime())
		if age > limit(src) {
			bad = append(bad, fmt.Sprintf("%v: newest snapshot is %v old", src.Path, age.Round(time.Minute)))
		}
	}

	if len(bad) > 0 {
		return failed(name, strings.Join(bad, "; "))
	}

	return passed(name, fmt.Sprintf("newest snapshot of each of %d sources is recent enough for its schedule", len(by)))
}

// failedFiles counts the files a snapshot could not back up, not counting those hidden by ignore rules.
func failedFiles(m *snapshot.Manifest, ignored *ignoreerr.Store) int {
	if m.RootEntry == nil || m.RootEntry.DirSummary == nil {
		return 0
	}

	return max(0, int(m.RootEntry.DirSummary.FatalErrorCount)-ignoredFailures(ignored, m.Source.Path, m.RootEntry.DirSummary))
}

// ignoredFailures counts the recorded failed entries of a snapshot that ignore rules hide.
func ignoredFailures(ignored *ignoreerr.Store, source string, sum *fs.DirectorySummary) int {
	if sum == nil {
		return 0
	}

	var fails []ignoreerr.Failure
	for _, e := range sum.FailedEntries {
		fails = append(fails, ignoreerr.Failure{Path: e.EntryPath, Error: e.Error})
	}

	return ignored.CountIgnored(source, fails)
}

// checkFailedFiles fails when the newest snapshot of a source skipped many files, or many more than the
// snapshot before it (this is what losing a permission looks like: the snapshot still "succeeds").
func checkFailedFiles(by map[snapshot.SourceInfo][]*snapshot.Manifest, ignored *ignoreerr.Store) verifyCheck {
	const name = checkFailedFilesName

	var bad []string

	for _, src := range sortedSources(by) {
		l := by[src]
		newest := failedFiles(l[0], ignored)

		prev := newest
		if len(l) > 1 {
			prev = failedFiles(l[1], ignored)
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
func quickChecks(now time.Time, ms []*snapshot.Manifest, checkAge bool, limit func(snapshot.SourceInfo) time.Duration, ignored *ignoreerr.Store) []verifyCheck {
	by := newestFirst(ms)

	var checks []verifyCheck

	if checkAge {
		checks = append(checks, checkFreshness(now, by, limit))
	}

	return append(checks, checkFailedFiles(by, ignored))
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

// sourceVerify is the sample read-back of one source's newest snapshot.
type sourceVerify struct {
	Manifest *snapshot.Manifest
	Started  time.Time
	Finished time.Time
	Result   snapVerifyResult
}

// sampleVerifyEach reads back a percentage of the files of each newest snapshot and checks that every
// object they refer to exists, including that its pack blob is present in storage and long enough.
// Every failing file is counted and kept; nothing stops the run early. Each source is read on its own,
// like a manual Verify of that snapshot.
func sampleVerifyEach(ctx context.Context, rep repo.Repository, roots map[snapshot.SourceInfo]*snapshot.Manifest, percent float64) ([]sourceVerify, error) {
	opts := snapVerifyOptions{Percent: percent}

	if dr, ok := rep.(repo.DirectRepository); ok {
		blobMap, err := blob.ReadBlobMap(ctx, dr.BlobReader())
		if err != nil {
			return nil, errors.Wrap(err, "unable to list the blobs in storage")
		}

		opts.BlobMap = blobMap
	}

	var out []sourceVerify

	for _, src := range sortedSources(roots) {
		root, err := snapshotfs.SnapshotRoot(rep, roots[src])
		if err != nil {
			return nil, errors.Wrapf(err, "unable to open the snapshot of %v", src.Path)
		}

		started := clock.Now()
		res := verifyTrees(ctx, rep, []treeRoot{{Path: src.Path, Entry: root}}, opts)
		out = append(out, sourceVerify{Manifest: roots[src], Started: started, Finished: clock.Now(), Result: res})
	}

	return out, nil
}

// sampleVerify is sampleVerifyEach with the sources added up.
func sampleVerify(ctx context.Context, rep repo.Repository, roots map[snapshot.SourceInfo]*snapshot.Manifest, percent float64) (snapVerifyResult, error) {
	each, err := sampleVerifyEach(ctx, rep, roots, percent)
	if err != nil {
		return snapVerifyResult{}, err
	}

	var total snapVerifyResult

	for _, e := range each {
		r := e.Result
		total.Files += r.Files
		total.Bytes += r.Bytes
		total.ReadFiles += r.ReadFiles
		total.ReadBytes += r.ReadBytes
		total.Errors += r.Errors
		total.Failures = append(total.Failures, r.Failures...)
	}

	return total, nil
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
	// instabilityUntil is set only when a tick actually detects a gap consistent with the machine having
	// just been asleep (never just from server startup, unlike graceUntil above): while now is before it,
	// scheduling defers starting new Snapshot/Verify/Maintenance work instead of judging a source overdue
	// off a connection that is likely still mid-reconnect-storm from a sleep/wake cycle.
	// +checklocks:mu
	instabilityUntil time.Time
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
	gap := now.Sub(v.lastTick)
	sleepDetected := gap > verifySleepGap

	if sleepDetected {
		userLog(ctx).Infof("verifier: last check was %v ago (machine asleep?); not reporting stale snapshots for %v", gap.Round(time.Second), verifyWakeGrace)

		v.graceUntil = now.Add(verifyWakeGrace)
		v.instabilityUntil = now.Add(verifyWakeGrace)
	}

	v.lastTick = now
	due := deepDue(now, v.status.LastDeep)
	v.mu.Unlock()

	if sleepDetected {
		// the gap we just saw means whatever was running when the machine fell asleep has likely been
		// limping through reconnect after reconnect since: let it be canceled and retried fresh once
		// things settle, instead of possibly burning hours on a race with maintenance (see
		// recentlyUnstable's doc comment) or just wasted reconnect churn.
		v.srv.cancelBackgroundTasksForInstability(ctx)
	}

	if due {
		v.runDeep(ctx, "scheduled")
		return
	}

	v.runQuick(ctx)
}

// recentlyUnstable reports whether a tick recently detected a gap consistent with the machine having just
// been asleep (brief DarkWake windows between bouts of real sleep, each one long enough to start a
// reconnect but rarely long enough to finish anything). Snapshot, Verify and Maintenance scheduling all
// defer while this is true, rechecking again shortly, rather than starting (or continuing) expensive
// network operations across a connection that is likely to drop again within seconds -- which, besides
// wasting hours on reconnect churn, risks a long-running Verify's blob listing going stale enough for a
// concurrent Maintenance pass to legitimately repack something it still expects to find, reporting a false
// "missing from storage" failure.
func (v *verifier) recentlyUnstable(now time.Time) bool {
	v.mu.Lock()
	defer v.mu.Unlock()

	return now.Before(v.instabilityUntil)
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

	checks = append(checks, quickChecks(now, ms, checkAge, v.limitFor, v.srv.ignoredErrors())...)

	if c, ok := v.srv.exclusionCheck(ctx, v.rep); ok {
		checks = append(checks, c)
	}

	if c, ok := v.newDataCheck(); ok {
		checks = append(checks, c)
	}

	return checks, ms
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

	// a sleeping Mac drops the NAS connection and the check stalls for the whole nap
	defer v.srv.keepAwake(ctx)()

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

		if bad := taskErrorSummary(checks); bad != "" {
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

	checks = append(checks, v.sampleCheck(ctx, ctrl, latest))

	ctrl.ReportProgressInfo("restoring a random file")

	return append(checks, v.readBackCheck(ctx, latest))
}

// newDataCheck reports the read-backs of the data each snapshot added: failing when any in the last day failed.
// It is left out when the setting is off and nothing has been checked.
func (v *verifier) newDataCheck() (verifyCheck, bool) {
	h := v.srv.options.TaskHistory
	if h == nil {
		return verifyCheck{}, false
	}

	prefs, _ := getUIPreferencesOrEmpty(v.srv)
	since := clock.Now().Add(-verifyNewDataWindow)

	total, bad, err := h.NewDataVerificationCounts(since)
	if err != nil {
		return failed(checkNewData, "unable to read the results: "+err.Error()), true
	}

	switch {
	case !prefs.VerifyNewData && total == 0:
		return verifyCheck{}, false
	case bad > 0:
		return v.newDataFailure(h, since, bad, total), true
	case total == 0:
		return passed(checkNewData, "no snapshot has finished in the last 24 hours"), true
	default:
		return passed(checkNewData, fmt.Sprintf("%d snapshots in the last 24 hours, all the data they added reads back", total)), true
	}
}

// newDataFailure names the source(s) and snapshot(s) behind a failing newDataCheck instead of only counting
// them, and -- when there's exactly one -- links to its failure list the same way the Sample check does.
func (v *verifier) newDataFailure(h *taskstore.Store, since time.Time, bad, total int64) verifyCheck {
	detail := fmt.Sprintf("%d of %d read-backs in the last 24 hours found data that does not read back", bad, total)

	failing, err := h.FailingNewDataVerifications(since)
	if err != nil || len(failing) == 0 {
		return failed(checkNewData, detail+" (History page, Verified column)")
	}

	named := make([]string, 0, len(failing))
	for _, f := range failing {
		named = append(named, fmt.Sprintf("%v (%v)", shortSourcePath(f.Source), f.FinishedAt.Local().Format("Jan 2, 3:04 PM")))
	}

	check := failed(checkNewData, detail+": "+strings.Join(named, ", "))

	if len(failing) == 1 {
		check.VerificationID = failing[0].ID
		check.FailureCount = int(failing[0].ErrorCount)

		if fs, err := h.VerificationFailures(failing[0].ID, verifyCheckFailuresListed); err == nil {
			for _, f := range fs {
				check.Failures = append(check.Failures, serverapi.VerifyFailure{Path: f.Path, Error: f.Error})
			}
		}
	}

	return check
}

// shortSourcePath is the path out of a source written as user@host:/path.
func shortSourcePath(s string) string {
	if i := strings.IndexByte(s, ':'); i >= 0 {
		return s[i+1:]
	}

	return s
}

// sampleCheck reads a sample of each source's newest snapshot back and records one verification per
// snapshot, exactly as a manual Verify does, so the Verified column shows it.
func (v *verifier) sampleCheck(ctx context.Context, ctrl uitask.Controller, latest map[snapshot.SourceInfo]*snapshot.Manifest) verifyCheck {
	each, err := sampleVerifyEach(ctx, v.rep, latest, verifySamplePercent)
	if err != nil {
		return failed(checkSample, err.Error())
	}

	var (
		total    snapVerifyResult
		failures []taskstore.VerificationFailure
		lastID   int64
	)

	taskSeq, _ := uitask.ParseTaskID(ctrl.CurrentTaskID())

	for _, e := range each {
		r := e.Result
		total.Files += r.Files
		total.ReadFiles += r.ReadFiles
		total.ReadBytes += r.ReadBytes
		total.Errors += r.Errors
		failures = append(failures, r.Failures...)

		h := v.srv.options.TaskHistory
		if h == nil {
			continue
		}

		rec := taskstore.Verification{
			SnapshotID: string(e.Manifest.ID), Source: e.Manifest.Source.String(), Mode: taskstore.VerifyModeSample, Percent: verifySamplePercent,
			StartedAt: e.Started, FinishedAt: e.Finished, OK: r.Errors == 0, TaskSeq: taskSeq,
			Files: r.Files, Bytes: r.Bytes, ReadFiles: r.ReadFiles, ReadBytes: r.ReadBytes, ErrorCount: r.Errors,
		}

		if id, clearedSeq, err := h.RecordVerification(rec, r.Failures); err != nil {
			userLog(ctx).Errorf("unable to record the sample verification: %v", err)
		} else if r.Errors > 0 {
			lastID = id
		} else if clearedSeq != 0 {
			userLog(ctx).Infof("cleared: %v's previous sample verification (#%d) failed; this one found everything reads back fine", e.Manifest.Source.Path, clearedSeq)
		}
	}

	if total.Errors == 0 {
		return passed(checkSample, fmt.Sprintf("%v%% sample: read %d files (%v), all objects present in storage", verifySamplePercent, total.ReadFiles, units.BytesString(total.ReadBytes)))
	}

	check := failed(checkSample, fmt.Sprintf("%d of %d files failed to read back; first: %v: %v", total.Errors, total.Files, failures[0].Path, failures[0].Error))
	check.FailureCount = int(total.Errors)
	check.VerificationID = lastID

	for _, f := range failures[:min(len(failures), verifyCheckFailuresListed)] {
		check.Failures = append(check.Failures, serverapi.VerifyFailure{Path: f.Path, Error: f.Error})
	}

	return check
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

// taskErrorSummary is what a Verify task's own error says: the failing checks by name only, so it stays
// short and reads well in the Tasks list. The full detail for each is already in the task's log lines.
func taskErrorSummary(checks []verifyCheck) string {
	var names []string

	for _, c := range checks {
		if !c.OK {
			names = append(names, c.Name)
		}
	}

	return strings.Join(names, "; ")
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
	deepTask := v.status.LastDeepTaskID
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
					if c.OK {
						continue
					}

					userLog(ctx).Errorf("FAIL  %v: %v", c.Name, c.Detail)

					// a full check's result stays in force until the next full check, so say when it ran
					if age := now.Sub(c.CheckedAt); age > 2*verifyQuickInterval {
						userLog(ctx).Errorf("      this result is from the check at %v (%v ago), not from this run", c.CheckedAt.Local().Format("Jan 2, 3:04 PM"), age.Round(time.Minute))
					}

					if c.VerificationID != 0 {
						userLog(ctx).Errorf("      verification #%d has all %d failing files", c.VerificationID, c.FailureCount)
					}

					for _, f := range c.Failures {
						userLog(ctx).Errorf("      %v: %v", f.Path, f.Error)
					}

					if len(c.Failures) == 0 && c.FailureCount == 0 && deepTask != "" {
						userLog(ctx).Errorf("      no file list was kept; see the full check task %v", deepTask)
					}
				}

				return errors.New(taskErrorSummary(checks))
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

// clearIfVerified clears a failed "sample of stored data" check once every source's newest snapshot has been
// verified, whatever the mode, since the check failed and nothing verified since has failed. Without it only the
// next full check could clear the failure, and a person who had just verified the snapshots saw it stay.
func (v *verifier) clearIfVerified(ctx context.Context) {
	v.mu.Lock()
	old, known := v.known[checkSample]
	v.mu.Unlock()

	h := v.srv.options.TaskHistory
	if !known || old.OK || h == nil || v.rep == nil {
		return
	}

	ms, err := v.loadManifests(ctx)
	if err != nil {
		return
	}

	newest := newestFirst(v.localOnly(ms))
	if len(newest) == 0 {
		return
	}

	for _, l := range newest {
		got, err := h.LatestVerifications([]string{string(l[0].ID)})
		if err != nil {
			return
		}

		good := false

		for _, g := range got {
			if !g.FinishedAt.After(old.CheckedAt) {
				continue
			}

			if !g.OK {
				return
			}

			good = true
		}

		if !good {
			return
		}
	}

	v.finish(ctx, []verifyCheck{passed(checkSample, "cleared: the newest snapshot of every source was verified after this check failed")}, false)
}

func (v *verifier) getStatus() serverapi.VerifyStatus {
	v.mu.Lock()
	defer v.mu.Unlock()

	st := v.status
	st.Checks = append([]verifyCheck(nil), st.Checks...)
	st.DeepRunning = v.deepRunning

	return st
}
