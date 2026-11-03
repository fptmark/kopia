package taskprogress

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/kopia/kopia/internal/clock"
)

func setClock(tb testing.TB, t time.Time) {
	tb.Helper()

	orig := clock.Now
	clock.Now = func() time.Time { return t }
	tb.Cleanup(func() { clock.Now = orig })
}

func TestTickFromContextIsANoOpWithoutAReporter(t *testing.T) {
	// no Reporter installed: must not panic, and Report must not call anything.
	Tick(context.Background())
	Report(context.Background(), "ignored")
}

func TestStalledForTracksTheLastTick(t *testing.T) {
	t0 := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC)
	setClock(t, t0)

	r := New(func(string) {})
	require.Equal(t, time.Duration(0), r.StalledFor(t0))

	t1 := t0.Add(10 * time.Second)
	require.Equal(t, 10*time.Second, r.StalledFor(t1))

	setClock(t, t1)
	r.Tick()
	require.Equal(t, time.Duration(0), r.StalledFor(t1), "Tick resets the clock")

	t2 := t1.Add(5 * time.Second)
	require.Equal(t, 5*time.Second, r.StalledFor(t2))
}

func TestTickViaContextReachesTheInstalledReporter(t *testing.T) {
	t0 := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC)
	setClock(t, t0)

	r := New(func(string) {})
	ctx := WithReporter(context.Background(), r)

	t1 := t0.Add(time.Minute)
	require.Equal(t, time.Minute, r.StalledFor(t1))

	setClock(t, t1)
	Tick(ctx)
	require.Equal(t, time.Duration(0), r.StalledFor(t1))
}

func TestReportIsThrottledToOncePerSecond(t *testing.T) {
	t0 := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC)
	setClock(t, t0)

	var got []string
	r := New(func(s string) { got = append(got, s) })

	r.Report("first")
	require.Equal(t, []string{"first"}, got, "the first call always goes through")

	r.Report("still within the second")
	require.Equal(t, []string{"first"}, got, "throttled: too soon after the last report")

	setClock(t, t0.Add(999*time.Millisecond))
	r.Report("still too soon")
	require.Equal(t, []string{"first"}, got)

	setClock(t, t0.Add(time.Second))
	r.Report("a full second later")
	require.Equal(t, []string{"first", "a full second later"}, got)
}

func TestReportViaContextIsANoOpOutsideATrackedTask(t *testing.T) {
	called := false
	r := New(func(string) { called = true })
	// ctx below was never given r, so Report(ctx, ...) must not reach it.
	Report(context.Background(), "x")
	require.False(t, called)
	_ = r
}
