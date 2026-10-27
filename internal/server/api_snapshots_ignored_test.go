package server

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/fs"
	"github.com/kopia/kopia/internal/ignoreerr"
	"github.com/kopia/kopia/internal/serverapi"
)

func TestMarkIgnoredFailuresTakesCoveredFailuresOutOfTheCount(t *testing.T) {
	rules, err := ignoreerr.Open(filepath.Join(t.TempDir(), "ignored-errors.json"), time.Now)
	require.NoError(t, err)

	_, err = rules.Add(ignoreerr.Rule{Source: "/Users/me", Path: "Library/Duet", Scope: "folder"})
	require.NoError(t, err)

	const denied = "open x: operation not permitted"

	stored := &fs.DirectorySummary{
		FatalErrorCount: 3,
		FailedEntries: []*fs.EntryWithError{
			{EntryPath: "Library/Duet/a", Error: denied},
			{EntryPath: "Library/Duet/b", Error: denied},
			{EntryPath: "Library/Other/c", Error: denied},
		},
	}
	snaps := []*serverapi.Snapshot{{ID: "s1", Summary: stored}, {ID: "s2"}}

	markIgnoredFailures(rules, "/Users/me", snaps)

	got := snaps[0].Summary
	require.Equal(t, 1, got.FatalErrorCount)
	require.Equal(t, 2, got.IgnoredByRule)
	require.True(t, got.FailedEntries[0].Ignored)
	require.True(t, got.FailedEntries[1].Ignored)
	require.False(t, got.FailedEntries[2].Ignored)

	// the stored record is not changed, only the answer
	require.Equal(t, 3, stored.FatalErrorCount)
	require.Zero(t, stored.IgnoredByRule)
	require.False(t, stored.FailedEntries[0].Ignored)

	// no rules, or a snapshot without failures, leaves everything as it is
	markIgnoredFailures(nil, "/Users/me", snaps)
	require.Nil(t, snaps[1].Summary)
}

func TestWithIgnoredFailuresReturnsTheSameSummaryWhenNothingIsCovered(t *testing.T) {
	rules, err := ignoreerr.Open(filepath.Join(t.TempDir(), "ignored-errors.json"), time.Now)
	require.NoError(t, err)

	_, err = rules.Add(ignoreerr.Rule{Source: "/Users/me", Path: "Library/Duet", Scope: "folder"})
	require.NoError(t, err)

	sum := &fs.DirectorySummary{
		FatalErrorCount: 1,
		FailedEntries:   []*fs.EntryWithError{{EntryPath: "Library/Other/c", Error: "operation not permitted"}},
	}

	got := withIgnoredFailures(rules, "/Users/me", sum)
	require.Equal(t, 1, got.FatalErrorCount)
	require.Zero(t, got.IgnoredByRule)
	require.Nil(t, withIgnoredFailures(rules, "/Users/me", nil))
}
