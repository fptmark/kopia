package server

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/fs"
	"github.com/kopia/kopia/internal/mockfs"
	"github.com/kopia/kopia/internal/repotesting"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/upload"
)

func TestGlobToRegexp(t *testing.T) {
	cases := []struct {
		pattern  string
		pathMode bool
		match    []string
		noMatch  []string
	}{
		{"x.txt", false, []string{"x.txt", "X.TXT"}, []string{"ax.txt", "x.txt2", "xtxt"}},
		{"*.txt", false, []string{"a.txt", ".txt", "A.Txt"}, []string{"a.txt.bak", "txt"}},
		{"rep?rt*", false, []string{"report.doc", "REPORT"}, []string{"rept.doc"}},
		{"a+b(1).c", false, []string{"a+b(1).c"}, []string{"aab(1).c", "a+b1.c"}},
		{"Documents/*.xls", true, []string{"Documents/a.xls", "documents/sub/b.xls"}, []string{"Other/Documents/a.xls"}},
		{"/Documents/x", true, []string{"Documents/x"}, nil},
	}

	for _, c := range cases {
		re, pathMode, err := globToRegexp(c.pattern)
		require.NoError(t, err, c.pattern)
		require.Equal(t, c.pathMode, pathMode, c.pattern)

		for _, m := range c.match {
			require.True(t, re.MatchString(m), "%q should match %q", c.pattern, m)
		}

		for _, m := range c.noMatch {
			require.False(t, re.MatchString(m), "%q should not match %q", c.pattern, m)
		}
	}

	_, _, err := globToRegexp("   ")
	require.Error(t, err)
}

func day(d int) time.Time {
	return time.Date(2026, time.March, d, 12, 0, 0, 0, time.UTC)
}

func runSearch(ctx context.Context, t *testing.T, s *snapshotSearcher, manifests []*snapshot.Manifest, req serverapi.SearchRequest) []serverapi.SearchResult {
	t.Helper()

	require.NoError(t, s.search(ctx, selectSnapshots(manifests, req)))

	res, _ := s.results()

	return res
}

