package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/gorilla/mux"
	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/gather"
	"github.com/kopia/kopia/internal/mockfs"
	"github.com/kopia/kopia/internal/repotesting"
	"github.com/kopia/kopia/internal/taskstore"
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/repo/blob"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/snapshotfs"
	"github.com/kopia/kopia/snapshot/upload"
)

const manyFiles = 20

// manyFilesEnv has a saved snapshot of manyFiles files with different content, more than the five failures the
// old verifier stopped at.
func manyFilesEnv(t *testing.T) (context.Context, *repotesting.Environment, *snapshot.Manifest) {
	t.Helper()

	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)

	live := mockfs.NewDirectory()
	d := live.AddDir("docs", 0o755)

	for i := range manyFiles {
		d.AddFile(fmt.Sprintf("f%02d.txt", i), []byte(fmt.Sprintf("file number %d with its own content, long enough to matter", i)), 0o644)
	}

	src := snapshot.SourceInfo{Host: env.Repository.ClientOptions().Hostname, UserName: env.Repository.ClientOptions().Username, Path: "/data"}

	m, err := upload.NewUploader(env.RepositoryWriter).Upload(ctx, live, nil, src)
	require.NoError(t, err)

	_, err = snapshot.SaveSnapshot(ctx, env.RepositoryWriter, m)
	require.NoError(t, err)
	require.NoError(t, env.RepositoryWriter.Flush(ctx))

	return ctx, env, m
}

func rootOf(t *testing.T, env *repotesting.Environment, m *snapshot.Manifest) []treeRoot {
	t.Helper()

	root, err := snapshotfs.SnapshotRoot(env.Repository, m)
	require.NoError(t, err)

	return []treeRoot{{Path: m.Source.Path, Entry: root}}
}

func blobMapOf(ctx context.Context, t *testing.T, env *repotesting.Environment) map[blob.ID]blob.Metadata {
	t.Helper()

	bm, err := blob.ReadBlobMap(ctx, env.RootStorage())
	require.NoError(t, err)

	return bm
}

func packIDs(ctx context.Context, t *testing.T, env *repotesting.Environment) []blob.ID {
	t.Helper()

	var packs []blob.ID

	require.NoError(t, env.RootStorage().ListBlobs(ctx, "p", func(bm blob.Metadata) error {
		packs = append(packs, bm.BlobID)

		return nil
	}))
	require.NotEmpty(t, packs)

	return packs
}

func TestVerifyTreesPassesOnAHealthySnapshot(t *testing.T) {
	ctx, env, m := manyFilesEnv(t)

	res := verifyTrees(ctx, env.Repository, rootOf(t, env, m), snapVerifyOptions{Percent: 100, BlobMap: blobMapOf(ctx, t, env), ExpectedFiles: manyFiles})

	require.Zero(t, res.Errors, "%v", res.Failures)
	require.EqualValues(t, manyFiles, res.Total, "the total progress is measured against")
	require.EqualValues(t, manyFiles, res.Files)
	require.EqualValues(t, manyFiles, res.ReadFiles)
	require.Positive(t, res.ReadBytes)
}

func TestVerifyTreesReportsEveryLostFileWithItsPath(t *testing.T) {
	ctx, env, m := manyFilesEnv(t)

	for _, id := range packIDs(ctx, t, env) {
		require.NoError(t, env.RootStorage().DeleteBlob(ctx, id))
	}

	res := verifyTrees(ctx, env.Repository, rootOf(t, env, m), snapVerifyOptions{Percent: 100, BlobMap: blobMapOf(ctx, t, env)})

	require.EqualValues(t, manyFiles, res.Errors, "no limit on the failures counted")
	require.Len(t, res.Failures, manyFiles)

	var paths []string
	for _, f := range res.Failures {
		paths = append(paths, f.Path)
		require.Contains(t, f.Error, "missing from storage")
	}

	sort.Strings(paths)
	require.Equal(t, "/data/docs/f00.txt", paths[0])
	require.Equal(t, "/data/docs/f19.txt", paths[manyFiles-1])
}

