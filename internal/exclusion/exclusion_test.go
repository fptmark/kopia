package exclusion_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/exclusion"
)

func open(t *testing.T) (*exclusion.Store, string) {
	t.Helper()

	file := filepath.Join(t.TempDir(), "exclusion-rules.json")
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)

	s, err := exclusion.Open(file, func() time.Time { return now })
	require.NoError(t, err)

	return s, file
}

func TestAddValidatesDedupesAndDates(t *testing.T) {
	s, _ := open(t)

	r, added, err := s.Add(exclusion.Rule{Pattern: "  node_modules/ "})
	require.NoError(t, err)
	require.True(t, added)
	require.Equal(t, "node_modules/", r.Pattern)
	require.Equal(t, exclusion.AddedManual, r.AddedBy)
	require.NotNil(t, r.AddedAt)
	require.True(t, r.Global())
	require.Len(t, r.ID, 12)

	again, added, err := s.Add(exclusion.Rule{Pattern: "node_modules/"})
	require.NoError(t, err)
	require.False(t, added)
	require.Equal(t, r.ID, again.ID)

	// the same pattern for a source is a different rule
	_, added, err = s.Add(exclusion.Rule{Source: "/Users/me/", Pattern: "node_modules/"})
	require.NoError(t, err)
	require.True(t, added)
	require.Len(t, s.Rules(), 2)
	require.Equal(t, "/Users/me", s.Rules()[1].Source)

	for _, bad := range []string{"", "   ", "a\nb", "# comment", "!keep"} {
		_, _, err := s.Add(exclusion.Rule{Pattern: bad})
		require.Error(t, err, bad)
	}
}

func TestRulesSurviveReopeningAndRemovalIsKept(t *testing.T) {
	s, file := open(t)

	r, _, err := s.Add(exclusion.Rule{Pattern: ".Trash/", AddedBy: exclusion.AddedCompare})
	require.NoError(t, err)

	reopened, err := exclusion.Open(file, time.Now)
	require.NoError(t, err)
	require.Equal(t, []string{".Trash/"}, reopened.GlobalPatterns())

	got, ok, err := reopened.Remove(r.ID)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, r.ID, got.ID)
	require.Empty(t, reopened.Rules())
	require.Len(t, reopened.Removed(), 1)
	require.Equal(t, ".Trash/", reopened.Removed()[0].Pattern)

	_, ok, err = reopened.Remove("nope")
	require.NoError(t, err)
	require.False(t, ok)

	again, err := exclusion.Open(file, time.Now)
	require.NoError(t, err)
	require.Len(t, again.Removed(), 1)
}

func TestNetRulesCombineBothSets(t *testing.T) {
	s, _ := open(t)

	for _, r := range []exclusion.Rule{
		{Pattern: "node_modules/"},
		{Pattern: ".Trash/"},
		{Source: "/Users/me", Pattern: "/Library/Caches"},
		{Source: "/Users/me", Pattern: "node_modules/"},
		{Source: "/Applications", Pattern: "/Foo.app"},
	} {
		_, _, err := s.Add(r)
		require.NoError(t, err)
	}

	net := s.Net("/Users/me/")
	require.Len(t, net, 3)

	from := map[string]string{}
	for _, n := range net {
		from[n.Pattern] = n.From
	}

	require.Equal(t, map[string]string{".Trash/": "global", "/Library/Caches": "source", "node_modules/": "both"}, from)
	require.Equal(t, []string{".Trash/", "/Foo.app", "node_modules/"}, s.NetPatterns("/Applications"))
	require.Equal(t, []string{".Trash/", "node_modules/"}, s.NetPatterns("/somewhere/else"))
	require.Equal(t, []string{"/Library/Caches", "node_modules/"}, s.SourcePatterns("/Users/me"))
}

func TestImportRunsOnceAndKeepsDatesUnknown(t *testing.T) {
	s, file := open(t)
	require.False(t, s.Imported())

	n, err := s.Import([]string{"node_modules/", ".Trash/"}, map[string][]string{
		"/Users/me": {"/milo.db-wal", "node_modules/", "Library/Containers/com.docker.docker/Data/vms"},
	})
	require.NoError(t, err)
	require.Equal(t, 4, n) // node_modules/ in the source is the global rule
	require.True(t, s.Imported())

	for _, r := range s.Rules() {
		require.Equal(t, exclusion.AddedImport, r.AddedBy)
		require.Nil(t, r.AddedAt)
	}

	n, err = s.Import([]string{"more/"}, nil)
	require.NoError(t, err)
	require.Zero(t, n)

	reopened, err := exclusion.Open(file, time.Now)
	require.NoError(t, err)
	require.True(t, reopened.Imported())
	require.Len(t, reopened.Rules(), 4)
}

func TestOpenReportsAFileThatCannotBeRead(t *testing.T) {
	file := filepath.Join(t.TempDir(), "r.json")
	require.NoError(t, os.WriteFile(file, []byte("{not json"), 0o600))

	_, err := exclusion.Open(file, time.Now)
	require.Error(t, err)
}

func TestSetHelpers(t *testing.T) {
	require.True(t, exclusion.SameSet([]string{"a", "b", "a"}, []string{"b", "a"}))
	require.False(t, exclusion.SameSet([]string{"a"}, []string{"a", "b"}))
	require.Equal(t, []string{"c"}, exclusion.Difference([]string{"a", "c", "b"}, []string{"a", "b", "d"}))
	require.Equal(t, []string{"a", "b"}, exclusion.Unique([]string{"b", "a", "b"}))
}

func TestMatcherFollowsKopiasRules(t *testing.T) {
	type c struct {
		path  string
		isDir bool
		want  bool
	}

	for pattern, cases := range map[string][]c{
		"node_modules/": {
			{"node_modules", true, true},
			{"Projects/a/node_modules", true, true},
			{"node_modules", false, false}, // a file with that name
			{"Projects/node_modules.txt", false, false},
		},
		"Projects/**/build/": {
			{"Projects/a/build", true, true},
			{"Projects/a/b/build", true, true},
			{"Projects/build", true, true},
			{"Library/build", true, false},
			{"Other/Projects/a/build", true, false},
			{"Projects/a/rebuild", true, false},
			{"Projects/a/build", false, false},
		},
		"/Library/Caches": {
			{"Library/Caches", true, true},
			{"Other/Library/Caches", true, false},
		},
		"*.tmp": {
			{"a.tmp", false, true},
			{"x/y/b.tmp", false, true},
			{"a.tmp.bak", false, false},
		},
	} {
		m, err := exclusion.NewMatcher(pattern)
		require.NoError(t, err, pattern)

		for _, tc := range cases {
			require.Equal(t, tc.want, m.Match(tc.path, tc.isDir), "%s on %s (dir=%v)", pattern, tc.path, tc.isDir)
		}
	}

	_, err := exclusion.NewMatcher("")
	require.Error(t, err)
}

func TestReconciledIsRemembered(t *testing.T) {
	s, file := open(t)
	require.False(t, s.Reconciled())
	require.NoError(t, s.MarkReconciled())
	require.True(t, s.Reconciled())

	reopened, err := exclusion.Open(file, time.Now)
	require.NoError(t, err)
	require.True(t, reopened.Reconciled())
}
