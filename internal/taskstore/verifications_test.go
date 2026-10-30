package taskstore_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/taskstore"
)

func TestVerificationsKeepTheLatestOfEachKindWithTheirFailures(t *testing.T) {
	s, _ := openStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	rec := func(snap, mode string, ok bool, errs int64, failures ...string) int64 {
		var fs []taskstore.VerificationFailure
		for _, p := range failures {
			fs = append(fs, taskstore.VerificationFailure{Path: p, Error: "bad"})
		}

		id, _, err := s.RecordVerification(taskstore.Verification{
			SnapshotID: snap, Source: "u@h:/home", Mode: mode, Percent: 100, StartedAt: now, FinishedAt: now.Add(time.Minute),
			OK: ok, Files: 10, Bytes: 100, ReadFiles: 10, ReadBytes: 100, ErrorCount: errs,
		}, fs)
		require.NoError(t, err)

		return id
	}

	rec("s1", "full", false, 2, "/b", "/a")
	second := rec("s1", "full", true, 0)
	rec("s1", "new", true, 0)
	rec("s2", "sample", false, 1, "/x")

	got, err := s.LatestVerifications([]string{"s1", "s2", "none"})
	require.NoError(t, err)
	require.Len(t, got, 3) // s1 full, s1 new, s2 sample

	var s1full taskstore.Verification

	for _, v := range got {
		if v.SnapshotID == "s1" && v.Mode == "full" {
			s1full = v
		}
	}

	require.Equal(t, second, s1full.ID)
	require.True(t, s1full.OK)
	require.Equal(t, now.Add(time.Minute), s1full.FinishedAt)

	// the newest full result replaced the failed one, whose failures are still there by its ID
	v, ok, err := s.GetVerification(1)
	require.NoError(t, err)
	require.True(t, ok)
	require.False(t, v.OK)
	require.EqualValues(t, 2, v.FailureKept)

	f, err := s.VerificationFailures(1, 0)
	require.NoError(t, err)
	require.Equal(t, []string{"/a", "/b"}, []string{f[0].Path, f[1].Path})

	f, err = s.VerificationFailures(1, 1)
	require.NoError(t, err)
	require.Len(t, f, 1)

	_, ok, err = s.GetVerification(999)
	require.NoError(t, err)
	require.False(t, ok)

	none, err := s.LatestVerifications(nil)
	require.NoError(t, err)
	require.Empty(t, none)
}

func TestNewDataVerificationCountsOnlyRecentNewModeAndNotDismissed(t *testing.T) {
	s, _ := openStore(t)
	now := time.Now().UTC()

	rec := func(mode string, ok bool, ago time.Duration) int64 {
		id, _, err := s.RecordVerification(taskstore.Verification{
			SnapshotID: "s", Source: "u@h:/x", Mode: mode, StartedAt: now.Add(-ago), FinishedAt: now.Add(-ago), OK: ok,
		}, nil)
		require.NoError(t, err)

		return id
	}

	total, failed, err := s.NewDataVerificationCounts(now.Add(-24 * time.Hour))
	require.NoError(t, err)
	require.Zero(t, total+failed)

	rec("new", true, time.Hour)
	bad := rec("new", false, 2*time.Hour)
	rec("new", false, 30*time.Hour) // too old
	rec("full", false, time.Hour)   // a different check (Sample) covers non-"new" modes
	rec("sample", false, time.Hour) // same

	total, failed, err = s.NewDataVerificationCounts(now.Add(-24 * time.Hour))
	require.NoError(t, err)
	require.EqualValues(t, 2, total)
	require.EqualValues(t, 1, failed)

	// dismissing the failure stops it counting at all, not just from the banner
	require.NoError(t, s.DismissVerifications([]int64{bad}))

	total, failed, err = s.NewDataVerificationCounts(now.Add(-24 * time.Hour))
	require.NoError(t, err)
	require.EqualValues(t, 1, total)
	require.EqualValues(t, 0, failed)
}

func TestFailingVerificationsIsTheNewestBadOneOfEachSourceAndModeUntilDismissed(t *testing.T) {
	s, _ := openStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	rec := func(src, mode string, ok bool, errs int64) int64 {
		id, _, err := s.RecordVerification(taskstore.Verification{
			SnapshotID: src + "-snap", Source: src, Mode: mode, Percent: 10, StartedAt: now, FinishedAt: now,
			OK: ok, Files: 5, ErrorCount: errs,
		}, nil)
		require.NoError(t, err)

		return id
	}

	rec("u@h:/a", "sample", false, 3) // superseded below, should not appear
	bad := rec("u@h:/a", "sample", false, 7)
	rec("u@h:/a", "new", true, 0) // passing, should not appear
	rec("u@h:/b", "full", true, 0)

	got, err := s.FailingVerifications()
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, bad, got[0].ID)
	require.Equal(t, "u@h:/a", got[0].Source)
	require.EqualValues(t, 7, got[0].ErrorCount)

	// a newer passing result for the same source and mode clears it
	rec("u@h:/a", "sample", true, 0)

	got, err = s.FailingVerifications()
	require.NoError(t, err)
	require.Empty(t, got)

	// dismissing hides a failure until a newer one of the same source and mode replaces it
	again := rec("u@h:/a", "sample", false, 1)

	require.NoError(t, s.DismissVerifications([]int64{again}))

	got, err = s.FailingVerifications()
	require.NoError(t, err)
	require.Empty(t, got)

	newer := rec("u@h:/a", "sample", false, 2)

	got, err = s.FailingVerifications()
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, newer, got[0].ID)

	require.NoError(t, s.DismissVerifications(nil)) // a no-op, not an error
}