func TestVerifyTreesFindsDataThatCannotBeReadBack(t *testing.T) {
	ctx, env, m := manyFilesEnv(t)

	// damage bytes all through every pack, so the blobs are there with the right length but the data is wrong
	for _, id := range packIDs(ctx, t, env) {
		var b gather.WriteBuffer

		require.NoError(t, env.RootStorage().GetBlob(ctx, id, 0, -1, &b))

		data := append([]byte(nil), b.ToByteSlice()...)
		for i := 0; i < len(data); i += 50 {
			data[i] ^= 0xff
		}

		require.NoError(t, env.RootStorage().PutBlob(ctx, id, gather.FromSlice(data), blob.PutOptions{}))
		b.Close()
	}

	// a second connection has no cached copy of the data, as the server has after a restart
	other := env.MustConnectOpenAnother(t)

	root, err := snapshotfs.SnapshotRoot(other, m)
	require.NoError(t, err)

	res := verifyTrees(ctx, other, []treeRoot{{Path: m.Source.Path, Entry: root}}, snapVerifyOptions{Percent: 100, BlobMap: blobMapOf(ctx, t, env)})
	require.Positive(t, res.Errors)
	require.NotEmpty(t, res.Failures[0].Path)
}

func TestVerifyTreesWithoutAReadStillChecksTheStorageListing(t *testing.T) {
	ctx, env, m := manyFilesEnv(t)

	packs := packIDs(ctx, t, env)
	require.NoError(t, env.RootStorage().DeleteBlob(ctx, packs[0]))

	res := verifyTrees(ctx, env.Repository, rootOf(t, env, m), snapVerifyOptions{Percent: 0.0001, BlobMap: blobMapOf(ctx, t, env)})
	require.Positive(t, res.Errors)
	require.EqualValues(t, res.Errors, len(res.Failures))
}

func TestVerifyNewContentsChecksOnlyWhatTheWindowWrote(t *testing.T) {
	ctx, env, m := manyFilesEnv(t)
	dr := env.Repository.(repo.DirectRepository)

	now := time.Now()

	all, err := verifyNewContents(ctx, dr, now.Add(-time.Hour), now.Add(time.Hour), nil)
	require.NoError(t, err)
	require.Zero(t, all.Errors, "%v", all.Failures)
	require.Positive(t, all.Files)
	require.Equal(t, all.Files, all.ReadFiles)
	require.Equal(t, all.Files, all.Total, "every content that was listed was checked")

	// a window long before the snapshot wrote nothing
	none, err := verifyNewContents(ctx, dr, now.Add(-72*time.Hour), now.Add(-48*time.Hour), nil)
	require.NoError(t, err)
	require.Zero(t, none.Files)

	for _, id := range packIDs(ctx, t, env) {
		require.NoError(t, env.RootStorage().DeleteBlob(ctx, id))
	}

	bad, err := verifyNewContents(ctx, dr, now.Add(-time.Hour), now.Add(time.Hour), nil)
	require.NoError(t, err)
	require.Positive(t, bad.Errors)
	require.Contains(t, bad.Failures[0].Path, "pack ")

	_ = m
}

func TestSnapshotVerifyTaskRecordsTheResultAndEveryFailure(t *testing.T) {
	ctx, env, m := manyFilesEnv(t)
	s, h, _ := newHistoryServer(t)

	waitIdle := func() {
		require.Eventually(t, func() bool { return len(s.snapVerifs.list(nil)) == 0 }, 30*time.Second, 20*time.Millisecond)
	}

	require.True(t, s.startSnapshotVerify(ctx, env.Repository, m, taskstore.VerifyModeFull, 100))
	waitIdle()

	got, err := h.LatestVerifications([]string{string(m.ID)})
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.True(t, got[0].OK)
	require.EqualValues(t, manyFiles, got[0].Files)
	require.Positive(t, got[0].TaskSeq)

	for _, id := range packIDs(ctx, t, env) {
		require.NoError(t, env.RootStorage().DeleteBlob(ctx, id))
	}

	require.True(t, s.startSnapshotVerify(ctx, env.Repository, m, taskstore.VerifyModeFull, 100))
	waitIdle()

	got, err = h.LatestVerifications([]string{string(m.ID)})
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.False(t, got[0].OK)
	require.EqualValues(t, manyFiles, got[0].ErrorCount)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/snapshots/verifications/x/failures", http.NoBody)
	req = mux.SetURLVars(req, map[string]string{"id": fmt.Sprint(got[0].ID)})

	res, aerr := handleVerificationFailures(ctx, requestContext{w: httptest.NewRecorder(), req: req, srv: s})
	require.Nil(t, aerr)
	require.Len(t, res.(*verificationFailuresResponse).Failures, manyFiles)

	// the same verification cannot be queued twice at once
	s.snapVerifs.mu.Lock()
	s.snapVerifs.running = map[string]*runningVerify{string(m.ID) + "/full": {SnapshotID: string(m.ID), Mode: taskstore.VerifyModeFull}}
	s.snapVerifs.mu.Unlock()

	require.False(t, s.startSnapshotVerify(ctx, env.Repository, m, taskstore.VerifyModeFull, 100))
}

