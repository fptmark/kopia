package server

import (
	"context"
	"math/rand/v2"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/fs"
	"github.com/kopia/kopia/internal/mockfs"
	"github.com/kopia/kopia/internal/notifyhub"
	"github.com/kopia/kopia/internal/repotesting"
	"github.com/kopia/kopia/internal/uitask"
	"github.com/kopia/kopia/repo/blob"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/policy"
	"github.com/kopia/kopia/snapshot/snapshotfs"
	"github.com/kopia/kopia/snapshot/upload"
)

func manifestAt(src snapshot.SourceInfo, start time.Time, failed int) *snapshot.Manifest {
	return &snapshot.Manifest{
		Source:    src,
		StartTime: fs.UTCTimestamp(start.UnixNano()),
		RootEntry: &snapshot.DirEntry{DirSummary: &fs.DirectorySummary{FatalErrorCount: failed}},
	}
}

func defaultLimit(snapshot.SourceInfo) time.Duration { return verifyMaxSnapshotAge }

func TestFreshnessLimitFollowsTheSchedule(t *testing.T) {
	sec := func(d time.Duration) int64 { return int64(d / time.Second) }

	for _, tc := range []struct {
		name string
		pol  policy.SchedulingPolicy
		want time.Duration
	}{
		{"hourly keeps the default", policy.SchedulingPolicy{IntervalSeconds: sec(time.Hour)}, 3 * time.Hour},
		{"every 10 minutes keeps the default", policy.SchedulingPolicy{IntervalSeconds: sec(10 * time.Minute)}, 3 * time.Hour},
		{"every 6 hours", policy.SchedulingPolicy{IntervalSeconds: sec(6 * time.Hour)}, 12*time.Hour + 30*time.Minute},
		{"daily", policy.SchedulingPolicy{IntervalSeconds: sec(24 * time.Hour)}, 48*time.Hour + 30*time.Minute},
		{"every 3 days", policy.SchedulingPolicy{IntervalSeconds: sec(72 * time.Hour)}, 144*time.Hour + 30*time.Minute},
		{"times of day", policy.SchedulingPolicy{TimesOfDay: []policy.TimeOfDay{{Hour: 17}}}, 26 * time.Hour},
		{"cron", policy.SchedulingPolicy{Cron: []string{"0 17 * * *"}}, 26 * time.Hour},
		{"manual", policy.SchedulingPolicy{Manual: true}, 8 * 24 * time.Hour},
		{"nothing set", policy.SchedulingPolicy{}, 3 * time.Hour},
	} {
		require.Equal(t, tc.want, freshnessLimit(tc.pol), tc.name)
	}
}

func TestADailySourceIsNotStaleAfterThreeHours(t *testing.T) {
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	hourly := snapshot.SourceInfo{Host: "h", UserName: "u", Path: "/hourly"}
	daily := snapshot.SourceInfo{Host: "h", UserName: "u", Path: "/daily"}

	limits := map[snapshot.SourceInfo]time.Duration{hourly: 3 * time.Hour, daily: 48*time.Hour + 30*time.Minute}
	limit := func(s snapshot.SourceInfo) time.Duration { return limits[s] }

	by := newestFirst([]*snapshot.Manifest{manifestAt(hourly, now.Add(-time.Hour), 0), manifestAt(daily, now.Add(-30*time.Hour), 0)})
	require.True(t, checkFreshness(now, by, limit).OK)

	by = newestFirst([]*snapshot.Manifest{manifestAt(hourly, now.Add(-time.Hour), 0), manifestAt(daily, now.Add(-50*time.Hour), 0)})
	c := checkFreshness(now, by, limit)
	require.False(t, c.OK)
	require.Contains(t, c.Detail, "/daily")
	require.NotContains(t, c.Detail, "/hourly")
}

func TestVerifyCheckFreshness(t *testing.T) {
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	home := snapshot.SourceInfo{Host: "h", UserName: "u", Path: "/home"}
	apps := snapshot.SourceInfo{Host: "h", UserName: "u", Path: "/Apps"}

	fresh := newestFirst([]*snapshot.Manifest{manifestAt(home, now.Add(-30*time.Minute), 0), manifestAt(apps, now.Add(-2*time.Hour), 0)})
	require.True(t, checkFreshness(now, fresh, defaultLimit).OK)

	// only the newest snapshot of a source counts
	old := newestFirst([]*snapshot.Manifest{manifestAt(home, now.Add(-30*time.Minute), 0), manifestAt(home, now.Add(-9*time.Hour), 0)})
	require.True(t, checkFreshness(now, old, defaultLimit).OK)

	stale := newestFirst([]*snapshot.Manifest{manifestAt(home, now.Add(-30*time.Minute), 0), manifestAt(apps, now.Add(-5*time.Hour), 0)})
	c := checkFreshness(now, stale, defaultLimit)
	require.False(t, c.OK)
	require.Contains(t, c.Detail, "/Apps")
	require.NotContains(t, c.Detail, "/home")

	require.False(t, checkFreshness(now, newestFirst(nil), defaultLimit).OK, "no snapshots at all is a failure")

	// incomplete snapshots are not counted as recent
	inc := manifestAt(home, now.Add(-10*time.Minute), 0)
	inc.IncompleteReason = "checkpoint"
	require.False(t, checkFreshness(now, newestFirst([]*snapshot.Manifest{inc}), defaultLimit).OK)
}

