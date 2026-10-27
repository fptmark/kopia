package server

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/fs"
	"github.com/kopia/kopia/internal/ignoreerr"
	"github.com/kopia/kopia/internal/serverapi"
	"github.com/kopia/kopia/notification/notifydata"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/policy"
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

func TestSourceOverdueUsesTheHealthCheckLimit(t *testing.T) {
	now := time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)
	status := func(ago time.Duration, p policy.SchedulingPolicy, state string) *serverapi.SourceStatus {
		return &serverapi.SourceStatus{
			Status:           state,
			SchedulingPolicy: p,
			LastSnapshot:     &snapshot.Manifest{StartTime: fs.UTCTimestampFromTime(now.Add(-ago))},
		}
	}

	hourly := policy.SchedulingPolicy{IntervalSeconds: 3600}
	require.False(t, sourceOverdue(status(2*time.Hour, hourly, "IDLE"), now))
	require.True(t, sourceOverdue(status(3*time.Hour+time.Minute, hourly, "IDLE"), now))
	require.False(t, sourceOverdue(status(30*time.Hour, hourly, "PAUSED"), now))

	// the schedules the old copy of this rule in the UI did not know about
	daily := policy.SchedulingPolicy{TimesOfDay: []policy.TimeOfDay{{Hour: 3}}}
	require.False(t, sourceOverdue(status(25*time.Hour, daily, "IDLE"), now))
	require.True(t, sourceOverdue(status(27*time.Hour, daily, "IDLE"), now))
	require.False(t, sourceOverdue(status(7*24*time.Hour, policy.SchedulingPolicy{Manual: true}, "IDLE"), now))

	require.False(t, sourceOverdue(&serverapi.SourceStatus{SchedulingPolicy: hourly}, now))
}

func TestReportSeesNoFailuresWhenEveryOneIsIgnored(t *testing.T) {
	rules, err := ignoreerr.Open(filepath.Join(t.TempDir(), "ignored-errors.json"), time.Now)
	require.NoError(t, err)

	_, err = rules.Add(ignoreerr.Rule{Source: "/Users/me", Path: "Library/Duet", Scope: "folder"})
	require.NoError(t, err)

	mwe := &notifydata.ManifestWithError{Manifest: snapshot.Manifest{RootEntry: &snapshot.DirEntry{DirSummary: &fs.DirectorySummary{
		FatalErrorCount: 1,
		FailedEntries:   []*fs.EntryWithError{{EntryPath: "Library/Duet/a", Error: "operation not permitted"}},
	}}}}

	require.Equal(t, notifydata.StatusCodeFatal, mwe.StatusCode())

	got := withoutIgnoredFailures(rules, "/Users/me", mwe)
	require.Equal(t, notifydata.StatusCodeSuccess, got.StatusCode())

	// the stored result is not changed
	require.Equal(t, notifydata.StatusCodeFatal, mwe.StatusCode())

	// a failure no rule covers still makes it a failure
	mwe.Manifest.RootEntry.DirSummary.FailedEntries[0].EntryPath = "Library/Other/a"
	require.Equal(t, notifydata.StatusCodeFatal, withoutIgnoredFailures(rules, "/Users/me", mwe).StatusCode())
}

func TestDirectoryListingCountsOnlyTheFailuresNoRuleCovers(t *testing.T) {
	rules, err := ignoreerr.Open(filepath.Join(t.TempDir(), "ignored-errors.json"), time.Now)
	require.NoError(t, err)

	_, err = rules.Add(ignoreerr.Rule{Source: "/Users/me", Path: "Library/Duet", Scope: "folder"})
	require.NoError(t, err)

	listing := []byte(`{"stream":"kopia:directory","entries":[` +
		`{"name":"Library","type":"d","summ":{"numFailed":2,"errors":[` +
		`{"path":"Library/Duet/a","error":"operation not permitted"},{"path":"Library/Other/b","error":"operation not permitted"}]}},` +
		`{"name":"Docs","type":"d","summ":{"numFailed":0}}]}`)

	var got snapshot.DirManifest
	require.NoError(t, json.Unmarshal(withIgnoredDirectoryFailures(rules, "/Users/me", listing), &got))
	require.Len(t, got.Entries, 2)
	require.Equal(t, 1, got.Entries[0].DirSummary.FatalErrorCount)
	require.Equal(t, 1, got.Entries[0].DirSummary.IgnoredByRule)
	require.True(t, got.Entries[0].DirSummary.FailedEntries[0].Ignored)
	require.Zero(t, got.Entries[1].DirSummary.FatalErrorCount)

	// an unreadable listing, or no rules, comes back untouched
	require.Equal(t, []byte("nope"), withIgnoredDirectoryFailures(rules, "/Users/me", []byte("nope")))
	require.Equal(t, listing, withIgnoredDirectoryFailures(nil, "/Users/me", listing))
}
