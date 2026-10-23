package notifyhub_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/notifyhub"
)

func at(y int, mo time.Month, d, h, m int) time.Time { return time.Date(y, mo, d, h, m, 0, 0, time.Local) }

func TestLatestDue(t *testing.T) {
	daily := notifyhub.Success{Freq: "daily", Time: "08:00"}
	require.Equal(t, at(2026, 10, 21, 8, 0), notifyhub.LatestDue(daily, at(2026, 10, 22, 7, 59)))
	require.Equal(t, at(2026, 10, 22, 8, 0), notifyhub.LatestDue(daily, at(2026, 10, 22, 8, 0)))
	require.Equal(t, at(2026, 10, 22, 8, 0), notifyhub.LatestDue(daily, at(2026, 10, 22, 23, 0)))
	require.Equal(t, at(2026, 10, 31, 8, 0), notifyhub.LatestDue(daily, at(2026, 11, 1, 7, 0)), "across a month end")

	// 22 October 2026 is a Thursday; weekday 0 is Monday
	weekly := func(wd int) notifyhub.Success { return notifyhub.Success{Freq: "weekly", Weekday: wd, Time: "07:30"} }
	require.Equal(t, at(2026, 10, 19, 7, 30), notifyhub.LatestDue(weekly(0), at(2026, 10, 22, 12, 0)))
	require.Equal(t, at(2026, 10, 22, 7, 30), notifyhub.LatestDue(weekly(3), at(2026, 10, 22, 8, 0)))
	require.Equal(t, at(2026, 10, 15, 7, 30), notifyhub.LatestDue(weekly(3), at(2026, 10, 22, 7, 0)))
	require.Equal(t, at(2026, 10, 18, 7, 30), notifyhub.LatestDue(weekly(6), at(2026, 10, 22, 8, 0)), "Sunday")

	monthly := func(dom int) notifyhub.Success { return notifyhub.Success{Freq: "monthly", DOM: dom, Time: "08:00"} }
	require.Equal(t, at(2026, 10, 1, 8, 0), notifyhub.LatestDue(monthly(1), at(2026, 10, 22, 0, 0)))
	require.Equal(t, at(2026, 9, 28, 8, 0), notifyhub.LatestDue(monthly(28), at(2026, 10, 22, 0, 0)))
	require.Equal(t, at(2026, 9, 30, 8, 0), notifyhub.LatestDue(monthly(0), at(2026, 10, 22, 0, 0)), "last day of the previous month")
	require.Equal(t, at(2026, 2, 28, 8, 0), notifyhub.LatestDue(monthly(0), at(2026, 3, 5, 0, 0)))
	require.Equal(t, at(2028, 2, 29, 8, 0), notifyhub.LatestDue(monthly(0), at(2028, 3, 5, 0, 0)), "leap year")
	require.Equal(t, at(2025, 12, 31, 8, 0), notifyhub.LatestDue(monthly(0), at(2026, 1, 5, 0, 0)), "across a year end")

	require.True(t, notifyhub.LatestDue(notifyhub.Success{Freq: "now"}, at(2026, 10, 22, 0, 0)).IsZero())
}

type memState struct {
	mu sync.Mutex
	m  map[string]time.Time
}

func (s *memState) LastRollup(d string) (time.Time, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.m[d]

	return t, ok, nil
}

func (s *memState) SetLastRollup(d string, t time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[d] = t

	return nil
}

func summaryHub(t *testing.T, ds []notifyhub.Destination) (*notifyhub.Hub, *fakeProvider, *memState, *time.Time, *[][2]time.Time) {
	t.Helper()

	p := &fakeProvider{}
	h, _ := newHub(t, ds, p)
	st := &memState{m: map[string]time.Time{}}
	now := at(2026, 10, 22, 9, 0)

	var periods [][2]time.Time

	h.State = st
	h.Now = func() time.Time { return now }
	h.Digest = func(_ context.Context, from, to time.Time, freq string) (notifyhub.Summary, error) {
		periods = append(periods, [2]time.Time{from, to})

		return notifyhub.Summary{Sources: []notifyhub.SourceSummary{{Source: "/Users/me", Snapshots: 24, Files: 662141}}, Health: "passed"}, nil
	}

	return h, p, st, &now, &periods
}