func TestVerifyCheckFailedFiles(t *testing.T) {
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	home := snapshot.SourceInfo{Host: "h", UserName: "u", Path: "/home"}

	check := func(failedFiles ...int) verifyCheck {
		var ms []*snapshot.Manifest
		for i, f := range failedFiles { // first argument is the oldest
			ms = append(ms, manifestAt(home, now.Add(time.Duration(i)*time.Hour), f))
		}

		return checkFailedFiles(newestFirst(ms), nil)
	}

	require.True(t, check(0, 0, 0).OK)
	require.True(t, check(6, 6).OK)
	require.True(t, check(0, 4).OK, "a few new failures are only visible in the task history")

	// losing Full Disk Access: 0 -> 144
	c := check(0, 144)
	require.False(t, c.OK)
	require.Contains(t, c.Detail, "144")

	require.False(t, check(40, 40).OK, "constantly high is still reported")
	require.False(t, check(2, 15).OK, "a jump over the previous snapshot is reported")
	require.True(t, check(144, 0).OK, "improvement is fine")
}

func TestVerifyQuickChecksSkipsFreshnessDuringGrace(t *testing.T) {
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	home := snapshot.SourceInfo{Host: "h", UserName: "u", Path: "/home"}
	ms := []*snapshot.Manifest{manifestAt(home, now.Add(-8*time.Hour), 0)}

	require.Len(t, quickChecks(now, ms, true, defaultLimit, nil), 2)
	require.False(t, quickChecks(now, ms, true, defaultLimit, nil)[0].OK)
	require.Len(t, quickChecks(now, ms, false, defaultLimit, nil), 1)
}

type verifyTestEnv struct {
	ctx  context.Context
	env  *repotesting.Environment
	live *mockfs.Directory
	m    *snapshot.Manifest
}

func newVerifyTestEnv(t *testing.T) *verifyTestEnv {
	t.Helper()

	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)

	live := mockfs.NewDirectory()
	docs := live.AddDir("docs", 0o755)
	docs.AddFile("a.txt", []byte("the first file, with some content"), 0o644)
	docs.AddFile("b.txt", []byte("another file with different content"), 0o644)
	live.AddDir("deep", 0o755).AddDir("er", 0o755).AddFile("c.txt", []byte("a deeply nested file"), 0o644)

	src := snapshot.SourceInfo{Host: env.Repository.ClientOptions().Hostname, UserName: env.Repository.ClientOptions().Username, Path: "/data"}

	m, err := upload.NewUploader(env.RepositoryWriter).Upload(ctx, live, nil, src)
	require.NoError(t, err)
	require.NoError(t, env.RepositoryWriter.Flush(ctx))

	return &verifyTestEnv{ctx: ctx, env: env, live: live, m: m}
}

func (e *verifyTestEnv) snapDir(t *testing.T) fs.Directory {
	t.Helper()

	root, err := snapshotfs.SnapshotRoot(e.env.Repository, e.m)
	require.NoError(t, err)

	return root.(fs.Directory)
}

func TestReadBackPassesWhenSnapshotMatchesLiveFiles(t *testing.T) {
	e := newVerifyTestEnv(t)
	rnd := rand.New(rand.NewPCG(1, 2))

	for i := 0; i < 10; i++ {
		rel, size, err := readBack(e.ctx, rnd, e.snapDir(t), e.live)
		require.NoError(t, err)
		require.NotEmpty(t, rel)
		require.Positive(t, size)
	}
}

func TestReadBackSkipsFilesChangedSinceTheSnapshot(t *testing.T) {
	e := newVerifyTestEnv(t)
	rnd := rand.New(rand.NewPCG(3, 4))

	// every file is edited after the snapshot, so nothing can be compared
	docs := e.live.Subdir("docs")
	docs.Remove("a.txt")
	docs.Remove("b.txt")
	docs.AddFile("a.txt", []byte("edited"), 0o644)
	docs.AddFile("b.txt", []byte("edited too"), 0o644)
	e.live.Subdir("deep").Subdir("er").Remove("c.txt")

	_, _, err := readBack(e.ctx, rnd, e.snapDir(t), e.live)
	require.ErrorContains(t, err, "no unchanged file")
}

