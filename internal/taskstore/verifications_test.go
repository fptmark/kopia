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

		id, err := s.RecordVerification(taskstore.Verification{
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