func TestVerificationNamesItsTaskTheWayTheUIDoes(t *testing.T) {
	s, _ := openStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	_, _, err := s.RecordVerification(taskstore.Verification{
		SnapshotID: "s1", Source: "u@h:/home", Mode: "full", StartedAt: now, FinishedAt: now, OK: true, TaskSeq: 205,
	}, nil)
	require.NoError(t, err)

	_, _, err = s.RecordVerification(taskstore.Verification{
		SnapshotID: "s2", Source: "u@h:/home", Mode: "full", StartedAt: now, FinishedAt: now, OK: true,
	}, nil)
	require.NoError(t, err)

	got, err := s.LatestVerifications([]string{"s1", "s2"})
	require.NoError(t, err)

	ids := map[string]string{}
	for _, v := range got {
		ids[v.SnapshotID] = v.TaskID
	}

	require.Equal(t, "cd", ids["s1"], "205 is cd in hexadecimal, as the task is named in the UI")
	require.Empty(t, ids["s2"])
}

func TestRecordVerificationReportsWhatItClearedAndFindsItByTask(t *testing.T) {
	s, _ := openStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	rec := func(mode string, ok bool, taskSeq int, when time.Time) (id, clearedSeq int64) {
		id, clearedSeq, err := s.RecordVerification(taskstore.Verification{
			SnapshotID: "s1", Source: "u@h:/home", Mode: mode, Percent: 10, StartedAt: when, FinishedAt: when,
			OK: ok, TaskSeq: taskSeq,
		}, nil)
		require.NoError(t, err)

		return id, clearedSeq
	}

	// the first result of its kind clears nothing: there is no prior one to clear
	_, cleared := rec("sample", false, 11, now)
	require.Zero(t, cleared)

	// a failure right after a failure clears nothing: the immediately prior result is still bad
	rec("sample", false, 12, now.Add(time.Minute))
	bad, cleared := rec("sample", false, 13, now.Add(2*time.Minute))
	require.Zero(t, cleared)

	// a pass right after that failure clears it
	_, cleared = rec("sample", true, 14, now.Add(3*time.Minute))
	require.Equal(t, bad, cleared, "clears 13, the immediately prior result, not 11 or 12")

	// a pass right after a pass clears nothing
	_, cleared = rec("sample", true, 15, now.Add(4*time.Minute))
	require.Zero(t, cleared)

	// a different mode bucket is unaffected by the sample failures above
	_, cleared = rec("new", true, 16, now.Add(5*time.Minute))
	require.Zero(t, cleared)

	ids, err := s.RecentlyClearedTaskIDs(now.Add(-time.Hour))
	require.NoError(t, err)
	require.Equal(t, []string{"e"}, ids, "14 is e in hexadecimal: only the task that actually cleared something")

	ids, err = s.RecentlyClearedTaskIDs(now.Add(time.Hour))
	require.NoError(t, err)
	require.Empty(t, ids, "nothing finished after a cutoff in the future")
}

func TestFailingNewDataVerificationsNamesTheSourceAndRespectsDismissal(t *testing.T) {
	s, _ := openStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	id, _, err := s.RecordVerification(taskstore.Verification{
		SnapshotID: "s1", Source: "u@h:/Applications", Mode: "new", StartedAt: now, FinishedAt: now, OK: false, ErrorCount: 1,
	}, nil)
	require.NoError(t, err)

	// a sample failure is a different check's business
	_, _, err = s.RecordVerification(taskstore.Verification{
		SnapshotID: "s2", Source: "u@h:/Users", Mode: "sample", StartedAt: now, FinishedAt: now, OK: false, ErrorCount: 1,
	}, nil)
	require.NoError(t, err)

	got, err := s.FailingNewDataVerifications(now.Add(-time.Hour))
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "u@h:/Applications", got[0].Source)

	require.NoError(t, s.DismissVerifications([]int64{id}))

	got, err = s.FailingNewDataVerifications(now.Add(-time.Hour))
	require.NoError(t, err)
	require.Empty(t, got)
}

func TestLastVerificationOfSourceUsesTheSameModeBucketAsFailingVerifications(t *testing.T) {
	s, _ := openStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	_, ok, err := s.LastVerificationOfSource("u@h:/a", "sample")
	require.NoError(t, err)
	require.False(t, ok, "no verification recorded yet")

	rec := func(mode string, at time.Time) {
		_, _, err := s.RecordVerification(taskstore.Verification{
			SnapshotID: "s", Source: "u@h:/a", Mode: mode, StartedAt: at, FinishedAt: at, OK: true,
		}, nil)
		require.NoError(t, err)
	}

	sampleTime := now.Add(-2 * time.Hour)
	rec("sample", sampleTime)

	// an hourly "new" check in between does not count toward the sample schedule's last-run
	rec("new", now.Add(-time.Hour))

	got, ok, err := s.LastVerificationOfSource("u@h:/a", "sample")
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, sampleTime, got)

	// full shares the same bucket as sample
	got, ok, err = s.LastVerificationOfSource("u@h:/a", "full")
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, sampleTime, got)

	// "new" has its own bucket
	newTime := now.Add(-time.Hour)
	got, ok, err = s.LastVerificationOfSource("u@h:/a", "new")
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, newTime, got)

	// a different source is unaffected
	_, ok, err = s.LastVerificationOfSource("u@h:/b", "sample")
	require.NoError(t, err)
	require.False(t, ok)
}