func TestReadBackDetectsContentThatDiffersFromTheSnapshot(t *testing.T) {
	e := newVerifyTestEnv(t)
	rnd := rand.New(rand.NewPCG(5, 6))

	// same name, size and modification time but different bytes: what the snapshot returns is not what was backed up
	docs := e.live.Subdir("docs")
	docs.Remove("a.txt")
	docs.Remove("b.txt")
	docs.AddFile("a.txt", []byte("the first file, with some CONTENT"), 0o644)
	docs.AddFile("b.txt", []byte("another file with different CONTENT"), 0o644)
	e.live.Subdir("deep").Subdir("er").Remove("c.txt")
	e.live.Subdir("deep").Subdir("er").AddFile("c.txt", []byte("a deeply nested FILE"), 0o644)

	rel, _, err := readBack(e.ctx, rnd, e.snapDir(t), e.live)
	require.ErrorContains(t, err, "differs from the live file")
	require.NotEmpty(t, rel)
}

func TestSampleVerifyPassesOnAHealthyRepository(t *testing.T) {
	e := newVerifyTestEnv(t)

	res, err := sampleVerify(e.ctx, e.env.Repository, map[snapshot.SourceInfo]*snapshot.Manifest{e.m.Source: e.m}, 100)
	require.NoError(t, err)
	require.Zero(t, res.Errors)
	require.EqualValues(t, 3, res.ReadFiles)
}

func TestSampleVerifyDetectsMissingDataInStorage(t *testing.T) {
	e := newVerifyTestEnv(t)

	// lose every pack blob in storage, as a damaged or partially restored NAS volume would
	var packs []blob.ID

	require.NoError(t, e.env.RootStorage().ListBlobs(e.ctx, "p", func(bm blob.Metadata) error {
		packs = append(packs, bm.BlobID)
		return nil
	}))
	require.NotEmpty(t, packs)

	for _, id := range packs {
		require.NoError(t, e.env.RootStorage().DeleteBlob(e.ctx, id))
	}

	res, err := sampleVerify(e.ctx, e.env.Repository, map[snapshot.SourceInfo]*snapshot.Manifest{e.m.Source: e.m}, 1)
	require.NoError(t, err)
	require.EqualValues(t, 3, res.Errors, "every file is named, not just the first few")
	require.Len(t, res.Failures, 3)
	require.Contains(t, res.Failures[0].Path, "/data/")
}

type recordingNotifier struct{ got []string }

func (r *recordingNotifier) Emit(_ context.Context, e notifyhub.Event) {
	title, body := notifyhub.Render(e)
	r.got = append(r.got, title+": "+body)
}

func TestVerifierReportsEveryFailingRunAndTheRecoveryOnce(t *testing.T) {
	n := &recordingNotifier{}
	v := &verifier{srv: &Server{notifier: n}}
	v.status.State = "unknown"

	ctx := context.Background()
	good := []verifyCheck{passed(checkRecent, "ok")}
	bad := []verifyCheck{failed(checkRecent, "broken")}

	v.finish(ctx, good, true)
	require.Empty(t, n.got, "a healthy start is silent")

	v.finish(ctx, bad, true)
	v.finish(ctx, bad, true)
	v.finish(ctx, bad, true)
	require.Len(t, n.got, 3, "reported while it lasts; the hub sends it once per repeat period")
	require.Contains(t, n.got[0], "Backup problem")
	require.Contains(t, n.got[0], "snapshots are out of date")

	v.finish(ctx, []verifyCheck{failed(checkRecent, "broken"), failed(checkSample, "also broken")}, true)
	require.Contains(t, n.got[3], "stored data failed verification", "a different set of failing checks is reported as it is")

	allGood := []verifyCheck{passed(checkRecent, "ok"), passed(checkSample, "ok")}
	v.finish(ctx, allGood, true)
	require.Len(t, n.got, 5)
	require.Contains(t, n.got[4], "healthy again")

	v.finish(ctx, allGood, true)
	require.Len(t, n.got, 5, "recovery is reported once")
	require.Equal(t, "ok", v.getStatus().State)
}

