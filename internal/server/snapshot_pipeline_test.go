package server

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/repotesting"
	"github.com/kopia/kopia/internal/taskstore"
	"github.com/kopia/kopia/notification/notifydata"
	"github.com/kopia/kopia/repo/manifest"
	"github.com/kopia/kopia/snapshot"
)

func TestSavedWithoutID(t *testing.T) {
	saved := func(id string) *notifydata.ManifestWithError {
		r := &notifydata.ManifestWithError{Saved: true}
		r.Manifest.ID = manifest.ID(id)

		return r
	}

	require.False(t, savedWithoutID(saved("abc")), "saved with an ID is fine")
	require.True(t, savedWithoutID(saved("")), "saved without an ID is the bug")
	require.False(t, savedWithoutID(&notifydata.ManifestWithError{}), "not saved (identical to the last one, or failed) has no ID and that is fine")
}

// A snapshot taken the way the scheduler takes one must come out with its ID, or nothing can link or verify it.
func TestScheduledSnapshotKeepsItsIDAndIsVerifiedWhenTheSettingIsOn(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)
	s, h, _ := newHistoryServer(t)
	s.rep = env.Repository
	s.rootctx = ctx
	s.maxParallelSnapshots = 1
	s.parallelSnapshotsChanged = sync.NewCond(&s.parallelSnapshotsMutex)

	dir := t.TempDir()
	for _, n := range []string{"a.txt", "b.txt", "c.txt"} {
		require.NoError(t, os.WriteFile(filepath.Join(dir, n), []byte("content of "+n), 0o600))
	}

	src := snapshot.SourceInfo{Host: env.Repository.ClientOptions().Hostname, UserName: env.Repository.ClientOptions().Username, Path: dir}
	sm := newSourceManager(src, s, env.Repository)

	idle := func() {
		require.Eventually(t, func() bool { return len(s.snapVerifs.list(nil)) == 0 }, 30*time.Second, 20*time.Millisecond)
	}

	snapshotIDs := func() []string {
		ms, err := snapshot.ListSnapshots(ctx, env.Repository, src)
		require.NoError(t, err)

		ids := make([]string, 0, len(ms))
		for _, m := range ms {
			ids = append(ids, string(m.ID))
		}

		return ids
	}

	// setting off: the snapshot is saved, nothing is verified
	writePrefs(t, s, `{"verifyNewData":false}`)
	require.NoError(t, s.runSnapshotTask(ctx, src, sm.snapshotInternal))
	idle()

	first := snapshotIDs()
	require.Len(t, first, 1)

	got, err := h.LatestVerifications(first)
	require.NoError(t, err)
	require.Empty(t, got)

	// setting on: the next snapshot is verified, under its own ID
	require.NoError(t, os.WriteFile(filepath.Join(dir, "d.txt"), []byte("a new file"), 0o600))
	writePrefs(t, s, `{"verifyNewData":true}`)
	require.NoError(t, s.runSnapshotTask(ctx, src, sm.snapshotInternal))

	require.Eventually(t, func() bool { return len(s.snapVerifs.list(nil)) == 0 }, 30*time.Second, 20*time.Millisecond)

	var second string

	for _, id := range snapshotIDs() {
		if id != first[0] {
			second = id
		}
	}

	require.NotEmpty(t, second)

	got, err = h.LatestVerifications([]string{second})
	require.NoError(t, err)
	require.Len(t, got, 1, "the snapshot taken with the setting on is verified")
	require.Equal(t, taskstore.VerifyModeNew, got[0].Mode)
	require.True(t, got[0].OK)

	// sample mode: the setting's share is read back instead
	writePrefs(t, s, `{"verifyNewData":true,"verifyEachMode":"sample","verifyEachPercent":50}`)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "e.txt"), []byte("another"), 0o600))
	require.NoError(t, s.runSnapshotTask(ctx, src, sm.snapshotInternal))
	idle()

	var third string

	for _, id := range snapshotIDs() {
		if id != first[0] && id != second {
			third = id
		}
	}

	got, err = h.LatestVerifications([]string{third})
	require.NoError(t, err)
	require.NotEmpty(t, got)
	require.Equal(t, taskstore.VerifyModeSample, got[len(got)-1].Mode)
}