func TestSnapshotSearch_VersionsAndDates(t *testing.T) {
	ctx, env := repotesting.NewEnvironment(t, repotesting.FormatNotImportant)

	root := mockfs.NewDirectory()
	docs := root.AddDir("docs", 0o755)
	docs.AddFile("a.txt", []byte("version one"), 0o644)
	docs.AddFile("b.log", []byte("log"), 0o644)
	root.AddDir("other", 0o755).AddFile("a.txt", []byte("version one"), 0o644) // same content, different path

	src := snapshot.SourceInfo{
		Host:     env.Repository.ClientOptions().Hostname,
		UserName: env.Repository.ClientOptions().Username,
		Path:     "/data",
	}

	u := upload.NewUploader(env.RepositoryWriter)

	take := func(d int) *snapshot.Manifest {
		m, err := u.Upload(ctx, root, nil, src)
		require.NoError(t, err)
		require.NoError(t, env.RepositoryWriter.Flush(ctx))

		m.StartTime = fs.UTCTimestamp(day(d).UnixNano())

		return m
	}

	m1 := take(1)
	m2 := take(2) // nothing changed
	docs.Remove("a.txt")
	docs.AddFile("a.txt", []byte("version number two"), 0o644)
	docs.AddFile("c.txt", []byte("new"), 0o644)
	m3 := take(5)
	docs.Remove("c.txt") // c.txt exists in snapshot 3 only
	m4 := take(9)

	all := []*snapshot.Manifest{m1, m2, m3, m4}

	newSearcher := func(req serverapi.SearchRequest) *snapshotSearcher {
		s, err := newSnapshotSearcher(env.Repository, req, func() {})
		require.NoError(t, err)

		return s
	}

	t.Run("collapses unchanged snapshots into one version with a date range", func(t *testing.T) {
		req := serverapi.SearchRequest{Pattern: "a.txt"}
		res := runSearch(ctx, t, newSearcher(req), all, req)

		// docs/a.txt v1 (snapshots 1,2), docs/a.txt v2 (3,4), other/a.txt (1-4)
		require.Len(t, res, 3)

		byKey := map[string]serverapi.SearchResult{}
		for _, r := range res {
			byKey[r.Path+"|"+r.Source] = r
		}

		var v1, v2, other serverapi.SearchResult

		for _, r := range res {
			switch {
			case r.Path == "other/a.txt":
				other = r
			case r.Path == "docs/a.txt" && r.Size == int64(len("version one")):
				v1 = r
			case r.Path == "docs/a.txt":
				v2 = r
			}
		}

		require.Equal(t, day(1), v1.FirstSeen.UTC())
		require.Equal(t, day(2), v1.LastSeen.UTC())
		require.Equal(t, 2, v1.SnapshotCount)

		require.Equal(t, day(5), v2.FirstSeen.UTC())
		require.Equal(t, day(9), v2.LastSeen.UTC())
		require.Equal(t, 2, v2.SnapshotCount)

		// untouched across all four snapshots, including those where the directory was not re-read
		require.Equal(t, day(1), other.FirstSeen.UTC())
		require.Equal(t, day(9), other.LastSeen.UTC())
		require.Equal(t, 4, other.SnapshotCount)
		require.NotEmpty(t, v1.ObjectID)
		require.NotEqual(t, v1.ObjectID, v2.ObjectID)
	})

	t.Run("a file that was deleted keeps the range where it existed", func(t *testing.T) {
		req := serverapi.SearchRequest{Pattern: "c.txt"}
		res := runSearch(ctx, t, newSearcher(req), all, req)

		require.Len(t, res, 1)
		require.Equal(t, day(5), res[0].FirstSeen.UTC())
		require.Equal(t, day(5), res[0].LastSeen.UTC())
	})

	t.Run("date range limits which snapshots are searched", func(t *testing.T) {
		req := serverapi.SearchRequest{Pattern: "a.txt", From: day(3), To: day(7)}
		res := runSearch(ctx, t, newSearcher(req), all, req)

		for _, r := range res {
			require.False(t, r.FirstSeen.Before(day(3)))
			require.False(t, r.LastSeen.After(day(7)))
		}

		// only snapshot 3 is in range: docs/a.txt v2 and other/a.txt, one snapshot each
		require.Len(t, res, 2)
		require.Equal(t, 1, res[0].SnapshotCount)
	})

	t.Run("wildcards, path patterns and directories", func(t *testing.T) {
		req := serverapi.SearchRequest{Pattern: "*.log"}
		res := runSearch(ctx, t, newSearcher(req), all, req)
		require.Len(t, res, 1)
		require.Equal(t, "docs/b.log", res[0].Path)
		require.Equal(t, 4, res[0].SnapshotCount)

		req = serverapi.SearchRequest{Pattern: "other/*"}
		res = runSearch(ctx, t, newSearcher(req), all, req)
		require.Len(t, res, 1)
		require.Equal(t, "other/a.txt", res[0].Path)

		req = serverapi.SearchRequest{Pattern: "docs", IncludeDirs: false}
		require.Empty(t, runSearch(ctx, t, newSearcher(req), all, req))

		req = serverapi.SearchRequest{Pattern: "docs", IncludeDirs: true}
		res = runSearch(ctx, t, newSearcher(req), all, req)
		require.NotEmpty(t, res)
		require.True(t, res[0].IsDir)
	})

	t.Run("limits results and reports truncation", func(t *testing.T) {
		ctx2, cancel := context.WithCancel(ctx)
		defer cancel()

		req := serverapi.SearchRequest{Pattern: "*", MaxResults: 2}
		s, err := newSnapshotSearcher(env.Repository, req, cancel)
		require.NoError(t, err)

		_ = s.search(ctx2, selectSnapshots(all, req))

		res, truncated := s.results()
		require.True(t, truncated)
		require.LessOrEqual(t, len(res), 2)
	})
}

func TestSnapshotRanges(t *testing.T) {
	mk := func(path string, d int) *snapshot.Manifest {
		return &snapshot.Manifest{
			Source:    snapshot.SourceInfo{Host: "h", UserName: "u", Path: path},
			StartTime: fs.UTCTimestamp(day(d).UnixNano()),
			RootEntry: &snapshot.DirEntry{},
		}
	}

	res := snapshotRanges([]*snapshot.Manifest{
		mk("/b", 7), mk("/a", 3), mk("/a", 1), mk("/b", 9),
		{Source: snapshot.SourceInfo{Path: "/skipped"}, StartTime: fs.UTCTimestamp(day(20).UnixNano())}, // no root entry
	})

	require.Equal(t, 4, res.Count)
	require.Equal(t, day(1), res.First.UTC())
	require.Equal(t, day(9), res.Last.UTC())
	require.Len(t, res.Sources, 2)
	require.Equal(t, "/a", res.Sources[0].Path)
	require.Equal(t, 2, res.Sources[0].Count)
	require.Equal(t, day(1), res.Sources[0].First.UTC())
	require.Equal(t, day(3), res.Sources[0].Last.UTC())
	require.Equal(t, day(9), res.Sources[1].Last.UTC())

	empty := snapshotRanges(nil)
	require.Zero(t, empty.Count)
	require.NotNil(t, empty.Sources)
}