func TestLatestDeepRunSkipsProblemTasksAndRunningOnes(t *testing.T) {
	at := func(h int) *time.Time { x := time.Date(2026, 10, 22, h, 0, 0, 0, time.UTC); return &x }

	tasks := []uitask.Info{
		{TaskID: "5", Description: "Backup health check (problem found)", EndTime: at(11)},
		{TaskID: "4", Description: "Backup health check (manual)"}, // still running
		{TaskID: "3", Description: "Backup health check (scheduled)", EndTime: at(3)},
		{TaskID: "2", Description: "Backup health check (scheduled)", EndTime: at(1)},
	}

	end, id, ok := latestDeepRun(tasks)
	require.True(t, ok)
	require.Equal(t, "3", id)
	require.Equal(t, *at(3), end)

	_, _, ok = latestDeepRun(tasks[:2])
	require.False(t, ok)
}

func TestDeepDue(t *testing.T) {
	at := func(day, hour, min int) time.Time { return time.Date(2026, 10, day, hour, min, 0, 0, time.UTC) }
	last := func(day, hour, min int) *time.Time { x := at(day, hour, min); return &x }

	require.True(t, deepDue(at(22, 10, 0), nil), "never run")
	require.False(t, deepDue(at(23, 3, 0), last(22, 10, 4)), "17 hours since the last run")
	require.False(t, deepDue(at(23, 12, 0), last(22, 10, 4)), "a day later but not early morning")
	require.True(t, deepDue(at(24, 3, 10), last(22, 10, 4)), "the next early morning")
	require.True(t, deepDue(at(24, 3, 10), last(23, 3, 4)), "daily at the same time")
	require.True(t, deepDue(at(23, 21, 0), last(22, 3, 0)), "36 hours late runs at any hour")
}

func TestVerifierKeepsFullCheckResultsBetweenQuickRuns(t *testing.T) {
	n := &recordingNotifier{}
	v := &verifier{srv: &Server{notifier: n}, known: map[string]verifyCheck{}}
	v.status.State = "unknown"

	ctx := context.Background()

	// the daily full check
	v.finish(ctx, []verifyCheck{
		passed(checkRecent, "ok"),
		passed(checkSample, "7744 files"),
		passed(checkRestore, "matches"),
	}, true)

	// later quick runs only report the quick checks
	v.finish(ctx, []verifyCheck{passed(checkReadable, "48 snapshots"), passed(checkRecent, "ok")}, false)

	st := v.getStatus()
	names := make([]string, 0, len(st.Checks))

	for _, c := range st.Checks {
		names = append(names, c.Name)
		require.False(t, c.CheckedAt.IsZero(), c.Name)
	}

	require.Equal(t, []string{checkReadable, checkRecent, checkSample, checkRestore}, names, "listed in a fixed order, full check results kept")

	// a failed full check stays failing until the next full check, quick runs do not clear it
	v.finish(ctx, []verifyCheck{failed(checkRestore, "differs")}, true)
	v.finish(ctx, []verifyCheck{passed(checkReadable, "48 snapshots")}, false)
	require.Equal(t, "failing", v.getStatus().State)

	v.finish(ctx, []verifyCheck{passed(checkRestore, "matches")}, true)
	require.Equal(t, "ok", v.getStatus().State)
}

func TestVerifierStateSurvivesARestartWithoutRepeatingAlerts(t *testing.T) {
	prefs := filepath.Join(t.TempDir(), "ui-preferences.json")
	ctx := context.Background()

	n1 := &recordingNotifier{}
	v1 := &verifier{srv: &Server{options: Options{UIPreferencesFile: prefs}, notifier: n1}, known: map[string]verifyCheck{}}
	v1.status.State = "unknown"

	v1.finish(ctx, []verifyCheck{passed(checkSample, "7744 files"), failed(checkRestore, "differs")}, true)
	require.Len(t, n1.got, 1)

	// the server restarts
	n2 := &recordingNotifier{}
	v2 := &verifier{srv: &Server{options: Options{UIPreferencesFile: prefs}, notifier: n2}, known: map[string]verifyCheck{}}
	v2.status.State = "unknown"
	v2.loadState(ctx)

	st := v2.getStatus()
	require.Equal(t, "failing", st.State)
	require.Len(t, st.Checks, 2, "the results of the last full check are shown after the restart")

	// the same problem is found again by the first quick run: it is reported again, and the hub's persistent
	// repeat state (tested there) keeps the destinations from being told twice
	v2.finish(ctx, []verifyCheck{passed(checkReadable, "48 snapshots")}, false)
	require.Len(t, n2.got, 1)
	require.Contains(t, n2.got[0], "a test restore did not match")

	// a damaged state file is ignored
	require.NoError(t, os.WriteFile(filepath.Join(filepath.Dir(prefs), "verifier-state.json"), []byte("{broken"), 0o600))

	v3 := &verifier{srv: &Server{options: Options{UIPreferencesFile: prefs}, notifier: &recordingNotifier{}}, known: map[string]verifyCheck{}}
	v3.loadState(ctx)
	require.Empty(t, v3.getStatus().Checks)
}
