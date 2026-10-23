package ignoreerr_test

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/ignoreerr"
)

const (
	denied  = "unable to read directory: open /x: operation not permitted"
	vanish  = "open /x: no such file or directory"
	srcPath = "/Users/me"
)

func TestKindOf(t *testing.T) {
	require.Equal(t, ignoreerr.KindPermission, ignoreerr.KindOf(denied))
	require.Equal(t, ignoreerr.KindPermission, ignoreerr.KindOf("open: Permission denied"))
	require.Equal(t, ignoreerr.KindMissing, ignoreerr.KindOf(vanish))
	require.Equal(t, ignoreerr.KindBusy, ignoreerr.KindOf("resource busy"))
	require.Equal(t, ignoreerr.KindOther, ignoreerr.KindOf("input/output error"))
}

func TestRuleMatches(t *testing.T) {
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	past, future := now.Add(-time.Hour), now.Add(time.Hour)

	cases := []struct {
		name string
		r    ignoreerr.Rule
		src  string
		path string
		msg  string
		want bool
	}{
		{"exact file", ignoreerr.Rule{Path: "Library/a", Scope: "file"}, srcPath, "Library/a", denied, true},
		{"file is not its children", ignoreerr.Rule{Path: "Library/a", Scope: "file"}, srcPath, "Library/a/b", denied, false},
		{"leading slash is the same path", ignoreerr.Rule{Path: "/Library/a/", Scope: "file"}, srcPath, "Library/a", denied, true},
		{"folder covers itself", ignoreerr.Rule{Path: "Library/a", Scope: "folder"}, srcPath, "Library/a", denied, true},
		{"folder covers children", ignoreerr.Rule{Path: "Library/a", Scope: "folder"}, srcPath, "Library/a/b/c", denied, true},
		{"folder is not a name prefix", ignoreerr.Rule{Path: "Library/a", Scope: "folder"}, srcPath, "Library/ab", denied, false},
		{"other source", ignoreerr.Rule{Source: "/Applications", Path: "a", Scope: "folder"}, srcPath, "a", denied, false},
		{"same source", ignoreerr.Rule{Source: srcPath, Path: "a", Scope: "folder"}, srcPath + "/", "a", denied, true},
		{"any source", ignoreerr.Rule{Path: "a", Scope: "folder"}, "/Applications", "a", denied, true},
		{"kind matches", ignoreerr.Rule{Path: "a", Scope: "folder", Kind: "permission"}, srcPath, "a/b", denied, true},
		{"kind differs", ignoreerr.Rule{Path: "a", Scope: "folder", Kind: "permission"}, srcPath, "a/b", vanish, false},
		{"whole source by kind", ignoreerr.Rule{Scope: "folder", Kind: "missing"}, srcPath, "anything", vanish, true},
		{"expired", ignoreerr.Rule{Path: "a", Scope: "folder", Expires: &past}, srcPath, "a", denied, false},
		{"not yet expired", ignoreerr.Rule{Path: "a", Scope: "folder", Expires: &future}, srcPath, "a", denied, true},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			require.Equal(t, c.want, c.r.Matches(c.src, c.path, c.msg, now))
		})
	}
}

func TestValidate(t *testing.T) {
	for _, r := range []ignoreerr.Rule{
		{Scope: "file"},                         // no path
		{Scope: "folder"},                       // everything everywhere
		{Scope: "nope", Path: "a"},              // unknown scope
		{Scope: "folder", Path: "a", Kind: "x"}, // unknown kind
	} {
		require.Error(t, r.Validate(), "%+v", r)
	}

	ok := ignoreerr.Rule{Scope: "folder", Source: "/Users/me/", Path: "/Library/a/"}
	require.NoError(t, ok.Validate())
	require.Equal(t, "Library/a", ok.Path)
	require.Equal(t, "/Users/me", ok.Source)
}

func TestStore(t *testing.T) {
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	file := filepath.Join(t.TempDir(), "ignored-errors.json")

	s, err := ignoreerr.Open(file, func() time.Time { return now })
	require.NoError(t, err)
	require.Empty(t, s.Rules())
	require.False(t, s.Ignored(srcPath, "Library/a", denied))

	r, err := s.Add(ignoreerr.Rule{Source: srcPath, Path: "Library/a", Scope: "folder", Kind: "permission"})
	require.NoError(t, err)
	require.NotEmpty(t, r.ID)
	require.Equal(t, now, r.Created)

	again, err := s.Add(ignoreerr.Rule{Source: srcPath, Path: "/Library/a", Scope: "folder", Kind: "permission"})
	require.NoError(t, err)
	require.Equal(t, r.ID, again.ID)
	require.Len(t, s.Rules(), 1)

	require.True(t, s.Ignored(srcPath, "Library/a/b", denied))
	require.Equal(t, 1, s.CountIgnored(srcPath, []ignoreerr.Failure{{Path: "Library/a/b", Error: denied}, {Path: "Library/z", Error: denied}}))

	// rules survive a restart
	s2, err := ignoreerr.Open(file, func() time.Time { return now })
	require.NoError(t, err)
	require.Equal(t, s.Rules(), s2.Rules())

	removed, err := s2.Remove(r.ID)
	require.NoError(t, err)
	require.True(t, removed)
	require.False(t, s2.Ignored(srcPath, "Library/a/b", denied))

	removed, err = s2.Remove(r.ID)
	require.NoError(t, err)
	require.False(t, removed)
}

func TestNilStoreIgnoresNothing(t *testing.T) {
	var s *ignoreerr.Store

	require.False(t, s.Ignored(srcPath, "a", denied))
	require.Zero(t, s.CountIgnored(srcPath, []ignoreerr.Failure{{Path: "a"}}))
	require.Empty(t, s.Rules())
}