func TestSummaryIsSentOnceWhenItsTimeComes(t *testing.T) {
	d := dest("d", notifyhub.FailureEvents, "daily")
	h, p, _, now, periods := summaryHub(t, []notifyhub.Destination{d})
	ctx := context.Background()

	h.CheckSummaries(ctx) // first sight of the schedule at 9:00: nothing is sent, counting starts
	h.Wait()
	require.Empty(t, p.got)

	*now = at(2026, 10, 22, 23, 0)
	h.CheckSummaries(ctx)
	h.Wait()
	require.Empty(t, p.got, "8 AM has passed but it was before the schedule began")

	*now = at(2026, 10, 23, 8, 0)
	h.CheckSummaries(ctx)
	h.Wait()
	require.Equal(t, []string{"d:Backup summary, last 24 hours"}, p.titles())
	require.Equal(t, [2]time.Time{at(2026, 10, 22, 9, 0), at(2026, 10, 23, 8, 0)}, (*periods)[0])

	h.CheckSummaries(ctx) // a minute later
	h.Wait()
	require.Len(t, p.got, 1, "sent once")

	*now = at(2026, 10, 24, 8, 0)
	h.CheckSummaries(ctx)
	h.Wait()
	require.Len(t, p.got, 2)
}

func TestMissedSummaryIsSentOnceAfterSleepCoveringTheWholePeriod(t *testing.T) {
	d := dest("d", notifyhub.FailureEvents, "daily")
	h, p, st, now, periods := summaryHub(t, []notifyhub.Destination{d})
	ctx := context.Background()

	require.NoError(t, st.SetLastRollup("d", at(2026, 10, 19, 8, 1)))

	*now = at(2026, 10, 22, 11, 0) // the Mac slept through three mornings
	h.CheckSummaries(ctx)
	h.CheckSummaries(ctx)
	h.Wait()

	require.Len(t, p.got, 1, "one catch-up message, not three")
	require.Equal(t, [2]time.Time{at(2026, 10, 19, 8, 1), at(2026, 10, 22, 11, 0)}, (*periods)[0])
}

func TestSummariesGoOnlyToScheduledDestinations(t *testing.T) {
	h, p, st, now, _ := summaryHub(t, []notifyhub.Destination{
		dest("daily", nil, "daily"),
		dest("now", nil, "now"),
		dest("off", nil, "off"),
	})

	require.NoError(t, st.SetLastRollup("daily", at(2026, 10, 20, 8, 0)))
	require.NoError(t, st.SetLastRollup("now", at(2026, 10, 20, 8, 0)))
	require.NoError(t, st.SetLastRollup("off", at(2026, 10, 20, 8, 0)))

	*now = at(2026, 10, 22, 9, 0)
	h.CheckSummaries(context.Background())
	h.Wait()

	require.Equal(t, []string{"daily:Backup summary, last 24 hours"}, p.titles())
}

func TestFailedSummaryBuildIsLoggedAndNotRepeatedEveryMinute(t *testing.T) {
	h, p, st, now, _ := summaryHub(t, []notifyhub.Destination{dest("d", nil, "daily")})

	var logged []string

	h.Logf = func(f string, a ...any) { logged = append(logged, f) }
	h.Digest = func(context.Context, time.Time, time.Time, string) (notifyhub.Summary, error) {
		return notifyhub.Summary{}, errors.New("database is locked")
	}

	require.NoError(t, st.SetLastRollup("d", at(2026, 10, 21, 8, 0)))

	*now = at(2026, 10, 22, 9, 0)
	h.CheckSummaries(context.Background())
	h.CheckSummaries(context.Background())
	h.Wait()

	require.Empty(t, p.got)
	require.Len(t, logged, 1)
}

func TestRenderSummary(t *testing.T) {
	title, body := notifyhub.RenderSummary(notifyhub.Summary{
		Freq:    "weekly",
		Sources: []notifyhub.SourceSummary{{Source: "/Users/me", Snapshots: 168, Files: 662141}, {Source: "/Applications", Snapshots: 168, Files: 556495}},
		Failed:  1, WithSkipped: 2, MostSkipped: 6, MaintRuns: 7, MaintFailed: 0,
		HaveRepo: true, RepoBytes: 149_000_000_000, HaveGrowth: true, RepoGrowth: 1_900_000_000, Health: "passed",
	})

	require.Equal(t, "Backup summary, last 7 days", title)
	require.Equal(t, `Snapshots completed:
  /Users/me: 168 snapshots, 662,141 files
  /Applications: 168 snapshots, 556,495 files
Failed snapshots: 1
Snapshots with skipped files: 2 (most: 6 files)
Maintenance: 7 runs, 0 problems
Repository: 149 GB (+1.9 GB)
Last full check: passed`, body)

	// an empty period still produces a message: silence should itself mean something is wrong
	title, body = notifyhub.RenderSummary(notifyhub.Summary{Freq: "daily"})
	require.Equal(t, "Backup summary, last 24 hours", title)
	require.Contains(t, body, "No snapshots completed.")
	require.Contains(t, body, "Last full check: not run")
	require.NotContains(t, body, "Repository:")

	title, _ = notifyhub.RenderSummary(notifyhub.Summary{Freq: "monthly"})
	require.Equal(t, "Backup summary, last month", title)
}