func writePrefs(t *testing.T, s *Server, json string) {
	t.Helper()

	f := filepath.Join(t.TempDir(), "ui-preferences.json")
	require.NoError(t, os.WriteFile(f, []byte(json), 0o600))

	s.options.UIPreferencesFile = f
}

func TestNewlyWrittenDataIsReadBackAfterASnapshotWhenTheSettingIsOn(t *testing.T) {
	ctx, env, m := manyFilesEnv(t)
	s, h, _ := newHistoryServer(t)
	s.rep = env.Repository

	idle := func() {
		require.Eventually(t, func() bool { return len(s.snapVerifs.list(nil)) == 0 }, 30*time.Second, 20*time.Millisecond)
	}

	recorded := func() []taskstore.Verification {
		got, err := h.LatestVerifications([]string{string(m.ID)})
		require.NoError(t, err)

		return got
	}

	// off: nothing happens, whatever the outcome of the snapshot
	writePrefs(t, s, `{"verifyNewData":false}`)
	s.verifyNewData(ctx, m, nil)
	idle()
	require.Empty(t, recorded())

	// on, but the snapshot failed or was not saved: nothing to read back
	writePrefs(t, s, `{"verifyNewData":true}`)
	s.verifyNewData(ctx, m, errTest)

	unsaved := *m
	unsaved.ID = ""
	s.verifyNewData(ctx, &unsaved, nil)
	idle()
	require.Empty(t, recorded())

	// on: the data the snapshot added is read back and the result kept
	s.verifyNewData(ctx, m, nil)
	idle()

	got := recorded()
	require.Len(t, got, 1)
	require.Equal(t, taskstore.VerifyModeNew, got[0].Mode)
	require.True(t, got[0].OK)
	require.Positive(t, got[0].Files)
}

func TestNewDataHealthCheckFailsForADayAfterABadReadBack(t *testing.T) {
	s, h, _ := newHistoryServer(t)
	v := &verifier{srv: s}

	_, ok := v.newDataCheck()
	require.False(t, ok, "no setting and no results: no row")

	writePrefs(t, s, `{"verifyNewData":true}`)

	c, ok := v.newDataCheck()
	require.True(t, ok)
	require.True(t, c.OK)
	require.Contains(t, c.Detail, "no snapshot")

	rec := func(good bool) {
		_, err := h.RecordVerification(taskstore.Verification{
			SnapshotID: "s", Source: "u@h:/x", Mode: taskstore.VerifyModeNew, StartedAt: time.Now(), FinishedAt: time.Now(), OK: good,
		}, nil)
		require.NoError(t, err)
	}

	rec(true)

	c, _ = v.newDataCheck()
	require.True(t, c.OK)
	require.Contains(t, c.Detail, "1 snapshots")

	rec(false)

	c, _ = v.newDataCheck()
	require.False(t, c.OK)
	require.Contains(t, c.Detail, "1 of 2")

	// results from before the setting was turned off still count, so a failure is not hidden by switching it off
	writePrefs(t, s, `{"verifyNewData":false}`)

	c, ok = v.newDataCheck()
	require.True(t, ok)
	require.False(t, c.OK)
}
